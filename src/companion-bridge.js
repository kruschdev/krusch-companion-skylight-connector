/**
 * Companion Bridge for @krusch/companion-skylight-connector
 *
 * Bridges Krusch Companion's local SQLite WAL database (data/companion.db)
 * with Skylight Calendar 2 (Chores, Grocery/To-Do Lists, Meals, and Local Twin Cache).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import {
  assertCloudAllowed,
  assertMatterNotPrivileged,
  sanitizeSyncRecord,
  logConnectorDebug
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PRIORITY_TIER_POINTS = { 1: 50, 2: 30, 3: 20, 4: 15, 5: 10 };

export const DEFAULT_COMPANION_PRIORITIES = [
  { id: 1, name: 'Core Values & Faith', emoji: '🙏', color: '#f0c040', tier: 1 },
  { id: 2, name: 'Family & Partner', emoji: '💕', color: '#e8587a', tier: 2 },
  { id: 3, name: 'Children & Loved Ones', emoji: '👧', color: '#a78bfa', tier: 3 },
  { id: 4, name: 'Health & Self', emoji: '💪', color: '#2dd4bf', tier: 4 },
  { id: 5, name: 'Work & Mastery', emoji: '🔧', color: '#60a5fa', tier: 5 }
];

export function computeContentHash(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export class CompanionBridge {
  constructor(config = {}, skylightClient = null) {
    this.companionDbPath = config.companionDbPath;
    assertMatterNotPrivileged(this.companionDbPath);
    this.frameId = config.skylightFrameId || 'default-frame';
    this.defaultCategoryLabel = config.defaultCategoryLabel || 'Krusch';
    this.allowCloud = Boolean(config.allowCloud);
    this.skylightClient = skylightClient;
    this.db = null;
    this._stmts = null;
  }

  /**
   * Open and initialize the local SQLite database with Companion + Skylight Connector schemas
   * and pre-compiled prepared statements.
   */
  _getDb() {
    if (this.db) return this.db;
    assertMatterNotPrivileged(this.companionDbPath);

    const dir = path.dirname(this.companionDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.companionDbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    // Ensure core Companion tables exist if running standalone against a fresh DB
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS priorities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        color TEXT NOT NULL,
        tier INTEGER NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        priority_id INTEGER NOT NULL DEFAULT 5,
        execution_priority INTEGER NOT NULL DEFAULT 2,
        pillar TEXT,
        title TEXT NOT NULL,
        notes TEXT,
        checklist_json TEXT DEFAULT '[]',
        completed INTEGER DEFAULT 0,
        recurring INTEGER DEFAULT 0,
        energy_level TEXT DEFAULT 'medium',
        date TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Ensure checklist_json column exists on older Companion databases
    try {
      const cols = this.db.prepare(`PRAGMA table_info(tasks)`).all();
      if (!cols.some(c => c.name === 'checklist_json')) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN checklist_json TEXT DEFAULT '[]';`);
      }
    } catch (err) {
      logConnectorDebug('_getDb.checklist_json', err);
    }

    // Seed default 5-tier priorities if empty
    const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM priorities').get();
    if (!countRow || Number(countRow.cnt) === 0) {
      const insertPrio = this.db.prepare(
        'INSERT OR IGNORE INTO priorities (id, name, emoji, color, tier) VALUES (?, ?, ?, ?, ?)'
      );
      for (const p of DEFAULT_COMPANION_PRIORITIES) {
        insertPrio.run(p.id, p.name, p.emoji, p.color, p.tier);
      }
    }

    // Apply Connector Schema v1
    const schemaSqlPath = path.resolve(__dirname, '../sql/schema_v1.sql');
    if (fs.existsSync(schemaSqlPath)) {
      const sql = fs.readFileSync(schemaSqlPath, 'utf8');
      this.db.exec(sql);
    }

    // Cache hot prepared statements for O(1) lookup and upsert throughput
    this._stmts = {
      startSyncRun: this.db.prepare(
        `INSERT INTO skylight_sync_runs (domain, frame_id, direction, status, metadata_json)
         VALUES (?, ?, ?, 'running', ?)`
      ),
      finishSyncRun: this.db.prepare(
        `UPDATE skylight_sync_runs
         SET finished_at = datetime('now'),
             status = ?,
             rows_synced = ?,
             rows_redacted = ?,
             error_message = ?
         WHERE id = ?`
      ),
      upsertTwin: this.db.prepare(
        `INSERT INTO skylight_local_twin
          (frame_id, entity_type, skylight_id, title, status, date, category_label, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(frame_id, entity_type, skylight_id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           date = excluded.date,
           category_label = excluded.category_label,
           payload_json = excluded.payload_json,
           updated_at = datetime('now')`
      ),
      getSyncMapByLocal: this.db.prepare(
        `SELECT * FROM skylight_sync_map
         WHERE entity_type = ? AND local_id = ? AND frame_id = ?`
      ),
      getSyncMapBySkylight: this.db.prepare(
        `SELECT * FROM skylight_sync_map
         WHERE entity_type = ? AND skylight_id = ? AND frame_id = ?`
      ),
      upsertSyncMap: this.db.prepare(
        `INSERT OR REPLACE INTO skylight_sync_map
          (entity_type, local_id, skylight_id, frame_id, content_hash, completed, direction, last_synced_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      ),
      getLocalTaskById: this.db.prepare(`SELECT * FROM tasks WHERE id = ?`),
      updateLocalTaskFromChore: this.db.prepare(
        `UPDATE tasks
         SET title = ?,
             completed = ?,
             completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, datetime('now')) ELSE NULL END
         WHERE id = ?`
      ),
      insertLocalTaskFromChore: this.db.prepare(
        `INSERT INTO tasks
          (priority_id, execution_priority, pillar, title, notes, completed, recurring, date, completed_at)
         VALUES (2, 2, 'Family & Partner', ?, ?, ?, ?, ?, ?)`
      )
    };

    return this.db;
  }

  /**
   * Execute a synchronous SQLite batch block inside a single atomic transaction.
   */
  _withTransaction(fn) {
    const db = this._getDb();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn(db);
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch (rbErr) {
        logConnectorDebug('_withTransaction.rollback', rbErr);
      }
      throw err;
    }
  }

  /**
   * Read tasks from Krusch Companion's local SQLite database.
   */
  readLocalTasks({ date = null, includeCompleted = true } = {}) {
    const db = this._getDb();
    let sql = `
      SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.tier as priority_tier
      FROM tasks t
      LEFT JOIN priorities p ON t.priority_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (date) {
      sql += ` AND t.date = ?`;
      params.push(date);
    }
    if (!includeCompleted) {
      sql += ` AND t.completed = 0`;
    }

    sql += ` ORDER BY COALESCE(t.execution_priority, 2) ASC, t.priority_id ASC, t.id ASC`;
    return db.prepare(sql).all(...params);
  }

  /**
   * Record a sync audit run in skylight_sync_runs.
   */
  _startSyncRun(domain, direction = 'push', frameId = this.frameId, metadata = {}) {
    this._getDb();
    const res = this._stmts.startSyncRun.run(domain, frameId, direction, JSON.stringify(metadata));
    return Number(res.lastInsertRowid);
  }

  _finishSyncRun(runId, { status = 'completed', rowsSynced = 0, rowsRedacted = 0, errorMessage = null } = {}) {
    this._getDb();
    this._stmts.finishSyncRun.run(status, rowsSynced, rowsRedacted, errorMessage, runId);
  }

  /**
   * Upsert an item into the local Skylight twin cache (skylight_local_twin).
   */
  upsertLocalTwinItem({
    frameId = this.frameId,
    entityType,
    skylightId,
    title,
    status = 'active',
    date = null,
    categoryLabel = null,
    payload = {}
  }) {
    this._getDb();
    this._stmts.upsertTwin.run(
      frameId,
      entityType,
      String(skylightId),
      String(title || 'Untitled'),
      String(status),
      date || null,
      categoryLabel || this.defaultCategoryLabel,
      JSON.stringify(payload)
    );
  }

  /**
   * Query items from the local Skylight twin cache.
   */
  getLocalTwinItems({ frameId = this.frameId, entityType = null, date = null } = {}) {
    const db = this._getDb();
    let sql = `SELECT * FROM skylight_local_twin WHERE frame_id = ?`;
    const params = [frameId];
    if (entityType) {
      sql += ` AND entity_type = ?`;
      params.push(entityType);
    }
    if (date) {
      sql += ` AND date = ?`;
      params.push(date);
    }
    sql += ` ORDER BY updated_at DESC, id DESC`;
    return db
      .prepare(sql)
      .all(...params)
      .map(r => ({
        ...r,
        payload: (() => {
          try {
            return JSON.parse(r.payload_json || '{}');
          } catch (err) {
            logConnectorDebug('getLocalTwinItems.json', err);
            return {};
          }
        })()
      }));
  }

  /**
   * Push local Companion Priority Board tasks to Skylight Calendar 2 Chores.
   * Performs secret redaction, privileged matter checks, and SHA-256 content-hash deduplication.
   */
  async pushLocalTasksToChores({
    date = todayIso(),
    frameId = this.frameId,
    categoryId = null,
    dryRun = false,
    redact = true
  } = {}) {
    if (!dryRun) {
      assertCloudAllowed(this.skylightClient?.baseUrl || 'https://app.ourskylight.com', this.allowCloud);
    }

    this._getDb();
    const tasks = this.readLocalTasks({ date, includeCompleted: true });
    const runId = this._startSyncRun('tasks_to_chores', 'push', frameId, { date, dryRun });

    let pushed = 0;
    let updated = 0;
    let skipped = 0;
    let redactedCount = 0;
    const syncedItems = [];

    try {
      for (const rawTask of tasks) {
        const { record: safeTask, redacted } = sanitizeSyncRecord(rawTask, { redact });
        if (redacted) redactedCount++;

        const points = PRIORITY_TIER_POINTS[safeTask.priority_id] || 15;
        const hashPayload = {
          title: safeTask.title,
          notes: safeTask.notes || '',
          completed: Boolean(safeTask.completed),
          date: safeTask.date,
          priority_id: safeTask.priority_id
        };
        const contentHash = computeContentHash(hashPayload);

        const existingMap = this._stmts.getSyncMapByLocal.get('chore', String(safeTask.id), frameId);

        if (
          existingMap &&
          existingMap.content_hash === contentHash &&
          Number(existingMap.completed) === Number(Boolean(safeTask.completed))
        ) {
          skipped++;
          continue;
        }

        if (dryRun) {
          pushed++;
          syncedItems.push({
            localId: safeTask.id,
            skylightId: existingMap?.skylight_id || `dryrun-chore-${safeTask.id}`,
            title: safeTask.title,
            completed: Boolean(safeTask.completed),
            points,
            redacted
          });
          continue;
        }

        let remoteChore;
        if (existingMap) {
          remoteChore = await this.skylightClient.updateChore(frameId, existingMap.skylight_id, {
            title: safeTask.title,
            completed: Boolean(safeTask.completed),
            notes: safeTask.notes || '',
            categoryId
          });
          updated++;
        } else {
          remoteChore = await this.skylightClient.createChore(frameId, {
            title: safeTask.title,
            date: safeTask.date,
            completed: Boolean(safeTask.completed),
            recurring: Boolean(safeTask.recurring),
            rewardPoints: points,
            notes: safeTask.notes || '',
            categoryId
          });
          pushed++;
        }

        const skylightId = String(remoteChore?.id || existingMap?.skylight_id || `chore-${safeTask.id}`);

        this._stmts.upsertSyncMap.run(
          'chore',
          String(safeTask.id),
          skylightId,
          frameId,
          contentHash,
          safeTask.completed ? 1 : 0,
          'push',
          JSON.stringify({ points, priority_id: safeTask.priority_id })
        );

        this.upsertLocalTwinItem({
          frameId,
          entityType: 'chore',
          skylightId,
          title: safeTask.title,
          status: safeTask.completed ? 'completed' : 'pending',
          date: safeTask.date,
          categoryLabel: safeTask.pillar || safeTask.priority_name || this.defaultCategoryLabel,
          payload: remoteChore
        });

        syncedItems.push({
          localId: safeTask.id,
          skylightId,
          title: safeTask.title,
          completed: Boolean(safeTask.completed),
          points,
          redacted
        });
      }

      this._finishSyncRun(runId, {
        status: 'completed',
        rowsSynced: pushed + updated,
        rowsRedacted: redactedCount
      });

      return {
        ok: true,
        frameId,
        date,
        dryRun,
        total: tasks.length,
        pushed,
        updated,
        skipped,
        redacted: redactedCount,
        items: syncedItems
      };
    } catch (err) {
      this._finishSyncRun(runId, {
        status: 'failed',
        rowsSynced: pushed + updated,
        rowsRedacted: redactedCount,
        errorMessage: err.message
      });
      throw err;
    }
  }

  /**
   * Pull Chores from Skylight Calendar 2 into local twin cache, and optionally write back
   * new chores or completion status toggles into Krusch Companion's `tasks` table.
   */
  async pullRemoteChoresToTasks({
    date = todayIso(),
    frameId = this.frameId,
    writeBack = false
  } = {}) {
    assertCloudAllowed(this.skylightClient?.baseUrl || 'https://app.ourskylight.com', this.allowCloud);

    this._getDb();
    const runId = this._startSyncRun('chores_to_tasks', 'pull', frameId, { date, writeBack });

    try {
      const remoteChores = await this.skylightClient.listChores(frameId, { date });
      let createdLocal = 0;
      let updatedLocal = 0;

      this._withTransaction(() => {
        for (const chore of remoteChores) {
          const skylightId = String(chore.id);
          const title = String(chore.title || chore.summary || 'Skylight Chore').trim();
          const isCompleted =
            Boolean(chore.completed) || String(chore.status || '').toLowerCase() === 'completed';
          const choreDate = chore.start || chore.date || date;

          this.upsertLocalTwinItem({
            frameId,
            entityType: 'chore',
            skylightId,
            title,
            status: isCompleted ? 'completed' : 'pending',
            date: choreDate,
            categoryLabel: chore.category_name || this.defaultCategoryLabel,
            payload: chore
          });

          if (writeBack) {
            const existingMap = this._stmts.getSyncMapBySkylight.get('chore', skylightId, frameId);

            if (existingMap) {
              const localTask = this._stmts.getLocalTaskById.get(Number(existingMap.local_id));
              if (
                localTask &&
                (Number(localTask.completed) !== (isCompleted ? 1 : 0) || localTask.title !== title)
              ) {
                this._stmts.updateLocalTaskFromChore.run(
                  title,
                  isCompleted ? 1 : 0,
                  isCompleted ? 1 : 0,
                  localTask.id
                );
                updatedLocal++;
              }
            } else {
              const insertRes = this._stmts.insertLocalTaskFromChore.run(
                title,
                chore.notes || 'Synced from Skylight Calendar 2',
                isCompleted ? 1 : 0,
                chore.recurring ? 1 : 0,
                choreDate,
                isCompleted ? new Date().toISOString() : null
              );
              const newLocalId = String(insertRes.lastInsertRowid);
              const contentHash = computeContentHash({
                title,
                notes: chore.notes || 'Synced from Skylight Calendar 2',
                completed: isCompleted,
                date: choreDate,
                priority_id: 2
              });

              this._stmts.upsertSyncMap.run(
                'chore',
                newLocalId,
                skylightId,
                frameId,
                contentHash,
                isCompleted ? 1 : 0,
                'pull',
                JSON.stringify({ priority_id: 2 })
              );
              createdLocal++;
            }
          }
        }
      });

      this._finishSyncRun(runId, {
        status: 'completed',
        rowsSynced: remoteChores.length
      });

      return {
        ok: true,
        frameId,
        date,
        fetched: remoteChores.length,
        writeBack,
        createdLocal,
        updatedLocal,
        chores: remoteChores
      };
    } catch (err) {
      this._finishSyncRun(runId, {
        status: 'failed',
        errorMessage: err.message
      });
      throw err;
    }
  }

  /**
   * Push grocery / checklist items from Krusch Companion to a Skylight List.
   */
  async pushListItems({
    frameId = this.frameId,
    listId = 'grocery',
    items = [],
    taskId = null,
    dryRun = false,
    redact = true
  } = {}) {
    if (!dryRun) {
      assertCloudAllowed(this.skylightClient?.baseUrl || 'https://app.ourskylight.com', this.allowCloud);
    }

    const db = this._getDb();
    let resolvedItems = Array.isArray(items) ? [...items] : [];

    // If taskId is provided, extract checklist_json items from that Companion task
    if (taskId !== null && resolvedItems.length === 0) {
      const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(taskId));
      if (taskRow && taskRow.checklist_json) {
        try {
          const parsed = JSON.parse(taskRow.checklist_json);
          if (Array.isArray(parsed)) {
            resolvedItems = parsed.map(i => ({
              label: i.text || i.label || String(i),
              completed: Boolean(i.done || i.completed)
            }));
          }
        } catch (err) {
          logConnectorDebug('pushListItems.checklist_json', err);
        }
      }
    }

    const runId = this._startSyncRun('lists_sync', 'push', frameId, { listId, count: resolvedItems.length, dryRun });
    const pushedItems = [];
    let skipped = 0;
    let redactedCount = 0;

    try {
      for (const rawItem of resolvedItems) {
        const itemObj =
          typeof rawItem === 'string'
            ? { title: rawItem, completed: false }
            : { title: rawItem.label || rawItem.text || rawItem.title || '', completed: Boolean(rawItem.completed || rawItem.done) };

        if (!itemObj.title.trim()) continue;

        const { record: safeItem, redacted } = sanitizeSyncRecord(itemObj, { redact });
        if (redacted) redactedCount++;

        const normalizedKey = `${listId}:${safeItem.title.trim().toLowerCase()}`;
        const contentHash = computeContentHash({
          listId,
          label: safeItem.title.trim(),
          completed: safeItem.completed
        });

        const existingMap = this._stmts.getSyncMapByLocal.get('list_item', normalizedKey, frameId);
        if (
          existingMap &&
          existingMap.content_hash === contentHash &&
          Number(existingMap.completed) === (safeItem.completed ? 1 : 0)
        ) {
          skipped++;
          continue;
        }

        if (dryRun) {
          pushedItems.push({
            id: existingMap?.skylight_id || `dryrun-item-${pushedItems.length + 1}`,
            label: safeItem.title,
            completed: safeItem.completed,
            redacted
          });
          continue;
        }

        let remoteItem;
        if (existingMap && this.skylightClient?.updateListItem) {
          remoteItem = await this.skylightClient.updateListItem(frameId, listId, existingMap.skylight_id, {
            label: safeItem.title,
            completed: safeItem.completed
          });
        } else {
          remoteItem = await this.skylightClient.createListItem(frameId, listId, {
            label: safeItem.title,
            completed: safeItem.completed
          });
        }

        const skylightId = String(remoteItem?.id || existingMap?.skylight_id || `item-${Date.now()}-${pushedItems.length}`);
        this._stmts.upsertSyncMap.run(
          'list_item',
          normalizedKey,
          skylightId,
          frameId,
          contentHash,
          safeItem.completed ? 1 : 0,
          'push',
          JSON.stringify({ listId })
        );

        this.upsertLocalTwinItem({
          frameId,
          entityType: 'list_item',
          skylightId,
          title: safeItem.title,
          status: safeItem.completed ? 'completed' : 'pending',
          categoryLabel: listId,
          payload: remoteItem
        });

        pushedItems.push({
          id: skylightId,
          label: safeItem.title,
          completed: safeItem.completed,
          redacted
        });
      }

      this._finishSyncRun(runId, {
        status: 'completed',
        rowsSynced: pushedItems.length,
        rowsRedacted: redactedCount
      });

      return {
        ok: true,
        frameId,
        listId,
        dryRun,
        pushed: pushedItems.length,
        skipped,
        redacted: redactedCount,
        items: pushedItems
      };
    } catch (err) {
      this._finishSyncRun(runId, {
        status: 'failed',
        rowsSynced: pushedItems.length,
        rowsRedacted: redactedCount,
        errorMessage: err.message
      });
      throw err;
    }
  }

  /**
   * Plan or push a Meal entry to Skylight Calendar 2 with SHA-256 deduplication and secret redaction.
   */
  async pushMealPlan({
    frameId = this.frameId,
    title,
    date = todayIso(),
    mealType = 'dinner',
    notes = '',
    dryRun = false,
    redact = true
  } = {}) {
    if (!title || !String(title).trim()) {
      throw new Error('Meal title is required for pushMealPlan.');
    }
    if (!dryRun && this.allowCloud && this.skylightClient?.isConfigured()) {
      assertCloudAllowed(this.skylightClient.baseUrl, this.allowCloud);
    }

    this._getDb();
    const { record: safeMeal, redacted } = sanitizeSyncRecord(
      { title: String(title).trim(), notes: String(notes || '').trim() },
      { redact }
    );

    const normalizedKey = `${date}:${String(mealType).toLowerCase()}:${safeMeal.title.toLowerCase()}`;
    const contentHash = computeContentHash({
      date,
      mealType: String(mealType).toLowerCase(),
      title: safeMeal.title,
      notes: safeMeal.notes
    });

    const existingMap = this._stmts.getSyncMapByLocal.get('meal', normalizedKey, frameId);
    if (existingMap && existingMap.content_hash === contentHash) {
      return {
        ok: true,
        frameId,
        date,
        mealType,
        dryRun,
        skipped: true,
        redacted,
        meal: {
          id: existingMap.skylight_id,
          title: safeMeal.title,
          date,
          mealType,
          notes: safeMeal.notes
        }
      };
    }

    if (dryRun || !this.allowCloud || !this.skylightClient?.isConfigured()) {
      const twinId = existingMap?.skylight_id || `twin-meal-${computeContentHash(normalizedKey).slice(0, 10)}`;
      if (!dryRun) {
        this.upsertLocalTwinItem({
          frameId,
          entityType: 'meal',
          skylightId: twinId,
          title: safeMeal.title,
          status: 'planned',
          date,
          categoryLabel: mealType,
          payload: { id: twinId, summary: safeMeal.title, date, meal_type: mealType, notes: safeMeal.notes }
        });
        this._stmts.upsertSyncMap.run(
          'meal',
          normalizedKey,
          twinId,
          frameId,
          contentHash,
          0,
          'local_twin',
          JSON.stringify({ mealType, date })
        );
      }
      return {
        ok: true,
        frameId,
        date,
        mealType,
        dryRun,
        skipped: false,
        mode: dryRun ? 'dry_run' : 'local_twin',
        redacted,
        meal: { id: twinId, summary: safeMeal.title, date, mealType, notes: safeMeal.notes }
      };
    }

    const created = await this.skylightClient.createMeal(frameId, {
      title: safeMeal.title,
      date,
      mealType,
      notes: safeMeal.notes
    });
    const skylightId = String(created?.id || `meal-${Date.now()}`);

    this._stmts.upsertSyncMap.run(
      'meal',
      normalizedKey,
      skylightId,
      frameId,
      contentHash,
      0,
      'push',
      JSON.stringify({ mealType, date })
    );

    this.upsertLocalTwinItem({
      frameId,
      entityType: 'meal',
      skylightId,
      title: safeMeal.title,
      status: 'planned',
      date,
      categoryLabel: mealType,
      payload: created
    });

    return {
      ok: true,
      frameId,
      date,
      mealType,
      dryRun: false,
      skipped: false,
      mode: 'skylight_api',
      redacted,
      meal: created
    };
  }

  /**
   * List Meal Plans from Skylight Cloud or local twin cache.
   */
  async listMealPlans({ frameId = this.frameId, date = null } = {}) {
    if (this.allowCloud && this.skylightClient?.isConfigured()) {
      assertCloudAllowed(this.skylightClient.baseUrl, this.allowCloud);
      const meals = await this.skylightClient.listMeals(frameId, { startDate: date, endDate: date });
      for (const m of meals) {
        this.upsertLocalTwinItem({
          frameId,
          entityType: 'meal',
          skylightId: String(m.id || computeContentHash(m).slice(0, 10)),
          title: m.summary || m.title || 'Meal',
          status: 'planned',
          date: m.date || date,
          categoryLabel: m.meal_type || 'dinner',
          payload: m
        });
      }
      return { ok: true, mode: 'skylight_api', count: meals.length, meals };
    }
    const twinMeals = this.getLocalTwinItems({ frameId, entityType: 'meal', date });
    return { ok: true, mode: 'local_twin', count: twinMeals.length, meals: twinMeals };
  }

  async close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logConnectorDebug('close', err);
      }
      this.db = null;
      this._stmts = null;
    }
  }
}
