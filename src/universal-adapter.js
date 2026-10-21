/**
 * Universal Multi-Agent & MCP Adapter for @krusch/companion-skylight-connector
 *
 * Enables OpenClaw, Hermes Agent (`hermes3`), Claude Code, Cursor, Antigravity,
 * Jean SRE, and any OpenAI / Anthropic / Model Context Protocol (MCP) agent to use
 * the Skylight Calendar 2 Connector without requiring Krusch Companion.
 */

import http from 'http';
import readline from 'readline';
import { createCompanionToolPlugin, createSkylightConnector } from './index.js';
import { SCHEMA_VERSION } from './config.js';

export const CONNECTOR_VERSION = '0.3.0';

/**
 * Canonical JSON Schema definitions for both unified (`skylight_calendar`)
 * and granular (`skylight_*`) tool interfaces.
 */
export const GRANULAR_TOOL_DEFINITIONS = [
  {
    name: 'skylight_status',
    action: 'status',
    description:
      'Check Skylight Calendar 2 Frame connectivity, Google Calendar 2-way bridge health, Magic Import email address, and local SQLite twin counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'skylight_create_event',
    action: 'create_event',
    description:
      'Create or schedule an event on Skylight Calendar 2 (auto-routes Mom/Grandma/Grandparents events to "grandparents" calendar and household events to "family"). Automatically redacts secrets/PII.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Event title or summary (e.g., "Family Dinner at 6:00 PM" or "Grandma babysitting at 2:00 PM")'
        },
        date: {
          type: 'string',
          description: 'Target date in YYYY-MM-DD format (defaults to today)'
        },
        startTime: {
          type: 'string',
          description: 'Optional ISO-8601 timestamp or time string (e.g., "2026-10-21T18:00:00" or "6:00 PM")'
        },
        endTime: {
          type: 'string',
          description: 'Optional ISO-8601 end timestamp'
        },
        calendar: {
          type: 'string',
          enum: ['family', 'grandparents', 'both'],
          description: 'Target family calendar profile (optional, auto-inferred from title/notes if omitted)'
        },
        location: {
          type: 'string',
          description: 'Optional event location'
        },
        description: {
          type: 'string',
          description: 'Optional event notes or description'
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate event creation without mutating Skylight or Google Calendar'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'skylight_list_events',
    action: 'list_events',
    description:
      'List upcoming events from Skylight Calendar 2 or the Google Calendar 2-way sync bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format (defaults to today)'
        },
        calendar: {
          type: 'string',
          enum: ['family', 'grandparents', 'both'],
          description: 'Which family calendar to query (default: "both")'
        },
        writeBack: {
          type: 'boolean',
          description: 'Optionally write fetched events back into local SQLite task board'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'skylight_assign_chore',
    action: 'assign_chore',
    description:
      'Assign a household chore on Skylight Calendar 2 with optional assignee name and reward stars.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Chore title (e.g., "Unload dishwasher")'
        },
        assignee: {
          type: 'string',
          description: 'Family member assigned to the chore (e.g., "Alex", "Sam")'
        },
        date: {
          type: 'string',
          description: 'Target date in YYYY-MM-DD format (defaults to today)'
        },
        stars: {
          type: 'number',
          description: 'Optional reward points/stars for completing the chore'
        },
        notes: {
          type: 'string',
          description: 'Optional chore instructions'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview chore assignment without mutating Skylight'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'skylight_pull_chores',
    action: 'pull_chores',
    description:
      'Pull chores and completion status from Skylight Calendar 2.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Target date in YYYY-MM-DD format (defaults to today)'
        },
        writeBack: {
          type: 'boolean',
          description: 'Write pulled chores back into local SQLite tasks table (default: true)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'skylight_push_list_items',
    action: 'push_list_items',
    description:
      'Push grocery or checklist items to a Skylight Calendar 2 list (with SHA-256 deduplication and secret redaction).',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' }
          ],
          description: 'Array of item strings or comma-separated list (e.g., "Organic Milk, Pasture Eggs, Sourdough")'
        },
        listId: {
          type: 'string',
          description: 'Target Skylight list name or ID (default: "grocery")'
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate pushing list items without mutating Skylight'
        }
      },
      required: ['items'],
      additionalProperties: false
    }
  },
  {
    name: 'skylight_plan_meal',
    action: 'plan_meal',
    description:
      'Add or update a meal on the Skylight Calendar 2 Meal Planner (breakfast, lunch, dinner, or snack).',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Meal name (e.g., "Rosemary Garlic Ribeye & Asparagus")'
        },
        date: {
          type: 'string',
          description: 'Meal date in YYYY-MM-DD format (defaults to today)'
        },
        mealType: {
          type: 'string',
          enum: ['breakfast', 'lunch', 'dinner', 'snack'],
          description: 'Meal slot (default: "dinner")'
        },
        notes: {
          type: 'string',
          description: 'Optional recipe or prep notes'
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate meal planning without mutating Skylight'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'skylight_list_meals',
    action: 'list_meals',
    description:
      'List planned meals from Skylight Calendar 2 or the local SQLite twin cache.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD filter date'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'skylight_magic_import',
    action: 'magic_import',
    description:
      'Send a formatted schedule, flyer text, or checklist digest to Skylight Magic Import ("Sidekick") email (<frame>@ourskylight.com).',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Email subject line for Skylight Sidekick Magic Import'
        },
        description: {
          type: 'string',
          description: 'Schedule or list body text to be parsed by Skylight Magic Import'
        },
        recipientEmail: {
          type: 'string',
          description: 'Optional override for <frame>@ourskylight.com address'
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate email dispatch without sending'
        }
      },
      required: ['title', 'description'],
      additionalProperties: false
    }
  },
  {
    name: 'skylight_sync_tasks',
    action: 'sync_tasks',
    description:
      'Synchronize local SQLite Priority Board tasks with Skylight Calendar 2 Chores.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Target YYYY-MM-DD date (defaults to today)'
        },
        allowPersonalTaskSync: {
          type: 'boolean',
          description: 'Explicitly opt in to pushing personal tasks when operating in Google Calendar bridge mode'
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate task sync without mutating remote Skylight'
        }
      },
      additionalProperties: false
    }
  }
];

