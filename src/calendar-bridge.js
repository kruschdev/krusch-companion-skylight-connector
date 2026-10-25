/**
 * Calendar & Magic Import Bridge for @krusch/companion-skylight-connector
 *
 * Supports 3 synchronization modes for Skylight Calendar 2:
 * 1. Direct Skylight Calendar Events API (`/api/frames/:frameId/calendar_events`)
 * 2. G-Krusch Google Calendar 2-Way Sync Bridge (`http://127.0.0.1:5446/api/calendar/events`)
 * 3. Skylight "Magic Import" (Sidekick) Email Bridge (`<frame>@ourskylight.com` via G-Krusch Gmail)
 */

import { assertCloudAllowed, resolveCalendarBridgeUrl, sanitizeSyncRecord, logConnectorDebug } from './config.js';
import { computeContentHash, todayIso } from './companion-bridge.js';

export class CalendarSyncBridge {
  constructor(config = {}, skylightClient = null, companionBridge = null) {
    this.config = config;
    this.frameId = config.skylightFrameId || 'default-frame';
    if ('gKruschUrl' in config && (!config.gKruschUrl || typeof config.gKruschUrl !== 'string' || !config.gKruschUrl.trim())) {
      throw new Error('gKruschUrl must be provided in configuration');
    }
    this.gKruschUrl = (config.gKruschUrl || resolveCalendarBridgeUrl()).replace(/\/+$/, '');
    this.magicImportEmail = config.skylightMagicImportEmail || null;
    this.allowCloud = Boolean(config.allowCloud);
    assertCloudAllowed(this.gKruschUrl, this.allowCloud);
    this.skylightClient = skylightClient;
    this.companionBridge = companionBridge;
    this.fetchImpl = config.fetchImpl || fetch;
  }

  _resolveEventStartTime(event = {}) {
    const rawStart = event.startTime || event.starts_at;
    const baseDate = event.date && /^\d{4}-\d{2}-\d{2}$/.test(String(event.date).trim())
      ? String(event.date).trim()
      : todayIso();

    if (rawStart) {
      const parsed = new Date(rawStart);
      if (!isNaN(parsed.getTime())) {
        // If only YYYY-MM-DD was provided, schedule at 10:00 AM local time instead of midnight UTC
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(rawStart).trim())) {
          const [y, m, d] = String(rawStart).trim().split('-').map(Number);
          return new Date(y, m - 1, d, 10, 0, 0).toISOString();
        }
        return parsed.toISOString();
      }
      // Check if rawStart is a time like "3:30 PM" or "15:30"
      const timeMatch = String(rawStart).match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
      if (timeMatch) {
        let hour = Number(timeMatch[1]);
        const minute = Number(timeMatch[2] || 0);
        const meridiem = (timeMatch[3] || '').toLowerCase();
        if (meridiem === 'pm' && hour < 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
        const [y, m, d] = baseDate.split('-').map(Number);
        return new Date(y, m - 1, d, hour, minute, 0).toISOString();
      }
    }

    // Check if title contains an explicit time (e.g., "Soccer practice at 4:30 PM")
    const titleStr = String(event.summary || event.title || '');
    const titleTimeMatch = titleStr.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (titleTimeMatch) {
      let hour = Number(titleTimeMatch[1]);
      const minute = Number(titleTimeMatch[2] || 0);
      const meridiem = titleTimeMatch[3].toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      const [y, m, d] = baseDate.split('-').map(Number);
      return new Date(y, m - 1, d, hour, minute, 0).toISOString();
    }

    if (event.date && /^\d{4}-\d{2}-\d{2}$/.test(String(event.date).trim())) {
      const [y, m, d] = baseDate.split('-').map(Number);
      return new Date(y, m - 1, d, 10, 0, 0).toISOString();
    }

