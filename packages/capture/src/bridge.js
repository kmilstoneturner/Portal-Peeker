// Isolated-world content script, document_start.
//
// The other half of the world boundary. This half has chrome.* but not the
// page's window, so it cannot patch fetch. It receives raw bodies from the
// MAIN-world interceptor over postMessage and holds them.
//
// Snapshot lifetime, deliberately: the raw body lives in this script's memory
// and nowhere else. Nothing touches chrome.storage. The capture exists exactly
// as long as the page does. Reload or close discards it. Captured payloads
// carry PII and full client business logic, so not persisting them is the
// feature, not a shortcut.
//
// Do not merge this file with interceptor.js.

// Imports stay on one line each: tools/build.mjs strips them line by line.
import { WINDOW_CHANNEL, PAGE_MSG, POPUP_MSG, WORKER_MSG, CAPTURE_KIND, CAPTURE_DOMAIN, SIDECAR_KIND, REFRESH_ERROR } from './protocol.js';
import { classifyUrl, hybridUrl, inbounddbListUrl, idsFromPageUrl } from './endpoints.js';

/** @type {null | {domain: string, kind: string, raw: string, url: string, flowId: string|null, listId: string|null, capturedAt: number, byteLength: number}} */
let snapshot = null;

/**
 * Raw bodies captured beside a segment snapshot, never in its place: the
 * referenced-list hydration batches, the suppression settings, and the
 * membership counts the page loads alongside a definition. Held per subject
 * list and discarded the moment a sidecar for a different list arrives, so a
 * body can never be exported under a segment it was not loaded for. Same
 * lifetime rules as the snapshot: this tab's memory, nothing else.
 *
 * @type {null | {forListId: string, listBatches: string[], suppression: string|null, membershipCounts: string|null}}
 */
let related = null;

// A page can legitimately re-fire hydration (SPA navigation away and back),
// but unbounded accumulation would be a memory leak wearing a feature's
// clothes. Byte-identical bodies are dropped as refires; beyond the cap, new
// batches are dropped rather than evicting older ones, because silently
// losing the first batch would un-cover lists the popup already counted.
const MAX_LIST_BATCHES = 8;

// One popup click may fetch several missing definitions, one GET each; the
// cap bounds a click, not the session, and a segment referencing more lists
// than this through suppression alone has not been observed.
const MAX_FETCHED_REFERENCES = 20;

function emptyRelated(forListId) {
  return {
    forListId,
    listBatches: [],
    suppression: null,
    membershipCounts: null,
    // Definitions fetched on request for referenced lists the page never
    // loaded, and the ids they were fetched for. Ids ride separately so a
    // repeat click can skip work without parsing bodies.
    fetchedLists: [],
    fetchedListIds: [],
  };
}

// ---------------------------------------------------------------- helpers

/**
 * Read one id field out of a raw body without involving packages/core.
 *
 * This looks like normalization and is not. The capture path never imports the
 * parser: a parser change must not be able to break a capture. All this does is
 * answer one question, "which flow or list is this?", for the staleness guard,
 * and it answers null rather than throwing when the shape is unfamiliar.
 *
 * Needed because POST /hybrid/batch has no flow ID in its path. Breadth-first,
 * so on a list payload the root's own listId is found before the listId fields
 * that IN_LIST filters carry deeper in the filter tree.
 */
function readIdLoosely(raw, field) {
  try {
    const parsed = JSON.parse(raw);
    const queue = [parsed];
    let guard = 0;
    while (queue.length && guard++ < 200) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        queue.push(...node.slice(0, 20));
        continue;
      }
      if (node[field] != null && typeof node[field] !== 'object') {
        return String(node[field]);
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') queue.push(value);
      }
    }
  } catch {
    // A body that will not parse is still a perfectly good capture. Copy and
    // Download work on raw bytes and do not care.
  }
  return null;
}