/**
 * Unified single-tool JSON Schema (`skylight_calendar`) for agents that prefer a compact 1-tool footprint.
 */
export const UNIFIED_TOOL_DEFINITION = {
  name: 'skylight_calendar',
  action: null,
  description:
    'Universal Skylight Calendar 2 Connector: check frame status, create/list family calendar events, assign/pull chores, push grocery/to-do list items, plan/list meals, or send a Magic Import digest.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status',
          'create_event',
          'list_events',
          'assign_chore',
          'pull_chores',
          'push_list_items',
          'plan_meal',
          'list_meals',
          'magic_import',
          'sync_tasks',
          'list_categories',
          'fix_two_tone_events'
        ],
        description: 'Operation to perform on Skylight Calendar 2'
      },
      title: {
        type: 'string',
        description: 'Event, chore, meal, or Magic Import subject title'
      },
      calendar: {
        type: 'string',
        enum: ['family', 'grandparents', 'both'],
        description: 'Target family calendar profile'
      },
      assignee: {
        type: 'string',
        description: 'Chore assignee name (for assign_chore)'
      },
      items: {
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string' }
        ],
        description: 'Grocery or checklist items (for push_list_items)'
      },
      listId: {
        type: 'string',
        description: 'Skylight list ID or name (default: "grocery")'
      },
      mealType: {
        type: 'string',
        enum: ['breakfast', 'lunch', 'dinner', 'snack'],
        description: 'Meal slot (for plan_meal)'
      },
      date: {
        type: 'string',
        description: 'Target date in YYYY-MM-DD format (defaults to today)'
      },
      startTime: {
        type: 'string',
        description: 'ISO-8601 start timestamp or time string (for create_event)'
      },
      endTime: {
        type: 'string',
        description: 'ISO-8601 end timestamp (for create_event)'
      },
      location: {
        type: 'string',
        description: 'Event location (for create_event)'
      },
      description: {
        type: 'string',
        description: 'Notes, description, or Magic Import body text'
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview operation without mutating remote Skylight state'
      }
    },
    required: ['action'],
    additionalProperties: true
  }
};

