/**
 * HTTP Transport for remote MCP access (SDK v2).
 *
 * Provides an Express HTTP server with:
 * - Stateless Streamable HTTP MCP endpoint (ALL /mcp) via createMcpHandler.
 *   2026-07-28-era clients are served per-request; 2025-era clients fall back
 *   to the SDK's stateless legacy mode. No sessions — any instance can serve
 *   any request, so the server works behind a plain load balancer.
 * - OAuth 2.1 authorization server (src/auth/router.ts) + bearer-gated /mcp
 * - .well-known discovery endpoints for OAuth metadata
 * - CORS support (opt-in)
 * - Explicit request body limit, enforced after authentication
 * - JSON error responses (never Express' HTML/stack-trace page)
 * - Health check endpoint
 * - Graceful shutdown
 *
 * The legacy HTTP+SSE transport (GET /sse + POST /messages) was removed in
 * v2.0 — those endpoints now answer 410 Gone with a migration hint.
 */

import { STATUS_CODES } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  requireBearerAuth,
  hostHeaderValidation,
  originValidation,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/express';

import { OpenClawAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { createAuthRouter } from '../auth/router.js';
import { log, logError } from '../utils/logger.js';
import { isLoopbackHost } from './http-auth.js';
import { createMcpServer, type ToolRegistrationDeps } from './mcp-server.js';

/**
 * Upper bound on an MCP request body (POST /mcp).
 *
 * `openclaw_chat` accepts messages of up to 100,000 characters — up to ~300 kB
 * of UTF-8, more once JSON-escaped — so Express' implicit 100 kB default would
 * reject valid calls with 413. 4 MiB is also the cap the MCP SDK's Node adapter
 * applies when it reads a request body itself.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Route whose JSON body is parsed after authentication, with the limit above. */
const MCP_PATH = '/mcp';

/** How long in-flight requests may finish on their own during shutdown. */
const DRAIN_GRACE_MS = 3_000;

export interface HttpServerConfig {
  port: number;
  host: string;
  /** Override the OAuth issuer URL (e.g., https://mcp.example.com behind a reverse proxy) */
  issuerUrl?: string;
  /**
   * Express `trust proxy` setting. Required when behind a reverse proxy that
   * sets `X-Forwarded-For` — otherwise `express-rate-limit` (used on the OAuth
   * endpoints) throws `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on `/token`.
   * Accepts `true` / `false`, a hop count (e.g. `1`), or an IP/CIDR string or
   * keyword (`loopback`, `linklocal`, `uniquelocal`). Undefined leaves the
   * Express default (`false`) untouched.
   */
  trustProxy?: boolean | number | string;
  /**
   * Extra hostnames accepted by DNS-rebinding protection, beyond the loopback
   * set. Needed when a reverse proxy in front of a loopback bind preserves the
   * public `Host` header (e.g. Tailscale Serve, nginx with `proxy_set_header
   * Host $host`). Hostnames only, no scheme or port; IPv6 in brackets.
   */
  allowedHosts?: string[];
  /** Auth is enabled when authConfig is provided */
  authConfig?: AuthProviderConfig;
}

/**
 * Parse the TRUST_PROXY env var / --trust-proxy CLI flag into an
 * Express-compatible value. Returns `undefined` when the input is empty so
 * callers can skip `app.set('trust proxy', …)` entirely.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  return trimmed;
}

/** Hostnames always accepted when Host/Origin validation is active. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Parse the ALLOWED_HOSTS env var / --allowed-hosts CLI flag: comma-separated
 * hostnames, case-insensitive. Returns `undefined` when nothing usable is set.
 */
export function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Decide whether Host/Origin validation applies and with which hostname list.
 * Validation is on for loopback binds (DNS-rebinding protection) and whenever
 * an explicit allowlist is configured; `null` means validation is disabled.
 */
export function resolveAllowedHostnames(
  host: string,
  allowedHosts: string[] | undefined
): string[] | null {
  if (!isLoopbackHost(host) && !allowedHosts?.length) return null;
  return [...LOOPBACK_HOSTNAMES, ...(allowedHosts ?? [])];
}

// --- CORS helpers ---

/**
 * Load CORS configuration from environment.
 *
 * Defaults to CORS disabled. Sending `Access-Control-Allow-Origin: *` by
 * default let any web page drive this server through a visitor's browser;
 * enabling cross-origin access is now an explicit opt-in via `CORS_ORIGINS`.
 * Set `CORS_ORIGINS=*` to restore the old behaviour, or list the origins you
 * actually serve. Non-browser clients (Claude.ai, Claude Desktop, Inspector
 * over stdio) are unaffected — CORS only applies to browsers.
 */
export function loadCorsConfig(): { origins: string[]; enabled: boolean } {
  const corsOrigins = process.env.CORS_ORIGINS;

  if (!corsOrigins || corsOrigins.toLowerCase() === 'none') {
    return { origins: [], enabled: false };
  }

  if (corsOrigins === '*') {
    return { origins: ['*'], enabled: true };
  }

  return {
    origins: corsOrigins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: true,
  };
}

/**
 * Check if origin is allowed by CORS config
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(1); // ".example.com"
      try {
        const originHost = new URL(origin).hostname;
        return originHost === domain.slice(1) || originHost.endsWith(domain);
      } catch {
        return false;
      }
    }
    return origin === allowed || origin === `https://${allowed}` || origin === `http://${allowed}`;
  });
}

// --- Error responses ---

/**
 * Final Express error handler. Body-parser failures (oversized or malformed
 * JSON) and anything else that reaches Express would otherwise be answered by
 * Express' default handler: an HTML page that includes the stack trace, with
 * internal paths, unless NODE_ENV=production. Reply with a terse JSON error
 * instead — JSON-RPC shaped on the MCP endpoint, OAuth shaped elsewhere.
 */
export function httpErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const {
    status: rawStatus,
    type,
    limit,
  } = (err ?? {}) as { status?: unknown; type?: unknown; limit?: unknown };
  const status =
    typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400
      ? Math.min(rawStatus, 599)
      : 500;

  let code = -32000;
  let message = STATUS_CODES[status] ?? 'Bad Request';
  if (status === 413 && typeof limit === 'number') {
    message = `Payload Too Large: request body must not exceed ${limit} bytes`;
  } else if (type === 'entity.parse.failed') {
    code = -32700;
    message = 'Parse error: Invalid JSON';
  } else if (status >= 500) {
    code = -32603;
    message = 'Internal server error';
    logError(`Unhandled error on ${req.method} ${req.path}`, err);
  }

  if (normalizePath(req.path) === MCP_PATH) {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
    return;
  }
  res.status(status).json({
    error: status >= 500 ? 'server_error' : 'invalid_request',
    error_description: message,
  });
}

