# Changelog

Notable changes to openclaw-mcp. Versions follow [Semantic Versioning](https://semver.org/).
2.0 is the current stable line (npm dist-tag `latest`,
`ghcr.io/freema/openclaw-mcp:latest`). The 1.x line ended with 1.8.1, listed
at the end; earlier releases are described in the
[GitHub releases](https://github.com/freema/openclaw-mcp/releases) and in the
"Upgrading" sections of the [README](README.md#security). The 2.0.0-beta
entries record how the 2.0 line got here.

## 2.0.0 — 2026-11-23

First stable release of the 2.0 line: MCP SDK v2, the
[MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/),
a stateless Streamable HTTP transport and streamed async tasks. The code is
2.0.0-beta.2, which carries every 1.8.1 security fix; only the version and
the documentation changed since. Tool names and inputs are the same as in
1.8.1, and Claude.ai / Claude Desktop need no change on their side.

### Summary of the 2.0 line

- **MCP SDK v2** (`@modelcontextprotocol/server`, `/node`, `/express`)
  replaces `@modelcontextprotocol/sdk`. Clients on the 2026-07-28 protocol get
  the new stateless protocol; clients still on 2025-11-25 (current Claude.ai
  and Claude Desktop) are served through the SDK's stateless legacy path.
- **Stateless Streamable HTTP at `/mcp`**, no per-connection sessions. The
  legacy HTTP+SSE transport is gone.
- **Streamed async tasks**: `openclaw_chat_async` streams from the gateway,
  `OPENCLAW_TIMEOUT_MS` becomes an idle timeout for it, `openclaw_task_status`
  reports live progress (`progress_chars`, `last_activity_at`), tasks run
  concurrently and running tasks can be cancelled. This addresses tasks that
  stayed "running" long after the gateway had finished
  ([#31](https://github.com/freema/openclaw-mcp/issues/31)).
- **Own OAuth 2.1 authorization server** (SDK v2 only provides the resource
  server): PKCE S256, timing-safe client authentication, refresh-token
  rotation, RFC 7009 revocation scoped to the issuing client, per-endpoint
  rate limits.
- **Security parity with 1.8.1**: mandatory OAuth for HTTP, async tasks owned
  by the OAuth client, CORS off by default, `ALLOWED_HOSTS`, 4 MiB body limit
  enforced after authentication, JSON error responses, loopback-only port in
  `docker-compose.yml`.
- zod v4 tool input schemas (JSON Schema 2020-12) with read-only annotations.

### Breaking changes (from 1.8.1)

- **`--transport sse` exits with an error** (in 1.x it was a deprecated alias
  for `http`). `GET /sse` and `POST /messages` answer `410 Gone`; `/health`
  reports `"legacySseSupported": false`. Use `--transport http` and `/mcp`.
- **No MCP sessions on HTTP.** The server no longer issues or tracks
  `Mcp-Session-Id`. Clients that depend on a stateful session must be
  updated; Claude.ai and Claude Desktop work unchanged.
- **Async tasks stream from the gateway.** `openclaw_chat_async` calls
  `/v1/chat/completions` with `stream: true` and needs a gateway (and any
  proxy in between) that answers with server-sent events. A gateway that
  ignores `stream` and returns plain JSON makes async tasks fail with
  "Gateway returned no streamed content". `openclaw_chat` still sends a plain
  request.
- **`OPENCLAW_TIMEOUT_MS` is an idle timeout for async tasks.** It resets on
  every received chunk, so a task that keeps streaming is no longer killed
  after 2 minutes; a streamed request is capped at 30 minutes overall. For
  `openclaw_chat` and `openclaw_status` it is still an absolute timeout.
- **Async tasks run in parallel**, 3 at a time by default
  (`OPENCLAW_TASK_CONCURRENCY`, 1–20). 1.x ran them one after another.
- **`openclaw_task_cancel` cancels running tasks** and aborts their gateway
  request; 1.x only cancelled pending tasks.
- **Task ownership without authentication.** With an OAuth client nothing
  changes: tasks belong to the client. Without one (stdio, or HTTP with
  `MCP_DANGEROUSLY_DISABLE_AUTH=true`) there is no connection to scope tasks
  to, so all tasks of the process share one owner; 1.x scoped them to the
  connection.
- **`TRUST_PROXY=true` refuses to start while OAuth is enabled**: it would
  make the client-controlled `X-Forwarded-For` entry the rate-limit key on the
  OAuth endpoints. Use the number of proxy hops (`TRUST_PROXY=1`) or the
  proxy's address range instead.
- **The OAuth authorization server is new code.** Endpoints and metadata
  paths are the same as in 1.x and the OAuth endpoints accept at most 100 kB.
  Tokens still live in memory, so the restart for the upgrade makes clients
  authorize again.
- Tool inputs are validated with zod v4 schemas; `priority` on
  `openclaw_chat_async` must be an integer.
- For code that imports the package instead of running it:
  `@modelcontextprotocol/sdk` is no longer a dependency, and
  `OpenClawClient.chat(message, options)` replaces `chat(message, sessionId)`.

### Upgrading from 1.x

1. Start from a working 1.8.1 configuration. 2.0 reads the same environment
   variables and CLI flags and applies the same mandatory-OAuth rules; see
   the 1.7.0 / 1.8.0 / 1.8.1 notes in the README if you skipped those.
2. Replace `--transport sse` with `--transport http` in CLI arguments and
   service units, and point any client still using `/sse` at `/mcp`. The
   Docker image already starts with `--transport http`; do not pass the flag
   again in `docker run` or a compose `command:`.
3. If you set `TRUST_PROXY=true`, change it to `TRUST_PROXY=1` (one reverse
   proxy) or the proxy's address range.
4. If you use the async tools, check that the gateway, and any proxy between
   it and the bridge, passes streamed (`text/event-stream`) responses from
   `/v1/chat/completions` through without buffering them.
5. Choose `OPENCLAW_TASK_CONCURRENCY`: the default 3, or `1` to keep the 1.x
   one-at-a-time behaviour if your agent cannot take parallel requests.
   `OPENCLAW_TIMEOUT_MS` can usually stay: for async tasks it now only has to
   cover the longest silence, not the whole answer.
6. Update with `npm install -g openclaw-mcp@latest` (or `npx openclaw-mcp@2`),
   or pull `ghcr.io/freema/openclaw-mcp:2.0.0`, and restart. Claude.ai and
   other clients authorize again after the restart.

`latest` on npm and GHCR moves to 2.0.0 with this release. To stay on 1.x for
now, pin `openclaw-mcp@1.8.1` / `ghcr.io/freema/openclaw-mcp:1.8.1`.

### Changed since 2.0.0-beta.2

- Version 2.0.0; npm `latest`, Docker `latest` and the MCP Registry entry move
  to the 2.0 line.
- Documentation describes 2.0 as the stable release: install commands without
  `@beta`, an "Upgrading to 2.0" section in the README, and a support table in
  SECURITY.md with 1.8.x as the previous line.
- Documentation no longer claims that several instances can sit behind a
  round-robin load balancer: the MCP protocol layer is stateless, but OAuth
  tokens and async tasks live in process memory, so run one instance or send
  each client to the same one.
- Not part of 2.0.0, moved to the roadmap: structured tool outputs, Client ID
  Metadata Documents, protocol-native Tasks (the SDK still ships no tasks
  runtime).

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
