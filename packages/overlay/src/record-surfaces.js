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
// WHY THIS SURFACE IS HARDER THAN THE SETTINGS TABLE
//
// On the property settings page every source carries a prefix, so an id can be
// recognised on sight. Here the primary source is the bare property name and
// nothing else:
//
//   <span data-test-id="lifecyclestage">
//
// The same page carries data-test-id="deals", "tasks", "contacts", and
// "dashboards" on nav chrome, and "badge" and "dropdown-caret" nested inside a
// property's own value. Every one of those is a well-formed property name, and a
// character-shape rule cannot separate them from a real one, because HubSpot
// property names may contain hyphens: `label-foo` in the settings fixture is
// exactly that. So on this surface, structure does the work that a prefix does
// on the other one, and it does it three times over before a name is read:
//
//   1. the container must be the properties card for THIS page's object,
//   2. the row must be a DIRECT child of that card's list,
//   3. the row must carry the per-row marker HubSpot puts on every one.
//
// Only then do the two name sources have to agree. That last step is what
// catches `badge`, which sits inside lifecyclestage's value and would survive
// steps 1 to 3 if a subtree query ever replaced the direct-child rule.
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

    // Carries `{cardType}/{objectTypeId}/{variant}`, e.g. PROPERTIES_V3/0-1/V2.
    // The objectTypeId in it must agree with the URL's before anything inside is
    // read, which is what makes the container trustworthy enough to scope on.
    container: '[data-properties-card-id]',
    containerAttribute: 'data-properties-card-id',

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
    source: `[data-selenium-test^="${PROPERTY_INPUT_PREFIX}"]`,
    sourceAttribute: 'data-selenium-test',

    // Label and value are siblings inside a class-only wrapper, so neither can
    // be selected on. This sits between them and is the only node in that
    // position carrying an attribute we are willing to read, which puts the API
    // name exactly where the settings table puts it: under the label, above the
    // value. Present on every row observed, including read-only ones.
    anchor: '[data-test-id="hover-content-wrapper"]',
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
export function readSurfaceContainer({ containerId, pathname } = {}) {
  const container = parseContainerId(containerId);
  if (!container.ok) return container;

  const path = parseRecordPath(pathname);
  if (!path.ok) return path;

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
  const name = afterPrefix(value, PROPERTY_INPUT_PREFIX);
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
export function readRecordRow({ rowTestId, inputTestId } = {}) {
  if (typeof rowTestId !== 'string') return refuse('no-row-name');

  const problem = nameProblem(rowTestId);
  if (problem) return refuse(problem);

  const input = parsePropertyInputTestId(inputTestId);
  if (!input.ok) return input;

  if (input.propertyName !== rowTestId) return refuse('name-mismatch');

  return { ok: true, propertyName: rowTestId };
}
