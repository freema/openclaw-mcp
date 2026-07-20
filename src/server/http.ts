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
 * - CORS support
 * - Health check endpoint
 * - Graceful shutdown
 *
 * The legacy HTTP+SSE transport (GET /sse + POST /messages) was removed in
 * v2.0 — those endpoints now answer 410 Gone with a migration hint.
 */

import type { Server as HttpServer } from 'node:http';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { requireBearerAuth } from '@modelcontextprotocol/express';

import { OpenClawAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { createAuthRouter } from '../auth/router.js';
import { log, logError } from '../utils/logger.js';
import { createMcpServer, type ToolRegistrationDeps } from './mcp-server.js';

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

// --- CORS helpers ---

/**
 * Load CORS configuration from environment
 */
export function loadCorsConfig(): { origins: string[]; enabled: boolean } {
  const corsOrigins = process.env.CORS_ORIGINS;

  if (!corsOrigins || corsOrigins === '*') {
    return { origins: ['*'], enabled: true };
  }

  if (corsOrigins.toLowerCase() === 'none' || corsOrigins === '') {
    return { origins: [], enabled: false };
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

// --- Main server factory ---

/**
 * Create and start the HTTP server with the stateless Streamable HTTP transport.
 */
export async function createHttpServer(
  config: HttpServerConfig,
  deps: ToolRegistrationDeps
): Promise<void> {
  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  const app = express();
  // Express 5 exposes query params via the extended parser by default; the
  // simple parser keeps values as plain strings, matching our validation.
  app.set('query parser', 'simple');

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
    app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
      res.json({
        resource: `${issuerUrl.toString()}${req.params.path}`,
        authorization_servers: [issuerUrl.toString().replace(/\/$/, '')],
        scopes_supported: ['mcp:tools'],
      });
    });

    // Bearer auth middleware for protected routes (sets req.auth, which
    // toNodeHandler forwards to the MCP handler as authInfo).
    authMiddleware = requireBearerAuth({ verifier: provider });
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

  const mcpHandler = createMcpHandler(() => createMcpServer(deps), {
    legacy: 'stateless',
    onerror: (error) => logError('MCP handler error', error),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => logError('MCP transport error', error),
  });

  const mcpRoute = (req: Request, res: Response) => {
    void nodeHandler(req, res);
  };

  if (authMiddleware) {
    app.all('/mcp', authMiddleware, mcpRoute);
  } else {
    app.all('/mcp', mcpRoute);
  }

  // --- Legacy SSE transport: removed in v2.0 ---
  const legacyGone = (_req: Request, res: Response) => {
    res.status(410).json({
      error:
        'The HTTP+SSE transport was removed in openclaw-mcp 2.0. Connect via /mcp (Streamable HTTP).',
    });
  };
  app.get('/sse', legacyGone);
  app.post('/messages', legacyGone);

  // --- Start server ---

  const httpServer: HttpServer = app.listen(config.port, config.host, () => {
    log(`HTTP server listening on ${config.host}:${config.port}`);
    log(`Auth enabled: ${authEnabled}`);
    log(`CORS origins: ${corsConfig.enabled ? corsConfig.origins.join(', ') : 'disabled'}`);

    if (authEnabled) {
      log('OAuth 2.1 authentication is REQUIRED for all connections');
      log('Endpoints:');
      log('  GET  /.well-known/oauth-authorization-server          - OAuth metadata');
      log('  GET  /.well-known/oauth-protected-resource/mcp        - Protected resource metadata');
      log('  GET  /authorize                                       - Authorization');
      log('  POST /token                                           - Token exchange');
    } else {
      log('WARNING: Auth is DISABLED - server is open to anyone!');
    }

    log('MCP Endpoints:');
    log('  GET  /health   - Health check (no auth)');
    log('  ALL  /mcp      - Streamable HTTP (stateless)');
  });

  // --- Graceful shutdown ---

  const shutdown = async () => {
    log('Shutting down HTTP server...');

    try {
      await mcpHandler.close();
    } catch (error) {
      logError('Error closing MCP handler', error);
    }

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
