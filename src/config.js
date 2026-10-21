/**
 * Configuration loader, Air-Gap guard, and Secret Redaction for @krusch/companion-skylight-connector
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SCHEMA_VERSION = 1;

/**
 * Debug-guarded observability helper replacing silent catch blocks.
 */
export function logConnectorDebug(context, err) {
  if (process.env.KRUSCH_DEBUG === '1') {
    console.warn(`[SkylightConnector:${context}]`, err?.message || err);
  }
}

/**
 * Layered environment string reader.
 */
export function envOr(key, fallback = null) {
  const val = process.env[key];
  if (val === undefined || val === null || String(val).trim() === '') {
    return fallback;
  }
  return String(val).trim();
}

/**
 * Layered environment boolean reader.
 */
export function envBool(key, fallback = false) {
  const val = process.env[key];
  if (val === undefined || val === null || String(val).trim() === '') {
    return fallback;
  }
  const normalized = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,                                      // OpenAI / OpenRouter / Anthropic keys
  /cfut_[a-zA-Z0-9_-]{20,}/g,                                    // Cloudflare tokens
  /ghp_[a-zA-Z0-9]{20,}/g,                                       // GitHub personal access tokens
  /glpat-[a-zA-Z0-9_-]{20,}/g,                                   // GitLab tokens
  /AKIA[0-9A-Z]{16}/g,                                           // AWS Access Key ID
  /xox[baprs]-[0-9a-zA-Z]{10,}/g,                                // Slack API tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // Generic JWT tokens
  /(?:postgres|postgresql|mysql|redis|mongodb):\/\/[^:\s]+:[^@\s]+@[^\s]+/g, // Connection strings with passwords
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|KEY BLOCK)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|KEY BLOCK)-----/g, // Cryptographic private keys
  /(?:password|passwd|secret|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi, // Plaintext hardcoded secrets
  /\b\d{3}-\d{2}-\d{4}\b/g                                       // SSN format protection for shared household display
];

/**
 * Redacts any detected sensitive credentials or PII with [REDACTED_SECRET].
 */
export function redactSensitiveText(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  return result;
}

/**
 * Sanitizes or redacts a task, note, or calendar record before pushing to Skylight.
 */
export function sanitizeSyncRecord(record, options = {}) {
  const { redact = true } = options;
  const titleStr = String(record.title || record.summary || '');
  const notesStr = String(record.notes || record.description || '');
  const combined = `${titleStr} ${notesStr}`;

  assertNotPrivilegedContent(combined);

  let hasSecret = false;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(combined)) {
      hasSecret = true;
      break;
    }
  }

  if (hasSecret) {
    if (!redact) {
      throw new Error(
        `[SanitizationError] Record #${record.id || 'new'} contains sensitive credentials or PII. Sync to Skylight cloud rejected.`
      );
    }
    return {
      record: {
        ...record,
        ...(record.title !== undefined ? { title: redactSensitiveText(titleStr) } : {}),
        ...(record.summary !== undefined ? { summary: redactSensitiveText(titleStr) } : {}),
        ...(record.notes !== undefined ? { notes: redactSensitiveText(notesStr) } : {}),
        ...(record.description !== undefined ? { description: redactSensitiveText(notesStr) } : {})
      },
      redacted: true
    };
  }

  return { record, redacted: false };
}

/**
 * Robust check if a target host/URL is local, private RFC1918, Docker/K8s, Tailscale, or IPv6 ULA.
 */
export function isPrivateOrLocalHost(target) {
  if (!target) return false;
  let hostname = target;

  try {
    if (target.startsWith('/') || target.startsWith('socket:')) {
      return true;
    }
    if (target.includes('://')) {
      const parsed = new URL(target);
      hostname = parsed.hostname;
    } else {
      hostname = target.split(':')[0];
    }
  } catch (err) {
    logConnectorDebug('isPrivateOrLocalHost', err);
    hostname = target;
  }

  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  if (hostname.endsWith('.local') || hostname === 'localhost.localdomain') {
    return true;
  }
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  const match172 = hostname.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  // Tailscale CGNAT mesh (100.64.0.0/10)
  const match100 = hostname.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (match100) {
    const secondOctet = parseInt(match100[1], 10);
    if (secondOctet >= 64 && secondOctet <= 127) return true;
  }
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  if (/^(?:fc|fd|fe80)/i.test(hostname)) {
    return true;
  }
  return false;
}

