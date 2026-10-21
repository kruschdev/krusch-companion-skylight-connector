# In-Flight Work Tracker: Krusch Companion Skylight Connector

> **Current Phase**: V0.3.0 Universal Multi-Agent & MCP Release Ready & Verified ✅ (`8/8` Tests Passing, `0` Lint Warnings)

## Summary
`@krusch/companion-skylight-connector` (`v0.3.0`) is a zero-dependency Node 22 (`node:sqlite` + native `fetch` + `node:http`) universal opt-in connector, CLI, and MCP server bridging **Krusch Companion**, **Clawdbot / OpenClaw**, **ClaudeBot / Claude**, **GrokBot (xAI)**, **Muse / Nous Hermes (`hermes3`)**, and any MCP client with **Skylight Calendar 2** and **G-Krusch Google Calendar**.

## Status
- [x] Air-gap guard (`ALLOW_SKYLIGHT=1` / `ALLOW_CLOUD=1`) and secret/PII redaction (`redactSensitiveText`, `sanitizeSyncRecord`) (`src/config.js`)
- [x] Resilient Skylight Cloud API client (`src/skylight-client.js`) with automatic `401 Unauthorized` session refresh (`authenticate()`) and transient `429/502/503/504` exponential backoff retry
- [x] High-efficiency SQLite WAL bridge (`src/companion-bridge.js`, `sql/schema_v1.sql`) with `PRAGMA busy_timeout = 5000`, `PRAGMA synchronous = NORMAL`, pre-compiled prepared statements (`this._stmts`), atomic `_withTransaction()` batching, and SHA-256 content-hash deduplication across Chores, Grocery Lists, and Meals (`pushMealPlan`, `listMealPlans`)
- [x] Google Calendar <-> Skylight Calendar 2 Dual-Calendar event bridge (`family` & `grandparents`) with SHA-256 event deduplication (`src/calendar-bridge.js`)
- [x] Universal Multi-Agent & MCP Adapter (`src/universal-adapter.js`): zero-dep JSON-RPC 2.0 Stdio MCP server (`startMcpStdioServer`), Streamable HTTP MCP & Bot Webhook server (`startMcpHttpServer` on `:5449` with `1MB` payload cap & optional `SKYLIGHT_MCP_API_KEY` auth), OpenAI/GrokBot/OpenClaw/Muse function schemas (`getOpenAiToolSchemas`, `executeOpenAiToolCall`), Anthropic/ClaudeBot `tool_use` schemas (`getAnthropicToolSchemas`, `executeAnthropicToolUse`), and `SKILL.md` generator
- [x] CLI utility (`bin/krusch-skylight.js`: `status`, `mcp`, `mcp-http`, `schema`, `skill`, `create-event`, `assign-chore`, `sync-tasks`, `pull-chores`, `push-list`, `plan-meal`, `list-meals`, `sync-events`, `magic-import`, `twin`)
- [x] Full automated test suite (`8/8` tests passing in `tests/connector.test.js`, `0` oxlint warnings/errors)
- [x] Published to GitHub (`git@github.com:kruschdev/krusch-companion-skylight-connector.git`)

