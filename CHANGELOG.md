# Changelog

## 2.0.0-beta.1

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

## 1.6.0 and earlier

See the [GitHub releases](https://github.com/freema/openclaw-mcp/releases).
