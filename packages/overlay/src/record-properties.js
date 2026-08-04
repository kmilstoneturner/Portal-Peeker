// Record pages, as one feature the host can start and stop.
//
// Everything here is DOM traversal driven by the selectors in
// record-surfaces.js. Adding a surface is an entry in that table, not code here.
// Class names are never selected on: they are styled-components hashes that
// change on every HubSpot build.
//
// Failure is per row, not per page, exactly as on the property settings table. A
// sidebar field with no API name under it is visibly missing and cannot mislead
// anyone, and the fields either side of it are still correct. Nothing withdraws
// wider than a row: a card is either the kind this table knows how to read or it
// is never opened.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { SURFACES, parseRecordPath, readRowName } from './record-surfaces.js';
import { placeApiName, removeApiNames } from './api-name-node.js';

/** The path of the document being annotated, or '' where there is none. */
function pathOf(root) {
  try {
    return root.location ? root.location.pathname : '';
  } catch {
    // A detached or cross-origin document. Treated as "not a record page",
    // which withdraws rather than guessing at an object type.
    return '';
  }
}

/**
 * Whether this page is showing any record surface at all. The host's cheap bail.
 *
 * The path test comes first because it is a regex against a string, so a CRM
 * list page (which the same match pattern loads us on) costs that and nothing
 * else. Only then does this touch the DOM, and then only one querySelector per
 * surface.
 */
export function recordSurfacesPresent(root) {
  if (!root || typeof root.querySelector !== 'function') return false;
  if (!parseRecordPath(pathOf(root)).ok) return false;
  return SURFACES.some((surface) => root.querySelector(surface.container) !== null);
}

/**
 * Annotate every property row that can be read with confidence.
 *
 * The order of the checks is the point, and it is structural before it is
 * textual. A bare property name carries no evidence on its own: the same page
 * puts data-test-id="deals" on a nav item and data-test-id="badge" inside a
 * property's own value. So a row has to survive being in the right card, being a
 * direct child of that card's list, and carrying the per-row marker, before its
 * two name sources are even compared.
 *
 * @returns {{inserted: number, skipped: number, rows: number, cards: number}}
 */
export function annotateRecordProperties(root) {
  const result = { inserted: 0, skipped: 0, rows: 0, cards: 0 };
  if (!root || typeof root.querySelectorAll !== 'function') return result;

  // Which object this page is showing, stated once for the whole pass. A record
  // page shows exactly one, and its own URL is the statement.
  //
  // Cards were briefly required to declare it too, and be turned away when they
  // did not. That was wrong twice over: HubSpot's stock card declares an object
  // type but a portal's own custom cards carry a bare numeric id, so the rule
  // skipped most of a real client's sidebar; and it was never what made a name
  // readable anyway. The card type, the properties list, the direct-child rows,
  // the per-row marker, and the two agreeing sources do that.
  const page = parseRecordPath(pathOf(root));
  if (!page.ok) return result;

  for (const surface of SURFACES) {
    for (const container of root.querySelectorAll(surface.container)) {
      result.cards += 1;

      // A surface only declares a list when its rows need scoping to direct
      // children of one. Where the row id identifies itself, the container is
      // scope enough.
      const scopes = surface.list ? container.querySelectorAll(surface.list) : [container];

      for (const scope of scopes) {
        for (const row of scope.querySelectorAll(surface.row)) {
          result.rows += 1;
          try {
            if (!annotateRow(row, surface, page.objectTypeId)) {
              result.skipped += 1;
              continue;
            }
            result.inserted += 1;
          } catch {
            // One row's worth of surprise is one missing line. It is never
            // allowed to become a broken record page for whoever is using this
            // portal.
            result.skipped += 1;
          }
        }
      }
    }
  }

  return result;
}

/**
 * One row.
 *
 * @returns {boolean} true only when a node was inserted, which is what the
 *   host's cycle breaker counts. A correction is not an insertion, and neither
 *   is a skip.
 */
function annotateRow(row, surface, objectTypeId) {
  // The marker HubSpot puts on every property row, required as a direct child.
  // This is what a nested decoy cannot fake at the same depth. Only surfaces
  // whose row id is bare declare one: where the id carries a prefix it already
  // says what it is, and demanding a marker as well would cost real rows to
  // prove something the prefix has proved.
  if (surface.rowMarker && !row.querySelector(surface.rowMarker)) return false;

  const source = surface.source ? row.querySelector(surface.source) : null;
  const read = readRowName(surface, {
    rowValue: row.getAttribute(surface.rowAttribute),
    sourceValue: source ? source.getAttribute(surface.sourceAttribute) : null,
  });
  if (!read.ok) return false;

  // The anchor does two jobs, and the second one is not obvious.
  //
  // It is where the name goes. It is ALSO the proof that this row is a rendered
  // property rather than something else wearing the prefix. On the All properties
  // panel, measured live: 101 nodes match the row selector, 33 carry the anchor,
  // 33 carry a label, and it is the same 33. The other 68 are
  // `property-input-skeleton` loading placeholders and one
  // `property-input-phone-button`, a textarea nested inside the fax row that
  // would otherwise be annotated "phone-button".
  //
  // So do not turn this into a fallback that puts the name somewhere else when
  // the anchor is missing. On a single-source surface it is the check standing
  // between us and a confidently wrong line.
  const anchor = surface.anchor ? row.querySelector(surface.anchor) : row;
  if (!anchor) return false;

  return placeApiName(anchor, read.propertyName, objectTypeId);
}

/** The feature record the host registers. */
export const recordPropertiesFeature = {
  id: 'record-properties',
  present: recordSurfacesPresent,
  annotate: annotateRecordProperties,
  remove: removeApiNames,
};