    return new Date(Date.now() + 3600 * 1000).toISOString();
  }

  /**
   * Resolve which of the two configured family calendars an event belongs to:
   * 1. Secondary / Extended Family Calendar (default: "grandparents" / "Grandparents & Extended Family")
   * 2. Primary Household Calendar (default: "family" / "Family Calendar")
   */
  _resolveTargetCalendar(event = {}) {
    const primaryProfile = this.config?.primaryCalendarProfile || 'family';
    const primaryLabel = this.config?.primaryCalendarLabel || 'Family Calendar';
    const primaryCalId = this.config?.primaryCalendarId || primaryProfile;

    const secondaryProfile = this.config?.secondaryCalendarProfile || 'grandparents';
    const secondaryLabel = this.config?.secondaryCalendarLabel || 'Grandparents & Extended Family';
    const secondaryCalId = this.config?.secondaryCalendarId || secondaryProfile;

    const rawTarget = String(event.calendar || event.calendarId || '').trim().toLowerCase();
    const combinedText = `${event.summary || event.title || ''} ${event.description || event.notes || ''}`;

    const isSecondaryExplicit = [
      secondaryProfile.toLowerCase(),
      secondaryCalId.toLowerCase(),
      'grandparents',
      'grandparent',
      'grandma',
      'grandpa',
      'mom',
      'extended',
      'together',
      'shared',
      'secondary'
    ].includes(rawTarget);

    const isPrimaryExplicit = [
      primaryProfile.toLowerCase(),
      primaryCalId.toLowerCase(),
      'family',
      'household',
      'primary',
      'ours'
    ].includes(rawTarget);

    const customWords = String(this.config?.extendedFamilyKeywords || '')
      .split(',')
      .map(s => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter(Boolean);
    const patternParts = [
      'mom',
      'grandma',
      'grandpa',
      'grandparents?',
      'nana',
      'grammy',
      'babysit(?:ting)?',
      'watching\\s+the\\s+kids',
      'together',
      ...customWords
    ];
    const secondaryRegex = new RegExp(`\\b(${patternParts.join('|')})\\b`, 'i');

    const isSecondaryInferred = !isPrimaryExplicit && secondaryRegex.test(combinedText);

    if (isSecondaryExplicit || isSecondaryInferred) {
      return {
        profile: secondaryProfile,
        label: secondaryLabel,
        calendarId: secondaryCalId
      };
    }

    return {
      profile: primaryProfile,
      label: primaryLabel,
      calendarId: primaryCalId
    };
  }

  /**
   * Create a calendar event on Skylight Calendar 2.
   * Uses Direct Skylight API when configured & opted-in, or falls back to the local
   * Google Calendar 2-Way Sync Bridge (routing to either Primary or Secondary Family Calendar).
   */
  async createCalendarEvent(
    event = {},
    { mode = 'auto', dryRun = false, redact = true } = {}
  ) {
    const targetCal = this._resolveTargetCalendar(event);
    const rawEvent = {
      title: event.summary || event.title || 'Scheduled Event',
      notes: event.description || event.notes || '',
      startTime: this._resolveEventStartTime(event),
      endTime: event.endTime || event.ends_at || null,
      location: event.location || '',
      allDay: Boolean(event.allDay),
      categoryId: event.categoryId || null,
      calendarProfile: targetCal.profile,
      calendarLabel: targetCal.label,
      calendarId: targetCal.calendarId
    };

    const { record: safeEvent, redacted } = sanitizeSyncRecord(rawEvent, { redact });
    const normalizedKey = `event:${targetCal.profile}:${safeEvent.title.trim().toLowerCase()}:${String(safeEvent.startTime).slice(0, 16)}`;
    const contentHash = computeContentHash({
      calendarProfile: targetCal.profile,
      title: safeEvent.title.trim(),
      startTime: safeEvent.startTime,
      endTime: safeEvent.endTime,
      location: safeEvent.location,
      notes: safeEvent.notes
    });

    if (this.companionBridge) {
      this.companionBridge._getDb();
      const existingMap = this.companionBridge._stmts.getSyncMapByLocal.get(
        'event',
        normalizedKey,
        this.frameId
      );
      if (existingMap && existingMap.content_hash === contentHash && !dryRun) {
        return {
          ok: true,
          skipped: true,
          mode: 'deduplicated',
          calendarProfile: targetCal.profile,
          calendarLabel: targetCal.label,
          redacted,
          event: {
            id: existingMap.skylight_id,
            calendarProfile: targetCal.profile,
            calendarLabel: targetCal.label,
            summary: safeEvent.title,
            startTime: safeEvent.startTime,
            endTime: safeEvent.endTime,
            location: safeEvent.location,
            description: safeEvent.notes
          }
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        skipped: false,
        mode: mode === 'auto' ? 'dry_run_preview' : mode,
        calendarProfile: targetCal.profile,
        calendarLabel: targetCal.label,
        redacted,
        event: {
          id: `dryrun-event-${Date.now()}`,
          calendarProfile: targetCal.profile,
          calendarLabel: targetCal.label,
          summary: safeEvent.title,
          startTime: safeEvent.startTime,
          endTime: safeEvent.endTime,
          location: safeEvent.location,
          description: safeEvent.notes
        }
      };
    }

    const useSkylightDirect =
      mode === 'skylight_api' ||
      (mode === 'auto' && this.allowCloud && this.skylightClient?.isConfigured());

    if (useSkylightDirect) {
      assertCloudAllowed(this.skylightClient.baseUrl, this.allowCloud);
      const created = await this.skylightClient.createEvent(this.frameId, {
        summary: safeEvent.title,
        startTime: safeEvent.startTime,
        endTime: safeEvent.endTime,
        location: safeEvent.location,
        description: safeEvent.notes,
        allDay: safeEvent.allDay,
        categoryId: safeEvent.categoryId
      });

      const skylightId = String(created.id || `evt-${Date.now()}`);
      if (this.companionBridge) {
        this.companionBridge._stmts.upsertSyncMap.run(
          'event',
          normalizedKey,
          skylightId,
          this.frameId,
          contentHash,
          0,
          'push',
          JSON.stringify({ mode: 'skylight_api', calendarProfile: targetCal.profile })
        );
        this.companionBridge.upsertLocalTwinItem({
          frameId: this.frameId,
          entityType: 'event',
          skylightId,
          title: safeEvent.title,
          status: 'scheduled',
          date: String(safeEvent.startTime).slice(0, 10),
          payload: created
        });
      }

      return {
        ok: true,
        skipped: false,
        mode: 'skylight_api',
        calendarProfile: targetCal.profile,
        calendarLabel: targetCal.label,
        redacted,
        event: created
      };
    }

    // Path 2: G-Krusch Google Calendar 2-Way Sync Bridge (local 127.0.0.1:5446 -> Google Calendar <-> Skylight 2)
    assertCloudAllowed(this.gKruschUrl, this.allowCloud);
    const res = await this.fetchImpl(`${this.gKruschUrl}/api/calendar/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: targetCal.calendarId,
        summary: safeEvent.title,
        startTime: safeEvent.startTime,
        endTime: safeEvent.endTime,
        location: safeEvent.location,
        description: safeEvent.notes
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`G-Krusch Calendar Bridge failed (HTTP ${res.status}): ${errText.slice(0, 160)}`);
    }

    const data = await res.json();
    const gEvent = data.event || data;
    const eventId = String(gEvent.id || `gcal-${Date.now()}`);

    if (this.companionBridge) {
      this.companionBridge._stmts.upsertSyncMap.run(
        'event',
        normalizedKey,
        eventId,
        this.frameId,
        contentHash,
        0,
        'push',
        JSON.stringify({ mode: 'google_calendar_bridge', calendarProfile: targetCal.profile })
      );
      this.companionBridge.upsertLocalTwinItem({
        frameId: this.frameId,
        entityType: 'event',
        skylightId: eventId,
        title: safeEvent.title,
        status: 'synced_via_gcal',
        date: String(safeEvent.startTime).slice(0, 10),
        payload: { ...gEvent, calendarProfile: targetCal.profile, calendarLabel: targetCal.label }
      });
    }

    return {
      ok: true,
      skipped: false,
      mode: 'google_calendar_bridge',
      calendarProfile: targetCal.profile,
      calendarLabel: targetCal.label,
      redacted,
      event: {
        ...gEvent,
        calendarProfile: targetCal.profile,
        calendarLabel: targetCal.label
      }
    };
  }

  /**
   * Pull Calendar Events from Skylight Calendar 2 (or G-Krusch Google Calendar Bridge)
   * and cache them in the local Skylight twin table.
   */
  async pullCalendarEvents({
    startDate = todayIso(),
    endDate = null,
    calendar = 'both',
    mode = 'auto',
    writeBackToCompanion = false
  } = {}) {
    const useSkylightDirect =
      mode === 'skylight_api' ||
      (mode === 'auto' && this.allowCloud && this.skylightClient?.isConfigured());

    let events = [];
    let resolvedMode = 'local_twin';

    if (useSkylightDirect) {
      assertCloudAllowed(this.skylightClient.baseUrl, this.allowCloud);
      events = await this.skylightClient.listEvents(this.frameId, { startDate, endDate });
      resolvedMode = 'skylight_api';
    } else if (mode === 'google_calendar_bridge' || mode === 'auto') {
      try {
        assertCloudAllowed(this.gKruschUrl, this.allowCloud);
        const requestedCal = String(calendar || 'both').trim().toLowerCase();
        const primaryTarget = this._resolveTargetCalendar({ calendar: 'family' });
        const secondaryTarget = this._resolveTargetCalendar({ calendar: 'grandparents' });
        const targets =
          requestedCal === 'both' || requestedCal === 'all'
            ? [primaryTarget, secondaryTarget]
            : [this._resolveTargetCalendar({ calendar: requestedCal })];

        for (const t of targets) {
          const res = await this.fetchImpl(
            `${this.gKruschUrl}/api/calendar/events?limit=15&calendarId=${encodeURIComponent(t.calendarId)}`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (res.ok) {
            const data = await res.json();
            const fetched = (data.events || []).map(ev => ({
              ...ev,
              calendarProfile: t.profile,
              calendarLabel: t.label
            }));
            events.push(...fetched);
            resolvedMode = 'google_calendar_bridge';
          }
        }
      } catch (err) {
        logConnectorDebug('pullCalendarEvents.gKrusch', err);
      }
    }

    let createdTasks = 0;
    if (this.companionBridge && events.length > 0) {
      this.companionBridge._getDb();
      this.companionBridge._withTransaction(db => {
        const insertEventTaskStmt = db.prepare(
          `INSERT INTO tasks
            (priority_id, execution_priority, pillar, title, notes, completed, date)
           VALUES (2, 1, 'Family & Partner', ?, ?, 0, ?)`
        );
        for (const ev of events) {
          const skylightId = String(ev.id || computeContentHash(ev).slice(0, 12));
          const title = String(ev.summary || ev.title || 'Calendar Event').trim();
          const rawStart = ev.starts_at || ev.start || startDate;
          const evDate = String(rawStart).slice(0, 10);

          this.companionBridge.upsertLocalTwinItem({
            frameId: this.frameId,
            entityType: 'event',
            skylightId,
            title,
            status: 'scheduled',
            date: evDate,
            payload: ev
          });

          if (writeBackToCompanion) {
            const existing = this.companionBridge._stmts.getSyncMapBySkylight.get(
              'event',
              skylightId,
              this.frameId
            );

            if (!existing) {
              const insertRes = insertEventTaskStmt.run(
                `${title}${ev.location ? ` [${ev.location}]` : ''}`,
                ev.description || `Synced from Skylight Calendar (${rawStart})`,
                evDate
              );
              const localId = String(insertRes.lastInsertRowid);
              this.companionBridge._stmts.upsertSyncMap.run(
                'event',
                localId,
                skylightId,
                this.frameId,
                computeContentHash({ title, rawStart }),
                0,
                'pull',
                JSON.stringify({ source: resolvedMode })
              );
              createdTasks++;
            }
          }
        }
      });
    } else if (this.companionBridge && events.length === 0 && resolvedMode === 'local_twin') {
      events = this.companionBridge.getLocalTwinItems({
        frameId: this.frameId,
        entityType: 'event'
      });
    }

    return {
      ok: true,
      mode: resolvedMode,
      count: events.length,
      createdTasks,
      events
    };
  }

  /**
   * Send a schedule digest, flyer text, or grocery checklist to Skylight's
   * "Magic Import" (Sidekick) `<frame>@ourskylight.com` email address via local Gmail bridge.
   */
  async sendMagicImportDigest({
    subject = 'Krusch Companion Schedule & List Import',
    bodyText = '',
    recipientEmail = null,
    dryRun = false,
    redact = true
  } = {}) {
    const targetEmail = recipientEmail || this.magicImportEmail;
    if (!targetEmail) {
      throw new Error(
        'Skylight Magic Import email is not configured. Set SKYLIGHT_MAGIC_IMPORT_EMAIL (e.g. yourframe@ourskylight.com).'
      );
    }

    const { record: safePayload, redacted } = sanitizeSyncRecord(
      { title: subject, notes: bodyText },
      { redact }
    );

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        recipientEmail: targetEmail,
        subject: safePayload.title,
        bodyText: safePayload.notes,
        redacted
      };
    }

    assertCloudAllowed(this.gKruschUrl, this.allowCloud);
    const res = await this.fetchImpl(`${this.gKruschUrl}/api/gmail/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: targetEmail,
        subject: safePayload.title,
        body: safePayload.notes
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Magic Import email dispatch failed (HTTP ${res.status}): ${errText.slice(0, 160)}`);
    }

    const data = await res.json();
    return {
      ok: true,
      mode: 'magic_import_email',
      recipientEmail: targetEmail,
      subject: safePayload.title,
      redacted,
      response: data
    };
  }

  /**
   * Sync local Priority Board tasks for a given date onto Skylight Calendar 2
   * via the local 2-Way Google Calendar Bridge with SHA-256 deduplication.
   */
  async syncTasksViaGoogleCalendar({
    date = todayIso(),
    dryRun = false,
    redact = true,
    includeAutomatedEmailAlerts = false
  } = {}) {
    if (!this.companionBridge) {
      throw new Error('CompanionBridge instance is required for syncTasksViaGoogleCalendar.');
    }

    this.companionBridge._getDb();
    const rawTasks = this.companionBridge.readLocalTasks({ date, includeCompleted: false });
    const tasks = includeAutomatedEmailAlerts
      ? rawTasks
      : rawTasks.filter(t => !/^\[Email Action\]/i.test(String(t.title || '').trim()));

    const runId = this.companionBridge._startSyncRun('tasks_to_gcal_bridge', 'push', this.frameId, {
      date,
      dryRun
    });

    let pushed = 0;
    let skipped = 0;
    let redactedCount = 0;
    const syncedItems = [];

    try {
      for (let idx = 0; idx < tasks.length; idx++) {
        const rawTask = tasks[idx];
        const { record: safeTask, redacted } = sanitizeSyncRecord(rawTask, { redact });
        if (redacted) redactedCount++;

        const cleanTitle = String(safeTask.title || 'Companion Task').trim();
        const summary = `${safeTask.priority_emoji || '📋'} [Companion] ${cleanTitle}`;

        // Extract explicit time if present (e.g., "3:30 PM"), otherwise stagger morning slots starting at 09:00
        let startIso = `${date}T09:00:00`;
        const timeMatch = cleanTitle.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
        if (timeMatch) {
          let hr = parseInt(timeMatch[1], 10);
          const min = timeMatch[2];
          const mer = timeMatch[3].toUpperCase();
          if (mer === 'PM' && hr < 12) hr += 12;
          if (mer === 'AM' && hr === 12) hr = 0;
          const d = new Date(`${date}T00:00:00`);
          d.setHours(hr, parseInt(min, 10), 0, 0);
          if (!isNaN(d.getTime())) startIso = d.toISOString();
        } else {
          const base = new Date(`${date}T09:00:00`);
          if (!isNaN(base.getTime())) {
            base.setMinutes(base.getMinutes() + idx * 30);
            startIso = base.toISOString();
          }
        }

        const res = await this.createCalendarEvent(
          {
            summary,
            startTime: startIso,
            description: `Synced from Krusch Companion (${safeTask.pillar || safeTask.priority_name || 'Priority Board'})${safeTask.notes ? `\n${safeTask.notes}` : ''}`
          },
          { mode: 'google_calendar_bridge', dryRun, redact: false }
        );

        if (res.skipped) {
          skipped++;
        } else {
          pushed++;
        }

        syncedItems.push({
          localId: safeTask.id,
          skylightId: res.event?.id || `gcal-task-${safeTask.id}`,
          title: summary,
          startTime: startIso,
          skipped: Boolean(res.skipped),
          redacted
        });
      }

      this.companionBridge._finishSyncRun(runId, {
        status: 'completed',
        rowsSynced: pushed,
        rowsRedacted: redactedCount
      });

      return {
        ok: true,
        mode: 'google_calendar_bridge',
        frameId: this.frameId,
        date,
        dryRun,
        total: tasks.length,
        pushed,
        updated: 0,
        skipped,
        redacted: redactedCount,
        items: syncedItems
      };
    } catch (err) {
      this.companionBridge._finishSyncRun(runId, {
        status: 'failed',
        rowsSynced: pushed,
        rowsRedacted: redactedCount,
        errorMessage: err.message
      });
      throw err;
    }
  }
}
