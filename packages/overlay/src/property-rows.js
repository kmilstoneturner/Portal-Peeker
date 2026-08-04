// The data-test-id grammar of HubSpot's property settings table.
//
// Strings in, object out. No DOM and no chrome.*, so it is testable in Vitest's
// node environment, and the DOM layer above it only has to find elements.
//
// HubSpot renders a property's internal name three times on every row, in
// attributes its own test suite uses:
//
//   <td     data-test-id="cell-name-0-1/annualrevenue">
//     <button data-test-id="property-label-annualrevenue">Annual Revenue</button>
//     <small  data-test-id="property-type-label-annualrevenue">Single-line text</small>
//
// This is an internal contract with no version and no notice. Two independent
// derivations must agree before a name is shown, so the failure mode when
// HubSpot changes one of them is a missing line rather than a confident wrong
// one. That is ADR-005's rule applied to markup: no rule fires on belief.

const CELL_PREFIX = 'cell-name-';
const TYPE_LABEL_PREFIX = 'property-type-label-';
const LABEL_PREFIX = 'property-label-';

// objectTypeId is 0-N for stock objects and 2-N for custom ones. Anchoring the
// split on that shape rather than on "the first slash" does two jobs: it
// rejects a malformed cell id instead of inventing a name from an incidental
// slash, and because the name half is greedy a property whose name contains a
// slash still parses.
const CELL_VALUE = /^(\d+-\d+)\/(.+)$/;

// Long enough that no real property comes near it, short enough that a runaway
// value is caught. Deliberately a short literal: tools/check-no-portal-data.mjs
// fails on any run of six or more digits, so a constant written with that many
// would have to be allowlisted alongside real portal ids, which is not company
// a structural constant should keep.
const MAX_NAME_LENGTH = 512;

const refuse = (reason) => ({ ok: false, reason });

/**
 * Strip a known prefix, or return null.
 *
 * startsWith plus slice, never a replace and never a split on '-'. A property
 * genuinely named `label-foo` arrives as `property-label-label-foo`, and both
 * of those would mangle it. There is a test.
 */
function afterPrefix(value, prefix) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(prefix)) return null;
  return value.slice(prefix.length);
}

/** A name is only rejected here for the shapes that mean the split went wrong. */
function nameProblem(name) {
  if (name === null) return 'no-prefix';
  if (name === '') return 'empty-name';
  if (/\s/.test(name)) return 'name-has-whitespace';
  if (name.length > MAX_NAME_LENGTH) return 'name-too-long';
  return null;
}

/**
 * Parse a name cell's test id.
 * @returns {{ok: true, objectTypeId: string, propertyName: string} | {ok: false, reason: string}}
 */
export function parseCellNameTestId(value) {
  const rest = afterPrefix(value, CELL_PREFIX);
  if (rest === null) return refuse('not-a-name-cell');

  const match = rest.match(CELL_VALUE);
  if (!match) return refuse('no-object-type-id');

  const problem = nameProblem(match[2]);
  if (problem) return refuse(problem);

  return { ok: true, objectTypeId: match[1], propertyName: match[2] };
}

/**
 * Parse a field type tag's test id.
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function parseTypeLabelTestId(value) {
  const name = afterPrefix(value, TYPE_LABEL_PREFIX);
  const problem = nameProblem(name);
  if (problem) return refuse(problem === 'no-prefix' ? 'not-a-type-label' : problem);
  return { ok: true, propertyName: name };
}

/**
 * Parse a label button's test id.
 *
 * `property-label-` cannot match a type label by accident: the two prefixes
 * diverge at index 9 (`property-l` against `property-t`). There is a test for
 * that too, because it is the sort of thing that stops being true when someone
 * renames a constant.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function parseLabelTestId(value) {
  const name = afterPrefix(value, LABEL_PREFIX);
  const problem = nameProblem(name);
  if (problem) return refuse(problem === 'no-prefix' ? 'not-a-label' : problem);
  return { ok: true, propertyName: name };
}

/**
 * Read one row, or refuse.
 *
 * The cell and the type tag are both required and must agree. The label button
 * is an optional third corroboration: when present it must agree, when absent
 * that is not a failure, because a read-only property can render its label as
 * something other than a button and requiring it would cost rows for no safety.
 *
 * objectTypeId is returned but never rendered. It is what makes the split
 * sound, and the record-page surface will need it.
 *
 * @returns {{ok: true, objectTypeId: string, propertyName: string} | {ok: false, reason: string}}
 */
export function readPropertyRow({ cellNameTestId, typeLabelTestId, labelTestId } = {}) {
  const cell = parseCellNameTestId(cellNameTestId);
  if (!cell.ok) return cell;

  const typeLabel = parseTypeLabelTestId(typeLabelTestId);
  if (!typeLabel.ok) return typeLabel;

  if (typeLabel.propertyName !== cell.propertyName) return refuse('name-mismatch');

  // Only checked when it parsed. An absent or unrecognized label button says
  // nothing either way; a present one that disagrees says the row is not what
  // it looks like.
  if (labelTestId !== undefined && labelTestId !== null) {
    const label = parseLabelTestId(labelTestId);
    if (label.ok && label.propertyName !== cell.propertyName) return refuse('name-mismatch');
  }

  return { ok: true, objectTypeId: cell.objectTypeId, propertyName: cell.propertyName };
}
