# Changelog

Notable changes to openclaw-mcp. Versions follow [Semantic Versioning](https://semver.org/).
This is the changelog of the 2.0 line (branch `v2`, npm dist-tag `beta`); the
stable 1.x line lives on `main`. Releases before 1.8.1 are described in the
[GitHub releases](https://github.com/freema/openclaw-mcp/releases) and in the
"Upgrading" sections of the [README](README.md#security).

## 2.0.0-beta.2 — 2026-11-06

Security release of the 2.0 line. **2.0.0-beta.1 should not be used**: it was
cut before the 1.7.0, 1.8.0 and 1.8.1 security releases and has none of their
fixes. In beta.1 the HTTP transport runs without authentication unless
`AUTH_ENABLED=true` is set and sends `Access-Control-Allow-Origin: *` by
default ([GHSA-f99f-69fc-572v](https://github.com/freema/openclaw-mcp/security/advisories/GHSA-f99f-69fc-572v),
[GHSA-xp77-pwm3-v4qr](https://github.com/freema/openclaw-mcp/security/advisories/GHSA-xp77-pwm3-v4qr)),
and async tasks have sequential IDs and no ownership checks, so any caller can
read, list and cancel any other caller's tasks (the 1.x issue of
[GHSA-j2fg-4r2j-424f](https://github.com/freema/openclaw-mcp/security/advisories/GHSA-j2fg-4r2j-424f) /
[GHSA-c4qg-mg2r-2c56](https://github.com/freema/openclaw-mcp/security/advisories/GHSA-c4qg-mg2r-2c56)).
This release merges `main` at 1.8.1 into the 2.0 branch; everything listed
under 1.7.0, 1.8.0 and 1.8.1 now holds here too, with the differences below.

### Security

- **OAuth is mandatory for the HTTP transport.** Without `MCP_CLIENT_ID` and
  `MCP_CLIENT_SECRET` the server refuses to start; `AUTH_ENABLED=false` /
  `--no-auth` refuses to start instead of disabling auth. The only way to run
  HTTP without authentication is `MCP_DANGEROUSLY_DISABLE_AUTH=true`
  (`--dangerously-disable-auth`). stdio is unchanged. (From 1.8.0.)
- **Async tasks are owned by the OAuth client.** `openclaw_task_status`,
  `openclaw_task_list` (including its stats) and `openclaw_task_cancel` only
  see tasks created by the same OAuth client; another client's task ID is
  answered exactly like an unknown one, and task IDs are random UUIDs. The
  stateless transport has no per-connection identity, so the owner is derived
  from the request's validated access token on every call — a client can
  poll its tasks across requests, tokens and protocol eras. Dynamically
  registered clients are separate owners. Without an authenticated client
  (stdio, or HTTP with `MCP_DANGEROUSLY_DISABLE_AUTH`) all tasks of the
  process share one owner; 1.x scoped them to the connection, which does not
  exist here. With auth enabled, a tool call that somehow carries no client
  identity is refused rather than pooled. (From 1.7.0 / 1.8.0.)
- **CORS is off unless `CORS_ORIGINS` opts in.** (From 1.7.0; beta.1 still
  defaulted to `*`.)
- **`ALLOWED_HOSTS`** extends DNS-rebinding protection (Host and Origin
  validation) for a loopback bind behind a reverse proxy that preserves the
  public `Host` header, and turns validation on for non-loopback binds.
  (From 1.8.0.)
- **Request body limits.** `POST /mcp` accepts at most 4 MiB
  (`MAX_REQUEST_BODY_BYTES`), parsed only after the bearer token has been
  verified; the SDK's Node adapter applies the same cap to bodies the JSON
  parser skips. The OAuth endpoints accept at most 100 kB. No other route
  reads a request body, and there is no app-wide body parser. (From 1.8.1.)
- **JSON error responses.** Oversized and malformed bodies get a short JSON
  error — JSON-RPC shaped on `/mcp`, OAuth shaped elsewhere — instead of
  Express' HTML page with a stack trace. (From 1.8.1.)
- MCP SDK v2 floors raised to the patched releases:
  `@modelcontextprotocol/server` `^2.4.0` (GHSA-f897-62hf-6gxq,
  GHSA-46jr-4wx8-v453), `@modelcontextprotocol/node` `^2.1.2`
  (GHSA-f897-62hf-6gxq), `@modelcontextprotocol/express` `^2.0.2`.
  Transitive production dependencies match 1.8.1; `npm audit --omit=dev`
  reports no vulnerabilities.
- `docker-compose.yml` publishes the port on `127.0.0.1` only
  (`BIND_ADDRESS` to override), drops all capabilities and passes
  `OPENCLAW_AGENT_ID`, `MCP_REDIRECT_URIS` and `TRUST_PROXY` through; the
  image is built on `node:24-slim`. (From 1.8.1.)

### Changed

- `/token` and `/revoke` accept JSON bodies in addition to
  `application/x-www-form-urlencoded`, as 1.x did; beta.1 only accepted form
  encoding.
- Release automation: the npm publish authenticates through GitHub OIDC
  trusted publishing (no token), checks that the tag matches `package.json`
  and runs the test suite; prereleases keep going to the `beta` dist-tag, get
  no `latest` Docker tag, are marked prerelease and never "Latest" on GitHub,
  and are refused by the MCP Registry workflow however it is started.
- CI runs for pushes and pull requests to the `v2` branch; the matrix tests
  Node.js 20, 22 and 24; vitest 4 and typescript-eslint 8 as on `main`.

### Documentation

- README, SECURITY.md, threat model, configuration and deployment docs carry
  the 1.8.x content (least-privilege agent, loopback port, mandatory OAuth),
  adjusted for 2.0: no `/messages`, own OAuth server, task ownership without
  auth, and a note on which 2.0 versions are safe to run.

## 2.0.0-beta.1 — 2026-07-20

First beta of the 2.0 line, targeting the [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) on MCP SDK v2.

### Breaking changes

- **Legacy HTTP+SSE transport removed.** `--transport sse` exits with an error; `GET /sse` and `POST /messages` answer `410 Gone`. Use `--transport http` (Streamable HTTP at `/mcp`). Claude.ai and Claude Desktop already use `/mcp` and need no change.
- **Stateless server.** Per-connection sessions are gone — any instance can serve any request, so the server runs behind a plain round-robin load balancer without sticky routing. Clients still speaking the 2025-11-25 protocol are served through the SDK's stateless legacy path.
- **`@modelcontextprotocol/sdk` replaced** by `@modelcontextprotocol/server`, `/node` and `/express`. SDK v2 is resource-server-only, so the OAuth authorization server is now implemented in this repo (`src/auth/router.ts`).
- Tool results carry `resultType: "complete"` per the new specification.

### Added

- **Streaming to the OpenClaw gateway.** Async tasks call `/v1/chat/completions` with `stream: true`. The request timeout became an *idle* timeout that resets on every chunk, so long gateway work is no longer killed at the 2-minute mark while a silent connection still aborts.
- **Live task progress.** `openclaw_task_status` reports `progress_chars` and `last_activity_at` for running tasks — the gateway proving it is still working. (Fixes [#31](https://github.com/freema/openclaw-mcp/issues/31).)
- **Concurrent task processing** via `OPENCLAW_TASK_CONCURRENCY` (default 3, max 20). Previously tasks ran strictly one at a time.
- **Cancelling running tasks.** `openclaw_task_cancel` now aborts the in-flight gateway request; previously only queued tasks could be cancelled.
- Tool input schemas are zod v4 (JSON Schema 2020-12) and carry read-only annotations.

### Changed

- `OpenClawClient.chat(message, options)` replaces `chat(message, sessionId)`.
- OAuth endpoints are served by our own router: PKCE S256 verification, timing-safe client authentication, refresh-token rotation, RFC 7009 revocation scoped to the issuing client, and per-endpoint rate limiting.
- Release automation keeps prereleases off stable channels: no `latest` Docker tag, npm publishes under the `beta` dist-tag, GitHub releases are marked prerelease, and the MCP registry entry is not replaced.

### Known limitations

- **Protocol-native Tasks are not adopted yet.** SDK v2 beta.4 ships only the task wire vocabulary with no runtime, so the custom `openclaw_chat_async` / `openclaw_task_*` tools remain. They will move to the `io.modelcontextprotocol/tasks` extension once the SDK supports it.
- Dynamic Client Registration is still the fallback registration mechanism; Client ID Metadata Documents are planned before 2.0.0 final.
- Depends on MCP SDK v2 **beta** packages. The final specification and SDK v2 stable are expected 2026-07-28; dependencies will be re-pinned then.

## 1.8.1 — 2026-11-06

Security and maintenance release. The MCP tool surface is unchanged and no
configuration change is required, but read the first item if you deploy with
the `docker-compose.yml` from this repository.

### Changed

- **`docker-compose.yml` publishes the port on `127.0.0.1` only**
  (`${BIND_ADDRESS:-127.0.0.1}:${PORT:-3000}:3000`). The bridge speaks plain
  HTTP and is meant to sit behind a TLS-terminating reverse proxy; Docker
  publishes ports past host firewalls, so the old `3000:3000` exposed it on
  every interface. If your reverse proxy runs on another machine, set
  `BIND_ADDRESS=0.0.0.0` (or an interface address) and firewall the port.
  Compose files you maintain yourself and plain `docker run` are not affected.
- `docker-compose.yml` drops all Linux capabilities (`cap_drop: [ALL]`) and
  passes `OPENCLAW_AGENT_ID`, `MCP_REDIRECT_URIS` and `TRUST_PROXY` through to
  the container.
- The Docker image is built on `node:24-slim` (Node.js 20 is end-of-life). The
  npm package still supports Node.js ≥ 20; CI now tests on 20, 22 and 24.
- Request bodies on `POST /mcp` and `POST /messages` are limited to 4 MiB and
  are parsed only after the bearer token has been verified. Before, Express'
  implicit 100 kB limit applied ahead of authentication.
- The startup warning for an unset `MCP_REDIRECT_URIS` now says what to set.

### Fixed

- Messages within the documented 100,000-character limit were rejected with
  `413` when they were longer than 100 kB on the wire (non-ASCII text, many
  escaped characters).
- Oversized and malformed request bodies were answered with Express' HTML
  error page, which includes a stack trace with internal paths unless
  `NODE_ENV=production`. They now get a short JSON error (JSON-RPC shaped on
  the MCP endpoints, OAuth shaped on the OAuth endpoints).

### Security

- `@modelcontextprotocol/sdk` raised to `^1.32.2` (from `^1.29.0`). Relevant
  to the HTTP transport: GHSA-f897-62hf-6gxq (no request body size / JSON-RPC
  batch limit) and GHSA-46jr-4wx8-v453 (memory exhaustion during validation).
  The same bump clears GHSA-22jm-h49p-29qw (experimental SDK tasks) and
  GHSA-6qxp-vccf-f47h (SDK OAuth client), which concern code this server does
  not use. Raising the floor makes `npm install` pick the fixed SDK as well,
  not only the Docker image.
- Transitive production dependencies updated to patched versions: `proxy-addr`
  (GHSA-jqcg-44mw-7w3h), `hono`, `@hono/node-server`, `body-parser`,
  `fast-uri`, `ip-address`, `qs` and `zod`. `npm audit --omit=dev` reports no
  vulnerabilities.
- JSON-RPC batches are capped at 100 messages (enforced by the SDK).
- `express` is now a direct dependency (it was already installed through the
  SDK) so the HTTP app can set its own body limit.

### Documentation

- Recommend running the bridge against a dedicated least-privilege OpenClaw
  agent via `OPENCLAW_AGENT_ID`: prompt injection into an agent with shell
  access is the biggest real-world risk of this setup.
- `SECURITY.md` "Authentication" rewritten to describe what the server
  actually does. It previously documented token introspection and static API
  keys, neither of which exists.
- `docs/threat-model.md` corrected (no private-IP blocking, CORS default,
  timeouts) and extended with a prompt-injection section.
- Deployment docs state that a reverse proxy is expected and explain the
  loopback port binding.
