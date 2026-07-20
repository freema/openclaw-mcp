/**
 * OAuth 2.1 Authorization Server endpoints.
 *
 * Replaces SDK v1's `mcpAuthRouter` (removed in SDK v2, which is
 * resource-server-only). Implements:
 *
 *   GET  /.well-known/oauth-authorization-server  - RFC 8414 AS metadata
 *   GET  /authorize                               - authorization code + PKCE (auto-approve)
 *   POST /token                                   - code exchange + refresh rotation
 *   POST /revoke                                  - RFC 7009 revocation
 *   POST /register                                - RFC 7591 DCR (opt-in only)
 *
 * All state lives in OpenClawAuthProvider (src/auth/provider.ts).
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, json, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';

import type { OpenClawAuthProvider, AuthorizationParams } from './provider.js';
import { logError } from '../utils/logger.js';

export interface AuthRouterOptions {
  provider: OpenClawAuthProvider;
  issuerUrl: URL;
  scopesSupported?: string[];
}

const ERROR_STATUS: Record<string, number> = {
  [OAuthErrorCode.InvalidClient]: 401,
  [OAuthErrorCode.InvalidToken]: 401,
  [OAuthErrorCode.InsufficientScope]: 403,
  [OAuthErrorCode.MethodNotAllowed]: 405,
  [OAuthErrorCode.ServerError]: 500,
  [OAuthErrorCode.TemporarilyUnavailable]: 503,
};

function sendOAuthError(res: Response, error: unknown): void {
  if (error instanceof OAuthError) {
    const status = ERROR_STATUS[error.code] ?? 400;
    res.status(status).json(error.toResponseObject());
    return;
  }
  logError('OAuth endpoint error', error);
  res
    .status(500)
    .json(new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error').toResponseObject());
}

function timingSafeStringEqual(a: string, b: string): boolean {
  // Hash both sides to fixed length so timingSafeEqual accepts them and
  // length differences leak nothing.
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return timingSafeStringEqual(computed, codeChallenge);
}

/** RFC 7636 §4.1: 43-128 characters from the unreserved set. */
export function isValidPkceValue(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseResource(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Invalid resource parameter');
  }
}

/**
 * Authenticate the client on token/revocation endpoints:
 * client_secret_post, client_secret_basic, or `none` (public clients — PKCE
 * is the gate for those).
 */
function authenticateClient(
  provider: OpenClawAuthProvider,
  req: Request
): OAuthClientInformationFull {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let clientId = firstString(body.client_id);
  let clientSecret = firstString(body.client_secret);

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    // RFC 6749 §2.3.1 encodes both halves as application/x-www-form-urlencoded,
    // where `+` means space — decodeURIComponent alone would mangle that.
    const formDecode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    let decoded: string;
    try {
      decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidClient, 'Malformed Basic authorization header');
    }
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      // Falling through to body credentials here would make the credential
      // source ambiguous; a malformed header is an error.
      throw new OAuthError(OAuthErrorCode.InvalidClient, 'Malformed Basic authorization header');
    }
    try {
      clientId = formDecode(decoded.slice(0, separator));
      clientSecret = formDecode(decoded.slice(separator + 1));
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidClient, 'Malformed Basic authorization header');
    }
  }

  if (!clientId) {
    throw new OAuthError(OAuthErrorCode.InvalidClient, 'Missing client_id');
  }

  const client = provider.clientsStore.getClient(clientId);
  if (!client) {
    throw new OAuthError(OAuthErrorCode.InvalidClient, 'Unknown client');
  }

  if (client.client_secret) {
    if (!clientSecret || !timingSafeStringEqual(client.client_secret, clientSecret)) {
      throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client credentials');
    }
  }

  return client;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Schemes we are willing to redirect a live authorization code to.
 *
 * The allow-any fallback (no MCP_REDIRECT_URIS) still must not turn the
 * server into a redirect gadget for `javascript:` / `data:` / `file:` URIs,
 * nor hand codes to plaintext HTTP outside loopback.
 */
export function isSafeRedirectScheme(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return false;
}

