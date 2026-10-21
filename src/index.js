/**
 * @krusch/companion-skylight-connector
 *
 * Standalone opt-in plugin & connector toolkit bridging Krusch Companion
 * (5-tier priority board, tasks, checklists, schedule) with Skylight Calendar 2.
 */

import { loadConfig, SCHEMA_VERSION } from './config.js';
import { SkylightCloudClient } from './skylight-client.js';
import { CompanionBridge, todayIso } from './companion-bridge.js';
import { CalendarSyncBridge } from './calendar-bridge.js';

export {
  loadConfig,
  validateSkylightConfig,
  envOr,
  envBool,
  logConnectorDebug,
  assertCloudAllowed,
  assertMatterNotPrivileged,
  assertNotPrivilegedContent,
  redactSensitiveText,
  sanitizeSyncRecord,
  maskUrl,
  maskToken,
  SCHEMA_VERSION
} from './config.js';
export { SkylightCloudClient } from './skylight-client.js';
export { CompanionBridge, todayIso } from './companion-bridge.js';
export { CalendarSyncBridge } from './calendar-bridge.js';
export {
  CONNECTOR_VERSION,
  GRANULAR_TOOL_DEFINITIONS,
  UNIFIED_TOOL_DEFINITION,
  getMcpToolDefinitions,
  getOpenAiToolSchemas,
  getAnthropicToolSchemas,
  executeUniversalToolCall,
  executeOpenAiToolCall,
  executeAnthropicToolUse,
  getUniversalAgentManifest,
  generateUniversalSkillMarkdown,
  handleMcpJsonRpc,
  startMcpStdioServer,
  startMcpHttpServer,
  createUniversalSkylightAdapter
} from './universal-adapter.js';

/**
 * Factory creating a fully configured Skylight Connector instance.
 * Supports both Krusch Companion (`companionDbPath` / `KRUSCH_COMPANION_DB_PATH`)
 * and standalone universal agents like OpenClaw & Hermes (`dbPath` / `SKYLIGHT_DB_PATH`).
 */
