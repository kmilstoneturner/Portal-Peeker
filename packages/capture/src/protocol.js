// Message contracts for every hop in the extension. One file so a rename cannot
// silently desync two sides of a channel.
//
// Three channels exist:
//
//   1. window.postMessage   MAIN-world interceptor  ->  isolated-world bridge
//      The only way across the world boundary. MAIN has no chrome.* at all.
//   2. chrome.runtime       isolated-world bridge   ->  service worker
//      Fire and forget, used once per capture to set the per-tab badge.
//   3. chrome.tabs          popup                   ->  isolated-world bridge
//      Request/response. The popup owns no state of its own.

// Namespaced so page scripts posting unrelated messages are cheap to reject.
export const WINDOW_CHANNEL = 'portal-peeker/v1';

// interceptor -> bridge
export const PAGE_MSG = {
  CAPTURE: 'capture',
  // A response captured beside the subject, never in its place: the raw
  // bodies HubSpot's own segment page loads alongside a list definition
  // (referenced-list hydration, suppression settings, member counts). A
  // separate message type on purpose: a bridge from before sidecars existed
  // ignores the unknown type instead of storing one as the subject.
  SIDECAR: 'sidecar',
};

// What a sidecar body is. The names double as the keys the export writes
// under _related, so the wire, the store, and the file cannot disagree.
export const SIDECAR_KIND = {
  LIST_BATCHES: 'listBatches',
  SUPPRESSION: 'suppression',
  MEMBERSHIP_COUNTS: 'membershipCounts',
};

// popup -> bridge
export const POPUP_MSG = {
  // Metadata plus the raw body, so the popup can build its summary in one hop.
  STATUS: 'pp:status',
  // Re-pull of the raw body immediately before Copy or Download, so a save that
  // landed while the popup was open cannot put a stale payload on the clipboard.
  PAYLOAD: 'pp:payload',
  // Same-origin refetch of the open flow or segment, run in the content script.
  REFRESH: 'pp:refresh',
  // Same-origin fetch of referenced list definitions the page itself never
  // loaded (a segment's suppression lists, for one). Carries listIds; one GET
  // per id, user-initiated, stored beside the snapshot like page sidecars.
  FETCH_REFERENCED: 'pp:fetch-referenced',
};

// bridge -> service worker
export const WORKER_MSG = {
  CAPTURED: 'pp:captured',
};

// Where a snapshot came from. Surfaced in the popup because "saved 2 seconds
// ago" and "loaded 40 minutes ago" mean very different things to the user.
export const CAPTURE_KIND = {
  LOAD: 'load',
  SAVE: 'save',
  REFRESH: 'refresh',
};

// What a snapshot is of. A workflow, a segment (list), and a CRM record travel
// the same wire and share the same popup, but they summarize differently,
// export under different names, and answer to different ids (a record answers
// to a pair, objectTypeId plus objectId, rather than one), so the distinction
// rides with the capture rather than being re-guessed downstream.
export const CAPTURE_DOMAIN = {
  FLOW: 'flow',
  LIST: 'list',
  RECORD: 'record',
};

// Refresh failures the popup gives distinct copy for. An unreadable csrf.app
// cookie is a reload-the-page problem, not a network problem, and saying so
// saves the user a support round trip.
export const REFRESH_ERROR = {
  NO_ID: 'no-id',
  // Records only: Refresh repeats the exact URL the page used and never
  // constructs one (the batch endpoint's query params are shape-bearing, and a
  // guessed set could silently return fewer properties than the capture). No
  // snapshot means no URL to repeat, which is a different failure from "no id"
  // with a different remedy: reload the page rather than open a record.
  NO_CAPTURED_URL: 'no-captured-url',
  CSRF_UNREADABLE: 'csrf-unreadable',
  NETWORK: 'network',
  HTTP: 'http',
  EMPTY: 'empty',
};
