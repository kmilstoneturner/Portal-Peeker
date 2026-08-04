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
// WHAT CANNOT BE DONE, AND WHY IT IS NOT LISTED BELOW
//
// The Contact profile card (data-card-type="PROPERTIES_LIST") renders its rows
// as [data-test-id="crm-property-list-item"] with the internal name nowhere in
// the DOM. Every attribute on every row was enumerated on a live record: there
// are per-render counters (FormControl18) and the human label, and nothing else.
// It is not in this table because it cannot be, not because nobody got to it.
// Association cards are absent for a different reason: their property ids belong
// to the ASSOCIATED object, not the record on screen.
//
// Everything is exported inline. A trailing `export { ... }` block is not
// bundlable: see the note in test-id.js.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { afterPrefix, nameProblem, refuse } from './test-id.js';

// objectTypeId is 0-N for stock objects and 2-N for custom ones. Anchored on
// that shape rather than on "the segment after the first slash", the same choice
// and for the same reason as CELL_VALUE in property-rows.js.
const OBJECT_TYPE = /^[^/]+\/(\d+-\d+)(?:\/|$)/;
const PATH_OBJECT_TYPE = /\/record\/(\d+-\d+)(?:\/|$)/;

const PROPERTY_INPUT_PREFIX = 'property-input-';
const HIGHLIGHT_PREFIX = 'highlight-property-display-';

/** How a surface derives a name. See the note at the top of this file. */
export const NAME_FROM = {
  CROSS_CHECK: 'cross-check',
  PREFIX: 'prefix',
};

/**
 * Where a surface's objectTypeId comes from.
 *
 * CONTAINER is stronger and is used wherever the container declares one: the id
 * has to agree with the URL, so a card left over from another record is turned
 * away. PATH is for containers that declare nothing, where the page's own URL is
 * the only statement of which object is on screen. The All properties panel is a
 * modal with no card id, and the highlights card id (OBJECT_HIGHLIGHT-FAS-0-1-1)
 * hyphenates where the grammar wants slashes and so parses as nothing.
 */
export const OBJECT_TYPE_FROM = {
  CONTAINER: 'container',
  PATH: 'path',
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
    objectTypeFrom: OBJECT_TYPE_FROM.CONTAINER,

    // Every card on a record page carries data-card-type and data-card-id,
    // whatever kind of card it is, so this scopes on the generic axis rather
    // than on one card's own attribute. That is what lets a custom card become
    // another entry in this table instead of another special case.
    //
    // data-card-id is `{cardType}/{objectTypeId}/{variant}`, e.g.
    // PROPERTIES_V3/0-1/V2. Cards that carry no objectTypeId in that shape
    // (MARKETING_LEAD_SCORES, OBJECT_HIGHLIGHT-FAS-0-1-1) fail to parse and are
    // skipped, and so are cards for a different object than the page is showing
    // (ASSOCIATION_V3/0-2 on a 0-1 record). Both are correct: the objectTypeId
    // agreeing is what makes a bare name inside trustworthy at all.
    container: '[data-card-type]',
    containerAttribute: 'data-card-id',

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
    objectTypeFrom: OBJECT_TYPE_FROM.PATH,

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
    objectTypeFrom: OBJECT_TYPE_FROM.PATH,

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
 * The objectTypeId a properties card declares, read from its own attribute.
 *
 * @returns {{ok: true, objectTypeId: string} | {ok: false, reason: string}}
 */
export function parseContainerId(value) {
  if (typeof value !== 'string') return refuse('no-container-id');
  const match = value.match(OBJECT_TYPE);
  if (!match) return refuse('no-object-type-id');
  return { ok: true, objectTypeId: match[1] };
}

/**
 * Whether a container belongs to the object this page is showing.
 *
 * Checked once per card rather than once per row. A card that fails this is not
 * partially read: nothing inside it is touched at all, because the thing that
 * makes its bare names trustworthy is precisely that it is the right card.
 *
 * @returns {{ok: true, objectTypeId: string} | {ok: false, reason: string}}
 */
export function readSurfaceContainer({ surface, containerId, pathname } = {}) {
  const path = parseRecordPath(pathname);
  if (!path.ok) return path;

  // Nothing to cross-check against. The URL is the only statement of which
  // object is on screen, and a surface only opts into this when its container
  // genuinely declares nothing.
  if (surface && surface.objectTypeFrom === OBJECT_TYPE_FROM.PATH) {
    return { ok: true, objectTypeId: path.objectTypeId };
  }

  const container = parseContainerId(containerId);
  if (!container.ok) return container;

  if (container.objectTypeId !== path.objectTypeId) return refuse('object-type-mismatch');

  return { ok: true, objectTypeId: container.objectTypeId };
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
export function readRowName(surface, { rowValue, sourceValue } = {}) {
  if (!surface) return refuse('no-surface');

  if (surface.nameFrom === NAME_FROM.PREFIX) {
    return parsePrefixedName(rowValue, surface.prefix);
  }

  return readRecordRow({
    rowTestId: rowValue,
    inputTestId: sourceValue,
    prefix: surface.prefix,
  });
}