/**
 * Return Model Context Protocol (MCP) tool definitions.
 */
export function getMcpToolDefinitions({ granular = true, includeUnified = true } = {}) {
  const defs = [];
  if (includeUnified) {
    defs.push({
      name: UNIFIED_TOOL_DEFINITION.name,
      description: UNIFIED_TOOL_DEFINITION.description,
      inputSchema: UNIFIED_TOOL_DEFINITION.inputSchema
    });
  }
  if (granular) {
    for (const tool of GRANULAR_TOOL_DEFINITIONS) {
      defs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      });
    }
  }
  return defs;
}

/**
 * Return OpenAI / Hermes (`hermes3`) / OpenClaw / Ollama function-calling tool schemas.
 * Format: `[{ type: 'function', function: { name, description, parameters } }]`
 */
export function getOpenAiToolSchemas({ granular = false } = {}) {
  const source = granular ? GRANULAR_TOOL_DEFINITIONS : [UNIFIED_TOOL_DEFINITION];
  return source.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

/**
 * Return Anthropic / Claude `input_schema` tool definitions.
 * Format: `[{ name, description, input_schema }]`
 */
export function getAnthropicToolSchemas({ granular = false } = {}) {
  const source = granular ? GRANULAR_TOOL_DEFINITIONS : [UNIFIED_TOOL_DEFINITION];
  return source.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

/**
 * Execute any unified (`skylight_calendar`) or granular (`skylight_*`) tool call.
 */
export async function executeUniversalToolCall(toolName, rawArgs = {}, options = {}) {
  let parsedArgs = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (err) {
      return {
        ok: false,
        tool: toolName,
        summary: `Invalid JSON arguments for ${toolName}: ${err.message}`
      };
    }
  }

  const normalizedName = String(toolName || '').trim();
  const granularMatch = GRANULAR_TOOL_DEFINITIONS.find(t => t.name === normalizedName);
  const action = granularMatch ? granularMatch.action : parsedArgs?.action;

  if (normalizedName !== 'skylight_calendar' && !granularMatch) {
    return {
      ok: false,
      tool: normalizedName,
      summary: `Unknown Skylight tool '${normalizedName}'. Supported tools: skylight_calendar, ${GRANULAR_TOOL_DEFINITIONS.map(t => t.name).join(', ')}`
    };
  }

  const plugin = createCompanionToolPlugin(options);
  return plugin.execute(
    {
      ...parsedArgs,
      action: action || 'status'
    },
    options
  );
}

/**
 * Execute an OpenAI / Hermes / OpenClaw `tool_call` object and return a standard `role: "tool"` message.
 */
export async function executeOpenAiToolCall(toolCall, options = {}) {
  const callId = toolCall?.id || `call_${Date.now()}`;
  const fnName = toolCall?.function?.name || toolCall?.name || 'skylight_calendar';
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
  const result = await executeUniversalToolCall(fnName, rawArgs, options);
  return {
    tool_call_id: callId,
    role: 'tool',
    name: fnName,
    content: JSON.stringify(result),
    result
  };
}

/**
 * Execute an Anthropic / Claude `tool_use` block and return a standard `tool_result` block.
 */
export async function executeAnthropicToolUse(toolUseBlock, options = {}) {
  const toolUseId = toolUseBlock?.id || `toolu_${Date.now()}`;
  const fnName = toolUseBlock?.name || 'skylight_calendar';
  const input = toolUseBlock?.input || {};
  const result = await executeUniversalToolCall(fnName, input, options);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: result?.ok === false,
    content: result?.summary ? `${result.summary}\n\n${JSON.stringify(result.data || result, null, 2)}` : JSON.stringify(result),
    result
  };
}