/**
 * Validates that opt-in cloud egress is explicitly authorized when connecting to Skylight Cloud.
 * Fails closed if allowCloud is false and target is a remote public host.
 */
export function assertCloudAllowed(target, allowCloud) {
  if (allowCloud) return true;
  if (!target) {
    throw new Error(
      `[AirGapSecurityError] Target endpoint is empty or undefined. Cannot verify local boundary without ALLOW_SKYLIGHT=1 or ALLOW_CLOUD=1.`
    );
  }
  if (!isPrivateOrLocalHost(target)) {
    throw new Error(
      `[AirGapSecurityError] Cloud egress to '${target}' blocked. Set ALLOW_SKYLIGHT=1 (or ALLOW_CLOUD=1) in your environment to authorize opt-in synchronization with Skylight Calendar Cloud.`
    );
  }
  return true;
}

/**
 * Validates that a directory or DB path does not resolve to an air-gapped litigation matter directory.
 */
export function assertMatterNotPrivileged(targetPath) {
  if (!targetPath) return true;
  let resolvedPath = targetPath;
  try {
    resolvedPath = fs.realpathSync(targetPath);
  } catch (err) {
    logConnectorDebug('assertMatterNotPrivileged', err);
    resolvedPath = path.resolve(targetPath);
  }

  const normalized = resolvedPath.replace(/\\/g, '/').toLowerCase();
  const forbiddenSegments = [
    '/data/matters',
    '/matters/',
    '/evidence/',
    '/privileged/',
    '/litigation/'
  ];

  for (const seg of forbiddenSegments) {
    if (
      normalized.includes(seg) ||
      normalized.endsWith('/matters') ||
      normalized.endsWith('/evidence') ||
      normalized.endsWith('/privileged')
    ) {
      throw new Error(
        `[AirGapSecurityError] Path '${targetPath}' resolves to privileged matter directory ('${resolvedPath}'). Cloud egress to Skylight is blocked under ABA Model Rule 1.6.`
      );
    }
  }
  return true;
}

/**
 * Validates that task/event content does not contain privileged legal matter tags.
 */
export function assertNotPrivilegedContent(text) {
  if (!text || typeof text !== 'string') return true;
  if (/\[(?:PRIVILEGED|ATTORNEY-CLIENT|WORK-PRODUCT|CONFIDENTIAL-MATTER)\]/i.test(text)) {
    throw new Error(
      `[AirGapSecurityError] Content contains privileged legal classification tag. Sync to shared Skylight display is blocked under ABA Model Rule 1.6.`
    );
  }
  return true;
}

/**
 * Mask sensitive credentials in URLs for logging.
 */
export function maskUrl(urlString) {
  if (!urlString) return 'none';
  try {
    const parsed = new URL(urlString);
    if (parsed.password) {
      parsed.password = '********';
    }
    return parsed.toString();
  } catch (err) {
    logConnectorDebug('maskUrl', err);
    return urlString.replace(/:([^@/:]+)@/, ':********@');
  }
}

/**
 * Mask sensitive API tokens or passwords for logging.
 */
export function maskToken(token) {
  if (!token) return 'not configured';
  if (token.length <= 8) return '********';
  return token.substring(0, 4) + '...' + token.substring(token.length - 4);
}

/**
 * Resolve default path to the local SQLite database.
 */
export function resolveDefaultCompanionDbPath() {
  const envDbPath = envOr('SKYLIGHT_DB_PATH') || envOr('KRUSCH_COMPANION_DB_PATH');
  if (envDbPath) {
    return path.resolve(envDbPath);
  }
  const siblingCompanionDb = path.resolve(__dirname, '../../krusch-companion/data/companion.db');
  if (fs.existsSync(path.dirname(siblingCompanionDb))) {
    return siblingCompanionDb;
  }
  return path.resolve(process.cwd(), 'data/companion.db');
}

/**
 * Validate resolved connector configuration.
 */
export function validateSkylightConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Invalid Skylight Connector configuration object.');
  }
  if (!cfg.companionDbPath || typeof cfg.companionDbPath !== 'string') {
    throw new Error('Invalid Skylight Connector config: companionDbPath is required.');
  }
  assertMatterNotPrivileged(cfg.companionDbPath);
  return cfg;
}

