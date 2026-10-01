// Domain-neutral scaffolding shared by the workflow trim (trim.js) and the
// record trim (record-trim.js). Extracted rather than exported from trim.js,
// for two reasons: the record path must not pull the whole flow parser in
// behind a helper import, and the two trims must not be able to drift on the
// result contract they are both judged by.
//
// What deliberately did NOT move here:
//
//   CHARS_PER_TOKEN and estimateTokens stay in trim.js, because the popup
//   imports estimateTokens from ./lib/trim.js and moving them would ripple
//   through the build's copy list for no gain.
//
//   prune stays in trim.js, because the record trim must not prune at all: a
//   record property whose value is null or "" is a fact ("this field is
//   empty"), and dropping it would turn "explicitly empty" into "not
//   present". Pruning is a workflow rule with workflow exemption tables, not
//   shared machinery.
//
// Pure, like everything in core: no chrome.*, no DOM, no network.

/**
 * Order-insensitive deep equality.
 *
 * Key order matters here: the server reorders arrays and object keys with no
 * semantic meaning, and two responses with identical content have been observed
 * differing only in key order. A JSON.stringify comparison would report those as
 * different and quietly stop deduplicating.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

export const weigh = (key, value) => {
  try {
    return JSON.stringify(value ?? null).length + String(key).length + 3;
  } catch {
    return 0;
  }
};

/** Records what each rule removed. This is the schema-drift alarm. */
export function ledger() {
  const rules = new Map();
  return {
    hit(id, key, value) {
      const entry = rules.get(id) || { id, count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += weigh(key, value);
      rules.set(id, entry);
    },
    list: () => [...rules.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/** delete obj[key], recording it, only when `when` holds. */
export function dropIf(log, id, obj, key, when = true) {
  if (!obj || !Object.hasOwn(obj, key) || !when) return false;
  log.hit(id, key, obj[key]);
  delete obj[key];
  return true;
}

export function byteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

/**
 * The shared refusal shape. Both trims answer with exactly this object when
 * they will not produce output, which is what keeps a caller written against
 * one honest about the other.
 */
export function refusal(inputBytes, reason) {
  return {
    ok: false,
    output: null,
    reason,
    inputBytes,
    outputBytes: inputBytes,
    rules: [],
  };
}
