// Every URL pattern Portal Peeker knows about, in exactly one module. These are
// undocumented internal HubSpot APIs with no stability contract, and they will
// move. When they move, this file is the only edit.
//
// v1 has no options page, so the patterns are not user-overridable yet. The
// seam is here: DEFAULT_PATTERNS is data, and classifyUrl takes the pattern set
// as an argument, so an options-page override is a plumbing change, not a
// rewrite.

import { CAPTURE_KIND, CAPTURE_DOMAIN, SIDECAR_KIND } from './protocol.js';

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

  // Sidecars: responses the segment page loads alongside the definition, all
  // observed live in the same page load. Kept beside the snapshot, never in
  // its place, and exported only behind the "Include referenced lists"
  // checkbox.
  //
  // /lists/getBatch answers with an array of full definitions for the lists
  // the open segment references (IN_LIST, association, suppression). No id in
  // its path: the bridge ties it to the list named in the page URL.
  listBatch: /\/api\/inbounddb-lists\/v1\/lists\/getBatch$/,

  // The subject's suppression settings and membership counts. Both carry the
  // list id in the path, so a response for another list can be told apart.
  listSuppression: /\/api\/inbounddb-lists\/v1\/lists\/(\d+)\/suppression$/,
  listMembership: /\/api\/inbounddb-lists\/v1\/list-membership-search\/list\/(\d+)\/\d+\/current-state$/,

  // Known and deliberately NOT captured: /api/crm-search/search. On a
  // segment page it resolves suppression-list ids to names (rows of the
  // internal 0-45 list object), but the same URL serves every CRM search in
  // HubSpot, the members table on that very page included, and this module
  // classifies by URL alone. Capturing it would risk keeping real record
  // rows; and it carries names only, no definitions, so the popup's Fetch
  // missing action covers the need with the definition endpoint instead.

  // GET /api/inbounddb-objects/v1/crm-objects/{objectTypeId}/batch?...&id={objectId}
  // The whole CRM record: identity, every property with its provenance
  // envelope, object state, permissions. One endpoint for every object type,
  // confirmed live on 0-1, 0-2, 0-3 and a portal-defined 2-N custom object
  // with a byte-identical response envelope. The type is the only id in the
  // path, and it is hyphenated: every other pattern in this file assumes
  // plain digits, this one must not.
  //
  // End-anchored like the list pattern, and for a sharper reason here: a
  // singular sibling exists, GET /crm-objects/{objectTypeId}/{objectId}
  // (observed with flpViewValidation=true on an engagement record page), and
  // an unanchored pattern would classify it too. The batch call accompanied
  // it on every page tested, so excluding the singular costs nothing and
  // prevents two subject patterns for one record.
  //
  // The objectId lives in the query, not the path; classifyUrl pulls it from
  // there and refuses anything but exactly one id (see below).
  record: /\/api\/inbounddb-objects\/v1\/crm-objects\/(\d+-\d+)\/batch$/,

  // Known and deliberately NOT captured on record pages, each for its own
  // reason:
  //
  //   /api/contacts/v1/contact/vids/batch, /api/companies/v2/companies/batch
  //     The legacy per-type family: one endpoint per legacy object type, none
  //     for custom objects, each with a different response shape. Strictly
  //     less coverage than the generic endpoint for N times the patterns.
  //   /api/timeline/v2/object/... (two query shapes) and
  //   /api/crm/events/v3/timeline/...
  //     Three response shapes for one dataset, paginated (silently partial
  //     when hasHiddenEvents is true), refires on scroll, and they embed full
  //     property blobs for OTHER records (engagements, sibling objects),
  //     which would pull other records' data into a file named for this one.
  //   /api/calls/v1/callees/omnibus/{objectTypeId}/{objectId}
  //     Fires at load on every record page tested, but lists callable
  //     associations only (a company's contacts, not its deal) and carries
  //     associated people's names and email addresses.
  //   /api/sales-views/v1/associated-open-objects/{WORD}/{id}/{WORD}
  //     Keyed by legacy words (CONTACT, COMPANY), so a custom object's 2-N
  //     has no path to a URL at all; returns open objects only.
  //   /api/chirp-frontend-app/.../AssociatedObjectsGatewayRpc/getAssociatedObjectsPaged
  //     The association cards' own source, one POST per card. Classifiable by
  //     URL (the RPC method is in the path), but it belongs to the associated
  //     records feature, which is its own slice with its own opt in.
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
 * @returns {{role: string, kind: string, domain: string, flowId: string|null, listId: string|null, objectTypeId: string|null, objectId: string|null, sidecarKind: string|null, url: string}|null}
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
      role: 'subject',
      kind: CAPTURE_KIND.SAVE,
      domain: CAPTURE_DOMAIN.FLOW,
      flowId: null,
      listId: null,
      objectTypeId: null,
      objectId: null,
      sidecarKind: null,
      url: parsed.href,
    };
  }

  const load = path.match(patterns.load);
  if (load) {
    return {
      role: 'subject',
      kind: CAPTURE_KIND.LOAD,
      domain: CAPTURE_DOMAIN.FLOW,
      flowId: load[1],
      listId: null,
      objectTypeId: null,
      objectId: null,
      sidecarKind: null,
      url: parsed.href,
    };
  }

  const record = patterns.record ? path.match(patterns.record) : null;
  if (record) {
    // GET only, unlike the list pattern. A write through this path has never
    // been observed, and there is no reason to think one would answer with a
    // full record envelope, so accepting a POST here risks storing a mutation
    // acknowledgment as the record. One line to relax if a write is ever seen.
    const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
    if (verb !== 'GET') return null;

    // The objectId rides in the query. Exactly one, or nothing is captured:
    // "batch" implies the id param can repeat, and a multi-record body has no
    // honest answer to "which record is this?". Refusing here is the
    // fail-closed rule expressed where all URL knowledge already lives, with
    // no body parse anywhere near the capture path.
    const ids = parsed.searchParams.getAll('id');
    if (ids.length !== 1 || !/^\d+$/.test(ids[0])) return null;

    return {
      role: 'subject',
      kind: CAPTURE_KIND.LOAD,
      domain: CAPTURE_DOMAIN.RECORD,
      flowId: null,
      listId: null,
      objectTypeId: record[1],
      objectId: ids[0],
      sidecarKind: null,
      url: parsed.href,
    };
  }

  const list = patterns.list ? path.match(patterns.list) : null;
  if (list) {
    // A GET answers with the definition, and a PUT, POST, or PATCH would
    // answer with the updated one. Any other verb on this path is not a
    // definition: a DELETE's acknowledgment body, captured as a "save", would
    // overwrite the one copy of a list that no longer exists in HubSpot.
    const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
    if (!['GET', 'PUT', 'POST', 'PATCH'].includes(verb)) return null;
    return {
      role: 'subject',
      kind: verb === 'GET' ? CAPTURE_KIND.LOAD : CAPTURE_KIND.SAVE,
      domain: CAPTURE_DOMAIN.LIST,
      flowId: null,
      listId: list[1],
      objectTypeId: null,
      objectId: null,
      sidecarKind: null,
      url: parsed.href,
    };
  }

  const sidecar = (sidecarKind, listId) => ({
    role: 'sidecar',
    kind: CAPTURE_KIND.LOAD,
    domain: CAPTURE_DOMAIN.LIST,
    flowId: null,
    listId,
    objectTypeId: null,
    objectId: null,
    sidecarKind,
    url: parsed.href,
  });

  if (patterns.listBatch && patterns.listBatch.test(path)) {
    return sidecar(SIDECAR_KIND.LIST_BATCHES, null);
  }
  const suppression = patterns.listSuppression ? path.match(patterns.listSuppression) : null;
  if (suppression) return sidecar(SIDECAR_KIND.SUPPRESSION, suppression[1]);
  const membership = patterns.listMembership ? path.match(patterns.listMembership) : null;
  if (membership) return sidecar(SIDECAR_KIND.MEMBERSHIP_COUNTS, membership[1]);

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