function byteLengthOf(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function readCookie(name) {
  try {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function store(entry) {
  const ids = idsFromPageUrl(location.href);

  if (entry.domain === CAPTURE_DOMAIN.LIST) {
    // A list body arriving on a workflows page is hydration, not the subject:
    // the editor fetches goal and suppression lists through the same endpoint
    // family, and letting one of those replace a flow capture would hand the
    // user the wrong JSON with the right buttons.
    if (ids.app === 'workflows') return;

    // Same reasoning within the lists tool: a segment page also hydrates the
    // lists its own filters refer to (IN_LIST, association lists, suppression),
    // through the same endpoint. When the page URL names the segment, only
    // that segment's definition may take the snapshot. Both ids here come from
    // URLs, never from a parsed body, so a mismatch is a fact.
    const urlListId =
      entry.listIdFromUrl || (classifyUrl(entry.url, location.href) || {}).listId || null;
    if (ids.listId && urlListId && ids.listId !== String(urlListId)) return;

    snapshot = {
      domain: CAPTURE_DOMAIN.LIST,
      kind: entry.kind,
      raw: entry.raw,
      url: entry.url,
      flowId: null,
      listId: urlListId ? String(urlListId) : readIdLoosely(entry.raw, 'listId'),
      capturedAt: entry.capturedAt || Date.now(),
      byteLength: byteLengthOf(entry.raw),
    };
  } else {
    const flowId =
      entry.flowIdFromUrl ||
      (classifyUrl(entry.url, location.href) || {}).flowId ||
      readIdLoosely(entry.raw, 'flowId');

    snapshot = {
      domain: CAPTURE_DOMAIN.FLOW,
      kind: entry.kind,
      raw: entry.raw,
      url: entry.url,
      flowId: flowId ? String(flowId) : null,
      listId: null,
      capturedAt: entry.capturedAt || Date.now(),
      byteLength: byteLengthOf(entry.raw),
    };
  }

  try {
    // One message per capture, purely to set the per-tab badge. The service
    // worker holds no other state.
    const sent = chrome.runtime.sendMessage({ type: WORKER_MSG.CAPTURED });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    // Extension context invalidated (reload during development). Harmless.
  }
}

function storeSidecar(entry) {
  const ids = idsFromPageUrl(location.href);

  // Same posture as list subjects: on a workflows page the flow is the
  // subject, and hydration bodies for its goal or suppression lists are not
  // ours to keep.
  if (ids.app === 'workflows') return;

  // Whose sidecar is this? An id in the request path is authoritative and, when
  // the page URL also names a list, the two must agree. getBatch carries no id
  // at all, so it can only be kept when the page URL says which segment is
  // open; on an index or an unrecognized URL shape there is no honest answer,
  // and a guess could bundle another segment's lists into an export.
  const pathId = entry.listIdFromUrl ? String(entry.listIdFromUrl) : null;
  if (pathId && ids.listId && pathId !== ids.listId) return;
  const forListId = pathId || ids.listId || null;
  if (!forListId) return;

  if (!related || related.forListId !== forListId) {
    related = emptyRelated(forListId);
  }

  if (entry.sidecarKind === SIDECAR_KIND.LIST_BATCHES) {
    if (related.listBatches.includes(entry.raw)) return;
    if (related.listBatches.length >= MAX_LIST_BATCHES) return;
    related.listBatches.push(entry.raw);
  } else if (entry.sidecarKind === SIDECAR_KIND.SUPPRESSION) {
    related.suppression = entry.raw;
  } else if (entry.sidecarKind === SIDECAR_KIND.MEMBERSHIP_COUNTS) {
    related.membershipCounts = entry.raw;
  }
  // No badge: a sidecar alone is nothing the popup can export, so advertising
  // it would be a check mark with an empty popup behind it.
}

/**
 * The sidecars, but only when they demonstrably belong to the snapshot being
 * read: a segment snapshot, ids equal, and at least one body present.
 */
function readableRelated(current) {
  if (!current || current.domain !== CAPTURE_DOMAIN.LIST || !related) return null;
  if (!current.listId || related.forListId !== current.listId) return null;
  const empty =
    !related.listBatches.length &&
    !related.fetchedLists.length &&
    !related.suppression &&
    !related.membershipCounts;
  if (empty) return null;
  return {
    listBatches: [...related.listBatches],
    fetchedLists: [...related.fetchedLists],
    suppression: related.suppression,
    membershipCounts: related.membershipCounts,
  };
}

/**
 * The snapshot, or null if it no longer belongs to the flow or segment on
 * screen.
 *
 * HubSpot is a SPA and it is not yet confirmed that the definition GET
 * re-fires when navigating between two workflows or two segments (findings
 * section 8, open question). If it does not, the previous subject's JSON would
 * otherwise sit under the new subject's URL. Comparing on every read fails
 * safe either way: showing no capture is recoverable, handing someone another
 * flow's or another segment's JSON is not.
 */
function readable() {
  if (!snapshot) return null;
  const ids = idsFromPageUrl(location.href);
  if (snapshot.domain === CAPTURE_DOMAIN.LIST) {
    if (ids.listId && snapshot.listId && ids.listId !== snapshot.listId) return null;
    // A list capture never belongs to a workflows page (store refuses them),
    // but an SPA could in principle navigate there afterwards.
    if (ids.app === 'workflows') return null;
    return snapshot;
  }
  if (ids.flowId && snapshot.flowId && ids.flowId !== snapshot.flowId) return null;
  return snapshot;
}

// ---------------------------------------------- MAIN world -> this world

window.addEventListener('message', (event) => {
  // event.source identity is the real check. Anything not posted by this exact
  // window is not ours.
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.channel !== WINDOW_CHANNEL) return;
  if (typeof data.body !== 'string' || data.body.length === 0) return;

  if (data.type === PAGE_MSG.CAPTURE) {
    store({
      kind: data.kind === CAPTURE_KIND.SAVE ? CAPTURE_KIND.SAVE : CAPTURE_KIND.LOAD,
      domain: data.domain === CAPTURE_DOMAIN.LIST ? CAPTURE_DOMAIN.LIST : CAPTURE_DOMAIN.FLOW,
      raw: data.body,
      url: data.url,
      flowIdFromUrl: data.flowIdFromUrl,
      listIdFromUrl: data.listIdFromUrl,
      capturedAt: data.capturedAt,
    });
    return;
  }

  if (data.type === PAGE_MSG.SIDECAR) {
    if (!Object.values(SIDECAR_KIND).includes(data.sidecarKind)) return;
    storeSidecar({
      sidecarKind: data.sidecarKind,
      raw: data.body,
      listIdFromUrl: data.listIdFromUrl,
    });
  }
});

// ---------------------------------------------------------------- refresh

async function refresh() {
  const current = readable();
  const ids = idsFromPageUrl(location.href);

  // The snapshot decides what a refetch means; with no snapshot, the page URL
  // does. This is also what lets the popup offer a first fetch on a segment or
  // workflow page where the passive capture was missed (popup opened before the
  // page finished loading, or the SPA navigated without refetching).
  const domain =
    (current && current.domain) ||
    (ids.listId ? CAPTURE_DOMAIN.LIST : CAPTURE_DOMAIN.FLOW);

  let url;
  let stamp;
  if (domain === CAPTURE_DOMAIN.LIST) {
    // Prefer refetching the exact URL the page itself used: it demonstrably
    // works, query params included. Constructing from the page URL is the
    // fallback for a first fetch.
    const listId = (current && current.listId) || ids.listId;
    if (!listId) return { ok: false, error: REFRESH_ERROR.NO_ID };
    url = current && current.url ? current.url : inbounddbListUrl(location.origin, listId, ids.portalId);
    stamp = { domain, listIdFromUrl: String(listId) };
  } else {
    const flowId = (current && current.flowId) || ids.flowId;
    if (!flowId) return { ok: false, error: REFRESH_ERROR.NO_ID };
    url = hybridUrl(location.origin, flowId, ids.portalId);
    stamp = { domain, flowIdFromUrl: String(flowId) };
  }

  // Confirmed July 31 2026: GET returns 401 without this header. HubSpot uses
  // 401 rather than 403 for a missing CSRF header, so a 401 here is not
  // evidence of an expired session.
  const csrf = readCookie('csrf.app');
  if (!csrf) return { ok: false, error: REFRESH_ERROR.CSRF_UNREADABLE };

  const answer = await authedGet(url, csrf);
  if (!answer.ok) return answer;

  // Only past every failure branch does the existing snapshot get replaced.
  store({
    kind: CAPTURE_KIND.REFRESH,
    raw: answer.text,
    url,
    capturedAt: Date.now(),
    ...stamp,
  });

  return { ok: true };
}

/**
 * One authenticated same-origin GET, shared by Refresh and Fetch missing.
 * Runs here rather than in the service worker so cookies ride along on a
 * same-origin request with no cookies permission.
 */
async function authedGet(url, csrf) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'x-hubspot-csrf-hubspotapi': csrf,
      },
    });
  } catch (error) {
    return { ok: false, error: REFRESH_ERROR.NETWORK, detail: String(error) };
  }

  if (!response.ok) {
    return { ok: false, error: REFRESH_ERROR.HTTP, status: response.status };
  }

  const text = await response.text();
  if (!text) return { ok: false, error: REFRESH_ERROR.EMPTY };

  return { ok: true, text };
}

