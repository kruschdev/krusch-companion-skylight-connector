#!/usr/bin/env node
/**
 * CLI launcher for @krusch/companion-skylight-connector
 */

import {
  createSkylightConnector,
  todayIso,
  CONNECTOR_VERSION,
  getMcpToolDefinitions,
  getOpenAiToolSchemas,
  getAnthropicToolSchemas,
  getUniversalAgentManifest,
  generateUniversalSkillMarkdown,
  startMcpStdioServer,
  startMcpHttpServer
} from '../src/index.js';
import { maskUrl, maskToken, SCHEMA_VERSION } from '../src/config.js';

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter(a => a.startsWith('-')));
const positionalArgs = rawArgs.filter(a => !a.startsWith('-'));
const invokedAsMcp = Boolean(process.argv[1] && process.argv[1].endsWith('krusch-skylight-mcp'));
const command = invokedAsMcp && !positionalArgs[0] ? 'mcp' : positionalArgs[0];

const isJson = flags.has('--json');
const isDryRun = flags.has('--dry-run');
const isWriteBack = flags.has('--write');
const isGranular = flags.has('--granular');
const isHttp = flags.has('--http');

if (flags.has('--version') || flags.has('-v') || command === 'version') {
  console.log(`@krusch/companion-skylight-connector v${CONNECTOR_VERSION}`);
  process.exit(0);
}

if (command === 'mcp' || command === 'mcp-http') {
  if (command === 'mcp-http' || isHttp) {
    const portArg = Number(positionalArgs[1] || process.env.SKYLIGHT_MCP_PORT || 5449);
    startMcpHttpServer({ port: portArg }).then(({ host, port }) => {
      console.log(`🚀 Skylight Universal MCP & Bot Webhook Server listening on http://${host}:${port} (/mcp, /tools, /tools/call)`);
    });
  } else {
    startMcpStdioServer();
  }
} else if (command === 'skill') {
  console.log(generateUniversalSkillMarkdown());
  process.exit(0);
} else if (command === 'schema') {
  const format = String(positionalArgs[1] || 'openai').toLowerCase();
  if (format === 'mcp') {
    console.log(JSON.stringify(getMcpToolDefinitions({ granular: true, includeUnified: true }), null, 2));
  } else if (['anthropic', 'claude', 'claudebot'].includes(format)) {
    console.log(JSON.stringify(getAnthropicToolSchemas({ granular: isGranular }), null, 2));
  } else if (format === 'manifest') {
    console.log(JSON.stringify(getUniversalAgentManifest(), null, 2));
  } else {
    // Supports openai, grok, grokbot, xai, hermes, muse, openclaw, clawdbot
    console.log(JSON.stringify(getOpenAiToolSchemas({ granular: isGranular }), null, 2));
  }
  process.exit(0);
} else if (!command || flags.has('--help') || flags.has('-h') || command === 'help') {
  console.log(`
@krusch/companion-skylight-connector CLI (v${CONNECTOR_VERSION})
Universal Skylight Calendar 2 Connector for Krusch Companion, OpenClaw, Hermes Agent & MCP.

Usage:
  krusch-skylight <command> [arguments] [flags]

Core Commands:
  status                                 Probe Local Twin DB, G-Krusch Bridge, and Skylight Cloud
  mcp                                    Start Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio
  schema [openai|mcp|anthropic|manifest] Print universal tool schemas (--granular for 10 specialized tools)
  skill                                  Print ready-to-drop SKILL.md for OpenClaw / Hermes / Antigravity
  create-event <title> [iso_start]       Create a calendar event on Skylight (Direct API or G-Cal Bridge)
  assign-chore <title> [assignee] [date] Assign a household chore on Skylight Calendar 2
  sync-tasks [date]                      Push local 5-tier Priority Board tasks to Skylight Chores
  pull-chores [date] [--write]           Pull Skylight Chores (optionally write back to local SQLite)
  push-list <list_id> <item1,item2...>   Push grocery or checklist items to a Skylight List
  plan-meal <title> [date] [meal_type]   Plan a meal on Skylight Calendar 2 (or Local Twin)
  list-meals [date]                      List planned meals from Skylight or Local Twin
  sync-events [start_date] [--write]     Pull Skylight Calendar events into Local Twin / SQLite
  magic-import <subject> <body>          Send a schedule/list digest to Skylight Magic Import email
  twin [entity_type]                     List cached items in the local Skylight twin store

Flags:
  --dry-run                              Simulate sync without mutating remote Skylight cloud
  --write                                Write pulled Skylight chores/events back into local SQLite
  --granular                             Emit 10 granular tool schemas instead of unified skylight_calendar
  --json                                 Output results in JSON format
  -h, --help                             Show this help message
  -v, --version                          Print version

Environment Variables:
  ALLOW_SKYLIGHT=1                       Mandatory opt-in flag authorizing Skylight Cloud egress
  SKYLIGHT_FRAME_ID                      Target Skylight Calendar 2 Frame ID
  SKYLIGHT_TOKEN                         Skylight Bearer / Session token (or use SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD)
  SKYLIGHT_MAGIC_IMPORT_EMAIL            Optional <frame>@ourskylight.com address for Sidekick Magic Import
  SKYLIGHT_DB_PATH                       Universal SQLite path (or KRUSCH_COMPANION_DB_PATH)
`);
  process.exit(0);
}

