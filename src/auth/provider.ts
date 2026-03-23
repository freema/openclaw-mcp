/**
 * MCP OAuth Server Provider for OpenClaw
 *
 * Implements OAuthServerProvider from the MCP SDK to provide
 * a full OAuth 2.1 flow (authorization code + PKCE) that
 * Claude.ai and MCP Inspector can use to authenticate.
 *
 * Pre-configured client credentials come from MCP_CLIENT_ID + MCP_CLIENT_SECRET
 * env vars. Dynamic client registration is disabled — only the pre-configured
 * client can authenticate. The pre-configured client accepts any redirect_uri
 * (it's added to the allowlist on first use by the SDK authorize handler).
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

// --- Configuration ---

export interface AuthProviderConfig {
  /** Pre-configured client ID (from MCP_CLIENT_ID) */
  clientId?: string;
  /** Pre-configured client secret (from MCP_CLIENT_SECRET) */
  clientSecret?: string;
  /** Allowed redirect URIs. When empty/undefined, any redirect_uri is accepted (with a warning). */
  redirectUris?: string[];
}

// --- Clients Store ---

interface CodeData {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface TokenData {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOKENS_PER_CLIENT = 100;
const MAX_AUTH_CODES = 50;

// An array that says "yes" to any .includes() check.
// The SDK authorize handler validates redirect_uri against client.redirect_uris.includes().
// For the pre-configured client we accept any redirect_uri since the real auth
// gate is the client_secret (verified during token exchange).
const ALLOW_ANY_REDIRECT: string[] = new Proxy([] as string[], {
  get(target, prop) {
    if (prop === 'includes') return () => true;
    if (prop === 'length') return 1; // SDK checks length === 1 when redirect_uri is omitted
    return Reflect.get(target, prop);
  },
});

/**
 * In-memory clients store. Only the pre-configured client from env vars is allowed.
 * Dynamic client registration is intentionally disabled to prevent unauthorized access.
 */
export class OpenClawClientsStore implements OAuthRegisteredClientsStore {
  private client: OAuthClientInformationFull | undefined;

  constructor(config: AuthProviderConfig) {
    if (config.clientId && config.clientSecret) {
      const redirectUris: string[] =
        config.redirectUris && config.redirectUris.length > 0
          ? config.redirectUris
          : ALLOW_ANY_REDIRECT;

      this.client = {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'OpenClaw MCP Client',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
    }
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (this.client && this.client.client_id === clientId) {
      return this.client;
    }
    return undefined;
  }

  // No registerClient — dynamic client registration is intentionally disabled.
  // Only the pre-configured client from MCP_CLIENT_ID + MCP_CLIENT_SECRET can authenticate.
  // This prevents anyone who knows the server URL from self-registering and bypassing auth.
}

// --- Auth Provider ---

/**
 * OAuth server provider for OpenClaw MCP.
 *
 * Auto-approves authorization requests (no consent screen) since this
 * is a single-purpose MCP server where the user already controls credentials.
 */
export class OpenClawAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OpenClawClientsStore;

  private codes = new Map<string, CodeData>();
  private tokens = new Map<string, TokenData>();
  private refreshTokens = new Map<
    string,
    { clientId: string; scopes: string[]; expiresAt: number; resource?: URL }
  >();
  private reaperInterval: ReturnType<typeof setInterval> | undefined;

  constructor(config: AuthProviderConfig) {
    this.clientsStore = new OpenClawClientsStore(config);
    this.reaperInterval = setInterval(() => this.reapExpired(), REAPER_INTERVAL_MS);
    // Allow process to exit without waiting for the reaper
    if (this.reaperInterval.unref) {
      this.reaperInterval.unref();
    }
  }

  /**
   * Clean up expired auth codes, access tokens, and refresh tokens.
   */
  reapExpired(): void {
    const now = Date.now();

    for (const [code, data] of this.codes) {
      if (now - data.createdAt > AUTH_CODE_TTL_MS) {
        this.codes.delete(code);
      }
    }

    for (const [token, data] of this.tokens) {
      if (data.expiresAt < now) {
        this.tokens.delete(token);
      }
    }

    for (const [token, data] of this.refreshTokens) {
      if (data.expiresAt < now) {
        this.refreshTokens.delete(token);
      }
    }
  }

  /**
   * Auto-approve: generate auth code and redirect immediately.
   */
  /**
   * Count active tokens for a given client ID.
   */
  private countTokensForClient(clientId: string): number {
    let count = 0;
    for (const data of this.tokens.values()) {
      if (data.clientId === clientId) count++;
    }
    for (const data of this.refreshTokens.values()) {
      if (data.clientId === clientId) count++;
    }
    return count;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Enforce auth code limit to prevent memory exhaustion
    if (this.codes.size >= MAX_AUTH_CODES) {
      this.reapExpired();
      if (this.codes.size >= MAX_AUTH_CODES) {
        throw new InvalidRequestError('Too many pending authorization requests. Try again later.');
      }
    }

    const code = randomUUID();

    this.codes.set(code, { client, params, createdAt: Date.now() });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new InvalidRequestError('Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new InvalidRequestError('Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new InvalidRequestError('Authorization code was not issued to this client');
    }

    this.codes.delete(authorizationCode);

    // Enforce per-client token limit
    if (this.countTokensForClient(client.client_id) >= MAX_TOKENS_PER_CLIENT) {
      this.reapExpired();
      if (this.countTokensForClient(client.client_id) >= MAX_TOKENS_PER_CLIENT) {
        throw new InvalidRequestError(
          'Token limit reached for this client. Revoke existing tokens or wait for expiry.'
        );
      }
    }

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const scopes = codeData.params.scopes || [];

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      resource: resource || codeData.params.resource,
    });

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: resource || codeData.params.resource,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data || data.expiresAt < Date.now()) {
      if (data) this.refreshTokens.delete(refreshToken);
      throw new InvalidRequestError('Invalid refresh token');
    }

    if (data.clientId !== client.client_id) {
      throw new InvalidRequestError('Refresh token was not issued to this client');
    }

    // Revoke old refresh token (rotation)
    this.refreshTokens.delete(refreshToken);

    const accessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const tokenScopes = scopes || data.scopes;

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: tokenScopes,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      resource: resource || data.resource,
    });

    this.refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: tokenScopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: resource || data.resource,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_MS / 1000,
      refresh_token: newRefreshToken,
      scope: tokenScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new InvalidTokenError('Invalid or expired token');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }
}
