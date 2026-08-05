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
import { propertyNameIndex } from './property-names-store.js';
import { API_NAME_SELECTOR, apiNameNodeFor, isApiNameNode, placeApiName, removeApiNames } from './api-name-node.js';

/**
 * The text a node renders, minus anything this extension drew inside it.
 *
 * textContent is right everywhere the annotation sits BESIDE the label, which
 * is every surface but one. On Property history it lands inside the label cell,
 * and there textContent would read "Create Date" back as "Create Datecreatedate"
 * on the second pass: the lookup then resolves nothing, the row skips, and the
 * name already written stands with nothing left able to correct it. A row React
 * later reuses for a different property would keep it, which is a confidently
 * wrong name, arrived at by the one route the rule does not otherwise cover.
 *
 * Direct children only. Nothing is ever placed deeper than one level inside a
 * label, and a full tree walk would be answering a question nobody has asked.
 */
function labelText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (isApiNameNode(child)) continue;
    text += child.textContent;
  }
  return text;
}

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

  // Only the label surfaces need this, and it is fetched once per page by
  // HubSpot rather than by us. Null until the interceptor's message arrives, and
  // null forever on a page where it never did, which costs those surfaces and
  // nothing else. Read once per pass rather than once per row.
  const index = propertyNameIndex(page.objectTypeId);

  for (const surface of SURFACES) {
    for (const container of root.querySelectorAll(surface.container)) {
      result.cards += 1;

      // Every node this pass placed or confirmed in this container. Whatever is
      // not in here when the container is done is stale and comes out below.
      const kept = new Set();

      // Only where there is no anchor. An anchorless surface has nothing that
      // filters a second element carrying the same name, and the highlights
      // strip renders exactly that: the jobtitle-and-company composite carries
      // the jobtitle id on more than one element, and annotating each printed
      // the same name twice, stacked. The name is identical either way, so
      // declining the repeat risks nothing, which is why one mechanism covers
      // both a nested duplicate and a sibling copy. The anchored surfaces keep
      // their sharper filter: on the All properties panel the anchor check is
      // what excludes phone-button inside the fax row, a case where the names
      // DIFFER and a dedupe would have kept the wrong one.
      const seenNames = surface.anchor === null ? new Set() : null;

      // A surface only declares a list when its rows need scoping to direct
      // children of one. Where the row id identifies itself, the container is
      // scope enough.
      const scopes = surface.list ? container.querySelectorAll(surface.list) : [container];

      for (const scope of scopes) {
        for (const row of scope.querySelectorAll(surface.row)) {
          result.rows += 1;
          try {
            const outcome = annotateRow(row, surface, page.objectTypeId, index, seenNames);
            if (outcome && outcome.node) kept.add(outcome.node);
            if (outcome && outcome.inserted) {
              result.inserted += 1;
            } else {
              result.skipped += 1;
            }
          } catch {
            // One row's worth of surprise is one missing line. It is never
            // allowed to become a broken record page for whoever is using this
            // portal.
            result.skipped += 1;
          }
        }
      }

      // The stranded-node sweep. placeApiName tidies the one parent it writes
      // to, which is as far as it can see. When React rebuilds a wrapper and
      // the row lands in a NEW parent, the node placed on an earlier pass
      // survives in the old one, still attached, still rendering: the same
      // name printed twice, and no later placement ever visits it. So each
      // container ends its pass keeping exactly the nodes the pass stood
      // behind. Removing our own nodes cannot desync React, which never saw
      // them; and a row that stopped resolving loses its stale line too, which
      // is the missing-over-wrong trade every surface already makes.
      for (const node of container.querySelectorAll(API_NAME_SELECTOR)) {
        if (!kept.has(node)) node.remove();
      }
    }
  }

  return result;
}

/**
 * One row.
 *
 * @returns {false | {inserted: boolean, node: Element | null}} false is a skip.
 *   `inserted` is true only when a node was placed, which is what the host's
 *   cycle breaker counts: a correction is not an insertion. `node` is whichever
 *   of our nodes now serves this row, corrected or fresh, so the caller can
 *   keep it through the end-of-container sweep.
 */
function annotateRow(row, surface, objectTypeId, index, seenNames) {
  // The marker HubSpot puts on every property row, required as a direct child.
  // This is what a nested decoy cannot fake at the same depth. Only surfaces
  // whose row id is bare declare one: where the id carries a prefix it already
  // says what it is, and demanding a marker as well would cost real rows to
  // prove something the prefix has proved.
  if (surface.rowMarker && !row.querySelector(surface.rowMarker)) return false;

  const source = surface.source ? row.querySelector(surface.source) : null;
  const labelNode = surface.label ? row.querySelector(surface.label) : null;
  const read = readRowName(surface, {
    rowValue: surface.rowAttribute ? row.getAttribute(surface.rowAttribute) : null,
    sourceValue: source ? source.getAttribute(surface.sourceAttribute) : null,
    // Text, never innerHTML or an attribute. This is the rendered label, and
    // the only thing done with it is a lookup in a map we built ourselves.
    labelValue: labelNode ? labelText(labelNode) : null,
    index,
  });
  if (!read.ok) return false;

  // The composite guard, for anchorless surfaces only. A name this container
  // has already carried this pass is the same property wrapped again, and one
  // line is the truth about it. Checked after the read so a refused decoy never
  // burns the name for the real row behind it.
  if (seenNames) {
    if (seenNames.has(read.propertyName)) return false;
    seenNames.add(read.propertyName);
  }

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

  const inserted = placeApiName(anchor, read.propertyName, objectTypeId, surface.placement);
  return { inserted, node: apiNameNodeFor(anchor, surface.placement) };
}

/** The feature record the host registers. */
export const recordPropertiesFeature = {
  id: 'record-properties',
  present: recordSurfacesPresent,
  annotate: annotateRecordProperties,
  remove: removeApiNames,
};