/**
 * Return a universal discovery manifest & SKILL.md template for OpenClaw, Hermes Agent, and MCP hosts.
 */
export function getUniversalAgentManifest() {
  return {
    name: '@krusch/companion-skylight-connector',
    version: CONNECTOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    repository: 'https://github.com/kruschdev/krusch-companion-skylight-connector',
    supportedAgents: [
      'krusch-companion',
      'openclaw',
      'clawdbot',
      'claudebot',
      'grokbot',
      'muse',
      'nous-hermes',
      'hermes-agent',
      'jean-sre',
      'claude-code',
      'cursor',
      'antigravity'
    ],
    transports: ['sdk', 'cli', 'mcp-stdio', 'mcp-http', 'openai-tools', 'xai-grok-tools', 'anthropic-tools'],
    mcpServerConfig: {
      mcpServers: {
        'krusch-skylight': {
          command: 'krusch-skylight',
          args: ['mcp'],
          env: {
            ALLOW_SKYLIGHT: '0',
            CALENDAR_BRIDGE_URL: 'http://127.0.0.1:5446'
          }
        }
      }
    },
    invariants: [
      'Air-gapped local mode by default unless ALLOW_SKYLIGHT=1 or ALLOW_CLOUD=1 is set',
      'Automatic secret, token, password, and SSN redaction ([REDACTED_SECRET]) before household screen display',
      'Strict ABA Model Rule 1.6 block on privileged legal and confidential matters',
      'SHA-256 content-hash deduplication across events, chores, grocery items, and meals'
    ],
    tools: getMcpToolDefinitions({ granular: true, includeUnified: true }).map(t => t.name)
  };
}

/**
 * Generate a ready-to-drop SKILL.md for OpenClaw, Hermes Agent, or Antigravity.
 */
export function generateUniversalSkillMarkdown() {
  return `---
name: skylight-calendar
description: Universal Skylight Calendar 2 connector for scheduling family events, assigning chores, pushing grocery/to-do list items, planning meals, and sending Sidekick Magic Import digests.
---

# Skylight Calendar 2 Universal Skill (\`@krusch/companion-skylight-connector\`)

Use this skill whenever the user asks to check, schedule, or update anything on the **Skylight Calendar 2** household display (events, chores, grocery lists, meal plans, or Sidekick Magic Import).

## 1. Quick CLI Execution (OpenClaw / Hermes / Bash Agents)

Always pass \`--json\` for structured machine-readable output:

\`\`\`bash
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
\`\`\`

## 2. MCP Server Configuration (Claude Code / Cursor / Antigravity / Hermes MCP)

\`\`\`json
{
  "mcpServers": {
    "krusch-skylight": {
      "command": "krusch-skylight",
      "args": ["mcp"]
    }
  }
}
\`\`\`
`;
}

/**
 * Handle a single MCP JSON-RPC 2.0 request object and return the JSON-RPC response (or null for notifications).
 */
