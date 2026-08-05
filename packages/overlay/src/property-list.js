// The property settings table, as one feature the host can start and stop.
//
// Everything here is DOM traversal against data-test-id attributes. Class names
// on that page are styled-components hashes that change on every HubSpot build,
// so they are never selected on.
//
// Failure is per row, not per page. The export options withdraw whole rather
// than ship a partial file, because a file where some cards carry numbers looks
// complete while lying. That reasoning does not transfer: a table row with no
// API name under it is visibly missing and cannot mislead anyone, and the rows
// either side of it are still correct. So a row whose sources disagree is
// skipped and the sweep carries on.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { readPropertyRow } from './property-rows.js';
import { placeApiName, removeApiNames } from './api-name-node.js';

// Exact match, not a prefix. properties-table-something-else is a different
// component and none of this grammar is promised to hold there.
const PROPERTIES_TABLE = 'table[data-test-id="properties-table"]';
const NAME_CELL = 'td[data-test-id^="cell-name-"]';
const TYPE_TAG = 'small[data-test-id^="property-type-label-"]';
const LABEL_BUTTON = 'button[data-test-id^="property-label-"]';

const testId = (node) => (node ? node.getAttribute('data-test-id') : null);

/** Whether this page is showing the table at all. The host's cheap bail. */
export function propertyTablePresent(root) {
  if (!root || typeof root.querySelector !== 'function') return false;
  return root.querySelector(PROPERTIES_TABLE) !== null;
}

/**
 * Annotate every row that can be read with confidence.
 *
 * The type tag is both the second source for the cross check and the insertion
 * anchor, which works out neatly: a row with no type tag is already skipped for
 * want of corroboration, so there is never a name to place with nowhere to put
 * it.
 *
 * @returns {{inserted: number, skipped: number, rows: number}}
 */
export function annotatePropertyList(root) {
  const result = { inserted: 0, skipped: 0, rows: 0 };
  if (!root || typeof root.querySelectorAll !== 'function') return result;

  for (const table of root.querySelectorAll(PROPERTIES_TABLE)) {
    for (const cell of table.querySelectorAll(NAME_CELL)) {
      result.rows += 1;
      try {
        const tag = cell.querySelector(TYPE_TAG);
        const row = readPropertyRow({
          cellNameTestId: testId(cell),
          typeLabelTestId: testId(tag),
          labelTestId: testId(cell.querySelector(LABEL_BUTTON)),
        });

        if (!row.ok) {
          result.skipped += 1;
          continue;
        }

        if (placeApiName(tag, row.propertyName, row.objectTypeId)) result.inserted += 1;
      } catch {
        // One row's worth of surprise is one missing line. It is never allowed
        // to become a broken settings page for whoever is using this portal.
        result.skipped += 1;
      }
    }
  }

  return result;
}

/** The feature record the host registers. */
export const propertyListFeature = {
  id: 'property-list',
  present: propertyTablePresent,
  annotate: annotatePropertyList,
  remove: removeApiNames,
};