export function loadConfig(overrides = {}) {
  const candidateEnvPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../.env')
  ];
  for (const envPath of candidateEnvPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
          const [k, ...v] = trimmed.split('=');
          const key = k.trim();
          const val = v.join('=').trim().replace(/^["']|["']$/g, '');
          if (!envOr(key)) {
            process.env[key] = val;
          }
        }
      } catch (err) {
        logConnectorDebug('loadConfig.env', err);
      }
    }
  }

  const companionDbPath = overrides.companionDbPath || resolveDefaultCompanionDbPath();
  assertMatterNotPrivileged(companionDbPath);

  const skylightBaseUrl = (
    overrides.skylightBaseUrl ||
    envOr('SKYLIGHT_BASE_URL', 'https://app.ourskylight.com')
  ).replace(/\/+$/, '');

  const skylightEmail = overrides.skylightEmail || envOr('SKYLIGHT_EMAIL');
  const skylightPassword = overrides.skylightPassword || envOr('SKYLIGHT_PASSWORD');
  const skylightToken =
    overrides.skylightToken ||
    envOr('SKYLIGHT_TOKEN') ||
    envOr('SKYLIGHT_REFRESH_TOKEN');
  const skylightUserId = overrides.skylightUserId || envOr('SKYLIGHT_USER_ID');
  const skylightFrameId = overrides.skylightFrameId || envOr('SKYLIGHT_FRAME_ID', 'default-frame');
  const skylightMagicImportEmail =
    overrides.skylightMagicImportEmail ||
    envOr('SKYLIGHT_MAGIC_IMPORT_EMAIL', null);
  const skylightGroceryListId =
    overrides.skylightGroceryListId ||
    envOr('SKYLIGHT_GROCERY_LIST_ID', null);
  const skylightTodoListId =
    overrides.skylightTodoListId ||
    envOr('SKYLIGHT_TODO_LIST_ID', null);

  const gKruschUrl = (
    overrides.calendarBridgeUrl ||
    overrides.gKruschUrl ||
    envOr('CALENDAR_BRIDGE_URL') ||
    envOr('G_KRUSCH_URL', 'http://127.0.0.1:5446')
  ).replace(/\/+$/, '');

  const primaryCalendarProfile =
    overrides.primaryCalendarProfile ||
    envOr('SKYLIGHT_PRIMARY_CALENDAR_PROFILE', 'family');
  const primaryCalendarLabel =
    overrides.primaryCalendarLabel ||
    envOr('SKYLIGHT_PRIMARY_CALENDAR_LABEL', 'Family Calendar');
  const primaryCalendarId =
    overrides.primaryCalendarId ||
    envOr('SKYLIGHT_PRIMARY_CALENDAR_ID', primaryCalendarProfile);

  const secondaryCalendarProfile =
    overrides.secondaryCalendarProfile ||
    envOr('SKYLIGHT_SECONDARY_CALENDAR_PROFILE', 'grandparents');
  const secondaryCalendarLabel =
    overrides.secondaryCalendarLabel ||
    envOr('SKYLIGHT_SECONDARY_CALENDAR_LABEL', 'Grandparents & Extended Family');
  const secondaryCalendarId =
    overrides.secondaryCalendarId ||
    envOr('SKYLIGHT_SECONDARY_CALENDAR_ID', secondaryCalendarProfile);

  const extendedFamilyKeywords =
    overrides.extendedFamilyKeywords ||
    envOr('SKYLIGHT_EXTENDED_FAMILY_KEYWORDS', '');

  const defaultCategoryLabel =
    overrides.defaultCategoryLabel ||
    envOr('SKYLIGHT_DEFAULT_CATEGORY', 'Household');

  const allowCloud =
    overrides.allowCloud !== undefined
      ? Boolean(overrides.allowCloud)
      : envBool('ALLOW_SKYLIGHT', false) || envBool('ALLOW_CLOUD', false);

  return validateSkylightConfig({
    companionDbPath,
    skylightBaseUrl,
    skylightEmail,
    skylightPassword,
    skylightToken,
    skylightUserId,
    skylightFrameId,
    skylightMagicImportEmail,
    skylightGroceryListId,
    skylightTodoListId,
    gKruschUrl,
    primaryCalendarProfile,
    primaryCalendarLabel,
    primaryCalendarId,
    secondaryCalendarProfile,
    secondaryCalendarLabel,
    secondaryCalendarId,
    extendedFamilyKeywords,
    defaultCategoryLabel,
    allowCloud,
    ...overrides
  });
}