// There is deliberately no crmObjectsBatchUrl builder. hybridUrl and
// inbounddbListUrl omit only the two hs_static_app telemetry params; the batch
// endpoint's other query params (allPropertiesFetchMode, includeAllProperties,
// includeCurrentUserPermissions, includeObjectVersion, flpViewValidation) are
// shape-bearing, not telemetry, and the same page has been observed calling
// the endpoint twice with different sets. A guessed set could make Refresh
// silently return fewer properties than the passive capture, so a record
// refetch reuses the exact URL the page used, or reports that it cannot.

/**
 * Pull identifiers out of the page URL.
 *
 * Used for three things: the SPA staleness guard (does the snapshot still
 * belong to the flow, segment, or record on screen?), the ids for a refetch,
 * and telling which HubSpot app the page belongs to at all.
 *
 * Flow shapes:
 *   /workflows/{portalId}/platform/flow/{flowId}/edit
 *   /workflows/{portalId}/edit/{legacyWorkflowId}        (legacy)
 *
 * Segment (list) shapes:
 *   /contacts/{portalId}/objectLists/{listId}            (+ /filters etc.)
 *   /contacts/{portalId}/lists/{legacyListId}            (legacy)
 *
 * Record shape (confirmed live on 0-1, 0-2, 0-3 and a 2-N custom object; the
 * objectTypeId is hyphenated, and HubSpot emits this shape in its own
 * payloads as relativeUri):
 *   /contacts/{portalId}/record/{objectTypeId}/{objectId}
 *
 * The record pair comes back both-or-neither: a partial pair is no pair. That
 * is the fail-closed rule expressed in the parser, and it is the deliberate
 * opposite of the flow guard's fail-open. Flows fail open because a missing
 * id only ever hides a valid capture; records fail closed because the same
 * document outlives the record it belongs to (HubSpot SPA-navigates between
 * records, measured: two different records' batch responses arrived in one
 * document lifetime), so an unguarded snapshot would be offered on the wrong
 * record's page.
 *
 * A second regex over this grammar lives in
 * packages/overlay/src/record-surfaces.js (PATH_OBJECT_TYPE). It reads only
 * the type, serves the DOM overlay, and cannot be merged here without a new
 * bundle entry; if the grammar ever changes, change both.
 *
 * The legacy ids are not the flow or ILS list ids (different id spaces), so
 * they are returned separately rather than being passed off as one. On URL
 * shapes carrying no usable id, every id comes back null and the staleness
 * guard simply cannot fire, which fails open the same way the workflow list
 * page always has.
 *
 * `app` names the URL root that matched: 'workflows', 'contacts', 'lists', or
 * 'segments'. The last two are HubSpot's newer roots for the renamed Lists
 * tool (its bundle calls itself segments-ui). On those, the number after the
 * portal is read as the list id, provisionally: it has not been observed live
 * the way the objectLists shape has. The asymmetry of the failure modes is
 * what decides it. If the guess is wrong, the guards hide a valid capture and
 * a reload recovers; if no id is read at all, the subject-vs-hydration guard
 * in the bridge cannot fire, and a referenced list's definition could take
 * the open segment's place in the snapshot, which nothing recovers because
 * nothing looks wrong.
 */
export function idsFromPageUrl(href) {
  const out = {
    app: null,
    portalId: null,
    flowId: null,
    legacyId: null,
    listId: null,
    legacyListId: null,
    objectTypeId: null,
    objectId: null,
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

  // Both or neither: one capture group failing fails the match, so a
  // truncated record URL yields no pair and the record guards cannot fire,
  // which on this domain means no capture rather than a guess.
  if (out.app === 'contacts') {
    const record = path.match(/\/contacts\/\d+\/record\/(\d+-\d+)\/(\d+)(?:\/|$)/);
    if (record) {
      out.objectTypeId = record[1];
      out.objectId = record[2];
      return out;
    }
  }

  const list = path.match(/\/objectLists\/(\d+)(?:\/|$)/);
  if (list) {
    out.listId = list[1];
    return out;
  }

  if (out.app === 'lists' || out.app === 'segments') {
    const bare = path.match(/^\/(?:lists|segments)\/\d+\/(\d+)(?:\/|$)/);
    if (bare) out.listId = bare[1];
    return out;
  }

  const legacyList = path.match(/\/contacts\/\d+\/lists\/(\d+)(?:\/|$)/);
  if (legacyList) out.legacyListId = legacyList[1];

  return out;
}
