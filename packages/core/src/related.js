// Pure. JSON text in, the same JSON text with one _related key spliced in,
// out. No chrome.*, no DOM, no network: the popup passes in the raw sidecar
// bodies the bridge captured beside the segment.
//
// The point of the key: a segment definition names the lists it depends on
// (IN_LIST, association, suppression) by id only, so the export answers "what
// is it filtering against" one hop deep and then stops. HubSpot's own page
// already fetched the missing hop, as full definitions, in the same page load.
// This module puts those bodies into the file, next to the definition, so the
// whole answer travels together.
//
// Same construction discipline as ai-context.js, for the same reason: the
// export with the checkbox off is HubSpot's raw bytes, and the one with it on
// must degrade back to them by deleting a single key. So the key is spliced
// as text, never parsed-and-reserialized, and every embedded body is included
// verbatim: byte-for-byte the response HubSpot sent, wrapped but never
// rewritten. Each body is still parsed once as a validity check whose result
// is thrown away, because embedding a body that is not JSON would corrupt the
// whole document, and a corrupt export is worse than a withdrawn option.

const RELATED_KEY = '_related';

/**
 * Whether a body can carry a _related key at all.
 *
 * Parses to find out and discards the result. Never throws.
 *
 * @param {string} jsonText
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkRelated(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    return { ok: false, reason: 'empty body' };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'response root is not a JSON object' };
  }
  if (Object.hasOwn(parsed, RELATED_KEY)) {
    // Either the file has already been through this extension, or HubSpot has
    // started shipping the key. Same posture as the context block: step aside
    // rather than overwrite.
    return { ok: false, reason: `payload already carries a ${RELATED_KEY} field` };
  }
  return { ok: true, reason: null };
}

const parses = (text) => {
  if (typeof text !== 'string' || text.trim() === '') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Splice the related captures in as one key of a JSON object document.
 *
 * The inserted value is an object with up to three members, every one of them
 * a verbatim captured body:
 *
 *   listBatches       array of hydration responses; each element is one
 *                     response body, itself an array of full list definitions
 *   suppression       the segment's suppression settings response
 *   membershipCounts  the segment's membership count response
 *
 * Members whose body was never captured are omitted rather than written as
 * null, so a reader can tell "not loaded" from "loaded and empty". Withdraws
 * whole rather than embedding a subset: an export that looks bundled while
 * silently missing a body it was asked to carry is the trap this project
 * refuses to build.
 *
 * @param {string} jsonText the export so far
 * @param {{listBatches?: string[], suppression?: string|null, membershipCounts?: string|null}} pieces
 * @returns {{ok: boolean, output: string|null, reason: string|null, inserted: string|null}}
 */
export function addRelated(jsonText, pieces) {
  const refuse = (reason) => ({ ok: false, output: null, reason, inserted: null });

  const check = checkRelated(jsonText);
  if (!check.ok) return refuse(check.reason);

  if (!pieces || typeof pieces !== 'object' || Array.isArray(pieces)) {
    return refuse('related captures are not a plain object');
  }

  const batches = Array.isArray(pieces.listBatches) ? pieces.listBatches : [];
  for (const body of batches) {
    if (!parses(body)) return refuse('a referenced-list batch body is not JSON');
  }

  const members = [];
  if (batches.length > 0) {
    members.push(`"listBatches":[${batches.join(',')}]`);
  }
  if (pieces.suppression != null) {
    if (!parses(pieces.suppression)) return refuse('the suppression body is not JSON');
    members.push(`"suppression":${pieces.suppression}`);
  }
  if (pieces.membershipCounts != null) {
    if (!parses(pieces.membershipCounts)) return refuse('the membership counts body is not JSON');
    members.push(`"membershipCounts":${pieces.membershipCounts}`);
  }

  if (members.length === 0) return refuse('no related captures to include');

  // Same splice mechanics as ai-context.js, and safe for the same reason: the
  // parse in checkRelated succeeded with an object at the root, so only JSON
  // whitespace can precede the root brace.
  const at = jsonText.indexOf('{') + 1;
  const rest = jsonText.slice(at);
  const emptyRoot = /^[ \t\n\r]*\}/.test(rest);
  const inserted = `"${RELATED_KEY}":{${members.join(',')}}${emptyRoot ? '' : ','}`;

  return { ok: true, output: jsonText.slice(0, at) + inserted + rest, reason: null, inserted };
}
