// Pure. The one place that knows how to put a key at the front of a JSON
// object document without touching any other byte.
//
// Two features live on this mechanism, the AI context block and the related
// captures bundle, and they make the same promise: the export with the
// checkbox off is HubSpot's raw bytes, and the one with it on degrades back
// to them by deleting a single key. Keeping the check and the splice here,
// once, is what keeps the two promises from drifting apart: an edge case
// fixed for one key cannot silently stay broken for the other.
//
// The text is parsed once, as a validity check whose result is thrown away.
// That check is what makes indexOf('{') safe: in a JSON document whose root
// is an object, nothing but whitespace can precede the root brace, since JSON
// has no comments and no prologue. A byte order mark fails the parse, so it
// never reaches the splice.

/**
 * Whether a body is a JSON object document that does not already carry `key`.
 *
 * Never throws. The refusal reasons are user-facing (the popup shows them as
 * checkbox titles), so they name the problem, not the internals.
 *
 * @param {string} jsonText
 * @param {string} key the root key the caller intends to insert
 * @param {string} [article] 'a' or 'an', to keep the message reading right
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkRootObject(jsonText, key, article = 'a') {
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
  if (Object.hasOwn(parsed, key)) {
    // Either the file has already been through this extension, or HubSpot has
    // started shipping the key. Overwriting would destroy data and two copies
    // cannot both be the first key, so the only honest move is to step aside.
    return { ok: false, reason: `payload already carries ${article} ${key} field` };
  }
  return { ok: true, reason: null };
}

/**
 * Splice one member in as the first key of a JSON object document.
 *
 * The caller must have passed checkRootObject on the same text; this function
 * assumes it and does no re-validation. memberText is the full `"key":value`
 * text, with the value already serialized, so nothing here parses or
 * re-serializes anything.
 *
 * The insertion is one contiguous span: output.slice around `inserted` gives
 * the input back byte for byte, which is the property every caller's tests
 * assert.
 *
 * @param {string} jsonText
 * @param {string} memberText e.g. '"_aiContext":{...}'
 * @returns {{output: string, inserted: string}}
 */
export function spliceFirstKey(jsonText, memberText) {
  // indexOf rather than a regex on purpose: the JS \s class matches
  // characters (U+FEFF among them) that the JSON grammar does not.
  const at = jsonText.indexOf('{') + 1;
  const rest = jsonText.slice(at);
  // {} has no members to separate, so no comma. Rare, and invalid JSON
  // without this branch.
  const emptyRoot = /^[ \t\n\r]*\}/.test(rest);
  const inserted = `${memberText}${emptyRoot ? '' : ','}`;
  return { output: jsonText.slice(0, at) + inserted + rest, inserted };
}
