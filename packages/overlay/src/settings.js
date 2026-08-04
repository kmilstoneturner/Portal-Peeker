// Every user setting, declared once.
//
// Three consumers read this table and none of them restates it: the popup
// builds the Settings page from it, the content script reads its storage keys
// from it, and tools/check-settings.mjs validates the built bundle against it.
// That is the same one-table shape as protocol.js and MODIFICATIONS, for the
// same reason: two sides of a contract that are written out twice drift.
//
// Adding a setting is one entry below.
//
// Everything here is exported inline (export const, export function). A
// trailing `export { ... }` block is not bundlable: tools/build.mjs strips
// `export ` only when a declaration follows it, and throws on anything else
// that still looks like module syntax.

/** Stable ids, so callers never spell a setting name as a bare string. */
export const SETTING = {
  API_NAMES: 'apiNames',
};

// `input` is the DOM id the popup gives this setting's checkbox. The `set-`
// prefix is load bearing: tools/check-ai-context.mjs counts every
// <input id="opt-..."> in popup.html and requires the count to match the
// MODIFICATIONS table. `opt-` means "changes an export", `set-` means
// "everything else". A settings checkbox named opt-anything fails the build
// with a message about the AI context block, which is the wrong trail.
export const SETTINGS = [
  {
    id: SETTING.API_NAMES,
    key: 'portal-peeker.apiNames',
    input: 'set-api-names',
    label: 'Show internal API names',
    // The note names where it currently works. The label deliberately does not,
    // which is what made widening this to record pages one sentence rather than
    // a rename.
    note: "Adds each property's internal name under its label, on the property settings page and on record pages",
    // Off. Editor numbers and the context block default on because they add to
    // a file the user asked for. This one changes what a customer's screen
    // looks like, which is not something to switch on for someone.
    default: false,
  },
];

// local, never sync. sync would replicate settings through Google's servers,
// which makes PRIVACY.md's "What leaves your computer" section and README's
// "nothing else it does leaves your machine" false. A preference is not worth
// that. Declared here so the popup, the content script, and the guard all take
// the area from one place and the choice cannot be made twice.
export const STORAGE_AREA = 'local';

export const STORAGE_KEYS = SETTINGS.map((setting) => setting.key);

/** The value every setting takes when storage says nothing about it. */
export function defaultSettings() {
  const out = {};
  for (const setting of SETTINGS) out[setting.id] = setting.default;
  return out;
}

/**
 * Turn whatever storage handed back into a complete settings object.
 *
 * Anything that is not a boolean is treated as absent rather than coerced. A
 * string 'false' read as truthy would silently turn a feature on, and storage
 * written by an older build is exactly where a wrong type comes from.
 */
export function normalizeSettings(stored) {
  const out = defaultSettings();
  if (!stored || typeof stored !== 'object') return out;
  for (const setting of SETTINGS) {
    const value = stored[setting.key];
    if (typeof value === 'boolean') out[setting.id] = value;
  }
  return out;
}

/** The storage key for a setting id, or null if nothing declares that id. */
export function storageKeyFor(id) {
  const setting = SETTINGS.find((entry) => entry.id === id);
  return setting ? setting.key : null;
}