// ------------------------------------------------- fetch missing references

/**
 * Fetch definitions for referenced lists the page itself never loaded.
 *
 * The observed gap this exists for: segments-ui hydrates full definitions
 * only for lists referenced in the filters (through getBatch); lists
 * referenced only in the suppression settings get their names resolved
 * through crm-search and their definitions fetched never. The popup computes
 * which references have no definition in the bundle and asks for exactly
 * those ids; each becomes one user-initiated GET to the same definition
 * endpoint every other capture uses, and each verbatim body lands beside the
 * snapshot as a fetched sidecar.
 *
 * Per-id failures do not abort the rest: a bundle that grew by two of three
 * beats one that refused to grow, and the popup reports which ids failed.
 */
async function fetchReferenced(listIds) {
  const current = readable();
  if (!current || current.domain !== CAPTURE_DOMAIN.LIST || !current.listId) {
    return { ok: false, error: REFRESH_ERROR.NO_ID };
  }

  const wanted = (Array.isArray(listIds) ? listIds : [])
    .map((id) => String(id))
    .filter((id) => /^\d+$/.test(id) && id !== current.listId)
    .slice(0, MAX_FETCHED_REFERENCES);
  if (!wanted.length) return { ok: false, error: REFRESH_ERROR.NO_ID };

  const csrf = readCookie('csrf.app');
  if (!csrf) return { ok: false, error: REFRESH_ERROR.CSRF_UNREADABLE };

  const ids = idsFromPageUrl(location.href);
  if (!related || related.forListId !== current.listId) {
    related = emptyRelated(current.listId);
  }

  let fetched = 0;
  const failed = [];
  for (const id of wanted) {
    if (related.fetchedListIds.includes(id)) continue;
    const answer = await authedGet(inbounddbListUrl(location.origin, id, ids.portalId), csrf);
    if (!answer.ok) {
      failed.push(id);
      continue;
    }
    related.fetchedLists.push(answer.text);
    related.fetchedListIds.push(id);
    fetched += 1;
  }

  return { ok: true, fetched, failed };
}

