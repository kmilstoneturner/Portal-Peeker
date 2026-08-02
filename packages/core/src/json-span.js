// Pure. JSON text in, byte offsets out. Nothing is parsed into values here.
//
// This exists so the extension can add a key to a document without rewriting
// the document. JSON.parse followed by JSON.stringify is not the identity
// function on a byte string: whitespace goes, number formats normalize, escape
// sequences change, and an object whose keys look like integers (the actions
// map, keyed by action ID) comes back sorted numerically rather than in the
// order HubSpot sent. Locating the exact span of each value lets an insertion
// be an insertion, so every other byte survives untouched.
//
// It is a scanner, not a parser, and it only runs on text that JSON.parse has
// already accepted. That is what lets it stay this small: it never has to
// diagnose malformed input, only walk well-formed input. Anything it does not
// recognize returns null and the caller withdraws the feature.

const WS = new Set([' ', '\t', '\n', '\r']);

const skipWs = (text, i) => {
  while (i < text.length && WS.has(text[i])) i += 1;
  return i;
};

/** Index just past the closing quote of the string starting at i. */
function endOfString(text, i) {
  i += 1;
  while (i < text.length) {
    const c = text[i];
    // A backslash escapes whatever follows, including a quote and including
    // another backslash. Skipping two characters handles every case except
    // \\uXXXX, whose four hex digits cannot be a quote anyway.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/** Index just past the value starting at i. */
function endOfValue(text, i) {
  const c = text[i];
  if (c === '"') return endOfString(text, i);

  if (c === '{' || c === '[') {
    // Depth counting without distinguishing the two bracket kinds: the input is
    // known-valid JSON, so they cannot interleave wrongly.
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const end = endOfString(text, i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }

  // Number, true, false, null: runs until something that can only follow it.
  while (i < text.length && !WS.has(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') {
    i += 1;
  }
  return i;
}

/**
 * The members of the object starting at i, in document order.
 *
 * @returns {Array<{key: string, valueStart: number, valueEnd: number}>|null}
 */
export function objectMembers(text, i) {
  if (text[i] !== '{') return null;
  const members = [];
  let at = skipWs(text, i + 1);
  if (text[at] === '}') return members;

  while (at < text.length) {
    if (text[at] !== '"') return null;
    const keyEnd = endOfString(text, at);
    if (keyEnd < 0) return null;

    let key;
    try {
      key = JSON.parse(text.slice(at, keyEnd));
    } catch {
      return null;
    }

    let valueStart = skipWs(text, keyEnd);
    if (text[valueStart] !== ':') return null;
    valueStart = skipWs(text, valueStart + 1);
    const valueEnd = endOfValue(text, valueStart);
    if (valueEnd < 0) return null;

    members.push({ key, valueStart, valueEnd });

    at = skipWs(text, valueEnd);
    if (text[at] === ',') {
      at = skipWs(text, at + 1);
      continue;
    }
    if (text[at] === '}') return members;
    return null;
  }
  return null;
}

/** The elements of the array starting at i, in document order. */
function arrayElements(text, i) {
  if (text[i] !== '[') return null;
  const elements = [];
  let at = skipWs(text, i + 1);
  if (text[at] === ']') return elements;

  while (at < text.length) {
    const end = endOfValue(text, at);
    if (end < 0) return null;
    elements.push({ valueStart: at, valueEnd: end });
    at = skipWs(text, end);
    if (text[at] === ',') {
      at = skipWs(text, at + 1);
      continue;
    }
    if (text[at] === ']') return elements;
    return null;
  }
  return null;
}

/**
 * Where the value at a path lives in the text.
 *
 * A repeated key refuses rather than picking one. JSON.parse keeps the last
 * occurrence and this scanner would see the first, and a disagreement about
 * which value is real is exactly the kind of thing that should stop the
 * feature rather than be resolved by a coin toss.
 *
 * @param {string} text JSON text that JSON.parse has already accepted
 * @param {Array<string|number>} path object keys and array indices
 * @returns {{start: number, end: number}|null}
 */
export function spanAt(text, path) {
  if (typeof text !== 'string') return null;
  let start = skipWs(text, 0);

  for (const segment of path) {
    if (typeof segment === 'number') {
      const elements = arrayElements(text, start);
      if (!elements || !elements[segment]) return null;
      start = elements[segment].valueStart;
      continue;
    }
    const members = objectMembers(text, start);
    if (!members) return null;
    const hits = members.filter((m) => m.key === segment);
    if (hits.length !== 1) return null;
    start = hits[0].valueStart;
  }

  const end = endOfValue(text, start);
  return end < 0 ? null : { start, end };
}

/**
 * Apply insertions to a text.
 *
 * Offsets are positions in the input, so they are applied back to front and
 * every one of them still means what it meant when it was found. Removing the
 * same spans from the output returns the input, which is the property the
 * tests assert.
 *
 * @param {string} text
 * @param {Array<{at: number, text: string}>} insertions ascending by `at`
 */
export function applyInsertions(text, insertions) {
  let output = text;
  for (let i = insertions.length - 1; i >= 0; i -= 1) {
    const { at, text: piece } = insertions[i];
    output = output.slice(0, at) + piece + output.slice(at);
  }
  return output;
}
