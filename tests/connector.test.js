import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  createSkylightConnector,
  createCompanionToolPlugin,
  createUniversalToolPlugin,
  createUniversalSkylightAdapter,
  getMcpToolDefinitions,
  getOpenAiToolSchemas,
  getAnthropicToolSchemas,
  executeOpenAiToolCall,
  executeAnthropicToolUse,
  handleMcpJsonRpc,
  assertCloudAllowed,
  assertMatterNotPrivileged,
  assertNotPrivilegedContent,
  redactSensitiveText,
  sanitizeSyncRecord,
  maskToken,
  maskUrl
} from '../src/index.js';

describe('@krusch/companion-skylight-connector test suite', () => {
  let tmpDir;
  let testDbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-skylight-test-'));
    testDbPath = path.join(tmpDir, 'companion.db');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('enforces air-gap security guards unless ALLOW_SKYLIGHT=1 / allowCloud=true is set', () => {
    // Local / RFC1918 / Tailscale hosts are allowed even when allowCloud=false
    assert.equal(assertCloudAllowed('http://127.0.0.1:5446', false), true);
    assert.equal(assertCloudAllowed('http://192.168.1.100:3004', false), true);
    assert.equal(assertCloudAllowed('http://100.64.0.10:3004', false), true);

    // Public Skylight Cloud endpoint is blocked when allowCloud=false
    assert.throws(
      () => assertCloudAllowed('https://app.ourskylight.com', false),
      /AirGapSecurityError/
    );

    // Public Skylight Cloud endpoint is permitted when allowCloud=true
    assert.equal(assertCloudAllowed('https://app.ourskylight.com', true), true);

    // Privileged legal matter paths and tags are strictly blocked
    assert.throws(
      () => assertMatterNotPrivileged('/var/data/matters/case1.db'),
      /AirGapSecurityError/
    );
    assert.throws(
      () => assertNotPrivilegedContent('[PRIVILEGED] Tenant Defense Deposition Strategy'),
      /AirGapSecurityError/
    );
  });

  it('redacts sensitive API tokens, passwords, and SSNs before syncing to Skylight', () => {
    const raw =
      'Pay CPA invoice using key sk-proj-1234567890abcdefghijklmno and SSN 123-45-6789';
    const cleaned = redactSensitiveText(raw);
    assert.ok(!cleaned.includes('sk-proj-1234567890abcdefghijklmno'));
    assert.ok(!cleaned.includes('123-45-6789'));
    assert.ok(cleaned.includes('[REDACTED_SECRET]'));

    const { record, redacted } = sanitizeSyncRecord({
      id: 42,
      title: 'Rotate token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      notes: 'Normal note'
    });
    assert.equal(redacted, true);
    assert.equal(record.title, 'Rotate token [REDACTED_SECRET]');
    assert.equal(maskToken('skylight_secret_token_9999'), 'skyl...9999');
    assert.equal(maskUrl('https://user:supersecret@app.ourskylight.com'), 'https://user:********@app.ourskylight.com/');
  });

  it('pushes Companion Priority Board tasks to Skylight Chores with SHA-256 deduplication and pulls remote chores back', async () => {
    const apiCalls = [];
    const mockFetch = async (url, options = {}) => {
      apiCalls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });

      if (url.endsWith('/api/frames')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'frame-mom-2', type: 'frame', attributes: { name: 'Krusch Skylight Two' } }]
          }),
          { status: 200 }
        );
      }

      if (url.includes('/api/frames/frame-mom-2/chores') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            data: {
              id: `sky-chore-${apiCalls.length}`,
              type: 'chore',
              attributes: {
                title: body.title,
                completed: body.completed,
                reward_points: body.reward_points
              }
            }
          }),
          { status: 201 }
        );
      }

      if (url.includes('/api/frames/frame-mom-2/chores') && (!options.method || options.method === 'GET')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'sky-chore-remote-99',
                type: 'chore',
                attributes: {
                  title: 'Call Mom to thank her for Skylight 2',
                  status: 'pending',
                  completed: false,
                  start: '2026-10-16'
                }
              }
            ]
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const connector = createSkylightConnector({
      companionDbPath: testDbPath,
      skylightFrameId: 'frame-mom-2',
      skylightToken: 'test_bearer_token_123456',
      allowCloud: true,
      fetchImpl: mockFetch
    });

    try {
      // Seed 2 tasks into Companion SQLite DB (one with a secret to verify redaction)
      const db = connector.companion._getDb();
      db.prepare(
        `INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, completed, date)
         VALUES (1, 1, 'Core Values & Faith', 'Morning Scripture & Gratitude', '15 mins', 0, '2026-10-16')`
      ).run();
      db.prepare(
        `INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, completed, date)
         VALUES (2, 1, 'Family & Partner', 'Set up Skylight 2 Wi-Fi', 'Token sk-abcdefghijklmnopqrstuvwxyz123456', 1, '2026-10-16')`
      ).run();

      // 1. First push should sync both tasks (and redact the secret in task #2)
      const firstPush = await connector.companion.pushLocalTasksToChores({ date: '2026-10-16' });
      assert.equal(firstPush.total, 2);
      assert.equal(firstPush.pushed, 2);
      assert.equal(firstPush.skipped, 0);
      assert.equal(firstPush.redacted, 1);

      // 2. Second push with no changes should skip both via SHA-256 content hash
      const secondPush = await connector.companion.pushLocalTasksToChores({ date: '2026-10-16' });
      assert.equal(secondPush.pushed, 0);
      assert.equal(secondPush.skipped, 2);

      // 3. Pull remote chores with writeBack=true should add "Call Mom to thank her for Skylight 2" to Companion tasks
      const pullRes = await connector.companion.pullRemoteChoresToTasks({
        date: '2026-10-16',
        writeBack: true
      });
      assert.equal(pullRes.fetched, 1);
      assert.equal(pullRes.createdLocal, 1);

      const allLocalTasks = connector.companion.readLocalTasks({ date: '2026-10-16' });
      assert.equal(allLocalTasks.length, 3);
      assert.ok(allLocalTasks.some(t => t.title === 'Call Mom to thank her for Skylight 2'));

      // 4. Probe status verifies DB counts and Skylight Cloud connection
      const status = await connector.probeStatus();
      assert.equal(status.localCompanionDb.ok, true);
      assert.equal(status.localCompanionDb.tasksCount, 3);
      assert.equal(status.skylightCloud.ok, true);
      assert.equal(status.skylightCloud.framesCount, 1);
    } finally {
      await connector.close();
    }
  });

  it('supports pushing grocery list items, Google Calendar 2-way bridge, Magic Import, and Opt-In Companion Tool Plugin', async () => {
    let itemSeq = 100;
    const mockFetch = async (url, options = {}) => {
      if (url.includes('/lists/grocery/list_items') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({ id: `item-${++itemSeq}`, label: body.label, completed: false }),
          { status: 201 }
        );
      }
      if (url.includes('/meals') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            data: {
              id: `meal-${++itemSeq}`,
              type: 'meal',
              attributes: { summary: body.summary, date: body.date, meal_type: body.meal_type }
            }
          }),
          { status: 201 }
        );
      }
      if (url.includes('/meals') && (!options.method || options.method === 'GET')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'meal-104',
                type: 'meal',
                attributes: {
                  summary: 'Rosemary Garlic Ribeye & Asparagus',
                  date: '2026-10-18',
                  meal_type: 'dinner'
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/calendar_events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            data: {
              id: `evt-${++itemSeq}`,
              type: 'calendar_event',
              attributes: { summary: body.summary, starts_at: body.starts_at }
            }
          }),
          { status: 201 }
        );
      }
      if (url.endsWith('/api/calendar/events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({ event: { id: 'gcal-777', summary: body.summary, start: body.startTime } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/gmail/send') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({ ok: true, to: body.to, subject: body.subject }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    };

    const plugin = createCompanionToolPlugin({
      companionDbPath: testDbPath,
      skylightFrameId: 'frame-mom-2',
      skylightToken: 'test_bearer_token_123456',
      skylightMagicImportEmail: 'kruschfamily@ourskylight.com',
      allowCloud: true
    });

    // 1. Push grocery items via Companion Tool Plugin
    const listRes = await plugin.execute(
      { action: 'push_list_items', listId: 'grocery', items: 'Avocados, Sourdough, Espresso Beans' },
      { fetchImpl: mockFetch }
    );
    assert.equal(listRes.ok, true);
    assert.equal(listRes.data.pushed, 3);
    assert.equal(listRes.data.skipped, 0);

    // 1b. Re-pushing the exact same grocery items should deduplicate all 3 via SHA-256 content hash
    const listDedupRes = await plugin.execute(
      { action: 'push_list_items', listId: 'grocery', items: 'Avocados, Sourdough, Espresso Beans' },
      { fetchImpl: mockFetch }
    );
    assert.equal(listDedupRes.ok, true);
    assert.equal(listDedupRes.data.pushed, 0);
    assert.equal(listDedupRes.data.skipped, 3);

    // 2. Plan a meal and verify deduplication + listing via Companion Tool Plugin
    const mealRes = await plugin.execute(
      {
        action: 'plan_meal',
        title: 'Rosemary Garlic Ribeye & Asparagus',
        date: '2026-10-18',
        mealType: 'dinner',
        description: 'Reverse sear at 250F'
      },
      { fetchImpl: mockFetch }
    );
    assert.equal(mealRes.ok, true);
    assert.equal(mealRes.data.skipped, false);

    const mealDedupRes = await plugin.execute(
      {
        action: 'plan_meal',
        title: 'Rosemary Garlic Ribeye & Asparagus',
        date: '2026-10-18',
        mealType: 'dinner',
        description: 'Reverse sear at 250F'
      },
      { fetchImpl: mockFetch }
    );
    assert.equal(mealDedupRes.ok, true);
    assert.equal(mealDedupRes.data.skipped, true);

    const listMealsRes = await plugin.execute(
      { action: 'list_meals', date: '2026-10-18' },
      { fetchImpl: mockFetch }
    );
    assert.equal(listMealsRes.ok, true);
    assert.ok(listMealsRes.data.count >= 1);

    // 3. Create calendar event and verify SHA-256 event deduplication
    const evtRes1 = await plugin.execute(
      {
        action: 'create_event',
        title: 'Family Sunday Brunch',
        startTime: '2026-10-18T18:00:00.000Z',
        location: 'Mom\'s House'
      },
      { fetchImpl: mockFetch }
    );
    assert.equal(evtRes1.ok, true);
    assert.equal(evtRes1.data.skipped, false);

    const evtRes2 = await plugin.execute(
      {
        action: 'create_event',
        title: 'Family Sunday Brunch',
        startTime: '2026-10-18T18:00:00.000Z',
        location: 'Mom\'s House'
      },
      { fetchImpl: mockFetch }
    );
    assert.equal(evtRes2.ok, true);
    assert.equal(evtRes2.data.skipped, true);
    assert.equal(evtRes2.data.mode, 'deduplicated');

    // 4. Magic Import email bridge via Companion Tool Plugin
    const magicRes = await plugin.execute(
      {
        action: 'magic_import',
        title: 'Sunday Family Dinner Schedule',
        description: 'Sunday 5:30 PM at Mom\'s house'
      },
      { fetchImpl: mockFetch }
    );
    assert.equal(magicRes.ok, true);
    assert.equal(magicRes.data.recipientEmail, 'kruschfamily@ourskylight.com');
  });

  it('automatically refreshes expired 401 tokens and retries transient 503 errors in SkylightCloudClient', async () => {
    let framesAttempts = 0;
    let authCalled = 0;

    const mockResilientFetch = async (url, options = {}) => {
      if (url.endsWith('/api/sessions') && options.method === 'POST') {
        authCalled++;
        return new Response(
          JSON.stringify({ data: { attributes: { token: 'refreshed_token_xyz_999' } } }),
          { status: 200 }
        );
      }

      if (url.endsWith('/api/frames')) {
        framesAttempts++;
        if (framesAttempts === 1) {
          // Simulate expired token (401)
          return new Response(JSON.stringify({ error: 'Token expired' }), { status: 401 });
        }
        if (framesAttempts === 2) {
          // Simulate transient 503 gateway error
          return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 });
        }
        return new Response(
          JSON.stringify({
            data: [{ id: 'frame-mom-2', type: 'frame', attributes: { name: 'Krusch Skylight Two' } }]
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const connector = createSkylightConnector({
      companionDbPath: testDbPath,
      skylightFrameId: 'frame-mom-2',
      skylightToken: 'expired_initial_token',
      skylightEmail: 'family@krusch.dev',
      skylightPassword: 'super_secret_password',
      allowCloud: true,
      fetchImpl: mockResilientFetch
    });

    try {
      const frames = await connector.skylight.listFrames();
      assert.equal(authCalled, 1);
      assert.equal(framesAttempts, 3);
      assert.equal(frames.length, 1);
      assert.equal(connector.skylight.token, 'refreshed_token_xyz_999');
    } finally {
      await connector.close();
    }
  });

  it('executes the krusch-skylight CLI with --version and status --json', () => {
    const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/krusch-skylight.js');
    const verOut = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    assert.match(verOut, /@krusch\/companion-skylight-connector/);

    const statusOut = execFileSync(process.execPath, [cliPath, 'status', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KRUSCH_COMPANION_DB_PATH: testDbPath,
        ALLOW_SKYLIGHT: '0'
      }
    });
    const parsed = JSON.parse(statusOut);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.probe.localCompanionDb.ok, true);
  });

  it('syncs Priority Board tasks via G-Krusch Google Calendar bridge when SKYLIGHT_TOKEN is not set', async () => {
    const gcalDbPath = path.join(tmpDir, 'companion-gcal-bridge.db');
    let gcalEventSeq = 500;
    const gcalCreatedEvents = [];

    const mockGCalFetch = async (url, options = {}) => {
      if (url.endsWith('/api/calendar/events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        gcalCreatedEvents.push(body);
        return new Response(
          JSON.stringify({
            event: {
              id: `gcal-bridge-${++gcalEventSeq}`,
              summary: body.summary,
              start: body.startTime
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/calendar/events') && (!options.method || options.method === 'GET')) {
        return new Response(
          JSON.stringify({
            events: gcalCreatedEvents.map((e, i) => ({
              id: `gcal-bridge-${501 + i}`,
              summary: e.summary,
              start: { dateTime: e.startTime }
            }))
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const connector = createSkylightConnector({
      companionDbPath: gcalDbPath,
      allowCloud: false,
      fetchImpl: mockGCalFetch
    });

    try {
      const db = connector.companion._getDb();
      db.prepare(
        `INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, completed, date)
         VALUES (1, 1, 'Family & Partner', 'Pick up groceries for dinner', 'Milk and fruit', 0, '2026-10-20')`
      ).run();
      db.prepare(
        `INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, completed, date)
         VALUES (2, 2, 'Life Admin & Finance', '[Email Action] Automated Promo Alert', 'Auto-generated', 0, '2026-10-20')`
      ).run();
    } finally {
      await connector.close();
    }

    const plugin = createCompanionToolPlugin({
      companionDbPath: gcalDbPath,
      allowCloud: false
    });

    // 1. Default Family Calendar Mode keeps personal Companion tasks off the shared family calendar
    const defaultSyncRes = await plugin.execute(
      { action: 'sync_tasks', date: '2026-10-20' },
      { fetchImpl: mockGCalFetch }
    );
    assert.equal(defaultSyncRes.ok, true);
    assert.equal(defaultSyncRes.data.mode, 'family_calendar_only');
    assert.equal(defaultSyncRes.data.pushed, 0);

    // 2. create_event routes household events to "family" and Mom/Grandparents events to "grandparents"
    const familyEvtRes = await plugin.execute(
      { action: 'create_event', title: 'Family Dinner with Sam at 6:30 PM', date: '2026-10-20' },
      { fetchImpl: mockGCalFetch }
    );
    assert.equal(familyEvtRes.ok, true);
    assert.equal(familyEvtRes.data.skipped, false);
    assert.equal(familyEvtRes.data.calendarProfile, 'family');
    assert.equal(familyEvtRes.data.event.summary, 'Family Dinner with Sam at 6:30 PM');

    const grandparentsEvtRes = await plugin.execute(
      { action: 'create_event', title: 'Mom watching the kids at 2:00 PM', date: '2026-10-20' },
      { fetchImpl: mockGCalFetch }
    );
    assert.equal(grandparentsEvtRes.ok, true);
    assert.equal(grandparentsEvtRes.data.calendarProfile, 'grandparents');
    assert.equal(grandparentsEvtRes.data.calendarLabel, 'Grandparents & Extended Family');

    // 3. Explicit opt-in (allowPersonalTaskSync: true) routes through G-Krusch Google Calendar bridge and skips [Email Action] spam
    const syncRes1 = await plugin.execute(
      { action: 'sync_tasks', date: '2026-10-20', allowPersonalTaskSync: true },
      { fetchImpl: mockGCalFetch }
    );
    assert.equal(syncRes1.ok, true);
    assert.equal(syncRes1.data.mode, 'google_calendar_bridge');
    assert.equal(syncRes1.data.total, 1);
    assert.equal(syncRes1.data.pushed, 1);
    assert.equal(syncRes1.data.skipped, 0);

    // 4. Second sync_tasks deduplicates via SHA-256 content hash
    const syncRes2 = await plugin.execute(
      { action: 'sync_tasks', date: '2026-10-20', allowPersonalTaskSync: true },
      { fetchImpl: mockGCalFetch }
    );
    assert.equal(syncRes2.ok, true);
    assert.equal(syncRes2.data.pushed, 0);
    assert.equal(syncRes2.data.skipped, 1);
  });

  it('supports OpenClaw, Hermes Agent, Anthropic, and MCP JSON-RPC 2.0 via Universal Skylight Adapter', async () => {
    const universalDbPath = path.join(tmpDir, 'openclaw-skylight.db');
    let seq = 800;

    const mockUniversalFetch = async (url, options = {}) => {
      if (url.endsWith('/api/calendar/events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            event: {
              id: `univ-evt-${++seq}`,
              summary: body.summary,
              start: body.startTime
            }
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    };

    const adapter = createUniversalSkylightAdapter({
      dbPath: universalDbPath,
      allowCloud: false,
      fetchImpl: mockUniversalFetch
    });

    // 1. Verify OpenAI / Hermes / OpenClaw tool schemas (unified and granular)
    const unifiedOpenAi = getOpenAiToolSchemas({ granular: false });
    assert.equal(unifiedOpenAi.length, 1);
    assert.equal(unifiedOpenAi[0].type, 'function');
    assert.equal(unifiedOpenAi[0].function.name, 'skylight_calendar');

    const granularOpenAi = getOpenAiToolSchemas({ granular: true });
    assert.equal(granularOpenAi.length, 10);
    assert.ok(granularOpenAi.some(t => t.function.name === 'skylight_create_event'));
    assert.ok(granularOpenAi.some(t => t.function.name === 'skylight_assign_chore'));

    // 2. Execute OpenAI / Hermes tool_call with stringified JSON arguments
    const openAiResp = await executeOpenAiToolCall(
      {
        id: 'call_hermes_01',
        function: {
          name: 'skylight_create_event',
          arguments: JSON.stringify({
            title: 'OpenClaw & Hermes Sync Check at 4:00 PM',
            date: '2026-10-21'
          })
        }
      },
      { dbPath: universalDbPath, allowCloud: false, fetchImpl: mockUniversalFetch }
    );
    assert.equal(openAiResp.role, 'tool');
    assert.equal(openAiResp.tool_call_id, 'call_hermes_01');
    assert.equal(openAiResp.result.ok, true);
    assert.equal(openAiResp.result.data.calendarProfile, 'family');

    // 3. Verify Anthropic / Claude tool_use execution
    const anthropicTools = getAnthropicToolSchemas({ granular: true });
    assert.equal(anthropicTools.length, 10);
    const anthropicResp = await executeAnthropicToolUse(
      {
        type: 'tool_use',
        id: 'toolu_claude_01',
        name: 'skylight_assign_chore',
        input: {
          title: 'Take out recycling',
          assignee: 'Alex',
          date: '2026-10-21'
        }
      },
      { dbPath: universalDbPath, allowCloud: false, fetchImpl: mockUniversalFetch }
    );
    assert.equal(anthropicResp.type, 'tool_result');
    assert.equal(anthropicResp.tool_use_id, 'toolu_claude_01');
    assert.equal(anthropicResp.is_error, false);
    assert.match(anthropicResp.content, /\[Alex\] Take out recycling/);

    // 4. Verify MCP JSON-RPC 2.0 protocol (initialize, tools/list, tools/call, resources/read)
    const initRes = await adapter.handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    });
    assert.equal(initRes.result.serverInfo.name, 'krusch-skylight-mcp');

    const listToolsRes = await handleMcpJsonRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    assert.equal(listToolsRes.result.tools.length, getMcpToolDefinitions().length);

    const callMealRes = await adapter.handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'skylight_plan_meal',
        arguments: {
          title: 'Grilled Tri-Tip & Chimichurri',
          date: '2026-10-21',
          mealType: 'dinner'
        }
      }
    });
    assert.equal(callMealRes.result.isError, false);
    assert.match(callMealRes.result.content[0].text, /Grilled Tri-Tip/);

    const readTwinRes = await adapter.handleMcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'skylight://twin' }
    });
    const twinPayload = JSON.parse(readTwinRes.result.contents[0].text);
    assert.ok(twinPayload.count >= 2);

    // 5. Verify CLI schema & skill outputs and createUniversalToolPlugin alias
    assert.equal(createUniversalToolPlugin, createCompanionToolPlugin);
    const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/krusch-skylight.js');
    const schemaOut = execFileSync(process.execPath, [cliPath, 'schema', 'manifest'], { encoding: 'utf8' });
    const manifest = JSON.parse(schemaOut);
    assert.ok(manifest.supportedAgents.includes('openclaw'));
    assert.ok(manifest.supportedAgents.includes('clawdbot'));
    assert.ok(manifest.supportedAgents.includes('claudebot'));
    assert.ok(manifest.supportedAgents.includes('grokbot'));
    assert.ok(manifest.supportedAgents.includes('muse'));
    assert.ok(manifest.supportedAgents.includes('hermes-agent'));

    const skillOut = execFileSync(process.execPath, [cliPath, 'skill'], { encoding: 'utf8' });
    assert.match(skillOut, /name: skylight-calendar/);

    // 6. Verify Streamable HTTP MCP & Bot Webhook Server (including optional API key auth & payload cap)
    const httpServer = await adapter.startMcpHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'test_mcp_secret_key',
      maxBodyBytes: 2048
    });
    try {
      const baseUrl = `http://127.0.0.1:${httpServer.port}`;

      // Unauthenticated request to /tools is rejected with 401 when apiKey is set
      const unauthRes = await fetch(`${baseUrl}/tools?format=grokbot&granular=1`);
      assert.equal(unauthRes.status, 401);

      const authHeaders = {
        Authorization: 'Bearer test_mcp_secret_key',
        'Content-Type': 'application/json'
      };

      const grokToolsRes = await fetch(`${baseUrl}/tools?format=grokbot&granular=1`, {
        headers: authHeaders
      });
      const grokTools = await grokToolsRes.json();
      assert.equal(grokTools.ok, true);
      assert.equal(grokTools.count, 10);

      const claudeToolsRes = await fetch(`${baseUrl}/tools?format=claudebot&granular=1`, {
        headers: authHeaders
      });
      const claudeTools = await claudeToolsRes.json();
      assert.equal(claudeTools.ok, true);
      assert.ok(claudeTools.tools[0].input_schema);

      const webhookRes = await fetch(`${baseUrl}/tools/call`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          tool: 'skylight_create_event',
          arguments: { title: 'GrokBot & Muse Sync Check at 5:00 PM', date: '2026-10-21' }
        })
      });
      const webhookData = await webhookRes.json();
      assert.equal(webhookData.ok, true);
      assert.equal(webhookData.data.calendarProfile, 'family');

      // Oversized payload (>2048 bytes) is rejected with 413 Payload Too Large
      const oversizedRes = await fetch(`${baseUrl}/tools/call`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          tool: 'skylight_create_event',
          arguments: { title: 'X'.repeat(3000) }
        })
      });
      assert.equal(oversizedRes.status, 413);
    } finally {
      await httpServer.close();
    }

    // 7. Verify BUG-01 & BUG-04: startMcpHttpServer rejects missing or invalid host/port/apiKey
    assert.throws(
      () => adapter.startMcpHttpServer({}),
      /Missing or invalid SKYLIGHT_MCP_\* configuration/
    );
    assert.throws(
      () => adapter.startMcpHttpServer({ port: -1, host: '127.0.0.1' }),
      /Missing or invalid SKYLIGHT_MCP_\* configuration/
    );
    assert.throws(
      () => adapter.startMcpHttpServer({ port: 5449, host: 'bad host!' }),
      /Missing or invalid SKYLIGHT_MCP_\* configuration/
    );
    assert.throws(
      () => adapter.startMcpHttpServer({ port: 5449, host: '127.0.0.1', apiKey: 'too_short' }),
      /Missing or invalid SKYLIGHT_MCP_\* configuration/
    );

    // 8. Verify BUG-03: unhandled error in request handler returns 500 JSON-RPC -32603
    const errServer = await adapter.startMcpHttpServer({
      port: 0,
      host: '127.0.0.1',
      onRequestBody: async () => {
        throw new Error('simulated internal failure');
      }
    });
    try {
      const errRes = await fetch(`http://127.0.0.1:${errServer.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
      });
      assert.equal(errRes.status, 500);
      const errBody = await errRes.json();
      assert.equal(errBody.jsonrpc, '2.0');
      assert.equal(errBody.error.code, -32603);
    } finally {
      await errServer.close();
    }

    // 9. Verify BUG-01 (Lap 3): CALENDAR_BRIDGE_URL in getUniversalAgentManifest respects env & fallback
    const prevBridgeUrl = process.env.CALENDAR_BRIDGE_URL;
    try {
      delete process.env.CALENDAR_BRIDGE_URL;
      assert.equal(
        adapter.getManifest().mcpServerConfig.mcpServers['krusch-skylight'].env.CALENDAR_BRIDGE_URL,
        'http://127.0.0.1:5446'
      );
      process.env.CALENDAR_BRIDGE_URL = 'http://10.0.0.2:5446/';
      assert.equal(
        adapter.getManifest().mcpServerConfig.mcpServers['krusch-skylight'].env.CALENDAR_BRIDGE_URL,
        'http://10.0.0.2:5446'
      );
    } finally {
      if (prevBridgeUrl === undefined) {
        delete process.env.CALENDAR_BRIDGE_URL;
      } else {
        process.env.CALENDAR_BRIDGE_URL = prevBridgeUrl;
      }
    }

    // 10. Verify BUG-01, BUG-03 & TEST-01 (Lap 4): CalendarSyncBridge validates gKruschUrl and enforces assertCloudAllowed
    const { CalendarSyncBridge } = await import('../src/calendar-bridge.js');
    assert.throws(
      () => new CalendarSyncBridge({ gKruschUrl: '' }),
      /gKruschUrl must be provided in configuration/
    );
    assert.throws(
      () => new CalendarSyncBridge({ gKruschUrl: 'https://evil.com', allowCloud: false }),
      /AirGapSecurityError/
    );
    const allowedBridge = new CalendarSyncBridge({ gKruschUrl: 'https://api.ourskylight.com', allowCloud: true });
    assert.equal(allowedBridge.gKruschUrl, 'https://api.ourskylight.com');

    // 11. Verify TEST-01 & TEST-02 (Lap 5): resolveCalendarBridgeUrl precedence and _resolveEventStartTime edge-cases
    const { resolveCalendarBridgeUrl } = await import('../src/config.js');
    const savedCalUrl = process.env.CALENDAR_BRIDGE_URL;
    const savedGKruschUrl = process.env.G_KRUSCH_URL;
    try {
      delete process.env.CALENDAR_BRIDGE_URL;
      delete process.env.G_KRUSCH_URL;
      assert.equal(resolveCalendarBridgeUrl('http://127.0.0.1:5446/'), 'http://127.0.0.1:5446');
      process.env.CALENDAR_BRIDGE_URL = 'http://10.0.0.2:5446/';
      assert.equal(resolveCalendarBridgeUrl(), 'http://10.0.0.2:5446');
    } finally {
      if (savedCalUrl === undefined) delete process.env.CALENDAR_BRIDGE_URL;
      else process.env.CALENDAR_BRIDGE_URL = savedCalUrl;
      if (savedGKruschUrl === undefined) delete process.env.G_KRUSCH_URL;
      else process.env.G_KRUSCH_URL = savedGKruschUrl;
    }

    const dateOnlyIso = allowedBridge._resolveEventStartTime({ startTime: '2026-10-25' });
    assert.equal(dateOnlyIso, new Date(2026, 9, 25, 10, 0, 0).toISOString());
    const timeOnlyIso = allowedBridge._resolveEventStartTime({ date: '2026-10-25', startTime: '3:30 pm' });
    assert.equal(timeOnlyIso, new Date(2026, 9, 25, 15, 30, 0).toISOString());

    // 12. Verify BUG-01 & BUG-02 (Pass 3): executeOpenAiToolCall and executeAnthropicToolUse catch rejections cleanly
    const openAiErrRes = await executeOpenAiToolCall(
      { id: 'call_err_1', function: { name: 'skylight_status', arguments: '{}' } },
      {
        executor: async () => {
          throw new Error('simulated OpenAI tool rejection');
        }
      }
    );
    assert.equal(openAiErrRes.tool_call_id, 'call_err_1');
    assert.equal(openAiErrRes.role, 'tool');
    assert.equal(openAiErrRes.result.ok, false);
    assert.match(openAiErrRes.result.error, /simulated OpenAI tool rejection/);

    const anthropicErrRes = await executeAnthropicToolUse(
      { id: 'toolu_err_1', name: 'skylight_status', input: {} },
      {
        executor: async () => {
          throw new Error('simulated Anthropic tool rejection');
        }
      }
    );
    assert.equal(anthropicErrRes.tool_use_id, 'toolu_err_1');
    assert.equal(anthropicErrRes.is_error, true);
    assert.equal(anthropicErrRes.result.ok, false);
    assert.match(anthropicErrRes.result.error, /simulated Anthropic tool rejection/);

    // 13. Verify SEC-01 (Pass 4): SkylightCloudClient.deleteChore validates frameId and choreId
    const { SkylightCloudClient } = await import('../src/skylight-client.js');
    const secClient = new SkylightCloudClient({
      skylightBaseUrl: 'http://127.0.0.1:19999',
      skylightToken: 'tok-test',
      fetchImpl: async () => new Response(JSON.stringify({ deleted: true }), { status: 200 })
    });
    await assert.rejects(() => secClient.deleteChore('', 'valid-chore-1'), {
      name: 'TypeError',
      message: /Invalid frameId supplied to deleteChore/
    });
    await assert.rejects(() => secClient.deleteChore('frame-1', '../bad-chore'), {
      name: 'TypeError',
      message: /Invalid choreId supplied to deleteChore/
    });
    const delOk = await secClient.deleteChore('frame-1', '123e4567-e89b-12d3-a456-426614174000');
    assert.equal(delOk.deleted, true);

    // 14. Verify SEC-01 & SEC-02 (Pass 5): loadEnvConfig centralization and createSkylightConnector option validation
    const { loadEnvConfig, envConfig, validateConnectorOptions } = await import('../src/config.js');
    const savedGrocery = process.env.SKYLIGHT_GROCERY_LIST_ID;
    try {
      process.env.SKYLIGHT_GROCERY_LIST_ID = '987654';
      assert.equal(loadEnvConfig().skylightGroceryListId, '987654');
      assert.equal(envConfig.skylightGroceryListId, '987654');
    } finally {
      if (savedGrocery === undefined) delete process.env.SKYLIGHT_GROCERY_LIST_ID;
      else process.env.SKYLIGHT_GROCERY_LIST_ID = savedGrocery;
    }

    assert.throws(
      () => validateConnectorOptions({ unknownEvilOption: true }),
      /Unknown Skylight Connector option key: "unknownEvilOption"/
    );
    assert.throws(
      () => createSkylightConnector({ dbPath: '   ' }),
      /Invalid Skylight Connector option "dbPath"/
    );
    assert.throws(
      () => createSkylightConnector({ companionDbPath: '/tmp/privileged/db.sqlite' }),
      /AirGapSecurityError/
    );

    // 15. Verify SEC-01 & PERF-01 (Pass 6): executeUniversalToolCall validates rawArgs type and enforces concurrency/timeout limits
    const { executeUniversalToolCall } = await import('../src/universal-adapter.js');
    const invalidNumRes = await executeUniversalToolCall('skylight_status', 123);
    assert.deepEqual(invalidNumRes, {
      ok: false,
      tool: 'skylight_status',
      summary: 'Invalid argument type for skylight_status: number'
    });

    const invalidArrRes = await executeUniversalToolCall('skylight_status', '[]');
    assert.deepEqual(invalidArrRes, {
      ok: false,
      tool: 'skylight_status',
      summary: 'Invalid argument type for skylight_status: array'
    });

    const timeoutRes = await executeUniversalToolCall(
      'skylight_status',
      {},
      {
        callTimeoutMs: 20,
        plugin: {
          execute: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 100))
        }
      }
    );
    assert.deepEqual(timeoutRes, {
      ok: false,
      tool: 'skylight_status',
      summary: 'Tool call timed out'
    });

    let releaseSlowCall;
    const slowPromise = executeUniversalToolCall(
      'skylight_status',
      {},
      {
        maxConcurrent: 1,
        plugin: {
          execute: () =>
            new Promise(resolve => {
              releaseSlowCall = () => resolve({ ok: true, tool: 'skylight_status', summary: 'ok' });
            })
        }
      }
    );
    const overloadRes = await executeUniversalToolCall(
      'skylight_status',
      {},
      {
        maxConcurrent: 1,
        plugin: { execute: async () => ({ ok: true }) }
      }
    );
    assert.deepEqual(overloadRes, {
      ok: false,
      tool: 'skylight_status',
      summary: 'Server overloaded – too many concurrent tool calls'
    });
    releaseSlowCall();
    const completedSlow = await slowPromise;
    assert.equal(completedSlow.ok, true);

    // 16. Verify OAuth 2.0 + PKCE 4-step login & Bearer header with opaque Doorkeeper token + userId
    let capturedAuthHeader = null;
    let capturedState = null;
    let capturedChallenge = null;
    const mockPkceFetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/oauth/authorize' && (!options.headers?.Cookie || !options.headers.Cookie.includes('authed_sess'))) {
        capturedState = parsed.searchParams.get('state');
        capturedChallenge = parsed.searchParams.get('code_challenge');
        return new Response('', {
          status: 302,
          headers: {
            location: `/auth/session/new?${parsed.searchParams.toString()}`,
            'set-cookie': 'skylightcloud_session=prelogin_sess; path=/; httponly'
          }
        });
      }
      if (parsed.pathname === '/auth/session/new') {
        return new Response(
          `<html><head><meta name="csrf-token" content="rails_csrf_token_abc"></head>
           <body><form action="/auth/session?client_id=skylight-mobile&amp;state=${capturedState}" method="post">
             <input type="hidden" name="return_to" value="/oauth/authorize?state=${capturedState}" />
           </form></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (parsed.pathname === '/auth/session' && options.method === 'POST') {
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('authenticity_token'), 'rails_csrf_token_abc');
        assert.equal(form.get('email'), 'family@krusch.dev');
        assert.equal(options.headers.Cookie, 'skylightcloud_session=prelogin_sess');
        return new Response('', {
          status: 302,
          headers: {
            location: `/oauth/authorize?state=${capturedState}`,
            'set-cookie': 'skylightcloud_session=authed_sess; path=/; httponly'
          }
        });
      }
      if (parsed.pathname === '/oauth/authorize') {
        assert.equal(options.headers.Cookie, 'skylightcloud_session=authed_sess');
        return new Response('', {
          status: 302,
          headers: {
            location: `https://ourskylight.com/welcome?code=pkce_auth_code_777&state=${capturedState}`
          }
        });
      }
      if (parsed.pathname === '/oauth/token' && options.method === 'POST') {
        const tokenForm = new URLSearchParams(options.body);
        assert.equal(tokenForm.get('grant_type'), 'authorization_code');
        assert.equal(tokenForm.get('code'), 'pkce_auth_code_777');
        assert.ok(tokenForm.get('code_verifier').length >= 40);
        assert.ok(capturedChallenge.length >= 40);
        return new Response(
          JSON.stringify({
            access_token: 'opaque_doorkeeper_access_token_without_dots',
            refresh_token: 'opaque_doorkeeper_refresh_token_rotated',
            token_type: 'Bearer',
            expires_in: 7200
          }),
          { status: 200 }
        );
      }
      if (parsed.pathname === '/api/frames') {
        capturedAuthHeader = options.headers?.Authorization;
        return new Response(
          JSON.stringify({ data: [{ id: 'frame-test-101', type: 'frame', attributes: { name: 'Household Calendar' } }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const pkceClient = new SkylightCloudClient({
      skylightBaseUrl: 'https://app.ourskylight.com',
      skylightEmail: 'family@krusch.dev',
      skylightPassword: 'test_password',
      skylightUserId: 'user-test-202',
      allowCloud: true,
      fetchImpl: mockPkceFetch
    });
    const pkceFrames = await pkceClient.listFrames();
    assert.equal(pkceFrames.length, 1);
    assert.equal(pkceFrames[0].id, 'frame-test-101');
    assert.equal(capturedAuthHeader, 'Bearer opaque_doorkeeper_access_token_without_dots');
    assert.equal(pkceClient.refreshToken, 'opaque_doorkeeper_refresh_token_rotated');
  });
});

