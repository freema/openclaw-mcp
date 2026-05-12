# Security Policy

## 🔐 Security Considerations

OpenClaw MCP Bridge provides access to your AI assistant. **Proper security is critical.**

### Threat Model

| Threat | Risk | Mitigation |
|--------|------|------------|
| Unauthorized access | High | OAuth2 authentication, API keys |
| Token theft | High | Short-lived tokens, HTTPS only |
| Man-in-the-middle | High | TLS 1.3, certificate validation |
| Denial of service | Medium | Rate limiting, request size limits |
| Information disclosure | Medium | Audit logging, minimal error details |

### Security Checklist

#### ✅ Required for Production

- [ ] Enable OAuth authentication (`OAUTH_ENABLED=true`)
- [ ] Use HTTPS (deploy behind reverse proxy with TLS)
- [ ] Set strong API keys or configure OAuth provider
- [ ] Restrict network access (firewall rules)
- [ ] Keep dependencies updated

#### ✅ Recommended

- [ ] Use short-lived OAuth tokens (15-60 minutes)
- [ ] Enable audit logging
- [ ] Set up rate limiting
- [ ] Configure CORS restrictions
- [ ] Monitor for suspicious activity
- [ ] Regular security audits

### Authentication Methods

#### 1. OAuth2 Token Introspection (Recommended)

Best for enterprise deployments with existing identity providers:

```bash
OAUTH_ENABLED=true
OAUTH_INTROSPECTION_ENDPOINT=https://auth.company.com/oauth2/introspect
OAUTH_CLIENT_ID=openclaw-mcp
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_REQUIRED_SCOPES=openclaw:read,openclaw:write
```

Supported providers:
- Auth0
- Keycloak
- Okta
- Azure AD
- Any OAuth2-compliant provider

#### 2. Static API Keys (Simple)

For personal or small team deployments:

```bash
OAUTH_ENABLED=true
API_KEYS=key-abc123,key-def456
```

Generate secure keys:
```bash
openssl rand -hex 32
```

### Network Security

#### Reverse Proxy Configuration (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.3;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/s;
    limit_req zone=mcp burst=20 nodelay;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Reporting Vulnerabilities

If you discover a security vulnerability, please **do not** open a public issue.

Instead, report it privately via GitHub Security Advisories:

👉 **[Report a vulnerability](https://github.com/freema/openclaw-mcp/security/advisories/new)**

When reporting, please include:

1. A clear description of the issue
2. Steps to reproduce
3. Impact assessment (if known)
4. Suggested fix (optional)

We will acknowledge receipt within 72 hours and aim to release a fix as soon as
possible. Please allow up to 90 days for a fix before public disclosure.

### Security Updates

We release security patches as soon as possible. Keep your installation updated:

```bash
npm update -g openclaw-mcp
```

Subscribe to security advisories on GitHub.