export function createSkylightConnector(options = {}) {
  const normalizedOptions = {
    ...options,
    ...(options.dbPath && !options.companionDbPath ? { companionDbPath: options.dbPath } : {}),
    ...(!options.companionDbPath &&
    !options.dbPath &&
    process.env.SKYLIGHT_DB_PATH &&
    !process.env.KRUSCH_COMPANION_DB_PATH
      ? { companionDbPath: process.env.SKYLIGHT_DB_PATH }
      : {})
  };
  const config = loadConfig(normalizedOptions);
  const skylight = new SkylightCloudClient(config);
  const companion = new CompanionBridge(config, skylight);
  const calendar = new CalendarSyncBridge(config, skylight, companion);

  return {
    config,
    skylight,
    companion,
    calendar,
    schemaVersion: SCHEMA_VERSION,

    /**
     * Diagnostic probe verifying local Companion SQLite DB, G-Krusch Calendar Bridge,
     * and remote Skylight Cloud connectivity.
     */
    async probeStatus() {
      const report = {
        schemaVersion: SCHEMA_VERSION,
        allowCloud: config.allowCloud,
        frameId: config.skylightFrameId,
        localCompanionDb: {
          ok: false,
          path: config.companionDbPath,
          tasksCount: 0,
          twinItemsCount: 0,
          syncRunsCount: 0,
          error: null
        },
        gKruschBridge: {
          ok: false,
          url: config.gKruschUrl,
          error: null
        },
        skylightCloud: {
          ok: false,
          configured: skylight.isConfigured(),
          framesCount: 0,
          error: null
        }
      };

      // 1. Local Companion SQLite probe
      try {
        const db = companion._getDb();
        const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get();
        const twinCount = db.prepare('SELECT COUNT(*) as cnt FROM skylight_local_twin').get();
        const runsCount = db.prepare('SELECT COUNT(*) as cnt FROM skylight_sync_runs').get();
        report.localCompanionDb.ok = true;
        report.localCompanionDb.tasksCount = Number(taskCount?.cnt || 0);
        report.localCompanionDb.twinItemsCount = Number(twinCount?.cnt || 0);
        report.localCompanionDb.syncRunsCount = Number(runsCount?.cnt || 0);
      } catch (err) {
        report.localCompanionDb.error = err.message;
      }

      // 2. Local G-Krusch Google Calendar Bridge probe
      try {
        const fetchImpl = config.fetchImpl || fetch;
        const gRes = await fetchImpl(`${config.gKruschUrl}/health`, {
          signal: AbortSignal.timeout(3000)
        });
        if (gRes.ok) {
          report.gKruschBridge.ok = true;
        } else {
          report.gKruschBridge.error = `HTTP ${gRes.status}`;
        }
      } catch (err) {
        report.gKruschBridge.error = err.message;
      }

      // 3. Remote Skylight Cloud API probe (only when opted in with ALLOW_SKYLIGHT=1 / ALLOW_CLOUD=1)
      if (config.allowCloud && skylight.isConfigured()) {
        try {
          const frames = await skylight.listFrames();
          report.skylightCloud.ok = true;
          report.skylightCloud.framesCount = frames.length;
        } catch (err) {
          report.skylightCloud.error = err.message;
        }
      } else if (!config.allowCloud) {
        report.skylightCloud.error = 'Air-gapped local mode (set ALLOW_SKYLIGHT=1 to enable cloud sync)';
      } else {
        report.skylightCloud.error = 'Credentials not configured (set SKYLIGHT_TOKEN or SKYLIGHT_EMAIL/SKYLIGHT_PASSWORD)';
      }

      return report;
    },

    /**
     * Full bidirectional synchronization cycle between Krusch Companion and Skylight Calendar 2.
     */
    async syncAll({ date = todayIso(), dryRun = false, writeBack = true } = {}) {
      if (config.allowCloud && skylight.isConfigured()) {
        const pushRes = await companion.pushLocalTasksToChores({ date, dryRun });
        let pullRes = null;
        if (!dryRun) {
          pullRes = await companion.pullRemoteChoresToTasks({ date, writeBack });
        }
        return {
          ok: true,
          mode: 'skylight_api',
          date,
          dryRun,
          pushedTasksToChores: pushRes,
          pulledChoresToTasks: pullRes
        };
      }

      const pushRes = await calendar.syncTasksViaGoogleCalendar({ date, dryRun });
      const pullRes = await calendar.pullCalendarEvents({
        startDate: date,
        writeBackToCompanion: !dryRun && writeBack
      });
      return {
        ok: true,
        mode: 'google_calendar_bridge',
        date,
        dryRun,
        pushedTasksToChores: pushRes,
        pulledEventsToTasks: pullRes
      };
    },

    async close() {
      await companion.close();
    }
  };
}

/**
 * Opt-in Companion Agent Tool Plugin factory.
 * Can be imported and registered into Krusch Companion's `COMPANION_TOOLS` array
 * when the user opts into Skylight Calendar 2 integration.
 */
