// Reading a property name out of a test id, for any surface.
//
// Strings in, object out. No DOM and no chrome.*, so every rule here is
// testable in Vitest's node environment.
//
// These started life inside property-rows.js and moved here when record pages
// arrived, because both surfaces need the same three decisions: where a prefix
// ends, what makes a name implausible, and how a refusal is shaped. Copying
// them would let one surface regress while the test protecting the other stays
// green, and the prefix rule below is exactly the kind that looks safe to
// rewrite until you know why it is written this way.
//
// Everything is exported inline (export const, export function). A trailing
// `export { ... }` block is not bundlable: tools/build.mjs strips `export ` only
// when a declaration follows it, and throws on anything else that still looks
// like module syntax.

// Long enough that no real property comes near it, short enough that a runaway
// value is caught. Deliberately a short literal: tools/check-no-portal-data.mjs
// fails on any run of six or more digits, so a constant written with that many
// would have to be allowlisted alongside real portal ids, which is not company
// a structural constant should keep.
export const MAX_NAME_LENGTH = 512;

/** The shape every parser in this package refuses with. */
export const refuse = (reason) => ({ ok: false, reason });

/**
 * Strip a known prefix, or return null.
 *
 * startsWith plus slice, never a replace and never a split on '-'. A property
 * genuinely named `label-foo` arrives as `property-label-label-foo`, and both of
 * those would mangle it. There is a test.
 *
 * That trap is not hypothetical on record pages either: the second source there
 * is `property-input-{name}`, so the same name arrives as
 * `property-input-label-foo`.
 */
export function afterPrefix(value, prefix) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(prefix)) return null;
  return value.slice(prefix.length);
}

/**
 * A name is only rejected here for the shapes that mean the split went wrong.
 *
 * Note what is deliberately absent: any test on the *characters* of a name.
 * HubSpot property names may contain hyphens, so a shape rule tight enough to
 * exclude `hover-content-wrapper` or `dropdown-caret` would also exclude a real
 * property. Telling a property apart from page furniture is structural work,
 * done by the caller scoping its search, and it cannot be done here.
 */
export function nameProblem(name) {
  if (name === null) return 'no-prefix';
  if (name === '') return 'empty-name';
  if (/\s/.test(name)) return 'name-has-whitespace';
  if (name.length > MAX_NAME_LENGTH) return 'name-too-long';
  return null;
}
