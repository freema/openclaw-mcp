/**
 * HTTP Transport for remote MCP access
 *
 * Provides a full Express HTTP server with:
 * - Modern Streamable HTTP transport (POST/GET/DELETE /mcp) — primary
 * - Legacy SSE transport (GET /sse + POST /messages) — deprecated, kept for backward compat
 * - OAuth 2.1 authentication via MCP SDK (mcpAuthRouter + requireBearerAuth)
 * - .well-known discovery endpoints for OAuth metadata
 * - CORS support
 * - Explicit request body limit, enforced after authentication
 * - Health check endpoint
 * - Graceful shutdown
 */

import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { OpenClawAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { log, logError } from '../utils/logger.js';
import { isLoopbackHost } from './http-auth.js';
import { createMcpServer, type ToolRegistrationDeps } from './tools-registration.js';

/**
 * Upper bound on an MCP request body (POST /mcp and POST /messages).
 *
 * `openclaw_chat` accepts messages of up to 100,000 characters — up to ~300 kB
 * of UTF-8, more once JSON-escaped. Express' implicit 100 kB default (what the
 * SDK's `createMcpExpressApp()` applies) rejected such messages with 413, so
 * the limit is explicit. 4 MiB is the cap the MCP SDK uses whenever it reads a
 * request body itself.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Routes whose JSON body is parsed after authentication, with the limit above. */
const MCP_BODY_PATHS = new Set(['/mcp', '/messages']);

export interface HttpServerConfig {
  port: number;
  host: string;
  /** Override the OAuth issuer URL (e.g., https://mcp.example.com behind a reverse proxy) */
  issuerUrl?: string;
  /**
   * Express `trust proxy` setting. Required when behind a reverse proxy that
   * sets `X-Forwarded-For` — otherwise `express-rate-limit` (used by the MCP
   * SDK auth handlers) throws `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on `/token`.
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

/** Hostnames always accepted when Host validation is active. */
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
 * Decide whether Host validation applies and with which hostname list.
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

// --- Session tracking ---

interface LegacySseSession {
  transport: SSEServerTransport;
  server: Server;
}

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

// --- Error responses ---

/**
 * Final Express error handler. Body-parser failures (oversized or malformed
 * JSON) and anything else that reaches Express would otherwise be answered by
 * Express' default handler: an HTML page that includes the stack trace, with
 * internal paths, unless NODE_ENV=production. Reply with a terse JSON error
 * instead — JSON-RPC shaped on the MCP endpoints, OAuth shaped elsewhere.
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

  if (MCP_BODY_PATHS.has(normalizePath(req.path))) {
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
  /** Close every open MCP session (used on shutdown). */
  closeSessions: () => Promise<void>;
}

/**
 * Build the Express app with Streamable HTTP + legacy SSE transports, without
 * listening. Split from `createHttpServer` so tests can drive the real app.
 */
export function createHttpApp(config: HttpServerConfig, deps: ToolRegistrationDeps): HttpApp {
  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  // Active sessions
  const legacySseSessions = new Map<string, LegacySseSession>();
  const streamableSessions = new Map<string, StreamableSession>();

  // The app is assembled here rather than with the SDK's createMcpExpressApp(),
  // which installs a global express.json() with the implicit 100 kB limit in
  // front of authentication. Host validation is the same SDK middleware.
  //
  // DNS-rebinding protection: on for loopback binds. ALLOWED_HOSTS extends the
  // accepted set for reverse proxies that preserve the public Host header
  // (#41), and also turns validation on for non-loopback binds.
  const app: Express = express();
  const allowedHostnames = resolveAllowedHostnames(config.host, config.allowedHosts);
  if (allowedHostnames) {
    app.use(hostHeaderValidation(allowedHostnames));
    log(`DNS-rebinding protection: enabled (allowed hosts: ${allowedHostnames.join(', ')})`);
  } else {
    log(
      `DNS-rebinding protection: disabled (HOST=${config.host} is not loopback and ` +
        'ALLOWED_HOSTS is not set) — rely on OAuth, your reverse proxy and CORS_ORIGINS'
    );
  }

  // Configure Express `trust proxy` when running behind a reverse proxy.
  // Without this, `express-rate-limit` (used by the MCP SDK auth handlers)
  // crashes /token with ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  if (config.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
    log(`Trust proxy: ${JSON.stringify(config.trustProxy)}`);
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
        'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // --- Body parsing ---
  // The MCP endpoints get their body parsed after authentication, with the
  // explicit limit, so an unauthenticated caller cannot make the server buffer
  // and parse megabytes of JSON. Every other route keeps Express' default
  // 100 kB JSON parser, exactly as before (the OAuth handlers additionally
  // bring their own urlencoded/JSON parsers).
  const defaultJsonParser = express.json();
  const mcpJsonParser = express.json({ limit: MAX_REQUEST_BODY_BYTES });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (MCP_BODY_PATHS.has(normalizePath(req.path))) {
      next();
      return;
    }
    defaultJsonParser(req, res, next);
  });

  // --- OAuth routes (if auth enabled) ---
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  if (authEnabled) {
    const provider = new OpenClawAuthProvider(config.authConfig!);
    const issuerUrl = config.issuerUrl
      ? new URL(config.issuerUrl)
      : new URL(`http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

    // Install OAuth endpoints: /authorize, /token, /register, /revoke
    // and .well-known discovery metadata
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        scopesSupported: ['mcp:tools'],
      })
    );

    // Protected Resource Metadata (RFC 9728)
    // Tells clients (Inspector, Claude.ai) where the OAuth server is.
    // This is read-only metadata — no security implications.
    app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
      res.json({
        resource: `${issuerUrl.toString()}${req.params.path}`,
        authorization_servers: [issuerUrl.toString().replace(/\/$/, '')],
        scopes_supported: ['mcp:tools'],
      });
    });

    // Bearer auth middleware for protected routes
    authMiddleware = requireBearerAuth({ verifier: provider });
  }

  // --- Health check (no auth) ---
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      legacySseSupported: true,
      auth: authEnabled,
    });
  });

  // Middleware chain for the MCP endpoints: bearer auth first (when enabled),
  // then the size-limited JSON body parser, then the handler.
  const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => [
    ...(authMiddleware ? [authMiddleware] : []),
    mcpJsonParser,
    async (req: Request, res: Response) => handler(req, res),
  ];

  // --- Legacy SSE transport (GET /sse + POST /messages) — deprecated ---

  app.get(
    '/sse',
    ...withAuth(async (req: Request, res: Response) => {
      log('Legacy SSE transport is deprecated; prefer Streamable HTTP at /mcp');
      const transport = new SSEServerTransport('/messages', res as unknown as ServerResponse);
      const server = createMcpServer(deps);

      const sessionId = transport.sessionId;
      legacySseSessions.set(sessionId, { transport, server });
      log(`SSE session connected: ${sessionId}`);

      transport.onclose = () => {
        legacySseSessions.delete(sessionId);
        log(`SSE session disconnected: ${sessionId}`);
      };

      try {
        await server.connect(transport);
      } catch (error) {
        legacySseSessions.delete(sessionId);
        logError(`Failed to connect SSE session ${sessionId}`, error);
      }
    })
  );

  app.post(
    '/messages',
    ...withAuth(async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      const session = legacySseSessions.get(sessionId);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      try {
        await session.transport.handlePostMessage(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      } catch (error) {
        logError(`Error handling message for session ${sessionId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    })
  );

  // --- Modern Streamable HTTP transport (ALL /mcp) ---

  const handleStreamableRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && streamableSessions.has(sessionId)) {
      // Existing session
      const session = streamableSessions.get(sessionId)!;
      try {
        await session.transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      } catch (error) {
        logError(`Error in streamable session ${sessionId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
      return;
    }

    // New session (initialization request)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        streamableSessions.set(newSessionId, { transport, server });
        log(`Streamable session initialized: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        streamableSessions.delete(sid);
        log(`Streamable session closed: ${sid}`);
      }
    };

    const server = createMcpServer(deps);

    try {
      await server.connect(transport);
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (error) {
      logError('Failed to initialize streamable session', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  app.get('/mcp', ...withAuth(handleStreamableRequest));
  app.post('/mcp', ...withAuth(handleStreamableRequest));
  app.delete('/mcp', ...withAuth(handleStreamableRequest));

  // --- Error handler (last) ---
  app.use(httpErrorHandler);

  const closeSessions = async () => {
    // Close all legacy SSE sessions
    for (const [id, session] of legacySseSessions) {
      try {
        await session.server.close();
      } catch (error) {
        logError(`Error closing SSE session ${id}`, error);
      }
    }
    legacySseSessions.clear();

    // Close all streamable sessions
    for (const [id, session] of streamableSessions) {
      try {
        await session.server.close();
      } catch (error) {
        logError(`Error closing streamable session ${id}`, error);
      }
    }
    streamableSessions.clear();
  };

  return { app, authEnabled, corsConfig, closeSessions };
}

/**
 * Create and start the HTTP server with Streamable HTTP + legacy SSE transports.
 */
export async function createHttpServer(
  config: HttpServerConfig,
  deps: ToolRegistrationDeps
): Promise<void> {
  const { app, authEnabled, corsConfig, closeSessions } = createHttpApp(config, deps);

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
      log('  POST /authorize                                       - Authorization');
      log('  POST /token                                           - Token exchange');
    } else {
      logError(
        'WARNING: Auth is DISABLED (MCP_DANGEROUSLY_DISABLE_AUTH) - server is open to anyone!'
      );
    }

    log('MCP Endpoints:');
    log('  GET  /health   - Health check (no auth)');
    log('  ALL  /mcp      - Streamable HTTP (primary)');
    log('  GET  /sse      - Legacy SSE stream (deprecated)');
    log('  POST /messages - Legacy SSE messages (deprecated)');
  });

  // --- Graceful shutdown ---

  const shutdown = async () => {
    log('Shutting down HTTP server...');

    await closeSessions();

    httpServer.close(() => {
      log('HTTP server stopped');
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
  };

  (process as NodeJS.Process).on('SIGTERM', shutdown);
  (process as NodeJS.Process).on('SIGINT', shutdown);
}