export function createCompanionToolPlugin(options = {}) {
  return {
    name: 'skylight_calendar',
    category: 'skylight_calendar',
    description:
      'Opt-in Skylight Calendar 2 Connector: sync Today\'s Priority Board tasks with Skylight Chores, push grocery/checklist items to Skylight Lists, schedule or pull Skylight Calendar events, manage Meal Plans, or send a Magic Import digest.',
    parameters: {
      action:
        'string (REQUIRED: "status" | "sync_tasks" | "pull_chores" | "push_list_items" | "plan_meal" | "list_meals" | "list_events" | "create_event" | "magic_import")',
      title: 'string (OPTIONAL: Event, chore, meal, or list item title)',
      calendar:
        'string (OPTIONAL: "family" | "grandparents" | "both" — auto-routes Mom/Grandma/Grandparents schedule & joint events to "grandparents", and household events to "family")',
      items: 'array|string (OPTIONAL: Array or comma-separated list of grocery/checklist items for push_list_items)',
      listId: 'string (OPTIONAL: Skylight list ID or name, default: "grocery")',
      mealType: 'string (OPTIONAL: "breakfast" | "lunch" | "dinner" | "snack")',
      startTime: 'string (OPTIONAL: ISO-8601 start timestamp for create_event)',
      location: 'string (OPTIONAL: Event location for create_event)',
      date: 'string (OPTIONAL: Target YYYY-MM-DD date, defaults to today)',
      dryRun: 'boolean (OPTIONAL: Simulate sync without mutating remote Skylight cloud)'
    },
    required: ['action'],
    async execute(args = {}, context = {}) {
      const connector = createSkylightConnector({
        ...options,
        ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {})
      });

      try {
        const action = String(args.action || 'status').toLowerCase().trim();
        const dryRun = Boolean(args.dryRun);
        const date = args.date || todayIso();

        if (action === 'status') {
          const status = await connector.probeStatus();
          const primaryProfile = connector.config.primaryCalendarProfile || 'family';
          const primaryLabel = connector.config.primaryCalendarLabel || 'Family Calendar';
          const secondaryProfile = connector.config.secondaryCalendarProfile || 'grandparents';
          const secondaryLabel = connector.config.secondaryCalendarLabel || 'Grandparents & Extended Family';

          let familyCalId = connector.config.primaryCalendarId || primaryProfile;
          let grandparentsCalId = connector.config.secondaryCalendarId || secondaryProfile;
          if (status.gKruschBridge.ok) {
            try {
              const calRes = await connector.calendar.fetchImpl(
                `${connector.config.gKruschUrl}/api/calendar/calendars`,
                { signal: AbortSignal.timeout(4000) }
              );
              if (calRes.ok) {
                const calData = await calRes.json();
                familyCalId =
                  calData.profiles?.[primaryProfile]?.calendarId ||
                  calData.profiles?.family?.calendarId ||
                  familyCalId;
                grandparentsCalId =
                  calData.profiles?.[secondaryProfile]?.calendarId ||
                  calData.profiles?.grandparents?.calendarId ||
                  grandparentsCalId;
              }
            } catch {
              // Ignore optional profile lookup failure
            }
          }
          const magicEmail = connector.config.skylightMagicImportEmail || 'not configured';
          const gcalStatusLine = status.gKruschBridge.ok
            ? 'Connected (2-Way Dual-Calendar Sync Active ✅)'
            : `Unreachable (${status.gKruschBridge.error})`;
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_status',
            summary: `🗓️ **Skylight Calendar 2 Status (Dual Family Calendar Mode)**:\n- **Frame / Magic Import Email**: \`${magicEmail}\` (\`${status.frameId}\`)\n- **Calendar 1 — ${primaryLabel} (\`${primaryProfile}\`)**: \`${familyCalId}\`\n- **Calendar 2 — ${secondaryLabel} (\`${secondaryProfile}\`)**: \`${grandparentsCalId}\`\n- **Google Calendar Bridge**: ${gcalStatusLine}\n- **Personal Task Privacy**: Personal habits & tasks excluded by default`,
            data: {
              ...status,
              familyCalendarOnly: true,
              magicImportEmail: magicEmail,
              calendars: {
                [primaryProfile]: familyCalId,
                [secondaryProfile]: grandparentsCalId
              }
            }
          };
        }

        if (action === 'sync_tasks' || action === 'push_tasks') {
          const useDirect = connector.config.allowCloud && connector.skylight.isConfigured();
          if (useDirect) {
            const res = await connector.companion.pushLocalTasksToChores({ date, dryRun });
            return {
              ok: true,
              tool: 'skylight_calendar',
              actionType: 'skylight_sync_tasks',
              summary: `🗓️ **Skylight Calendar 2 Chore Sync (${date} via \`skylight_api\`)**: Pushed **${res.pushed}** new, updated **${res.updated || 0}**, skipped **${res.skipped}** unchanged (${res.redacted} redacted).`,
              data: res
            };
          }
          // In Family Calendar Mode (Google Calendar bridge), do NOT dump personal tasks/habits
          // onto the shared family calendar unless allowPersonalTaskSync: true is explicitly requested.
          const allowPersonalTaskSync = Boolean(args.allowPersonalTaskSync ?? options.allowPersonalTaskSync);
          if (!allowPersonalTaskSync) {
            return {
              ok: true,
              tool: 'skylight_calendar',
              actionType: 'skylight_sync_tasks',
              summary: `🗓️ **Skylight Family Calendar Mode**: Personal tasks and habits are kept off your Skylight family calendar by default. Use \`create_event\` (e.g. *"Add [event] to Skylight"*) to schedule shared family events.`,
              data: {
                ok: true,
                mode: 'family_calendar_only',
                familyCalendarOnly: true,
                date,
                dryRun,
                total: 0,
                pushed: 0,
                updated: 0,
                skipped: 0,
                redacted: 0,
                items: []
              }
            };
          }
          const res = await connector.calendar.syncTasksViaGoogleCalendar({ date, dryRun });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_sync_tasks',
            summary: `🗓️ **Skylight Calendar 2 Task Sync (${date} via \`${res.mode || 'google_calendar_bridge'}\`)**: Pushed **${res.pushed}** new, updated **${res.updated || 0}**, skipped **${res.skipped}** unchanged (${res.redacted} redacted).`,
            data: res
          };
        }

        if (action === 'assign_chore') {
          const choreTitle = String(args.title || args.summary || 'Household Chore').trim();
          const assigneePrefix = args.assignee ? `[${args.assignee}] ` : '';
          const defaultCal = connector.config.primaryCalendarProfile || 'family';
          const defaultLabel = connector.config.primaryCalendarLabel || 'Family Calendar';
          const res = await connector.calendar.createCalendarEvent(
            {
              summary: `🧹 ${assigneePrefix}${choreTitle}`,
              calendar: args.calendar || args.calendarId || defaultCal,
              date,
              startTime: args.startTime,
              description: args.notes || args.description || (args.stars ? `Reward: ${args.stars} stars` : 'Assigned via Skylight Connector')
            },
            { dryRun }
          );
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_assign_chore',
            summary: `🧹 **Assigned on Skylight Calendar 2 (${res.calendarLabel || defaultLabel})** *(via \`${res.mode}\`)*: **${res.event?.summary || choreTitle}**`,
            data: res
          };
        }

        if (action === 'pull_chores') {
          if (connector.config.allowCloud && connector.skylight.isConfigured()) {
            const res = await connector.companion.pullRemoteChoresToTasks({
              date,
              writeBack: args.writeBack !== false
            });
            return {
              ok: true,
              tool: 'skylight_calendar',
              actionType: 'skylight_pull_chores',
              summary: `🗓️ **Pulled Skylight Chores (${date})**: Fetched **${res.fetched}** chore(s) (${res.createdLocal} added to Companion Priority Board, ${res.updatedLocal} updated).`,
              data: res
            };
          }
          const res = await connector.calendar.pullCalendarEvents({
            startDate: date,
            calendar: args.calendar || args.calendarId || 'both',
            writeBackToCompanion: Boolean(args.writeBack)
          });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_pull_chores',
            summary: `🗓️ **Pulled Skylight Calendar Events (${date} via \`${res.mode}\`)**: Fetched **${res.count}** event(s).`,
            data: res
          };
        }

        if (action === 'push_list_items' || action === 'add_grocery_item' || action === 'add_grocery') {
          const rawItems = Array.isArray(args.items)
            ? args.items
            : String(args.items || args.title || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
          const res = await connector.companion.pushListItems({
            listId: args.listId || 'grocery',
            items: rawItems,
            taskId: args.taskId ?? null,
            dryRun
          });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_list_push',
            summary: `🛒 **Skylight List (\`${res.listId}\`) Updated**: Added **${res.pushed}** item(s) (${res.items.map(i => i.label).join(', ')}).`,
            data: res
          };
        }

        if (action === 'create_event' || action === 'add_event' || action === 'schedule') {
          const res = await connector.calendar.createCalendarEvent(
            {
              summary: args.title || args.summary || 'Scheduled Event',
              calendar: args.calendar || args.calendarId,
              date,
              startTime: args.startTime,
              endTime: args.endTime,
              location: args.location,
              description: args.description || args.notes
            },
            { dryRun }
          );
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_create_event',
            summary: `📅 **Added to ${res.calendarLabel || 'Skylight Family'} Calendar** *(via \`${res.mode}\`)*: **${res.event.summary || args.title}**`,
            data: res
          };
        }

        if (action === 'list_events') {
          const res = await connector.calendar.pullCalendarEvents({
            startDate: date,
            calendar: args.calendar || args.calendarId || 'both',
            writeBackToCompanion: Boolean(args.writeBack)
          });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_list_events',
            summary: `📅 **Skylight Calendar Events (${res.count})** *(source: \`${res.mode}\`)*`,
            data: res
          };
        }

        if (action === 'plan_meal' || action === 'create_meal') {
          const mealTitle = args.title || args.meal || args.summary || 'Family Dinner';
          const res = await connector.companion.pushMealPlan({
            title: mealTitle,
            date,
            mealType: args.mealType || args.category || 'dinner',
            notes: args.notes || args.description || '',
            dryRun
          });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_plan_meal',
            summary: `🍽️ **Skylight Meal Plan (${date} • ${res.mealType})**: **${mealTitle}** ${res.skipped ? '*(unchanged)*' : `*(synced via \`${res.mode}\`)*`}`,
            data: res
          };
        }

        if (action === 'list_meals') {
          const res = await connector.companion.listMealPlans({ date: args.date || null });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_list_meals',
            summary: `🍽️ **Skylight Meal Plans (${res.count})** *(source: \`${res.mode}\`)*`,
            data: res
          };
        }

        if (action === 'magic_import') {
          const res = await connector.calendar.sendMagicImportDigest({
            subject: args.title || 'Krusch Companion Schedule Import',
            bodyText: args.description || args.notes || '',
            recipientEmail: args.recipientEmail || null,
            dryRun
          });
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_magic_import',
            summary: `✉️ **Dispatched Skylight Magic Import Digest** to \`${res.recipientEmail}\`.`,
            data: res
          };
        }

        if (action === 'list_categories' || action === 'categories') {
          if (!connector.config.allowCloud || !connector.skylight.isConfigured()) {
            return {
              ok: true,
              tool: 'skylight_calendar',
              actionType: 'skylight_list_categories',
              summary:
                '🎨 **Skylight Categories**: Set `ALLOW_SKYLIGHT=1` and `SKYLIGHT_EMAIL` + `SKYLIGHT_PASSWORD` (or `SKYLIGHT_TOKEN`) in `.env` to query & edit Skylight frame categories (`category_ids`) and colors directly via `https://app.ourskylight.com/api`.',
              data: { configured: false, categories: [] }
            };
          }
          const categories = await connector.skylight.listCategories(connector.config.skylightFrameId);
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_list_categories',
            summary: `🎨 **Skylight Frame Categories (${categories.length})**:\n${categories.map(c => `- **${c.label || c.name}** (\`id: ${c.id}\`, color: \`${c.color || 'default'}\`)`).join('\n')}`,
            data: { configured: true, categories }
          };
        }

        if (action === 'fix_two_tone_events') {
          if (!connector.config.allowCloud || !connector.skylight.isConfigured()) {
            return {
              ok: false,
              tool: 'skylight_calendar',
              summary:
                'Set `ALLOW_SKYLIGHT=1` and `SKYLIGHT_EMAIL` + `SKYLIGHT_PASSWORD` (or `SKYLIGHT_TOKEN`) in `.env` so Krusch Companion can patch `category_ids` directly via the Skylight API.'
            };
          }
          const events = await connector.skylight.listEvents(connector.config.skylightFrameId, {
            startDate: date
          });
          const fixed = [];
          for (const ev of events) {
            const catIds = ev.category_ids || ev.categoryIds || [];
            if (Array.isArray(catIds) && catIds.length > 1) {
              const preferredId = args.categoryId || catIds[0];
              if (!dryRun) {
                await connector.skylight.updateEvent(connector.config.skylightFrameId, ev.id, {
                  categoryIds: [preferredId]
                });
              }
              fixed.push({ id: ev.id, summary: ev.summary || ev.title, before: catIds, after: [preferredId] });
            }
          }
          return {
            ok: true,
            tool: 'skylight_calendar',
            actionType: 'skylight_fix_two_tone',
            summary: `🎨 **Normalized Two-Tone Skylight Events (${fixed.length} updated to single solid category color)**.`,
            data: { count: fixed.length, fixed, dryRun }
          };
        }

        return {
          ok: false,
          tool: 'skylight_calendar',
          summary: `Unknown skylight_calendar action: '${action}'.`
        };
      } finally {
        await connector.close();
      }
    }
  };
}

export const createUniversalToolPlugin = createCompanionToolPlugin;

