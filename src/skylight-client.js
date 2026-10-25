/**
 * Skylight Calendar 2 Cloud REST Client (@krusch/companion-skylight-connector)
 *
 * Interfaces with Skylight's backend endpoints (https://app.ourskylight.com/api)
 * supporting Frames, Categories (Family Profiles), Calendar Events, Chores,
 * Lists (Grocery / To-Do), Meals, and Rewards.
 *
 * Strictly enforces opt-in cloud egress via assertCloudAllowed().
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertCloudAllowed, envConfig, logConnectorDebug } from './config.js';

export const SKYLIGHT_API_VERSION = '2026-05-01';
const SKYLIGHT_OAUTH_CLIENT_ID = 'skylight-mobile';
const SKYLIGHT_OAUTH_REDIRECT_URI = 'https://ourskylight.com/welcome';

function extractSetCookies(res, cookieJar) {
  const rawCookies =
    typeof res?.headers?.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res?.headers?.get?.('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  for (const cookieStr of rawCookies) {
    const firstPart = String(cookieStr || '').split(';')[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      cookieJar.set(name, val);
    }
  }
}

function formatCookieHeader(cookieJar) {
  return Array.from(cookieJar.entries())
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export class SkylightCloudClient {
  constructor(config = {}) {
    this.baseUrl = (config.skylightBaseUrl || 'https://app.ourskylight.com').replace(/\/+$/, '');
    this.email = config.skylightEmail || null;
    this.password = config.skylightPassword || null;
    this.token = config.skylightToken || null;
    this.refreshToken = config.skylightRefreshToken || envConfig.skylightRefreshToken || null;
    this.groceryListId = config.skylightGroceryListId || null;
    this.todoListId = config.skylightTodoListId || null;
    this.userId = config.skylightUserId || null;
    this.defaultFrameId = config.skylightFrameId || 'default-frame';
    this.allowCloud = Boolean(config.allowCloud);
    this.fetchImpl = config.fetchImpl || fetch;
    this._authScheme = 'Bearer';
    this._skipCachedAccessToken = false;
    this.tokenCachePath =
      this.fetchImpl === fetch && config.companionDbPath
        ? path.join(path.dirname(config.companionDbPath), '.skylight-oauth-session.json')
        : null;
    const cached = this._readTokenCache();
    if (cached?.refreshToken) {
      this.refreshToken = cached.refreshToken;
    }
    if (cached?.accessToken && cached?.expiresAt && Date.now() < cached.expiresAt - 60_000) {
      this.token = cached.accessToken;
    }
  }

  /**
   * Returns true if credentials or bearer token are configured.
   */
  isConfigured() {
    return Boolean(this.token || this.refreshToken || (this.email && this.password));
  }

  _readTokenCache() {
    if (!this.tokenCachePath) return null;
    try {
      if (!fs.existsSync(this.tokenCachePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.tokenCachePath, 'utf8'));
      if (!parsed || parsed.baseUrl !== this.baseUrl) return null;
      if (this.email && parsed.email && parsed.email !== this.email) return null;
      return parsed;
    } catch (err) {
      logConnectorDebug('readTokenCache', err);
      return null;
    }
  }

  _writeTokenCache({ accessToken, refreshToken, expiresIn }) {
    if (!this.tokenCachePath || !accessToken) return;
    try {
      fs.mkdirSync(path.dirname(this.tokenCachePath), { recursive: true });
      const ttlMs = Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : 3600 * 1000;
      const payload = {
        baseUrl: this.baseUrl,
        email: this.email || null,
        accessToken,
        refreshToken: refreshToken || this.refreshToken || null,
        expiresAt: Date.now() + ttlMs,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.tokenCachePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (err) {
      logConnectorDebug('writeTokenCache', err);
    }
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
      if (this.token.startsWith('Bearer ') || this.token.startsWith('Basic ')) {
        headers.Authorization = this.token;
      } else if (this._authScheme === 'Basic' && this.userId) {
        const encoded = Buffer.from(`${this.userId}:${this.token}`).toString('base64');
        headers.Authorization = `Basic ${encoded}`;
      } else {
        headers.Authorization = `Bearer ${this.token}`;
      }
    }

    return headers;
  }

  /**
   * Perform Skylight's 4-step OAuth 2.0 + PKCE login flow against Rails + Doorkeeper.
   * Returns null if the target server does not serve an OAuth PKCE HTML login page
   * (allowing clean fallback to legacy /api/sessions in mock tests).
   */
  async _authenticateViaOAuthPkce() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const cookieJar = new Map();

    const authorizeQuery = new URLSearchParams({
      client_id: SKYLIGHT_OAUTH_CLIENT_ID,
      response_type: 'code',
      scope: 'everything',
      redirect_uri: SKYLIGHT_OAUTH_REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString();

    let currentUrl = `${this.baseUrl}/oauth/authorize?${authorizeQuery}`;
    let currentRes = await this.fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json',
        'User-Agent': 'SkylightMobile (web)'
      },
      signal: AbortSignal.timeout(10000)
    });
    extractSetCookies(currentRes, cookieJar);

    let authCode = null;
    for (let hop = 0; hop < 6 && [301, 302, 303, 307, 308].includes(currentRes.status); hop++) {
      const loc = currentRes.headers?.get?.('location');
      if (!loc) break;
      const nextUrl = new URL(loc, currentUrl).toString();
      const parsedNext = new URL(nextUrl);
      if (parsedNext.searchParams.get('code')) {
        const returnedState = parsedNext.searchParams.get('state');
        if (returnedState && returnedState !== state) {
          throw new Error('Skylight OAuth PKCE state mismatch during authorization.');
        }
        authCode = parsedNext.searchParams.get('code');
        break;
      }
      if (!nextUrl.startsWith(this.baseUrl)) break;

      const cookieHeader = formatCookieHeader(cookieJar);
      currentUrl = nextUrl;
      currentRes = await this.fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json',
          'User-Agent': 'SkylightMobile (web)',
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        signal: AbortSignal.timeout(10000)
      });
      extractSetCookies(currentRes, cookieJar);
    }

    if (!authCode) {
      if (!currentRes.ok) return null;
      const html = await currentRes.text();
      const csrfMatch =
        html.match(/<input[^>]*name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
      if (!csrfMatch) {
        return null;
      }
      const csrfToken = decodeHtmlEntities(csrfMatch[1]);

      const formMatch = html.match(
        /<form[^>]*action=["']([^"']*\/auth\/session[^"']*)["'][^>]*>([\s\S]*?)<\/form>/i
      );
      const rawAction = formMatch ? decodeHtmlEntities(formMatch[1]) : '/auth/session';
      const formInner = formMatch ? formMatch[2] : '';

      const formParams = new URLSearchParams();
      const hiddenInputRegex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
      let inputTagMatch;
      while ((inputTagMatch = hiddenInputRegex.exec(formInner)) !== null) {
        const tag = inputTagMatch[0];
        const nameMatch = tag.match(/name=["']([^"']+)["']/i);
        const valMatch = tag.match(/value=["']([^"']*)["']/i);
        if (nameMatch) {
          formParams.set(
            decodeHtmlEntities(nameMatch[1]),
            valMatch ? decodeHtmlEntities(valMatch[1]) : ''
          );
        }
      }
      if (!formParams.get('authenticity_token')) {
        formParams.set('authenticity_token', csrfToken);
      }
      formParams.set('email', this.email);
      formParams.set('password', this.password);

      const postUrl = new URL(rawAction, currentUrl).toString();
      const postCookies = formatCookieHeader(cookieJar);
      let hopUrlBase = postUrl;
      let hopRes = await this.fetchImpl(postUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'SkylightMobile (web)',
          Origin: new URL(this.baseUrl).origin,
          Referer: currentUrl,
          ...(postCookies ? { Cookie: postCookies } : {})
        },
        body: formParams.toString(),
        signal: AbortSignal.timeout(10000)
      });
      extractSetCookies(hopRes, cookieJar);

      for (let hop = 0; hop < 6 && [301, 302, 303, 307, 308].includes(hopRes.status); hop++) {
        const loc = hopRes.headers?.get?.('location');
        if (!loc) break;
        const nextUrl = new URL(loc, hopUrlBase).toString();
        const parsedNext = new URL(nextUrl);
        if (parsedNext.pathname.includes('/mfa_challenge')) {
          throw new Error(
            'Skylight Cloud requires interactive MFA verification (/auth/mfa_challenge). Provide a refreshed SKYLIGHT_TOKEN/SKYLIGHT_REFRESH_TOKEN or use the 2-way G-Krusch Google Calendar bridge.'
          );
        }
        if (parsedNext.searchParams.get('code')) {
          const returnedState = parsedNext.searchParams.get('state');
          if (returnedState && returnedState !== state) {
            throw new Error('Skylight OAuth PKCE state mismatch after login.');
          }
          authCode = parsedNext.searchParams.get('code');
          break;
        }
        if (parsedNext.searchParams.get('error')) {
          throw new Error(
            `Skylight OAuth error: ${parsedNext.searchParams.get('error_description') || parsedNext.searchParams.get('error')}`
          );
        }
        if (!nextUrl.startsWith(this.baseUrl)) break;

        const hopCookies = formatCookieHeader(cookieJar);
        hopUrlBase = nextUrl;
        hopRes = await this.fetchImpl(nextUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'SkylightMobile (web)',
            ...(hopCookies ? { Cookie: hopCookies } : {})
          },
          signal: AbortSignal.timeout(10000)
        });
        extractSetCookies(hopRes, cookieJar);
      }

      if (!authCode) {
        throw new Error(
          `Skylight OAuth PKCE login failed (HTTP ${hopRes.status}): no authorization code issued.`
        );
      }
    }

    const tokenRes = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'SkylightMobile (web)'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SKYLIGHT_OAUTH_CLIENT_ID,
        code: authCode,
        redirect_uri: SKYLIGHT_OAUTH_REDIRECT_URI,
        code_verifier: codeVerifier
      }).toString(),
      signal: AbortSignal.timeout(10000)
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new Error(
        `Skylight OAuth token exchange failed (HTTP ${tokenRes.status}): ${errText.slice(0, 160)}`
      );
    }

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('Skylight OAuth token response did not include access_token.');
    }

    this.token = tokenData.access_token;
    this._authScheme = 'Bearer';
    if (tokenData.refresh_token) {
      this.refreshToken = tokenData.refresh_token;
    }
    this._writeTokenCache({
      accessToken: this.token,
      refreshToken: this.refreshToken,
      expiresIn: tokenData.expires_in
    });

    return { ok: true, token: this.token, userId: this.userId, mode: 'oauth_pkce' };
  }

  /**
   * Authenticate with Skylight OAuth2 (cached token, refresh_token, or PKCE login)
   * with fallback to legacy /api/sessions.
   */
  async authenticate() {
    assertCloudAllowed(this.baseUrl, this.allowCloud);

    if (this.token) {
      return { ok: true, token: this.token, userId: this.userId, mode: 'token' };
    }

    const cached = this._readTokenCache();
    if (
      cached &&
      !this._skipCachedAccessToken &&
      cached.accessToken &&
      cached.expiresAt &&
      Date.now() < cached.expiresAt - 60_000
    ) {
      this.token = cached.accessToken;
      this._authScheme = 'Bearer';
      if (cached.refreshToken) this.refreshToken = cached.refreshToken;
      return { ok: true, token: this.token, userId: this.userId, mode: 'oauth_cache' };
    }
    this._skipCachedAccessToken = false;

    const candidateRefreshTokens = [
      ...(cached?.refreshToken ? [cached.refreshToken] : []),
      ...(this.refreshToken && this.refreshToken !== cached?.refreshToken ? [this.refreshToken] : [])
    ];

    for (const candidateRefresh of candidateRefreshTokens) {
      try {
        const refreshRes = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'SkylightMobile (web)'
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: SKYLIGHT_OAUTH_CLIENT_ID,
            refresh_token: candidateRefresh
          }).toString(),
          signal: AbortSignal.timeout(8000)
        });
        if (refreshRes.ok) {
          const tokenData = await refreshRes.json();
          if (tokenData.access_token) {
            this.token = tokenData.access_token;
            this._authScheme = 'Bearer';
            if (tokenData.refresh_token) this.refreshToken = tokenData.refresh_token;
            this._writeTokenCache({
              accessToken: this.token,
              refreshToken: this.refreshToken,
              expiresIn: tokenData.expires_in
            });
            return { ok: true, token: this.token, userId: this.userId, mode: 'oauth_refresh' };
          }
        }
      } catch (err) {
        logConnectorDebug('authenticate.refresh', err);
      }
    }

    if (!this.email || !this.password) {
      throw new Error(
        'Skylight credentials not configured. Set SKYLIGHT_TOKEN or SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD.'
      );
    }

    const pkceResult = await this._authenticateViaOAuthPkce();
    if (pkceResult) {
      return pkceResult;
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
    this._authScheme = payload.access_token || String(this.token || '').includes('.') ? 'Bearer' : (this.userId ? 'Basic' : 'Bearer');

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

    if (!this.token && (this.refreshToken || (this.email && this.password))) {
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

      if (
        res.status === 401 &&
        !reauthenticated &&
        (this.refreshToken || (this.email && this.password))
      ) {
        reauthenticated = true;
        this.token = null;
        this._skipCachedAccessToken = true;
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
  async listChores(
    frameId = this.defaultFrameId,
    { date = null, after = null, before = null, status = null } = {}
  ) {
    const fallbackDate = date || new Date().toISOString().slice(0, 10);
    const payload = await this._request(`/api/frames/${encodeURIComponent(frameId)}/chores`, {
      query: {
        after: after || fallbackDate,
        before: before || fallbackDate,
        date,
        status
      }
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

  static validateIdentifier(value, name = 'id') {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.trim())) {
      throw new TypeError(`Invalid ${name} supplied to deleteChore`);
    }
    return value.trim();
  }

  async deleteChore(frameId = this.defaultFrameId, choreId) {
    const validFrameId = SkylightCloudClient.validateIdentifier(frameId, 'frameId');
    const validChoreId = SkylightCloudClient.validateIdentifier(choreId, 'choreId');
    return this._request(
      `/api/frames/${encodeURIComponent(validFrameId)}/chores/${encodeURIComponent(validChoreId)}`,
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
    const groceryId = this.groceryListId || envConfig.skylightGroceryListId;
    if (groceryId && /^(grocery|groceries|shopping|grocery\s+list)$/i.test(raw)) {
      return groceryId;
    }
    const todoId = this.todoListId || envConfig.skylightTodoListId;
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
