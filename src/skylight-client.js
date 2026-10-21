/**
 * Skylight Calendar 2 Cloud REST Client (@krusch/companion-skylight-connector)
 *
 * Interfaces with Skylight's backend endpoints (https://app.ourskylight.com/api)
 * supporting Frames, Categories (Family Profiles), Calendar Events, Chores,
 * Lists (Grocery / To-Do), Meals, and Rewards.
 *
 * Strictly enforces opt-in cloud egress via assertCloudAllowed().
 */

import { assertCloudAllowed } from './config.js';

export const SKYLIGHT_API_VERSION = '2026-05-01';

export class SkylightCloudClient {
  constructor(config = {}) {
    this.baseUrl = (config.skylightBaseUrl || 'https://app.ourskylight.com').replace(/\/+$/, '');
    this.email = config.skylightEmail || null;
    this.password = config.skylightPassword || null;
    this.token = config.skylightToken || null;
    this.refreshToken = config.skylightRefreshToken || process.env.SKYLIGHT_REFRESH_TOKEN || null;
    this.userId = config.skylightUserId || null;
    this.defaultFrameId = config.skylightFrameId || 'default-frame';
    this.allowCloud = Boolean(config.allowCloud);
    this.fetchImpl = config.fetchImpl || fetch;
  }

  /**
   * Returns true if credentials or bearer token are configured.
   */
  isConfigured() {
    return Boolean(this.token || this.refreshToken || (this.email && this.password));
  }

