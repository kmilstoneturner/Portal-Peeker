// The node this extension draws, and the only code that draws it.
//
// Takes an anchor and a name. Knows nothing about tables, rows, or property
// settings, which is what lets a second surface (record pages) reuse it whole:
// only finding the anchor and reading the name are surface specific.
//
// THE RULE, and it is absolute:
//
//   This code only ever adds nodes it created. It never removes, moves,
//   reparents, or rewrites a node HubSpot rendered, and never writes an
//   attribute on one.
//
// That is what keeps React's reconciler safe. React removes children by calling
// parent.removeChild(itsOwnChildRef); it does not enumerate childNodes to work
// out what is there, so an extra sibling is invisible to it. Removing a node it
// owns, or wiping a container, is what produces the NotFoundError class of bug
// inside a customer's CRM. No test can prove this, because a simulated DOM is
// not React. The design is the mitigation.

const API_NAME_CLASS = 'pp-api-name';
const OBJECT_TYPE_ATTRIBUTE = 'data-pp-object-type';

/**
 * Where a surface's name node goes, relative to its anchor.
 *
 * BEFORE is every surface with an element to sit ahead of: the name lands as a
 * sibling in the anchor's parent. INSIDE appends to the anchor itself, for a
 * cell whose only child is a bare text node and so offers nothing to insert
 * ahead of.
 *
 * The two are not equally invisible to React, and the difference is worth
 * writing down rather than discovering. A sibling is genuinely invisible:
 * React removes children by direct reference, so one it never rendered is in no
 * fiber's child list. Appending into a host node whose sole child is text is
 * not, because React updates that case by assigning textContent, which takes
 * our node with it. That is a node that vanishes and is replaced on the next
 * pass, never a reconciler that desyncs. Both stay additive only: nothing
 * HubSpot rendered is removed, moved, or rewritten either way, which is the
 * rule that actually matters.
 */
export const PLACEMENT = {
  BEFORE: 'before',
  INSIDE: 'inside',
};

/** Every node this extension has drawn, anywhere under root. */
export const API_NAME_SELECTOR = `code.${API_NAME_CLASS}`;

/** Whether a node is one of ours. Never trust position alone. */
export function isApiNameNode(node) {
  return Boolean(node) && node.nodeType === 1 && node.classList.contains(API_NAME_CLASS);
}

/**
 * Put the API name immediately before an anchor, or correct the one already
 * there.
 *
 * Idempotency reads our own node rather than marking HubSpot's. Marking the row
 * would be wrong for a specific reason: React reuses row elements across
 * renders, so if rows are keyed by position the same element serves a different
 * property on page 2, and a stale marker would suppress the annotation on the
 * row that replaced it. Reading our own node instead makes the pass
 * self correcting: a reused row gets its text fixed rather than being trusted.
 *
 * @returns {boolean} true only when a node was inserted, which is what the
 *   host's cycle breaker counts. A correction is not an insertion.
 */
export function placeApiName(anchor, propertyName, objectTypeId, placement = PLACEMENT.BEFORE) {
  if (!anchor) return false;

  // One shape, two placements. insertBefore(node, null) is appendChild, so all
  // that varies is which node is the parent and which neighbour counts as the
  // name already written.
  const inside = placement === PLACEMENT.INSIDE;
  const parent = inside ? anchor : anchor.parentNode;
  if (!parent) return false;
  const reference = inside ? null : anchor;
  const neighbour = inside ? anchor.lastElementChild : anchor.previousElementSibling;

  const existing = isApiNameNode(neighbour) ? neighbour : null;

  // Anything else of ours in this parent is an orphan, and leaving it produces
  // the same name printed twice. Observed live on the highlights strip: React
  // re-rendered the value node and put the new one AHEAD of the node we had
  // already placed, so the previousElementSibling test above missed and the next
  // pass inserted a second one.
  //
  // Sweeping is safe in a way that almost nothing else here would be: these are
  // nodes this file created, and React has never seen them, so removing one
  // cannot desync a reconciler. Contrast removeApiNames, which takes out every
  // node anywhere; this only tidies the one parent it is about to write to.
  //
  // It assumes one anchor per parent, which holds on every surface today and is
  // asserted by a test rather than believed. Under INSIDE the parent IS the
  // anchor, so there is exactly one by construction.
  sweepStrays(parent, existing);

  if (existing) {
    if (existing.textContent !== propertyName) existing.textContent = propertyName;
    if (objectTypeId && existing.getAttribute(OBJECT_TYPE_ATTRIBUTE) !== objectTypeId) {
      existing.setAttribute(OBJECT_TYPE_ATTRIBUTE, objectTypeId);
    }
    return false;
  }

  const node = anchor.ownerDocument.createElement('code');
  node.className = API_NAME_CLASS;
  // textContent, never innerHTML. The value came off a customer's page and this
  // code has no business assembling markup from it.
  node.textContent = propertyName;
  // Carried for the record-page surface and for debugging. Nothing renders it.
  //
  // Written only when there is one. On the create dialog the object type comes
  // from an admin-only link and is legitimately absent, and an absent fact has
  // to be an absent attribute: setAttribute would stringify it and put the word
  // "null" on the page, which is a claim rather than a gap.
  if (objectTypeId) node.setAttribute(OBJECT_TYPE_ATTRIBUTE, objectTypeId);

  parent.insertBefore(node, reference);
  return true;
}

/**
 * The node currently serving an anchor, or null.
 *
 * The same neighbour rule placeApiName applies, exported so a caller can learn
 * WHICH node now stands for a row it just processed. record-properties.js needs
 * that to end each container pass with only the nodes the pass vouched for:
 * placeApiName's own sweep reaches one parent, and a node stranded elsewhere by
 * a React re-parent is invisible to it.
 */
export function apiNameNodeFor(anchor, placement = PLACEMENT.BEFORE) {
  if (!anchor) return null;
  const neighbour =
    placement === PLACEMENT.INSIDE ? anchor.lastElementChild : anchor.previousElementSibling;
  return isApiNameNode(neighbour) ? neighbour : null;
}

/**
 * Drop any node of ours in this parent except the one being kept.
 *
 * Snapshotted before removing: parent.children is live, and mutating it while
 * iterating skips elements.
 *
 * @returns {number} how many were removed
 */
function sweepStrays(parent, keep) {
  const strays = [];
  for (const child of parent.children) {
    if (child !== keep && isApiNameNode(child)) strays.push(child);
  }
  for (const stray of strays) stray.remove();
  return strays.length;
}

/**
 * Take every node this extension drew back out.
 *
 * Surface agnostic on purpose: turning the setting off has to clean up every
 * surface, and a second one is coming. Removing our own nodes cannot desync
 * React, because they were never in any fiber's child list.
 *
 * @returns {number} how many were removed
 */
export function removeApiNames(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const nodes = root.querySelectorAll(API_NAME_SELECTOR);
  for (const node of nodes) node.remove();
  return nodes.length;
}