async function main() {
  if (command === 'mcp' || command === 'mcp-http') return;
  const connector = createSkylightConnector();

  try {
    switch (command) {
      case 'status': {
        const probe = await connector.probeStatus();
        if (isJson) {
          console.log(
            JSON.stringify(
              {
                schemaVersion: SCHEMA_VERSION,
                config: {
                  allowCloud: connector.config.allowCloud,
                  skylightBaseUrl: maskUrl(connector.config.skylightBaseUrl),
                  skylightFrameId: connector.config.skylightFrameId,
                  skylightToken: maskToken(connector.config.skylightToken),
                  companionDbPath: connector.config.companionDbPath,
                  gKruschUrl: maskUrl(connector.config.gKruschUrl)
                },
                probe
              },
              null,
              2
            )
          );
        } else {
          console.log('=== Krusch Companion Skylight Connector Status ===');
          console.log(`Schema Version: ${SCHEMA_VERSION}`);
          console.log(
            `Cloud Egress: ${
              connector.config.allowCloud
                ? 'AUTHORIZED (ALLOW_SKYLIGHT=1) ✅'
                : 'AIR-GAPPED LOCAL ONLY (ALLOW_SKYLIGHT=0) 🛡️'
            }`
          );
          console.log(`Skylight API Base: ${maskUrl(connector.config.skylightBaseUrl)}`);
          console.log(`Skylight Frame ID: ${connector.config.skylightFrameId}`);
          console.log(`Skylight Token: ${maskToken(connector.config.skylightToken)}`);
          console.log(
            `Skylight Cloud Status: ${
              probe.skylightCloud.ok
                ? `CONNECTED (${probe.skylightCloud.framesCount} frames) ✅`
                : `OFFLINE / OPTED-OUT (${probe.skylightCloud.error}) ⚠️`
            }`
          );
          console.log(`Companion SQLite DB: ${connector.config.companionDbPath}`);
          console.log(
            `Companion DB Status: ${
              probe.localCompanionDb.ok
                ? `OK (${probe.localCompanionDb.tasksCount} tasks, ${probe.localCompanionDb.twinItemsCount} twin items, ${probe.localCompanionDb.syncRunsCount} sync runs) ✅`
                : `FAIL (${probe.localCompanionDb.error}) ❌`
            }`
          );
          console.log(
            `G-Krusch Calendar Bridge: ${
              probe.gKruschBridge.ok
                ? `OK (${connector.config.gKruschUrl}) ✅`
                : `UNREACHABLE (${probe.gKruschBridge.error}) ⚠️`
            }`
          );
        }
        break;
      }

      case 'sync-tasks': {
        const date = positionalArgs[1] || todayIso();
        const result = await connector.companion.pushLocalTasksToChores({
          date,
          dryRun: isDryRun
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `✅ Synced Companion tasks for ${date} (dryRun: ${isDryRun}): ${result.pushed} pushed, ${result.updated} updated, ${result.skipped} unchanged (${result.redacted} redacted).`
          );
        }
        break;
      }

      case 'pull-chores': {
        const date = positionalArgs[1] || todayIso();
        const result = await connector.companion.pullRemoteChoresToTasks({
          date,
          writeBack: isWriteBack
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `✅ Pulled ${result.fetched} Skylight chores for ${date} (created local: ${result.createdLocal}, updated local: ${result.updatedLocal}).`
          );
        }
        break;
      }

      case 'push-list': {
        const listId = positionalArgs[1] || 'grocery';
        const rawItems = positionalArgs.slice(2).join(' ');
        if (!rawItems) {
          console.error('Error: specify list_id and items: krusch-skylight push-list grocery "Milk, Eggs, Bread"');
          process.exit(1);
        }
        const items = rawItems
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        const result = await connector.companion.pushListItems({
          listId,
          items,
          dryRun: isDryRun
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `✅ Pushed ${result.pushed} item(s) to Skylight list '${listId}' (${result.skipped} unchanged skipped, dryRun: ${isDryRun}).`
          );
        }
        break;
      }

      case 'plan-meal': {
        const title = positionalArgs[1];
        const date = positionalArgs[2] || todayIso();
        const mealType = positionalArgs[3] || 'dinner';
        if (!title) {
          console.error('Error: specify meal title: krusch-skylight plan-meal "Grilled Salmon" [date] [meal_type]');
          process.exit(1);
        }
        const result = await connector.companion.pushMealPlan({
          title,
          date,
          mealType,
          dryRun: isDryRun
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `✅ Planned ${mealType} '${title}' for ${date} (${result.skipped ? 'unchanged/deduplicated' : result.mode}, dryRun: ${isDryRun}).`
          );
        }
        break;
      }

      case 'list-meals': {
        const date = positionalArgs[1] || null;
        const result = await connector.companion.listMealPlans({ date });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Found ${result.count} planned meal(s) (${result.mode}):`);
          for (const m of result.meals) {
            console.log(`- [${m.category_label || m.meal_type || 'meal'}] ${m.date || 'any'}: ${m.title || m.summary}`);
          }
        }
        break;
      }

      case 'sync-events': {
        const startDate = positionalArgs[1] || todayIso();
        const result = await connector.calendar.pullCalendarEvents({
          startDate,
          writeBackToCompanion: isWriteBack
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `✅ Pulled ${result.count} calendar event(s) via '${result.mode}' (created Companion tasks: ${result.createdTasks}).`
          );
        }
        break;
      }

      case 'create-event': {
        const title = positionalArgs[1];
        const startTime = positionalArgs[2] || new Date(Date.now() + 3600 * 1000).toISOString();
        if (!title) {
          console.error('Error: specify event title: krusch-skylight create-event "Family Dinner" [iso_start]');
          process.exit(1);
        }
        const result = await connector.calendar.createCalendarEvent(
          { summary: title, startTime },
          { dryRun: isDryRun }
        );
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ Created event '${title}' via ${result.mode} (dryRun: ${isDryRun}).`);
        }
        break;
      }

      case 'assign-chore': {
        const title = positionalArgs[1];
        const assignee = positionalArgs[2] || '';
        const date = positionalArgs[3] || todayIso();
        if (!title) {
          console.error('Error: specify chore title: krusch-skylight assign-chore "Unload dishwasher" [assignee] [date]');
          process.exit(1);
        }
        const prefix = assignee ? `[${assignee}] ` : '';
        const result = await connector.calendar.createCalendarEvent(
          {
            summary: `🧹 ${prefix}${title}`,
            date,
            description: 'Assigned via Universal Skylight Connector'
          },
          { dryRun: isDryRun }
        );
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ Assigned chore '${prefix}${title}' for ${date} via ${result.mode} (dryRun: ${isDryRun}).`);
        }
        break;
      }

      case 'magic-import': {
        const subject = positionalArgs[1] || 'Krusch Companion Schedule Import';
        const bodyText = positionalArgs.slice(2).join(' ') || '';
        const result = await connector.calendar.sendMagicImportDigest({
          subject,
          bodyText,
          dryRun: isDryRun
        });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ Sent Magic Import digest to ${result.recipientEmail} (dryRun: ${isDryRun}).`);
        }
        break;
      }

      case 'twin': {
        const entityType = positionalArgs[1] || null;
        const items = connector.companion.getLocalTwinItems({ entityType });
        if (isJson) {
          console.log(JSON.stringify({ count: items.length, items }, null, 2));
        } else {
          console.log(`Found ${items.length} local twin item(s):`);
          for (const item of items) {
            console.log(`- [${item.entity_type}] #${item.skylight_id}: ${item.title} (${item.status})`);
          }
        }
        break;
      }

      default: {
        console.error(`Unknown command: '${command}'. Run 'krusch-skylight --help' for available commands.`);
        process.exit(1);
      }
    }
  } catch (err) {
    if (isJson) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`❌ Error: ${err.message}`);
    }
    process.exit(1);
  } finally {
    await connector.close();
    process.exit(0);
  }
}

main();