  /**
   * Build standard Skylight mobile/web headers.
   */
  _headers(extra = {}) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'SkylightMobile (web)',
      'Skylight-Api-Version': SKYLIGHT_API_VERSION,
      ...extra
    };

    if (this.token) {
      if (this.userId && !this.token.startsWith('Bearer ') && !this.token.startsWith('Basic ')) {
        // Support both Bearer OAuth tokens and Basic userId:token session format
        if (this.token.includes('.')) {
          headers.Authorization = `Bearer ${this.token}`;
        } else {
          const encoded = Buffer.from(`${this.userId}:${this.token}`).toString('base64');
          headers.Authorization = `Basic ${encoded}`;
        }
      } else if (this.token.startsWith('Bearer ') || this.token.startsWith('Basic ')) {
        headers.Authorization = this.token;
      } else {
        headers.Authorization = `Bearer ${this.token}`;
      }
    }

    return headers;
  }

  /**
   * Authenticate with Skylight OAuth2 refresh_token or session endpoint if no token is present.
   */
  async authenticate() {
    assertCloudAllowed(this.baseUrl, this.allowCloud);

    if (this.token) {
      return { ok: true, token: this.token, userId: this.userId, mode: 'token' };
    }

    if (this.refreshToken) {
      try {
        const refreshRes = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: 'skylight-mobile',
            refresh_token: this.refreshToken
          }).toString(),
          signal: AbortSignal.timeout(8000)
        });
        if (refreshRes.ok) {
          const tokenData = await refreshRes.json();
          if (tokenData.access_token) {
            this.token = tokenData.access_token;
            if (tokenData.refresh_token) this.refreshToken = tokenData.refresh_token;
            return { ok: true, token: this.token, userId: this.userId, mode: 'oauth_refresh' };
          }
        }
      } catch {
        // Fall through to session login if refresh token fails
      }
    }

    if (!this.email || !this.password) {
      throw new Error(
        'Skylight credentials not configured. Set SKYLIGHT_TOKEN or SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD.'
      );
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        email: this.email,
        password: this.password
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Skylight authentication failed (HTTP ${res.status}): ${errBody.slice(0, 160)}`);
    }

    const payload = await res.json();
    const data = payload.data || payload;
    this.userId = data.id || data.user_id || this.userId;
    this.token =
      data.attributes?.token ||
      data.token ||
      payload.meta?.token ||
      payload.access_token ||
      null;

    if (!this.token) {
      throw new Error('Skylight authentication response did not include an access token.');
    }

    return { ok: true, token: this.token, userId: this.userId, mode: 'session_login' };
  }

  /**
   * Internal authenticated request helper with automatic JSON:API / flat payload normalization,
   * 401 token refresh re-authentication, and bounded transient error retry.
   */
  async _request(endpoint, { method = 'GET', body = null, query = null, retries = 1 } = {}) {
    assertCloudAllowed(this.baseUrl, this.allowCloud);

    if (!this.token && this.email && this.password) {
      await this.authenticate();
    }

    let url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    if (query && typeof query === 'object') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    let attempt = 0;
    let reauthenticated = false;

    while (true) {
      const res = await this.fetchImpl(url, {
        method,
        headers: this._headers(),
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000)
      });

      if (res.status === 401 && !reauthenticated && this.email && this.password) {
        reauthenticated = true;
        this.token = null;
        await this.authenticate();
        continue;
      }

      if ([429, 502, 503, 504].includes(res.status) && attempt < retries) {
        attempt++;
        await new Promise(resolve => setTimeout(resolve, 120 * attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Skylight API ${method} ${endpoint} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }

      if (res.status === 204) {
        return { ok: true };
      }

      return res.json();
    }
  }

  /**
   * Normalize JSON:API (`{ id, type, attributes }`) or standard JSON objects into clean flat records.
   */
  static normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.attributes && typeof raw.attributes === 'object') {
      return {
        id: String(raw.id),
        type: raw.type || null,
        ...raw.attributes
      };
    }
    return {
      ...raw,
      ...(raw.id !== undefined ? { id: String(raw.id) } : {})
    };
  }

  static normalizeList(payload, key = null) {
    if (!payload) return [];
    const arr =
      (key && Array.isArray(payload[key]) ? payload[key] : null) ||
      (Array.isArray(payload.data) ? payload.data : null) ||
      (Array.isArray(payload) ? payload : []);
    return arr.map(item => SkylightCloudClient.normalizeRecord(item));
  }

  /**
   * 1. Frames & Family Categories
   */
  async listFrames() {
    const payload = await this._request('/api/frames');
    return SkylightCloudClient.normalizeList(payload, 'frames');
  }

  async getFrame(frameId = this.defaultFrameId) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}`);
    return SkylightCloudClient.normalizeRecord(payload.data || payload.frame || payload);
  }

  async listCategories(frameId = this.defaultFrameId) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/categories`);
    return SkylightCloudClient.normalizeList(payload, 'categories');
  }

  async updateCategory(frameId = this.defaultFrameId, categoryId, patch = {}) {
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/categories/${encodeURIComponent(categoryId)}`,
      {
        method: 'PATCH',
        body: {
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {})
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.category || payload);
  }

  /**
   * 2. Chores (Maps to Krusch Companion 5-Tier Priority Board Tasks)
   */
  async listChores(frameId = this.defaultFrameId, { date = null, status = null } = {}) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/chores`, {
      query: { date, status }
    });
    return SkylightCloudClient.normalizeList(payload, 'chores');
  }

  async createChore(frameId = this.defaultFrameId, chore = {}) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/chores`, {
      method: 'POST',
      body: {
        summary: chore.summary || chore.title,
        title: chore.title || chore.summary,
        start: chore.date || chore.start || new Date().toISOString().slice(0, 10),
        status: chore.completed ? 'completed' : 'pending',
        completed: Boolean(chore.completed),
        category_id: chore.categoryId || chore.category_id || null,
        recurring: Boolean(chore.recurring),
        reward_points: chore.rewardPoints ?? chore.points ?? 0,
        notes: chore.notes || ''
      }
    });
    return SkylightCloudClient.normalizeRecord(payload.data || payload.chore || payload);
  }

  async updateChore(frameId = this.defaultFrameId, choreId, patch = {}) {
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/chores/${encodeURIComponent(choreId)}`,
      {
        method: 'PATCH',
        body: {
          ...(patch.title !== undefined ? { title: patch.title, summary: patch.title } : {}),
          ...(patch.completed !== undefined
            ? { completed: Boolean(patch.completed), status: patch.completed ? 'completed' : 'pending' }
            : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {})
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.chore || payload);
  }

  async deleteChore(frameId = this.defaultFrameId, choreId) {
    return this._request(
      `/api/frames/${encodeURIComponent(frameId)}/chores/${encodeURIComponent(choreId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * 3. Calendar Events
   */
  async listEvents(frameId = this.defaultFrameId, { startDate = null, endDate = null } = {}) {
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/calendar_events`,
      {
        query: {
          date_min: startDate,
          date_max: endDate
        }
      }
    );
    return SkylightCloudClient.normalizeList(payload, 'calendar_events');
  }

  async createEvent(frameId = this.defaultFrameId, event = {}) {
    // Enforce a single category_id by default when categoryId is provided so Skylight
    // renders a solid single-tone color bar instead of a multi-category two-tone stripe.
    const resolvedCategoryIds = Array.isArray(event.categoryIds)
      ? event.categoryIds
      : event.categoryId
        ? [event.categoryId]
        : [];
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/calendar_events`,
      {
        method: 'POST',
        body: {
          summary: event.summary || event.title || 'Scheduled Event',
          starts_at: event.startTime || event.starts_at || new Date().toISOString(),
          ends_at: event.endTime || event.ends_at || null,
          all_day: Boolean(event.allDay),
          location: event.location || '',
          description: event.description || event.notes || '',
          category_ids: resolvedCategoryIds
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.calendar_event || payload);
  }

  async updateEvent(frameId = this.defaultFrameId, eventId, patch = {}) {
    const resolvedCategoryIds = Array.isArray(patch.categoryIds)
      ? patch.categoryIds
      : patch.categoryId
        ? [patch.categoryId]
        : undefined;
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/calendar_events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        body: {
          ...(patch.summary !== undefined || patch.title !== undefined
            ? { summary: patch.summary || patch.title }
            : {}),
          ...(patch.startTime !== undefined ? { starts_at: patch.startTime } : {}),
          ...(patch.endTime !== undefined ? { ends_at: patch.endTime } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(resolvedCategoryIds !== undefined ? { category_ids: resolvedCategoryIds } : {})
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.calendar_event || payload);
  }

  async deleteEvent(frameId = this.defaultFrameId, eventId) {
    return this._request(
      `/api/frames/${encodeURIComponent(frameId)}/calendar_events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * 4. Lists (Grocery Lists & Shared Checklists)
   */
  _resolveNumericListId(_frameId, listId) {
    const raw = String(listId || 'grocery').trim();
    if (/^\d+$/.test(raw)) return raw;
    const groceryId = process.env.SKYLIGHT_GROCERY_LIST_ID;
    if (groceryId && /^(grocery|groceries|shopping|grocery\s+list)$/i.test(raw)) {
      return groceryId;
    }
    const todoId = process.env.SKYLIGHT_TODO_LIST_ID;
    if (todoId && /^(todo|to_do|to-do|to-do\s+list)$/i.test(raw)) {
      return todoId;
    }
    return raw;
  }

  async listLists(frameId = this.defaultFrameId) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/lists`);
    return SkylightCloudClient.normalizeList(payload, 'lists');
  }

  async getList(frameId = this.defaultFrameId, listId) {
    const resolvedId = this._resolveNumericListId(frameId, listId);
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/lists/${encodeURIComponent(resolvedId)}`
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.list || payload);
  }

  async createListItem(frameId = this.defaultFrameId, listId, item = {}) {
    const resolvedId = this._resolveNumericListId(frameId, listId);
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/lists/${encodeURIComponent(resolvedId)}/list_items`,
      {
        method: 'POST',
        body: {
          label: item.label || item.text || item.title,
          status: item.completed ? 'completed' : 'pending',
          completed: Boolean(item.completed),
          section: item.section || null
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.list_item || payload);
  }

  async updateListItem(frameId = this.defaultFrameId, listId, itemId, patch = {}) {
    const resolvedId = this._resolveNumericListId(frameId, listId);
    const payload = await this._request(
      `/api/frames/${encodeURIComponent(frameId)}/lists/${encodeURIComponent(resolvedId)}/list_items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        body: {
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.completed !== undefined
            ? { completed: Boolean(patch.completed), status: patch.completed ? 'completed' : 'pending' }
            : {})
        }
      }
    );
    return SkylightCloudClient.normalizeRecord(payload.data || payload.list_item || payload);
  }

  /**
   * 5. Meals & Rewards
   */
  async listMeals(frameId = this.defaultFrameId, { startDate = null, endDate = null } = {}) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/meals`, {
      query: { start_date: startDate, end_date: endDate }
    });
    return SkylightCloudClient.normalizeList(payload, 'meals');
  }

  async createMeal(frameId = this.defaultFrameId, meal = {}) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/meals`, {
      method: 'POST',
      body: {
        summary: meal.summary || meal.title,
        date: meal.date || new Date().toISOString().slice(0, 10),
        meal_type: meal.mealType || meal.category || 'dinner',
        recipe_notes: meal.notes || '',
        notes: meal.notes || ''
      }
    });
    return SkylightCloudClient.normalizeRecord(payload.data || payload.meal || payload);
  }

  async listRewards(frameId = this.defaultFrameId) {
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/rewards`);
    return SkylightCloudClient.normalizeList(payload, 'rewards');
  }
}
