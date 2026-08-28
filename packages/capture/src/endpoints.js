// Every URL pattern Portal Peeker knows about, in exactly one module. These are
// undocumented internal HubSpot APIs with no stability contract, and they will
// move. When they move, this file is the only edit.
//
// v1 has no options page, so the patterns are not user-overridable yet. The
// seam is here: DEFAULT_PATTERNS is data, and classifyUrl takes the pattern set
// as an argument, so an options-page override is a plumbing change, not a
// rewrite.

import { CAPTURE_KIND, CAPTURE_DOMAIN } from './protocol.js';

export const DEFAULT_PATTERNS = {
  // GET /api/automationplatform/v1/hybrid/{flowId}
  // Primary source. Full flow definition on editor load.
  load: /\/api\/automationplatform\/v1\/hybrid\/(\d+)$/,

  // POST /api/automationplatform/v1/hybrid/batch
  // No flow ID in the path. The authoritative post-save state is the response.
  save: /\/api\/automationplatform\/v1\/hybrid\/batch$/,

  // GET /api/inbounddb-lists/v1/lists/{listId}
  // The full segment (list) definition, filterBranch included, fetched by
  // segments-ui when a list opens. Observed live August 2026, with portalId
  // and clienttimeout query params. The ID in the path is the ILS list ID,
  // the same one the page URL and the public v3 lists API use.
  //
  // End-anchored on purpose: the same service serves subresources such as
  // /lists/{legacyId}/ilsMapping, which are not list definitions and, worse,
  // take ids from the legacy id space.
  //
  // The one pattern covers reads and writes: a save that PUTs the same
  // resource would answer with the updated definition, so the method, not the
  // path, is what tells a load from a save here.
  list: /\/api\/inbounddb-lists\/v1\/lists\/(\d+)$/,
};

/**
 * Decide whether a request URL is one we capture, and pull the flow or list ID
 * out of the path when the path carries one.
 *
 * Returns null for everything else, which is the overwhelming majority of
 * traffic on a HubSpot page. Cheap rejection matters: this runs on every fetch.
 *
 * @param {string} rawUrl absolute or relative
 * @param {string} [base] resolution base, normally location.href
 * @param {object} [patterns]
 * @param {string} [method] HTTP method, for endpoints where the path alone
 *   cannot tell a load from a save. Defaults to GET, which is what the
 *   flow patterns assume and what an XHR without a recorded method was.
 * @returns {{kind: string, domain: string, flowId: string|null, listId: string|null, url: string}|null}
 */
export function classifyUrl(rawUrl, base, patterns = DEFAULT_PATTERNS, method = 'GET') {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;

  let parsed;
  try {
    parsed = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }

  const path = parsed.pathname;

  // Order matters only for readability here: "batch" is not digits, so the two
  // flow patterns cannot both match, and the list path is a different prefix.
  if (patterns.save.test(path)) {
    return {
      kind: CAPTURE_KIND.SAVE,
      domain: CAPTURE_DOMAIN.FLOW,
      flowId: null,
      listId: null,
      url: parsed.href,
    };
  }

  const load = path.match(patterns.load);
  if (load) {
    return {
      kind: CAPTURE_KIND.LOAD,
      domain: CAPTURE_DOMAIN.FLOW,
      flowId: load[1],
      listId: null,
      url: parsed.href,
    };
  }

  const list = patterns.list ? path.match(patterns.list) : null;
  if (list) {
    const writes = typeof method === 'string' && method.toUpperCase() !== 'GET';
    return {
      kind: writes ? CAPTURE_KIND.SAVE : CAPTURE_KIND.LOAD,
      domain: CAPTURE_DOMAIN.LIST,
      flowId: null,
      listId: list[1],
      url: parsed.href,
    };
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
 * Build the refetch URL for GET /api/inbounddb-lists/v1/lists/{listId}.
 *
 * Same policy as hybridUrl: portalId and clienttimeout ride along because the
 * live page sends them (14000 observed, against the workflow editor's 30000),
 * and the two hs_static_app telemetry params are deliberately omitted.
 */
export function inbounddbListUrl(origin, listId, portalId, { clientTimeoutMs = 14000 } = {}) {
  const url = new URL(`/api/inbounddb-lists/v1/lists/${listId}`, origin);
  if (portalId) url.searchParams.set('portalId', String(portalId));
  url.searchParams.set('clienttimeout', String(clientTimeoutMs));
  return url.href;
}

/**
 * Pull identifiers out of the page URL.
 *
 * Used for three things: the SPA staleness guard (does the snapshot still
 * belong to the flow or segment on screen?), the ids for a refetch, and
 * telling which HubSpot app the page belongs to at all.
 *
 * Flow shapes:
 *   /workflows/{portalId}/platform/flow/{flowId}/edit
 *   /workflows/{portalId}/edit/{legacyWorkflowId}        (legacy)
 *
 * Segment (list) shapes:
 *   /contacts/{portalId}/objectLists/{listId}            (+ /filters etc.)
 *   /contacts/{portalId}/lists/{legacyListId}            (legacy)
 *
 * The legacy ids are not the flow or ILS list ids (different id spaces), so
 * they are returned separately rather than being passed off as one. On URL
 * shapes carrying no usable id, every id comes back null and the staleness
 * guard simply cannot fire, which fails open the same way the workflow list
 * page always has.
 *
 * `app` names the URL root that matched: 'workflows', 'contacts', 'lists', or
 * 'segments'. The last two are HubSpot's newer roots for the renamed Lists
 * tool (its bundle calls itself segments-ui); only the portal is read from
 * them, because guessing which of two bare numbers is the list would let a
 * wrong guess hide a valid capture.
 */
export function idsFromPageUrl(href) {
  const out = {
    app: null,
    portalId: null,
    flowId: null,
    legacyId: null,
    listId: null,
    legacyListId: null,
  };

  let path;
  try {
    path = new URL(href).pathname;
  } catch {
    return out;
  }

  const root = path.match(/^\/(workflows|contacts|lists|segments)\/(\d+)(?:\/|$)/);
  if (root) {
    out.app = root[1];
    out.portalId = root[2];
  }

  if (out.app === 'workflows') {
    const flow = path.match(/\/flow\/(\d+)(?:\/|$)/);
    if (flow) {
      out.flowId = flow[1];
      return out;
    }

    const legacy = path.match(/\/workflows\/\d+\/(?:edit|view)\/(\d+)(?:\/|$)/);
    if (legacy) out.legacyId = legacy[1];
    return out;
  }

  const list = path.match(/\/objectLists\/(\d+)(?:\/|$)/);
  if (list) {
    out.listId = list[1];
    return out;
  }

  const legacyList = path.match(/\/contacts\/\d+\/lists\/(\d+)(?:\/|$)/);
  if (legacyList) out.legacyListId = legacyList[1];

  return out;
}
