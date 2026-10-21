---
name: skylight-calendar
description: Universal Skylight Calendar 2 connector & MCP toolset for Krusch Companion, Clawdbot/OpenClaw, ClaudeBot/Claude, GrokBot/xAI, and Muse/Nous Hermes — schedule family events, assign chores, push grocery/to-do list items, plan meals, and send Sidekick Magic Import digests.
---

# Skylight Calendar 2 Universal Skill (`@krusch/companion-skylight-connector`)

Use this skill whenever the user asks to check, schedule, or update anything on the **Skylight Calendar 2** household display (events, chores, grocery lists, meal plans, or Sidekick Magic Import).

## 1. Quick CLI Execution (OpenClaw / Clawdbot / Muse / Hermes / Bash Agents)

Always pass `--json` for structured machine-readable output:

```bash
# Check Skylight Frame, Google Calendar 2-Way Bridge, and Local Twin status
krusch-skylight status --json

# Create an event on Skylight (auto-routes Mom/Grandma/Grandparents to 'grandparents' & household to 'family')
krusch-skylight create-event "Family Dinner at 6:30 PM" "2026-10-21T18:30:00" --json

# Assign a household chore
krusch-skylight assign-chore "Unload dishwasher" "Alex" --json

# Push items to Skylight Grocery or To-Do list
krusch-skylight push-list grocery "Organic Milk, Pasture Eggs, Sourdough Bread" --json

# Plan a family meal (breakfast | lunch | dinner | snack)
krusch-skylight plan-meal "Rosemary Garlic Ribeye" 2026-10-21 dinner --json

# Pull upcoming Skylight events or chores
krusch-skylight sync-events --json
krusch-skylight pull-chores --json
```

## 2. MCP Server Configuration (ClaudeBot / Claude Code / Cursor / Antigravity / Hermes MCP)

### Stdio MCP
```json
{
  "mcpServers": {
    "krusch-skylight": {
      "command": "krusch-skylight",
      "args": ["mcp"]
    }
  }
}
```

### Streamable HTTP MCP & Bot Webhook Server (`:5449`)
```bash
krusch-skylight mcp-http 5449
```
- `GET http://127.0.0.1:5449/tools?format=grokbot|claudebot|clawdbot|muse|mcp`
- `POST http://127.0.0.1:5449/mcp` (JSON-RPC 2.0 MCP)
- `POST http://127.0.0.1:5449/tools/call` (Universal webhook for GrokBot, ClaudeBot, Clawdbot, Muse)
