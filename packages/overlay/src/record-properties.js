// Record pages, as one feature the host can start and stop.
//
// Everything here is DOM traversal driven by the selectors in
// record-surfaces.js. Adding a surface is an entry in that table, not code here.
// Class names are never selected on: they are styled-components hashes that
// change on every HubSpot build.
//
// Failure is per row, not per page, exactly as on the property settings table. A
// sidebar field with no API name under it is visibly missing and cannot mislead
// anyone, and the fields either side of it are still correct. The one thing that
// withdraws wider than a row is a container whose objectTypeId disagrees with
// the URL's: nothing inside such a card is read at all, because being the right
// card is the whole reason its bare names can be trusted.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { SURFACES, parseRecordPath, readRecordRow, readSurfaceContainer } from './record-surfaces.js';
import { placeApiName, removeApiNames } from './api-name-node.js';

const ROW_NAME_ATTRIBUTE = 'data-test-id';

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

  const pathname = pathOf(root);

  for (const surface of SURFACES) {
    for (const container of root.querySelectorAll(surface.container)) {
      let card;
      try {
        card = readSurfaceContainer({
          containerId: container.getAttribute(surface.containerAttribute),
          pathname,
        });
      } catch {
        continue;
      }

      // Not this page's object, or an id shape nobody recognises. Skipped whole
      // and not counted: these are not rows we declined, they are rows we never
      // had grounds to look at.
      if (!card.ok) continue;
      result.cards += 1;

      for (const list of container.querySelectorAll(surface.list)) {
        for (const row of list.querySelectorAll(surface.row)) {
          result.rows += 1;
          try {
            if (!annotateRow(row, surface, card.objectTypeId)) {
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
  // This is what a nested decoy cannot fake at the same depth.
  if (!row.querySelector(surface.rowMarker)) return false;

  const source = row.querySelector(surface.source);
  const read = readRecordRow({
    rowTestId: row.getAttribute(ROW_NAME_ATTRIBUTE),
    inputTestId: source ? source.getAttribute(surface.sourceAttribute) : null,
  });
  if (!read.ok) return false;

  // No anchor means nowhere to put the name. Unlike the settings table, where
  // the anchor was also the second source and so could not go missing on its
  // own, here it is a third element and has to be checked for.
  const anchor = row.querySelector(surface.anchor);
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
