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
export function placeApiName(anchor, propertyName, objectTypeId) {
  if (!anchor || !anchor.parentNode) return false;

  const existing = isApiNameNode(anchor.previousElementSibling)
    ? anchor.previousElementSibling
    : null;

  if (existing) {
    if (existing.textContent !== propertyName) existing.textContent = propertyName;
    if (existing.getAttribute(OBJECT_TYPE_ATTRIBUTE) !== objectTypeId) {
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
  node.setAttribute(OBJECT_TYPE_ATTRIBUTE, objectTypeId);

  anchor.parentNode.insertBefore(node, anchor);
  return true;
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
