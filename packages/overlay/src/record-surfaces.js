// The surfaces on a HubSpot record page that render a property, and how to read
// a name off each one.
//
// Strings in, object out. No DOM and no chrome.*, so the whole grammar is
// testable in Vitest's node environment and record-properties.js above it only
// has to walk elements.
//
// Adding a surface is one entry in SURFACES. That is the same one-table shape as
// SETTINGS, MODIFICATIONS, and protocol.js, for the same reason: two sides of a
// contract written out twice drift apart.
//
// THE RULE, RESTATED (ADR-010)
//
// ADR-009 said two independent sources must agree before a name is shown. Its
// reason was the failure mode: when HubSpot changes an attribute the result must
// be a missing line, never a confident wrong one. Reading three record surfaces
// showed that "two sources" was the mechanism, not the rule. The rule is:
//
//   THE NAME MUST BE SELF-IDENTIFYING.
//
// A prefixed id announces what it is, so it fails safe on its own: rename
// `property-input-` and the selector matches nothing. A BARE id announces
// nothing, and this page carries data-test-id="deals", "tasks", "contacts", and
// "dashboards" on nav chrome, plus "badge" and "dropdown-caret" nested inside a
// property's own value. Every one is a well-formed property name, and no
// character-shape rule separates them from a real one, because HubSpot names may
// contain hyphens (`label-foo` in the settings fixture is exactly that).
//
// So the two shapes below are not a strong rule and a weak one. They are two
// ways of reaching the same guarantee:
//
//   NAME_FROM.CROSS_CHECK  the row's name is bare, so a second prefixed source
//                          must agree. Used by the Key information card, where
//                          structure also does work a prefix cannot: the right
//                          card, a direct child of its list, carrying the per-row
//                          marker, and only then the two names compared.
//
//   NAME_FROM.PREFIX       the row's own id carries the prefix, so it identifies
//                          itself. Used by the All properties panel and the
//                          highlights strip. Still container scoped, because a
//                          prefix says "this is a property input", not "this is
//                          a property input belonging to the record you are
//                          looking at".
//
//   NAME_FROM.LABEL        the card emits no name at all, so the rendered label
//                          is resolved against HubSpot's own property metadata.
//                          Used by Contact profile, Data highlights, and the
//                          Property history modal. One source, and allowed to
//                          be, because the failure is detectable: a label
//                          matching no property or two properties skips the
//                          row. See property-names.js.
//
// Where the name SITS is a separate axis from where it comes from, and the
// table carries both: see `anchor` and `placement`. Every surface but one puts
// the name beside an element; Property history appends it inside the label
// cell, because that cell holds a bare text node and nothing to sit ahead of.
//
// WHERE THE LABEL SURFACES CAME FROM
//
// Three surfaces render properties and emit no internal name anywhere:
//
//   PROPERTIES_LIST  ("Contact profile")   rows are [crm-property-list-item]
//   DATA_HIGHLIGHTS  ("Data highlights")   rows are [crm-data-highlights-item]
//   the Property history modal             rows are [property-info-table-row]
//
// The pattern is consistent. Where the row id is GENERIC rather than carrying
// the name, the name is absent from the card entirely: what is left is a
// per-render counter (FormControl22, FormControl-label23) and the human label.
// PROPERTIES_LIST is the sharper case, because its rows have the same form
// control shell as the Key information card, right down to the hover wrapper.
// The only difference is the value span, which carries property-input-{name}
// there and nothing at all here.
//
// Checked three ways on a live record before concluding: every attribute on
// every row enumerated, inline scripts searched for bootstrapped card config
// (none), and all 245 window globals searched for property metadata (none).
// Property history was read later, from its rendered markup, and every id in
// that table is generic in exactly the way above.
//
// So these three read the label and resolve it against the property metadata
// HubSpot already fetches. That response is INTERCEPTED, never requested: see
// property-names-interceptor.js, and PRIVACY.md, which says so in the copy.
//
// Association cards remain absent, for a reason neither route fixes: their
// property ids are real but belong to the ASSOCIATED object rather than the
// record on screen.
//
// Everything is exported inline. A trailing `export { ... }` block is not
// bundlable: see the note in test-id.js.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { afterPrefix, nameProblem, refuse, PROPERTY_INPUT_PREFIX } from './test-id.js';
import { lookupPropertyName } from './property-names.js';
import { PLACEMENT } from './api-name-node.js';

// objectTypeId is 0-N for stock objects and 2-N for custom ones.
const PATH_OBJECT_TYPE = /\/record\/(\d+-\d+)(?:\/|$)/;

const HIGHLIGHT_PREFIX = 'highlight-property-display-';

/** How a surface derives a name. See the note at the top of this file. */
export const NAME_FROM = {
  CROSS_CHECK: 'cross-check',
  PREFIX: 'prefix',
  LABEL: 'label',
};

/**
 * Every record-page surface, and the selectors that find one property on it.
 *
 * Selectors are data, not code: this module stays pure and record-properties.js
 * does the querying. Class names never appear in any of them. They are
 * styled-components hashes that change on every HubSpot build, and a selector
 * resting on one is a feature that breaks silently on a Tuesday.
 */