export async function handleMcpJsonRpc(request, options = {}) {
  if (!request || typeof request !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  const { id, method, params } = request;

  // Notifications (no id) do not receive a JSON-RPC response
  if (id === undefined || id === null) {
    return null;
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: {
            name: 'krusch-skylight-mcp',
            version: CONNECTOR_VERSION
          }
        }
      };
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id,
        result: {}
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: getMcpToolDefinitions({ granular: true, includeUnified: true })
        }
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const res = await executeUniversalToolCall(toolName, toolArgs, options);
      const textSummary = res.summary
        ? `${res.summary}\n\n${JSON.stringify(res.data || res, null, 2)}`
        : JSON.stringify(res, null, 2);

      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: res.ok === false,
          content: [
            {
              type: 'text',
              text: textSummary
            }
          ],
          structuredContent: res
        }
      };
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'skylight://status',
              name: 'Skylight Calendar 2 Connector Status',
              mimeType: 'application/json',
              description: 'Live diagnostic probe of Local SQLite Twin, Calendar Bridge, and Skylight Cloud.'
            },
            {
              uri: 'skylight://twin',
              name: 'Skylight Local Twin Cache',
              mimeType: 'application/json',
              description: 'Cached offline mirror of Skylight Calendar 2 events, chores, grocery items, and meals.'
            },
            {
              uri: 'skylight://skill',
              name: 'Universal Agent SKILL.md',
              mimeType: 'text/markdown',
              description: 'SKILL.md instructions for OpenClaw, Hermes Agent, and MCP clients.'
            }
          ]
        }
      };
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri === 'skylight://skill') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: generateUniversalSkillMarkdown()
              }
            ]
          }
        };
      }

      const connector = createSkylightConnector(options);
      try {
        if (uri === 'skylight://status') {
          const status = await connector.probeStatus();
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(status, null, 2)
                }
              ]
            }
          };
        }
        if (uri === 'skylight://twin') {
          const items = connector.companion.getLocalTwinItems();
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({ count: items.length, items }, null, 2)
                }
              ]
            }
          };
        }
      } finally {
        await connector.close();
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown resource URI: ${uri}` }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err?.message || 'Internal MCP server error'
      }
    };
  }
}

export const MAX_MCP_PAYLOAD_BYTES = 1_048_576; // 1 MB safety cap

/**
 * Start a zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio.
 */
export function startMcpStdioServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const maxLineBytes = Number(options.maxLineBytes || MAX_MCP_PAYLOAD_BYTES);

  const rl = readline.createInterface({
    input,
    terminal: false
  });

  rl.on('line', async line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (Buffer.byteLength(trimmed, 'utf8') > maxLineBytes) {
      output.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Payload exceeds maximum allowed size (1MB)' }
        })}\n`
      );
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const errResp = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      output.write(`${JSON.stringify(errResp)}\n`);
      return;
    }

    try {
      const response = await handleMcpJsonRpc(parsed, options);
      if (response) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err) {
      const fallbackErr = {
        jsonrpc: '2.0',
        id: parsed?.id ?? null,
        error: { code: -32603, message: err?.message || 'Internal MCP error' }
      };
      output.write(`${JSON.stringify(fallbackErr)}\n`);
    }
  });

  return rl;
}

/**
 * Start a zero-dependency Streamable HTTP MCP & Universal Bot Webhook server (`node:http`).
 * Supports:
 * - `POST /mcp`       : Standard MCP JSON-RPC 2.0 over HTTP
 * - `POST /tools/call`: Universal bot webhook (`{ tool, arguments }` or OpenAI/Grok `tool_call` or Claude `tool_use`)
 * - `GET  /tools`     : Tool schema discovery (`?format=mcp|openai|grok|claude&granular=1`)
 * - `GET  /health`    : Health & manifest check
 */