/** Express routes match case-insensitively and ignore a trailing slash; so does this. */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, '').toLowerCase();
}

// --- Main server factory ---

export interface HttpApp {
  app: Express;
  authEnabled: boolean;
  corsConfig: { origins: string[]; enabled: boolean };
  /** Abort in-flight MCP exchanges (used on shutdown). */
  close: () => Promise<void>;
}

/**
 * Build the Express app with the stateless Streamable HTTP transport, without
 * listening. Split from `createHttpServer` so tests can drive the real app.
 */
export function createHttpApp(config: HttpServerConfig, deps: ToolRegistrationDeps): HttpApp {
  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  const app: Express = express();
  // Express 5 exposes query params via the extended parser by default; the
  // simple parser keeps values as plain strings, matching our validation.
  app.set('query parser', 'simple');

  // DNS-rebinding protection for loopback binds. A browser can resolve an
  // attacker-controlled name to 127.0.0.1, so a local server must check that
  // Host and Origin really are local. SDK v1's createMcpExpressApp did this;
  // on v2 it has to be wired explicitly. ALLOWED_HOSTS extends the accepted
  // set for reverse proxies that preserve the public Host header (#41), and
  // also turns validation on for non-loopback binds.
  const allowedHostnames = resolveAllowedHostnames(config.host, config.allowedHosts);
  if (allowedHostnames) {
    app.use(hostHeaderValidation(allowedHostnames));
    app.use(originValidation(allowedHostnames));
    log(`DNS-rebinding protection: enabled (allowed hosts: ${allowedHostnames.join(', ')})`);
  } else {
    log(
      `DNS-rebinding protection: disabled (HOST=${config.host} is not loopback and ` +
        'ALLOWED_HOSTS is not set) — rely on OAuth, your reverse proxy and CORS_ORIGINS'
    );
  }

  if (config.trustProxy !== undefined) {
    // `trust proxy: true` makes Express take req.ip from the leftmost
    // X-Forwarded-For entry, which the client fully controls — rate limiting
    // then keys on an attacker-chosen value and stops limiting anything.
    if (config.trustProxy === true && authEnabled) {
      logError(
        'TRUST_PROXY=true is unsafe with authentication enabled: the client-controlled ' +
          'X-Forwarded-For entry becomes the rate-limit key, disabling rate limiting on ' +
          'the OAuth endpoints. Set TRUST_PROXY to the number of proxy hops instead ' +
          '(TRUST_PROXY=1 for a single reverse proxy). Refusing to start.'
      );
      process.exit(1);
    }
    app.set('trust proxy', config.trustProxy);
    log(`Trust proxy: ${JSON.stringify(config.trustProxy)}`);
  } else if (authEnabled) {
    log(
      'WARNING: TRUST_PROXY is not set. Behind a reverse proxy every request appears to ' +
        "come from the proxy's IP, so the OAuth rate limits apply to all clients as one " +
        'shared budget. Set TRUST_PROXY=1 when running behind a proxy.'
    );
  }

  // --- CORS middleware (before auth so preflight works) ---
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!corsConfig.enabled) {
      next();
      return;
    }

    const origin = req.headers.origin as string | undefined;
    const allowedOrigin = corsConfig.origins.includes('*')
      ? '*'
      : origin && isOriginAllowed(origin, corsConfig.origins)
        ? origin
        : undefined;

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        // Mcp-Method / Mcp-Name are required request headers in the
        // 2026-07-28 Streamable HTTP transport; Mcp-Session-Id is 2025-era.
        'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // --- OAuth routes (if auth enabled) ---
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  if (authEnabled) {
    const provider = new OpenClawAuthProvider(config.authConfig!);
    const issuerUrl = config.issuerUrl
      ? new URL(config.issuerUrl)
      : new URL(`http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

    // Authorization-server endpoints: /authorize, /token, /revoke,
    // /register (DCR opt-in) and .well-known AS metadata
    app.use(createAuthRouter({ provider, issuerUrl, scopesSupported: ['mcp:tools'] }));

    // Protected Resource Metadata (RFC 9728)
    // Tells clients (Inspector, Claude.ai) where the OAuth server is.
    // This is read-only metadata — no security implications.
    const protectedResourceMetadata = (resourcePath: string) => ({
      resource: `${issuerUrl.toString().replace(/\/$/, '')}${resourcePath}`,
      authorization_servers: [issuerUrl.toString().replace(/\/$/, '')],
      scopes_supported: ['mcp:tools'],
    });
    app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
      res.json(protectedResourceMetadata(`/${req.params.path}`));
    });
    // Some clients probe the un-suffixed document.
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.json(protectedResourceMetadata('/mcp'));
    });

    // Bearer auth middleware for protected routes (sets req.auth, which
    // toNodeHandler forwards to the MCP handler as authInfo). The
    // resource_metadata hint lets an unauthenticated client discover the
    // authorization server straight from the 401 challenge.
    authMiddleware = requireBearerAuth({
      verifier: provider,
      // Actually enforce the scope the metadata advertises; without this any
      // non-expired token authorizes every tool call regardless of its grant.
      requiredScopes: ['mcp:tools'],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', issuerUrl)),
    });
  }

  // --- Health check (no auth) ---
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      legacySseSupported: false,
      auth: authEnabled,
    });
  });

  // --- MCP endpoint (stateless Streamable HTTP) ---

  // A fresh McpServer per request. With OAuth on, every tool call must resolve
  // to an authenticated OAuth client — that is what async tasks are owned by.
  const mcpHandler = createMcpHandler(() => createMcpServer(deps, { authRequired: authEnabled }), {
    legacy: 'stateless',
    onerror: (error) => logError('MCP handler error', error),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => logError('MCP transport error', error),
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });

  const mcpRoute = (req: Request, res: Response) => {
    // Pass the parsed body through — toNodeHandler re-serializes it. A body
    // the JSON parser skipped (wrong Content-Type) is read by the SDK's Node
    // adapter, under the same cap.
    void nodeHandler(req, res, req.body);
  };

  // --- Body parsing ---
  // There is deliberately no app-wide body parser. The MCP endpoint gets its
  // body parsed after authentication, with the explicit limit, so an
  // unauthenticated caller cannot make the server buffer and parse megabytes
  // of JSON. The OAuth endpoints bring their own 100 kB parsers
  // (src/auth/router.ts); no other route reads a body at all.
  const mcpJsonParser = express.json({ limit: MAX_REQUEST_BODY_BYTES });

  // Middleware chain: bearer auth first (when enabled), then the size-limited
  // JSON body parser, then the handler.
  app.all(MCP_PATH, ...(authMiddleware ? [authMiddleware] : []), mcpJsonParser, mcpRoute);

  // --- Legacy SSE transport: removed in v2.0 ---
  const legacyGone = (_req: Request, res: Response) => {
    res.status(410).json({
      error:
        'The HTTP+SSE transport was removed in openclaw-mcp 2.0. Connect via /mcp (Streamable HTTP).',
    });
  };
  app.get('/sse', legacyGone);
  app.post('/messages', legacyGone);

  // --- Error handler (last) ---
  // Body-parser rejections (malformed JSON, payload too large) never reach the
  // MCP handler's onerror.
  app.use(httpErrorHandler);

  return { app, authEnabled, corsConfig, close: () => mcpHandler.close() };
}

/**
 * Create and start the HTTP server with the stateless Streamable HTTP transport.
 */
export async function createHttpServer(
  config: HttpServerConfig,
  deps: ToolRegistrationDeps
): Promise<void> {
  const { app, authEnabled, corsConfig, close } = createHttpApp(config, deps);

  // --- Start server ---

  const httpServer: HttpServer = app.listen(config.port, config.host, () => {
    log(`HTTP server listening on ${config.host}:${config.port}`);
    log(`Auth enabled: ${authEnabled}`);
    log(`CORS origins: ${corsConfig.enabled ? corsConfig.origins.join(', ') : 'disabled'}`);
    log(`Max MCP request body: ${MAX_REQUEST_BODY_BYTES} bytes`);

    if (corsConfig.origins.includes('*')) {
      logError(
        'WARNING: CORS_ORIGINS=* allows any web page to call this server from a browser. ' +
          'List explicit origins instead.'
      );
    }

    if (authEnabled) {
      log('OAuth 2.1 authentication is REQUIRED for all connections');
      log('Endpoints:');
      log('  GET  /.well-known/oauth-authorization-server          - OAuth metadata');
      log('  GET  /.well-known/oauth-protected-resource/mcp        - Protected resource metadata');
      log('  GET  /authorize                                       - Authorization');
      log('  POST /token                                           - Token exchange');
    } else {
      logError(
        'WARNING: Auth is DISABLED (MCP_DANGEROUSLY_DISABLE_AUTH) - server is open to anyone!'
      );
    }

    log('MCP Endpoints:');
    log('  GET  /health   - Health check (no auth)');
    log('  ALL  /mcp      - Streamable HTTP (stateless)');
  });

  // --- Graceful shutdown ---

  let shuttingDown = false;
  const shutdown = async () => {
    // SIGTERM followed by SIGINT must not run this twice.
    if (shuttingDown) return;
    shuttingDown = true;

    log('Shutting down HTTP server...');

    // Force exit if the drain below doesn't finish in time.
    const forceExit = setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
    forceExit.unref?.();

    // `close()` stops accepting new connections synchronously, but its
    // callback only fires once every existing connection has ended — and an
    // in-flight MCP exchange holds its connection open. So start the drain
    // first (to close the door), then abort the transports, then await it.
    // Awaiting the drain before aborting would deadlock until the force timer.
    const drained = new Promise<void>((resolve) => httpServer.close(() => resolve()));

    try {
      await close();
    } catch (error) {
      logError('Error closing MCP handler', error);
    }

    // handler.close() only aborts modern per-request exchanges; a legacy-era
    // request sitting on a slow gateway call keeps its connection open until
    // its own timeout. Let those finish briefly, then cut them, so a restart
    // doesn't hang until the force timer and report failure to the supervisor.
    const cutConnections = setTimeout(() => {
      log('Draining timed out; closing remaining connections');
      httpServer.closeAllConnections?.();
    }, DRAIN_GRACE_MS);
    cutConnections.unref?.();

    await drained;

    clearTimeout(cutConnections);
    clearTimeout(forceExit);
    log('HTTP server stopped');
    process.exit(0);
  };

  (process as NodeJS.Process).on('SIGTERM', shutdown);
  (process as NodeJS.Process).on('SIGINT', shutdown);
}
