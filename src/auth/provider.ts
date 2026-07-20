/**
 * OAuth 2.1 Authorization Server state for OpenClaw MCP.
 *
 * SDK v2 no longer ships an OAuth Authorization Server (only resource-server
 * token verification), so the AS lives here: this module owns clients, codes,
 * and tokens, while `src/auth/router.ts` exposes the HTTP endpoints.
 *
 * Pre-configured client credentials come from MCP_CLIENT_ID + MCP_CLIENT_SECRET
 * env vars. By default, dynamic client registration (DCR) is disabled — only
 * the pre-configured client can authenticate. Setting MCP_DANGEROUSLY_ALLOW_DCR=true
 * opts into DCR so clients like Cursor and Windsurf, which require DCR, can
 * connect. That mode is intended for local development only.
 *
 * The provider implements the SDK v2 `OAuthTokenVerifier` contract
 * (`verifyAccessToken`), so it plugs directly into `requireBearerAuth`.
 */

import { randomUUID } from 'node:crypto';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/server';

// --- Configuration ---

export interface AuthProviderConfig {
  /** Pre-configured client ID (from MCP_CLIENT_ID) */
  clientId?: string;
  /** Pre-configured client secret (from MCP_CLIENT_SECRET) */
  clientSecret?: string;
  /** Allowed redirect URIs. When empty/undefined, any redirect_uri is accepted (with a warning). */
  redirectUris?: string[];
  /**
   * Enable OAuth 2.0 Dynamic Client Registration (RFC 7591).
   * Required for clients like Cursor / Windsurf. Dev-only — auto-registered
   * clients combined with auto-approve mean anyone who can reach the server
   * can obtain a token.
   */
  allowDynamicRegistration?: boolean;
}

/** Parameters captured from a validated /authorize request. */
export interface AuthorizationParams {
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
  resource?: URL;
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

/**
 * An empty redirect-URI list that reports "registered" for any requested URI.
 *
 * For the pre-configured client we accept any redirect_uri since the real
 * auth gate is the client_secret (verified during token exchange).
 * The list stays empty (`length === 0`), so when a client omits redirect_uri
 * entirely the router reports a proper validation error instead of
 * redirecting to `undefined`.
 */
class AllowAnyRedirectUris extends Array<string> {
  override includes(_searchElement: string, _fromIndex?: number): boolean {
    return true;
  }

  override some(
    _predicate: (value: string, index: number, array: string[]) => unknown,
    _thisArg?: unknown
  ): boolean {
    return true;
  }
}

const ALLOW_ANY_REDIRECT: string[] = new AllowAnyRedirectUris();

/**
 * Cap on dynamically registered clients to avoid unbounded memory growth when
 * DCR is left enabled in a long-running dev session. FIFO eviction keeps the
 * store bounded; the router's per-IP rate limit is the first line of defense,
 * this cap is a backstop.
 */
const MAX_DYNAMIC_CLIENTS = 100;

export class OpenClawClientsStore {
  private client: OAuthClientInformationFull | undefined;
  private dynamicClients = new Map<string, OAuthClientInformationFull>();
  readonly allowDynamicRegistration: boolean;

  constructor(config: AuthProviderConfig) {
    this.allowDynamicRegistration = !!config.allowDynamicRegistration;

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

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (this.client && this.client.client_id === clientId) {
      return this.client;
    }
    return this.dynamicClients.get(clientId);
  }

  /** RFC 7591 dynamic registration. Throws unless DCR is enabled. */
  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    if (!this.allowDynamicRegistration) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Dynamic registration is disabled');
    }
    // FIFO eviction when the cap is reached. Map iteration order is
    // insertion order, so the first key is the oldest entry.
    if (this.dynamicClients.size >= MAX_DYNAMIC_CLIENTS) {
      const oldestKey = this.dynamicClients.keys().next().value;
      if (oldestKey !== undefined) {
        this.dynamicClients.delete(oldestKey);
      }
    }
    this.dynamicClients.set(client.client_id, client);
    return client;
  }
}

// --- Auth Provider ---

/**
 * OAuth authorization-server state for OpenClaw MCP.
 *
 * Auto-approves authorization requests (no consent screen) since this
 * is a single-purpose MCP server where the user already controls credentials.
 */
export class OpenClawAuthProvider {
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
   * Auto-approve: issue an auth code and return the redirect URL the
   * router should send the user-agent to.
   */
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const code = randomUUID();

    this.codes.set(code, { client, params, createdAt: Date.now() });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    return targetUrl.toString();
  }

  /** PKCE challenge recorded for a still-valid authorization code. */
  challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): string {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    resource?: URL
  ): OAuthTokens {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        'Authorization code was not issued to this client'
      );
    }

    this.codes.delete(authorizationCode);

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

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): OAuthTokens {
    const data = this.refreshTokens.get(refreshToken);
    if (!data || data.expiresAt < Date.now()) {
      if (data) this.refreshTokens.delete(refreshToken);
      throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid refresh token');
    }

    if (data.clientId !== client.client_id) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        'Refresh token was not issued to this client'
      );
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

  /** SDK v2 `OAuthTokenVerifier` contract — plugs into `requireBearerAuth`. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired token');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): void {
    // RFC 7009: the token is only revoked if it was issued to the requesting
    // client. Without this check, any authenticated client could revoke any
    // other client's tokens — which becomes exploitable once DCR lets strangers
    // obtain a valid client_id/secret pair.
    const tokenData = this.tokens.get(request.token);
    if (tokenData && tokenData.clientId === client.client_id) {
      this.tokens.delete(request.token);
    }

    const refreshData = this.refreshTokens.get(request.token);
    if (refreshData && refreshData.clientId === client.client_id) {
      this.refreshTokens.delete(request.token);
    }
  }
}
