# Krusch Companion Skylight Connector Guidelines (`AGENTS.md`)

> **Package**: `@krusch/companion-skylight-connector`  
> **Type**: Universal Opt-In Multi-Agent & MCP Connector (Krusch Companion, Clawdbot/OpenClaw, ClaudeBot/Claude, GrokBot/xAI, Muse/Nous Hermes)  
> **Status**: `0.3.0` (`8/8` tests passing, `0` lint warnings)  
> **Schema Version**: 1 (compatible with Krusch Companion SQLite WAL `data/companion.db` or standalone `SKYLIGHT_DB_PATH`)

---

## 🎯 Purpose & Constraints
1. **Universal & Decoupled Opt-In Plugin**: This package MUST remain decoupled from `krusch-companion` by default and work standalone across any assistant bot (`SKYLIGHT_DB_PATH`). `krusch-companion` and connected bots run 100% sovereign and local-only unless the user explicitly opts into Skylight Cloud synchronization (`ALLOW_SKYLIGHT=1`).
2. **Multi-Transport Agent Compatibility (`src/universal-adapter.js`)**:
   - **Stdio MCP Server (`krusch-skylight mcp`)**: Zero-dependency JSON-RPC 2.0 MCP server exposing `skylight_calendar` + 10 granular `skylight_*` tools and `skylight://status`, `skylight://twin`, and `skylight://skill` resources.
   - **Streamable HTTP MCP & Bot Webhook Server (`krusch-skylight mcp-http 5449`)**: Exposes `POST /mcp`, `POST /tools/call`, `GET /tools?format=grokbot|claudebot|clawdbot|muse|mcp`, and `GET /health`.
   - **Native Tool Schema Exporters**: `getOpenAiToolSchemas()` (GrokBot, OpenClaw/Clawdbot, Muse/Nous Hermes) and `getAnthropicToolSchemas()` (ClaudeBot/Claude).
3. **Tri-Path Synchronization Protocol**:
   - **Direct Skylight Cloud API (`SkylightCloudClient`)**: Syncs Priority Board tasks <-> Skylight Chores (`/api/frames/:frameId/chores`), Checklists <-> Skylight Grocery/To-Do Lists (`/lists/:listId/list_items`), Calendar Events (`/calendar_events`), and Meals (`/meals`).
   - **Google Calendar 2-Way Bridge (`CalendarSyncBridge`)**: Pushes/pulls events through the local Google Calendar bridge (`127.0.0.1:5446`), which Skylight Calendar 2 natively syncs two-way via Google Calendar (`family` & `grandparents`).
   - **Skylight Magic Import ("Sidekick") Email Bridge**: Sends formatted schedules or checklists via local Gmail bridge to `<frame>@ourskylight.com`.
4. **Air-Gap & Confidentiality Invariant**:
   - Fails closed with `AirGapSecurityError` if `ALLOW_SKYLIGHT=1` (or `ALLOW_CLOUD=1`) is not set when calling remote `https://app.ourskylight.com`.
   - Blocks paths resolving to privileged litigation matters (`/matters/`, `/evidence/`, `/privileged/`) and rejects content tagged `[PRIVILEGED]` / `[ATTORNEY-CLIENT]` under ABA Model Rule 1.6.
5. **Automatic Secret & PII Redaction**: Scans and replaces API keys, passwords, JWTs, database connection strings, and SSNs with `[REDACTED_SECRET]` before displaying any task or note on a shared household Skylight screen.
6. **Idempotent Sync Ledger & Local Twin**: All sync operations record audit runs in `skylight_sync_runs`, track SHA-256 content hashes in `skylight_sync_map` to avoid duplicate items, and maintain an offline `skylight_local_twin` table.

---

## 🧪 Testing
Run tests and linter via Node's native test runner:
```bash
npm test && npm run lint
```

