// Every URL pattern Portal Peeker knows about, in exactly one module. These are
// undocumented internal HubSpot APIs with no stability contract, and they will
// move. When they move, this file is the only edit.
//
// v1 has no options page, so the patterns are not user-overridable yet. The
// seam is here: DEFAULT_PATTERNS is data, and classifyUrl takes the pattern set
// as an argument, so an options-page override is a plumbing change, not a
// rewrite.

import { CAPTURE_KIND } from './protocol.js';

export const DEFAULT_PATTERNS = {
  // GET /api/automationplatform/v1/hybrid/{flowId}
  // Primary source. Full flow definition on editor load.
  load: /\/api\/automationplatform\/v1\/hybrid\/(\d+)$/,

  // POST /api/automationplatform/v1/hybrid/batch
  // No flow ID in the path. The authoritative post-save state is the response.
  save: /\/api\/automationplatform\/v1\/hybrid\/batch$/,
};

/**
 * Decide whether a request URL is one we capture, and pull the flow ID out of
 * the path when the path carries one.
 *
 * Returns null for everything else, which is the overwhelming majority of
 * traffic on a HubSpot page. Cheap rejection matters: this runs on every fetch.
 *
 * @param {string} rawUrl absolute or relative
 * @param {string} [base] resolution base, normally location.href
 * @param {object} [patterns]
 * @returns {{kind: string, flowId: string|null, url: string}|null}
 */
export function classifyUrl(rawUrl, base, patterns = DEFAULT_PATTERNS) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;

  let parsed;
  try {
    parsed = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }

  const path = parsed.pathname;

  // Order matters only for readability here: "batch" is not digits, so the two
  // patterns cannot both match.
  if (patterns.save.test(path)) {
    return { kind: CAPTURE_KIND.SAVE, flowId: null, url: parsed.href };
  }

  const load = path.match(patterns.load);
  if (load) {
    return { kind: CAPTURE_KIND.LOAD, flowId: load[1], url: parsed.href };
  }

  return null;
}

/**
 * Build the refetch URL for GET /hybrid/{flowId}.
 *
 * portalId and clienttimeout are assumed required (omission untested).
 * hs_static_app and hs_static_app_version are telemetry and are deliberately
 * omitted: pinning a version string guarantees a stale-value bug later.
 */
export function hybridUrl(origin, flowId, portalId, { clientTimeoutMs = 30000 } = {}) {
  const url = new URL(`/api/automationplatform/v1/hybrid/${flowId}`, origin);
  if (portalId) url.searchParams.set('portalId', String(portalId));
  url.searchParams.set('clienttimeout', String(clientTimeoutMs));
  return url.href;
}

/**
 * Pull identifiers out of the editor page URL.
 *
 * Used for two things: the SPA staleness guard (does the snapshot still belong
 * to the flow on screen?) and the portalId for refetch.
 *
 * Observed shape: /workflows/{portalId}/platform/flow/{flowId}/edit
 * Legacy shape:   /workflows/{portalId}/edit/{legacyWorkflowId}
 *
 * The legacy ID is not the flow ID (see findings section 5), so it is returned
 * separately rather than being passed off as one.
 */
export function idsFromPageUrl(href) {
  const out = { portalId: null, flowId: null, legacyId: null };

  let path;
  try {
    path = new URL(href).pathname;
  } catch {
    return out;
  }

  const portal = path.match(/\/workflows\/(\d+)(?:\/|$)/);
  if (portal) out.portalId = portal[1];

  const flow = path.match(/\/flow\/(\d+)(?:\/|$)/);
  if (flow) {
    out.flowId = flow[1];
    return out;
  }

  const legacy = path.match(/\/workflows\/\d+\/(?:edit|view)\/(\d+)(?:\/|$)/);
  if (legacy) out.legacyId = legacy[1];

  return out;
}