// ---------------------------------------------------------------- popup

function statusPayload() {
  const current = readable();
  if (!current) return { hasCapture: false };
  return {
    hasCapture: true,
    domain: current.domain,
    kind: current.kind,
    flowId: current.flowId,
    listId: current.listId,
    capturedAt: current.capturedAt,
    byteLength: current.byteLength,
    raw: current.raw,
    // The sidecars ride along raw, exactly like the snapshot itself: the
    // popup needs the bodies to size and build the bundled export, and the
    // bridge stays parser-free either way.
    related: readableRelated(current),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case POPUP_MSG.STATUS:
      sendResponse(statusPayload());
      return undefined;

    case POPUP_MSG.PAYLOAD: {
      const current = readable();
      // domain, kind and capturedAt ride along so an export can state when it
      // was taken and where it came from. Facts about the snapshot, same as
      // the ids: the bridge still knows nothing about preferences or output.
      sendResponse(
        current
          ? {
              hasCapture: true,
              raw: current.raw,
              domain: current.domain,
              flowId: current.flowId,
              listId: current.listId,
              kind: current.kind,
              capturedAt: current.capturedAt,
              related: readableRelated(current),
            }
          : { hasCapture: false },
      );
      return undefined;
    }

    case POPUP_MSG.REFRESH:
      refresh().then(
        (result) => sendResponse(result),
        (error) => sendResponse({ ok: false, error: REFRESH_ERROR.NETWORK, detail: String(error) }),
      );
      return true; // async sendResponse

    case POPUP_MSG.FETCH_REFERENCED:
      fetchReferenced(message.listIds).then(
        (result) => sendResponse(result),
        (error) => sendResponse({ ok: false, error: REFRESH_ERROR.NETWORK, detail: String(error) }),
      );
      return true; // async sendResponse

    default:
      return undefined;
  }
});