export function startMcpHttpServer(options = {}) {
  const port = Number(options.port ?? process.env.SKYLIGHT_MCP_PORT ?? 5449);
  const host = options.host || process.env.SKYLIGHT_MCP_HOST || '127.0.0.1';
  const apiKey = options.apiKey ?? process.env.SKYLIGHT_MCP_API_KEY ?? null;
  const maxBodyBytes = Number(options.maxBodyBytes || MAX_MCP_PAYLOAD_BYTES);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          service: 'krusch-skylight-mcp',
          version: CONNECTOR_VERSION,
          supportedAgents: getUniversalAgentManifest().supportedAgents
        })
      );
      return;
    }

    // Optional Bearer / X-API-Key authentication guard when SKYLIGHT_MCP_API_KEY is configured
    if (apiKey) {
      const authHeader = String(req.headers.authorization || '').trim();
      const headerKey = String(req.headers['x-api-key'] || '').trim();
      const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      if (bearerToken !== apiKey && headerKey !== apiKey) {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: valid SKYLIGHT_MCP_API_KEY required' }));
        return;
      }
    }

    if (req.method === 'GET' && (url.pathname === '/tools' || url.pathname === '/mcp/tools')) {
      const format = (url.searchParams.get('format') || 'mcp').toLowerCase();
      const granular = url.searchParams.get('granular') !== '0';
      let toolsPayload;
      if (format === 'claude' || format === 'claudebot' || format === 'anthropic') {
        toolsPayload = getAnthropicToolSchemas({ granular });
      } else if (['openai', 'grok', 'grokbot', 'xai', 'hermes', 'muse', 'openclaw', 'clawdbot'].includes(format)) {
        toolsPayload = getOpenAiToolSchemas({ granular });
      } else {
        toolsPayload = getMcpToolDefinitions({ granular: true, includeUnified: true });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, format, count: toolsPayload.length, tools: toolsPayload }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/tools/call')) {
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > maxBodyBytes) {
          res.writeHead(413);
          res.end(JSON.stringify({ ok: false, error: 'Payload Too Large (max 1MB)' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      if (url.pathname === '/mcp' || body.jsonrpc === '2.0') {
        const rpcRes = await handleMcpJsonRpc(body, options);
        res.writeHead(rpcRes ? 200 : 202);
        res.end(rpcRes ? JSON.stringify(rpcRes) : '');
        return;
      }

      // Universal Bot Webhook (`/tools/call`) supporting OpenAI/Grok, Claude, or direct `{ tool, arguments }`
      if (body.type === 'tool_use' || body.input) {
        const out = await executeAnthropicToolUse(body, options);
        res.writeHead(200);
        res.end(JSON.stringify(out));
        return;
      }
      if (body.function) {
        const out = await executeOpenAiToolCall(body, options);
        res.writeHead(200);
        res.end(JSON.stringify(out));
        return;
      }

      const toolName = body.tool || body.name || 'skylight_calendar';
      const toolArgs = body.arguments || body.args || body;
      const out = await executeUniversalToolCall(toolName, toolArgs, options);
      res.writeHead(200);
      res.end(JSON.stringify(out));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: `Route not found: ${req.method} ${url.pathname}` }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        host,
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () =>
          new Promise(res => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => res());
          })
      });
    });
  });
}

/**
 * Factory creating a Universal Skylight Adapter instance for any agent framework.
 */
export function createUniversalSkylightAdapter(options = {}) {
  return {
    version: CONNECTOR_VERSION,
    getManifest: () => getUniversalAgentManifest(),
    getSkillMarkdown: () => generateUniversalSkillMarkdown(),
    getMcpTools: opts => getMcpToolDefinitions(opts),
    getOpenAiTools: opts => getOpenAiToolSchemas(opts),
    getAnthropicTools: opts => getAnthropicToolSchemas(opts),
    executeTool: (name, args, callOpts = {}) =>
      executeUniversalToolCall(name, args, { ...options, ...callOpts }),
    executeOpenAiToolCall: (toolCall, callOpts = {}) =>
      executeOpenAiToolCall(toolCall, { ...options, ...callOpts }),
    executeAnthropicToolUse: (toolUseBlock, callOpts = {}) =>
      executeAnthropicToolUse(toolUseBlock, { ...options, ...callOpts }),
    handleMcpRequest: (req, callOpts = {}) =>
      handleMcpJsonRpc(req, { ...options, ...callOpts }),
    startMcpStdioServer: (stdioOpts = {}) =>
      startMcpStdioServer({ ...options, ...stdioOpts }),
    startMcpHttpServer: (httpOpts = {}) =>
      startMcpHttpServer({ ...options, ...httpOpts })
  };
}