function isRedirectUriAllowed(client: OAuthClientInformationFull, redirectUri: string): boolean {
  const uris = client.redirect_uris;
  if (!uris) return false;
  if (uris.some((registered) => registered === redirectUri)) return true;

  // RFC 8252 §7.3: native clients use an ephemeral loopback port, so the port
  // is ignored when everything else about a registered loopback URI matches.
  let requested: URL;
  try {
    requested = new URL(redirectUri);
  } catch {
    return false;
  }
  if (!isLoopbackHost(requested.hostname)) return false;

  return uris.some((registered) => {
    try {
      const candidate = new URL(registered);
      return (
        isLoopbackHost(candidate.hostname) &&
        candidate.protocol === requested.protocol &&
        candidate.hostname === requested.hostname &&
        candidate.pathname === requested.pathname
      );
    } catch {
      return false;
    }
  });
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { provider, issuerUrl } = options;
  const scopesSupported = options.scopesSupported ?? ['mcp:tools'];
  const issuer = issuerUrl.toString().replace(/\/$/, '');
  const router = Router();

  // One limiter instance per endpoint. Sharing a single instance would let an
  // unauthenticated flood of /authorize requests exhaust the budget for
  // /token and /revoke, denying service to a legitimate client.
  const makeLimiter = (limit: number) =>
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
    });
  const authorizeLimiter = makeLimiter(100);
  const tokenLimiter = makeLimiter(100);
  const revokeLimiter = makeLimiter(100);
  const registerLimiter = makeLimiter(20);

  // --- RFC 8414 Authorization Server metadata ---
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const metadata: Record<string, unknown> = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes_supported: scopesSupported,
    };
    if (provider.clientsStore.allowDynamicRegistration) {
      metadata.registration_endpoint = `${issuer}/register`;
    }
    res.json(metadata);
  });

  // --- Authorization endpoint (auto-approve) ---
  router.get('/authorize', authorizeLimiter, (req, res) => {
    try {
      const clientId = firstString(req.query.client_id);
      if (!clientId) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing client_id');
      }
      const client = provider.clientsStore.getClient(clientId);
      if (!client) {
        throw new OAuthError(OAuthErrorCode.InvalidClient, 'Unknown client');
      }

      const redirectUri = firstString(req.query.redirect_uri);
      if (!redirectUri) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing redirect_uri');
      }
      let parsedRedirect: URL;
      try {
        // Must be an absolute URI before we agree to redirect anywhere.
        parsedRedirect = new URL(redirectUri);
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Invalid redirect_uri');
      }
      if (!isSafeRedirectScheme(parsedRedirect)) {
        throw new OAuthError(
          OAuthErrorCode.InvalidRequest,
          'redirect_uri must use https, or http on loopback'
        );
      }
      if (!isRedirectUriAllowed(client, redirectUri)) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Unregistered redirect_uri');
      }

      // From here on, errors are delivered via redirect (RFC 6749 §4.1.2.1)
      // because the redirect_uri has been validated against the client.
      const redirectError = (code: string, description: string) => {
        const url = new URL(redirectUri);
        url.searchParams.set('error', code);
        url.searchParams.set('error_description', description);
        const state = firstString(req.query.state);
        if (state !== undefined) url.searchParams.set('state', state);
        res.redirect(url.toString());
      };

      const responseType = firstString(req.query.response_type);
      if (responseType !== 'code') {
        redirectError(OAuthErrorCode.UnsupportedResponseType, 'response_type must be "code"');
        return;
      }

      const codeChallenge = firstString(req.query.code_challenge);
      if (!codeChallenge) {
        redirectError(OAuthErrorCode.InvalidRequest, 'code_challenge is required (PKCE)');
        return;
      }
      if (!isValidPkceValue(codeChallenge)) {
        redirectError(
          OAuthErrorCode.InvalidRequest,
          'code_challenge must be 43-128 characters (RFC 7636)'
        );
        return;
      }
      const challengeMethod = firstString(req.query.code_challenge_method) ?? 'S256';
      if (challengeMethod !== 'S256') {
        redirectError(OAuthErrorCode.InvalidRequest, 'code_challenge_method must be S256');
        return;
      }

      let resource: URL | undefined;
      try {
        resource = parseResource(firstString(req.query.resource));
      } catch {
        redirectError(OAuthErrorCode.InvalidRequest, 'Invalid resource parameter');
        return;
      }

      // Only scopes this server actually advertises may be granted; otherwise
      // a token can carry arbitrary claims that later scope checks would trust.
      const requestedScopes = firstString(req.query.scope)?.split(' ').filter(Boolean);
      if (requestedScopes) {
        const unknown = requestedScopes.filter((scope) => !scopesSupported.includes(scope));
        if (unknown.length > 0) {
          redirectError(OAuthErrorCode.InvalidScope, `Unsupported scope: ${unknown.join(' ')}`);
          return;
        }
      }

      const params: AuthorizationParams = {
        redirectUri,
        codeChallenge,
        state: firstString(req.query.state),
        // Clients that omit `scope` get the full supported set, so the
        // resource server can require a scope without breaking them.
        scopes: requestedScopes ?? [...scopesSupported],
        resource,
      };

      res.redirect(provider.authorize(client, params));
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  // --- Token endpoint ---
  router.post('/token', tokenLimiter, urlencoded({ extended: false }), (req, res) => {
    try {
      const client = authenticateClient(provider, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = firstString(body.grant_type);
      const resource = parseResource(firstString(body.resource));

      if (grantType === 'authorization_code') {
        const code = firstString(body.code);
        if (!code) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing code');
        }
        const codeVerifier = firstString(body.code_verifier);
        if (!codeVerifier) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing code_verifier (PKCE)');
        }
        if (!isValidPkceValue(codeVerifier)) {
          provider.invalidateAuthorizationCode(code);
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            'code_verifier must be 43-128 characters (RFC 7636)'
          );
        }

        // RFC 6749 §4.1.3: redirect_uri must be repeated and identical.
        const grant = provider.getAuthorizationGrant(client, code);
        const presentedRedirectUri = firstString(body.redirect_uri);
        if (presentedRedirectUri !== grant.redirectUri) {
          // A mismatch means the code is being redeemed for a different
          // callback than it was issued for — treat it as compromised.
          provider.invalidateAuthorizationCode(code);
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            'redirect_uri does not match the authorization request'
          );
        }

        if (!verifyPkce(codeVerifier, grant.codeChallenge)) {
          // OAuth 2.1: a failed PKCE check is the signature of a stolen or
          // injected code. Burn it instead of allowing unlimited retries.
          provider.invalidateAuthorizationCode(code);
          throw new OAuthError(OAuthErrorCode.InvalidGrant, 'PKCE verification failed');
        }

        res.json(provider.exchangeAuthorizationCode(client, code, resource));
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = firstString(body.refresh_token);
        if (!refreshToken) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing refresh_token');
        }
        const scopes = firstString(body.scope)?.split(' ').filter(Boolean);
        res.json(provider.exchangeRefreshToken(client, refreshToken, scopes, resource));
        return;
      }

      throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, 'Unsupported grant_type');
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  // --- RFC 7009 revocation ---
  router.post('/revoke', revokeLimiter, urlencoded({ extended: false }), (req, res) => {
    try {
      const client = authenticateClient(provider, req);
      const token = firstString((req.body as Record<string, unknown>)?.token);
      if (!token) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing token');
      }
      provider.revokeToken(client, { token });
      // RFC 7009: 200 even when the token was unknown
      res.status(200).json({});
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  // --- RFC 7591 dynamic client registration (opt-in) ---
  if (provider.clientsStore.allowDynamicRegistration) {
    router.post('/register', registerLimiter, json(), (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const redirectUris = body.redirect_uris;
        if (
          !Array.isArray(redirectUris) ||
          redirectUris.length === 0 ||
          !redirectUris.every((uri) => typeof uri === 'string')
        ) {
          throw new OAuthError(
            OAuthErrorCode.InvalidRequest,
            'redirect_uris must be a non-empty array of strings'
          );
        }
        for (const uri of redirectUris as string[]) {
          let parsed: URL;
          try {
            parsed = new URL(uri);
          } catch {
            throw new OAuthError(OAuthErrorCode.InvalidRequest, `Invalid redirect_uri: ${uri}`);
          }
          // A stored javascript:/data: URI would make /authorize a persistent
          // redirect gadget on this server's own origin.
          if (!isSafeRedirectScheme(parsed)) {
            throw new OAuthError(
              OAuthErrorCode.InvalidRequest,
              `redirect_uri must use https, or http on loopback: ${uri}`
            );
          }
        }

        const authMethod = firstString(body.token_endpoint_auth_method) ?? 'client_secret_post';
        const isPublic = authMethod === 'none';

        const client: OAuthClientInformationFull = {
          client_id: randomUUID(),
          redirect_uris: redirectUris as string[],
          token_endpoint_auth_method: authMethod,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: firstString(body.client_name) ?? 'Dynamically Registered Client',
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        if (!isPublic) {
          client.client_secret = randomUUID() + randomUUID();
        }

        res.status(201).json(provider.clientsStore.registerClient(client));
      } catch (error) {
        sendOAuthError(res, error);
      }
    });
  }

  return router;
}