export const SURFACES = [
  {
    id: 'sidebar-properties',
    nameFrom: NAME_FROM.CROSS_CHECK,

    // The card TYPE, not one card's id. Every card holding a properties list is
    // a PROPERTIES_V3, on both portals this was read against: HubSpot's own
    // "About this contact" card and every custom card an admin builds. Their ids
    // differ wildly (PROPERTIES_V3/0-1/V2 against a bare numeric 4773) and none
    // of that matters, because the type is what says which grammar is inside.
    //
    // Nothing here reads the object type off the card. That was tried and it
    // skipped most of a real client's sidebar, since custom card ids declare
    // none. It also protected nothing: the only cards it excluded were
    // association cards, and those carry no properties list to begin with.
    container: '[data-card-type="PROPERTIES_V3"]',

    list: 'ul[data-selenium-test="profile-properties-list"]',

    // Direct children only, and the marker must be a direct child of the row.
    // hover-content-wrapper, dropdown-caret, and badge are all nested
    // data-test-id values inside a row; a subtree query would offer all three as
    // candidate property names and nothing downstream could tell them apart.
    row: ':scope > span[data-test-id]',
    rowMarker: ':scope > div[data-deferred-property-input-root="true"]',

    // The second derivation. Matched on the attribute alone, never on tag or
    // position: it is a <span> while the field displays and a <button> one layer
    // deeper (under an extra DisplayOptimizedFormControl) while it is being
    // edited. Both were observed on the same field.
    rowAttribute: 'data-test-id',
    source: `[data-selenium-test^="${PROPERTY_INPUT_PREFIX}"]`,
    sourceAttribute: 'data-selenium-test',
    prefix: PROPERTY_INPUT_PREFIX,

    // Label and value are siblings inside a class-only wrapper, so neither can
    // be selected on. This sits between them and is the only node in that
    // position carrying an attribute we are willing to read, which puts the API
    // name exactly where the settings table puts it: under the label, above the
    // value. Present on every row observed, including read-only ones.
    anchor: '[data-test-id="hover-content-wrapper"]',
  },

  {
    // The "View all properties" panel. 78 rows on the record this was read from,
    // across 13 property groups, and the group accordions need no handling of
    // their own: the rows carry everything and a collapsed group simply has none
    // in the DOM yet, which the observer picks up when it expands.
    id: 'all-properties',
    nameFrom: NAME_FROM.PREFIX,

    // A modal, rendered outside the card tree, so it has no data-card-type and
    // declares no object. Scoping still matters and is doing real work here: an
    // association card elsewhere on the page carries
    // data-test-id="property-input-name" for the associated COMPANY's name
    // property, which this panel's scope is what excludes.
    container: '[data-test-id="all-properties-panel"]',

    // No list and no per-row marker: the row is the prefixed node itself, so
    // there is no bare id needing structural corroboration.
    row: `[data-test-id^="${PROPERTY_INPUT_PREFIX}"]`,
    rowAttribute: 'data-test-id',
    prefix: PROPERTY_INPUT_PREFIX,

    anchor: '[data-test-id="hover-content-wrapper"]',
  },

  {
    // The highlights strip across the top of a record.
    id: 'record-highlights',
    nameFrom: NAME_FROM.PREFIX,

    // Scoped to the highlight card's content rather than to [data-card-type]:
    // that card's id is OBJECT_HIGHLIGHT-FAS-0-1-1, which hyphenates where the
    // grammar wants slashes and so declares no object type at all.
    container: '[data-test-id="record-highlight-content"]',

    // Only the -display- prefix. The sibling highlight-property-item- prefix
    // looks like a second source and is not one: on the record this was read
    // from, one of them is `jobtitle-and-company`, a composite of two properties
    // that is not a property name. Requiring the two to agree would drop real
    // rows and prove nothing, which is why this surface reads one prefixed id.
    row: `[data-test-id^="${HIGHLIGHT_PREFIX}"]`,
    rowAttribute: 'data-test-id',
    prefix: HIGHLIGHT_PREFIX,

    // The strip has no label/value pair to sit between, so the name goes
    // immediately before the value itself.
    anchor: null,
  },

  {
    // "Contact profile". Renders the same form control shell as the Key
    // information card, hover wrapper and all, and differs in exactly one way:
    // the value span carries property-input-{name} there and nothing here. So
    // the label is the only handle, and property-names.js resolves it.
    id: 'contact-profile',
    nameFrom: NAME_FROM.LABEL,
    container: '[data-card-type="PROPERTIES_LIST"]',
    row: '[data-test-id="crm-property-list-item"]',
    label: 'label',
    anchor: '[data-test-id="hover-content-wrapper"]',
  },

  {
    // "Data highlights". A well of label/value pairs, each row a plain <li>
    // with two <p> children and no name anywhere.
    id: 'data-highlights',
    nameFrom: NAME_FROM.LABEL,
    container: '[data-card-type="DATA_HIGHLIGHTS"]',
    row: '[data-test-id="crm-data-highlights-item"]',
    label: 'div > p:nth-of-type(1)',

    // nth-of-type rather than `p + p`, and the difference is not cosmetic.
    // Inserting our <code> between the two paragraphs breaks their adjacency,
    // so `p + p` would match on the first pass and never again, leaving the row
    // uncorrectable when it re-renders. nth-of-type counts only paragraphs and
    // is blind to what we put between them.
    anchor: 'div > p:nth-of-type(2)',
  },

  {
    // The Property history modal, opened over a record.
    //
    // Every id in the table is generic: property-info-table-row on the row,
    // property-label-cell on the cell. That is the same tell PROPERTIES_LIST
    // gives, and it means the same thing here, checked the same way: nothing in
    // the table carries an internal name, only the rendered label. So the label
    // is the handle, resolved against the same intercepted metadata.
    //
    // The modal renders over the record page without navigating, so the path
    // still names the object type and parseRecordPath is unchanged.
    id: 'property-history',
    nameFrom: NAME_FROM.LABEL,
    container: '[data-test-id="property-info-table"]',
    row: '[data-test-id="property-info-table-row"]',
    label: '[data-test-id="property-label-cell"]',

    // The label cell is the anchor, and the name goes INSIDE it. Two reasons,
    // and the first is not a preference: that cell's only child is a bare text
    // node, so there is no element to insert ahead of, and a BEFORE placement
    // would put a <code> between two table cells, which a browser hoists
    // straight back out of the table. The second is that under the label is
    // where it was asked for, and where display:block then puts it.
    //
    // This is the only surface where the annotation lands inside the node its
    // label is read from, which is why record-properties.js reads that label
    // past its own nodes. Without that, the second pass reads the label back
    // with the name glued to it, resolves nothing, and leaves a name it can no
    // longer correct.
    anchor: '[data-test-id="property-label-cell"]',
    placement: PLACEMENT.INSIDE,
  },
];

