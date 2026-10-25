# @krusch/companion-skylight-connector (v0.3.0)

> **Universal, zero-dependency Skylight Calendar 2 Connector & MCP Server** bridging **Krusch Companion**, **Clawdbot / OpenClaw**, **ClaudeBot / Claude**, **GrokBot (xAI)**, **Muse / Nous Hermes (`hermes3`)**, and any MCP client with **Skylight Calendar 2**.

---

> [!IMPORTANT]
> **Opt-In Sovereignty & Household Display Safety:**  
> Just like `@krusch/polygres-connector`, this connector is **100% decoupled and opt-in**. `krusch-companion` and all connected bots remain strictly local-only by default. Remote communication with `https://app.ourskylight.com` is blocked unless `ALLOW_SKYLIGHT=1` is set. Before any task, checklist, or calendar event is pushed to the shared household Skylight screen, it passes through secret/PII redaction (`[REDACTED_SECRET]`) and ABA Model Rule 1.6 privileged-matter air-gap checks.

---

## 🤖 Supported Assistant Bots & Ecosystems

| Bot / Agent | Transport | Command / Endpoint |
| :--- | :--- | :--- |
| **Krusch Companion** | Opt-In Tool Plugin (`ENABLE_SKYLIGHT_CONNECTOR=1`) | `createCompanionToolPlugin()` / `createUniversalToolPlugin()` |
| **ClaudeBot / Claude Code / Cursor / Antigravity** | **MCP Stdio**, **MCP HTTP**, or **Anthropic `tool_use`** | `krusch-skylight mcp` or `krusch-skylight schema claudebot --granular` |
| **Clawdbot / OpenClaw** | **CLI (`SKILL.md`)**, **MCP**, or **Bot Webhook** | `krusch-skylight skill` or `krusch-skylight schema clawdbot --granular` |
| **GrokBot (xAI Grok)** | **xAI / OpenAI Function Calling** or **HTTP Webhook** | `krusch-skylight schema grokbot --granular` or `GET /tools?format=grokbot` |
| **Muse / Nous Hermes (`hermes3`)** | **Hermes `<tool_call>` Schema** or **MCP** | `krusch-skylight schema muse --granular` or `GET /tools?format=muse` |

---

## 🏛️ Architecture: 3 Ways Data Flows to Skylight Calendar 2

| Domain | Skylight 2 Destination | Sync Mechanism | Requires Skylight Cloud Credentials? |
| :--- | :--- | :--- | :--- |
| **5-Tier Priority Board Tasks & Chores** | **Skylight Chores Tab**<br>(`/api/frames/:id/chores`) | Bidirectional upsert via `skylight_sync_map` with SHA-256 content hash deduplication, completion toggle sync, and tier-to-reward-point mapping (`10–50 pts`). | Yes (`ALLOW_SKYLIGHT=1` + `SKYLIGHT_TOKEN` or Email/Password) |
| **Task Checklists & Grocery Notes** | **Skylight Lists**<br>(`/api/frames/:id/lists/:listId/list_items`) | Direct push of checklist items (`checklist_json` or comma-separated items) into Skylight Grocery / To-Do lists. | Yes (`ALLOW_SKYLIGHT=1` + `SKYLIGHT_TOKEN` or Email/Password) |
| **Calendar Appointments & Holds** | **Skylight Calendar View** | **Dual-Mode**: (1) Direct `/calendar_events` API, OR (2) Local **Google Calendar Bridge** (`127.0.0.1:5446`) which Skylight 2 natively 2-way syncs with Google Calendar (`family` & `grandparents`). | **No** when using Google Calendar 2-Way Sync |
| **Schedules, Flyers & Digests** | **Skylight Magic Import ("Sidekick")** | Dispatches formatted schedule/checklist emails via local Gmail bridge to `<your-frame>@ourskylight.com`. | **No** (Only requires `SKYLIGHT_MAGIC_IMPORT_EMAIL`) |
| **Privileged Legal / Confidential Matters** | <strong style="color: #ff5252;">100% Air-Gapped Local</strong> | Strictly blocked by `assertMatterNotPrivileged` and `assertNotPrivilegedContent` (`AirGapSecurityError`). | Never synced |

---

## 🚀 Usage

### Environment Configuration
```bash
export ALLOW_SKYLIGHT=1
export SKYLIGHT_FRAME_ID="your_frame_id"
export SKYLIGHT_TOKEN="your_skylight_token"
# Or authenticate with email/password:
# export SKYLIGHT_EMAIL="you@example.com"
# export SKYLIGHT_PASSWORD="your_password"

# Optional: Magic Import email address for Sidekick parsing
export SKYLIGHT_MAGIC_IMPORT_EMAIL="yourframe@ourskylight.com"

# Optional: Universal SQLite DB path & Calendar Bridge URL
export SKYLIGHT_DB_PATH="./data/skylight.db"
export CALENDAR_BRIDGE_URL="http://127.0.0.1:5446"
```

### 1. Universal CLI (`krusch-skylight`)
```bash
# Probe Local Twin SQLite DB, Calendar Bridge, and Skylight Cloud status
node bin/krusch-skylight.js status [--json]

# Start Model Context Protocol (MCP) JSON-RPC 2.0 Server over stdio
node bin/krusch-skylight.js mcp

# Start Streamable HTTP MCP & Universal Bot Webhook Server (default :5449)
node bin/krusch-skylight.js mcp-http 5449

# Export tool schemas for GrokBot, ClaudeBot, Clawdbot/OpenClaw, Muse/Hermes, or MCP
node bin/krusch-skylight.js schema [grokbot|claudebot|clawdbot|muse|mcp|manifest] [--granular]

# Print ready-to-drop SKILL.md for OpenClaw / Hermes / Antigravity
node bin/krusch-skylight.js skill

# Create a Calendar Event on Skylight (via Direct API or Google Calendar Bridge)
node bin/krusch-skylight.js create-event "Mom's Birthday Dinner" "2026-10-18T18:30:00" [--json]

# Assign a household chore on Skylight
node bin/krusch-skylight.js assign-chore "Unload dishwasher" "Alex" [--json]

# Push items to a Skylight Grocery / To-Do List
node bin/krusch-skylight.js push-list grocery "Organic Milk, Pasture Eggs, Sourdough Bread" [--dry-run] [--json]

# Plan a family meal
node bin/krusch-skylight.js plan-meal "Rosemary Garlic Ribeye" 2026-10-21 dinner [--json]
```

### 2. Programmatic SDK & Universal Multi-Agent Adapter
```javascript
import {
  createSkylightConnector,
  createUniversalSkylightAdapter,
  getOpenAiToolSchemas,
  executeOpenAiToolCall,
  getAnthropicToolSchemas,
  executeAnthropicToolUse
} from '@krusch/companion-skylight-connector';

// A) Universal Multi-Agent Adapter (OpenClaw, GrokBot, ClaudeBot, Muse, MCP):
const adapter = createUniversalSkylightAdapter({ dbPath: './data/skylight.db' });
const grokOrHermesTools = getOpenAiToolSchemas({ granular: true });
const claudeTools = getAnthropicToolSchemas({ granular: true });

// B) Start HTTP MCP & Bot Webhook Server programmatically:
const httpServer = await adapter.startMcpHttpServer({ port: 5449 });
```