/**
 * The objectTypeId this page is showing, read from its path.
 *
 * `/contacts/{portalId}/record/{objectTypeId}/{recordId}`. The object type is a
 * path segment, which is why one match pattern covers stock and custom objects
 * alike.
 *
 * @returns {{ok: true, objectTypeId: string} | {ok: false, reason: string}}
 */
export function parseRecordPath(pathname) {
  if (typeof pathname !== 'string') return refuse('no-path');
  const match = pathname.match(PATH_OBJECT_TYPE);
  if (!match) return refuse('not-a-record-page');
  return { ok: true, objectTypeId: match[1] };
}

/**
 * Parse the second source's test id.
 *
 * Prefixed, so afterPrefix's strip-by-length applies unchanged. A property
 * genuinely named `label-foo` arrives here as `property-input-label-foo`.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function parsePropertyInputTestId(value) {
  return parsePrefixedName(value, PROPERTY_INPUT_PREFIX);
}

/**
 * Read a name out of any prefixed id.
 *
 * This is the whole of NAME_FROM.PREFIX. It looks thin next to the cross-check
 * below, and the reason it can be is the prefix: an id that does not start with
 * one is refused, so a nav item or an engagement button never gets this far. The
 * failure mode when HubSpot renames the prefix is that nothing matches, which is
 * a missing line and not a wrong one.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function parsePrefixedName(value, prefix) {
  const name = afterPrefix(value, prefix);
  const problem = nameProblem(name);
  if (problem) return refuse(problem === 'no-prefix' ? 'not-a-property-input' : problem);
  return { ok: true, propertyName: name };
}

/**
 * Read one row, or refuse.
 *
 * Both sources are required and must agree. Unlike the settings table there is
 * no optional third corroboration, and there is no room for one: the primary
 * source here carries no prefix, so it contributes no evidence on its own beyond
 * "some element in a property list has a test id". The agreement IS the check.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function readRecordRow({ rowTestId, inputTestId, prefix = PROPERTY_INPUT_PREFIX } = {}) {
  if (typeof rowTestId !== 'string') return refuse('no-row-name');

  const problem = nameProblem(rowTestId);
  if (problem) return refuse(problem);

  const input = parsePrefixedName(inputTestId, prefix);
  if (!input.ok) return input;

  if (input.propertyName !== rowTestId) return refuse('name-mismatch');

  return { ok: true, propertyName: rowTestId };
}

/**
 * Read one row's name, whichever way its surface derives one.
 *
 * The single place that knows both shapes exist, so record-properties.js walks
 * elements and never branches on grammar.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function readRowName(surface, { rowValue, sourceValue, labelValue, index } = {}) {
  if (!surface) return refuse('no-surface');

  if (surface.nameFrom === NAME_FROM.LABEL) {
    return lookupPropertyName(index, labelValue);
  }

  if (surface.nameFrom === NAME_FROM.PREFIX) {
    return parsePrefixedName(rowValue, surface.prefix);
  }

  return readRecordRow({
    rowTestId: rowValue,
    inputTestId: sourceValue,
    prefix: surface.prefix,
  });
}
