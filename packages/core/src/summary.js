// Pure. JSON text in, plain object out. No chrome.*, no DOM, no network, so the
// whole thing is testable in Vitest without loading the extension.
//
// This is the only parsing v1 does, and it exists for one reason: the six rows
// at the top of the popup. It runs downstream of capture and is never imported
// into the capture path. A failure here degrades the popup to "shape not fully
// recognized" and must never block a capture, a copy, or a download, which is
// why nothing in this file throws.

/**
 * @typedef {object} CaptureSummary
 * @property {boolean} recognized  false means show the degraded popup state
 * @property {string|null} reason  why it was not recognized
 * @property {'flow'|'list'|null} domain  what kind of payload this is
 * @property {string|null} name
 * @property {string|null} flowId
 * @property {string|null} listId
 * @property {string|null} portalId
 * @property {number|string|null} version  flow version, or listVersion
 * @property {boolean|null} isClassicWorkflow
 * @property {string|null} legacyWorkflowId
 * @property {number|null} actionCount
 * @property {boolean|null} enabled
 * @property {string|null} processingType  DYNAMIC | SNAPSHOT | MANUAL, lists only
 * @property {string|null} objectTypeId    lists only
 * @property {number|null} filterCount     lists only
 * @property {string[]|null} referencedListIds  lists only: ids this segment depends on
 */

const EMPTY = {
  recognized: false,
  reason: null,
  domain: null,
  name: null,
  flowId: null,
  listId: null,
  portalId: null,
  version: null,
  isClassicWorkflow: null,
  legacyWorkflowId: null,
  actionCount: null,
  enabled: null,
  processingType: null,
  objectTypeId: null,
  filterCount: null,
  referencedListIds: null,
};

/**
 * Find the flow object inside a parsed response body.
 *
 * GET /hybrid/{flowId} returns the flow at the root. POST /hybrid/batch has not
 * been captured often enough to pin its envelope, and section 8 of the findings
 * says shapes will keep arriving that nobody has seen. So: breadth-first, depth
 * limited, looking for the first object that carries a flowId and looks like a
 * flow rather than a child record that merely repeats the ID.
 *
 * Actions and data sources carry flowId too (findings section 3, "strip for
 * diff, keep for export"), hence the name/actions corroboration.
 *
 * The path back to the flow comes out with it, as object keys and array
 * indices. Anything that wants to edit the text rather than the parsed value
 * needs it to find the same object again (see json-span.js).
 */
export function findFlow(root) {
  const queue = [{ node: root, depth: 0, path: [] }];
  let fallback = null;
  let guard = 0;

  while (queue.length && guard++ < 500) {
    const { node, depth, path } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 4) continue;

    if (Array.isArray(node)) {
      node.slice(0, 25).forEach((item, index) => {
        queue.push({ node: item, depth: depth + 1, path: [...path, index] });
      });
      continue;
    }

    if (node.flowId != null && typeof node.flowId !== 'object') {
      const looksLikeFlow =
        'actions' in node || 'name' in node || 'isClassicWorkflow' in node;
      if (looksLikeFlow) return { flow: node, direct: node === root, path };
      if (!fallback) fallback = { flow: node, direct: false, path };
    }

    for (const [key, value] of Object.entries(node)) {
      // Never descend into our own inserted keys (see ai-context.js and
      // related.js). The context block records the flow's ID and name, so on
      // an envelope payload, whose root carries no flowId, the block would
      // otherwise be found before the flow it describes; the related block
      // carries whole other list definitions.
      if (key === '_aiContext' || key === '_related') continue;
      if (value && typeof value === 'object') {
        queue.push({ node: value, depth: depth + 1, path: [...path, key] });
      }
    }
  }

  return fallback;
}

/**
 * Find the segment (list) object inside a parsed response body.
 *
 * GET /api/inbounddb-lists/v1/lists/{listId} returns the list at the root
 * (observed live, August 2026); the public v3 API wraps the same object in a
 * {list: ...} envelope. So: the root, then the root's direct object children,
 * and nothing deeper. A deep scan here would be a hazard rather than
 * tolerance, because listId also appears inside IN_LIST filters and inside a
 * workflow's associatedLists, and fishing one of those out would summarize a
 * reference as if it were the payload.
 *
 * Corroboration mirrors findFlow: an object is only a list if, next to its
 * listId, it carries something only a list definition has.
 */
export function findList(root) {
  const candidates = [{ node: root, path: [] }];
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    for (const [key, value] of Object.entries(root)) {
      if (key === '_aiContext' || key === '_related') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        candidates.push({ node: value, path: [key] });
      }
    }
  }

  for (const { node, path } of candidates) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (node.listId == null || typeof node.listId === 'object') continue;
    const looksLikeList =
      'processingType' in node || 'filterBranch' in node || 'listVersion' in node || 'objectTypeId' in node;
    if (looksLikeList) return { list: node, direct: node === root, path };
  }

  return null;
}

/**
 * Count the leaf filters in a filterBranch tree.
 *
 * Leaves live in each branch's `filters` array; branches nest through
 * `filterBranches`, including ASSOCIATION branches, which carry their own
 * operator and then nest the filters that apply to the associated object.
 * This is the number a person would give if asked "how many conditions does
 * this segment check?", and it is computed rather than trusted from any
 * count field, because no count field has been observed.
 */
export function countFilters(branch) {
  if (!branch || typeof branch !== 'object') return null;
  let count = 0;
  const queue = [branch];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node.filters)) count += node.filters.length;
    if (Array.isArray(node.filterBranches)) queue.push(...node.filterBranches);
  }
  return count;
}

/**
 * The ids of every list this segment depends on, from its own definition.
 *
 * Three places name one: IN_LIST filters (filter.listId), ASSOCIATION
 * branches (branch.associationListId), and the suppression settings under
 * metadata. The segment's own id is excluded. This is the denominator for
 * "how much of what this segment references did we also capture".
 *
 * @param {object} list a list definition, as found by findList
 * @returns {string[]} distinct ids, sorted numerically where possible
 */
export function referencedListIds(list) {
  const out = new Set();
  const add = (value) => {
    if (value == null || typeof value === 'object' || typeof value === 'boolean') return;
    out.add(String(value));
  };

  if (list && typeof list === 'object') {
    const queue = [list.filterBranch];
    let guard = 0;
    while (queue.length && guard++ < 2000) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node.filters)) {
        for (const filter of node.filters) {
          if (filter && typeof filter === 'object') add(filter.listId);
        }
      }
      add(node.associationListId);
      if (Array.isArray(node.filterBranches)) queue.push(...node.filterBranches);
    }

    const suppression =
      list.metadata && list.metadata.membershipSettings
        ? list.metadata.membershipSettings.suppressionSettings
        : null;
    if (suppression && typeof suppression === 'object') {
      const entries = Array.isArray(suppression.suppressionLists) ? suppression.suppressionLists : [];
      for (const entry of entries) {
        if (entry && typeof entry === 'object') add(entry.listId);
        else add(entry);
      }
      add(suppression.secondarySuppressionListId);
      add(suppression.individualSuppressionSecondaryListId);
      add(suppression.emailDomainSuppressionSecondaryListId);
    }

    if (list.listId != null) out.delete(String(list.listId));
  }

  return [...out].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
}

/**
 * The list ids present in a set of raw getBatch bodies: the numerator for the
 * coverage the popup reports. Bodies that will not parse contribute nothing
 * rather than failing the count.
 *
 * @param {string[]} bodies raw responses, each an array of list definitions
 * @returns {string[]}
 */
export function listIdsInBatches(bodies) {
  const out = new Set();
  for (const body of Array.isArray(bodies) ? bodies : []) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed.slice(0, 500)) {
      if (item && typeof item === 'object' && item.listId != null && typeof item.listId !== 'object') {
        out.add(String(item.listId));
      }
    }
  }
  return [...out];
}

function countActions(actions) {
  // actions is a map keyed by action ID, not an array (findings section 5).
  // Tolerate an array anyway rather than reporting a wrong number.
  if (Array.isArray(actions)) return actions.length;
  if (actions && typeof actions === 'object') return Object.keys(actions).length;
  return null;
}

function pickPortalId(flow, root) {
  if (flow.portalId != null) return String(flow.portalId);
  if (root && root.portalId != null) return String(root.portalId);
  // Every action carries a redundant copy. Redundant for diffing, useful here.
  const actions = flow.actions;
  const first = actions && typeof actions === 'object' ? Object.values(actions)[0] : null;
  if (first && first.portalId != null) return String(first.portalId);
  return null;
}

/**
 * @param {string} rawText raw response body, verbatim
 * @returns {CaptureSummary}
 */
export function summarize(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { ...EMPTY, reason: 'empty body' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ...EMPTY, reason: 'body is not JSON' };
  }

  // Flows first, and it matters: a workflow's associatedLists carry listId and
  // filterBranch fields, so a payload that has a flow in it is a flow capture
  // whatever else it mentions. A list payload has no flowId anywhere, so the
  // order costs the list path nothing.
  const located = findFlow(parsed);
  if (!located) {
    const foundList = findList(parsed);
    if (foundList) return summarizeList(foundList.list, parsed);
    return { ...EMPTY, reason: 'no flow or list object found in response' };
  }

  const flow = located.flow;

  const summary = {
    ...EMPTY,
    recognized: true,
    reason: null,
    domain: 'flow',
    name: typeof flow.name === 'string' ? flow.name : null,
    flowId: flow.flowId != null ? String(flow.flowId) : null,
    portalId: pickPortalId(flow, parsed),
    // Root version only. Nested flowVersion fields are unreliable and the
    // copilot payload has been observed reporting 0 while the envelope said 2.
    version: flow.version != null ? flow.version : (flow.revisionId != null ? flow.revisionId : null),
    isClassicWorkflow:
      typeof flow.isClassicWorkflow === 'boolean' ? flow.isClassicWorkflow : null,
    legacyWorkflowId:
      flow.classicEnrollmentSettings && flow.classicEnrollmentSettings.workflowId != null
        ? String(flow.classicEnrollmentSettings.workflowId)
        : null,
    actionCount: countActions(flow.actions),
    enabled: typeof flow.isEnabled === 'boolean' ? flow.isEnabled : (typeof flow.enabled === 'boolean' ? flow.enabled : null),
  };

  // Degrade, do not fail. A partial inspection beats a blank panel.
  if (summary.flowId == null) {
    summary.recognized = false;
    summary.reason = 'no flowId in response';
  } else if (summary.isClassicWorkflow === false) {
    // Platform (non-classic) flows have not been captured yet. Enrollment lives
    // somewhere other than classicEnrollmentSettings and the reader for it does
    // not exist. Flag it and keep going.
    summary.recognized = false;
    summary.reason = 'platform flow envelope not yet supported';
  } else if (summary.actionCount == null) {
    summary.recognized = false;
    summary.reason = 'no actions map in response';
  }

  return summary;
}

/**
 * The list half of summarize. Observed envelope, August 2026:
 * portalId, listId, listVersion, objectTypeId, processingType, name,
 * metadata {...}, filterBranch {...}, description, uuid, at the root.
 */
function summarizeList(list, root) {
  const summary = {
    ...EMPTY,
    recognized: true,
    reason: null,
    domain: 'list',
    name: typeof list.name === 'string' ? list.name : null,
    listId: list.listId != null ? String(list.listId) : null,
    portalId:
      list.portalId != null
        ? String(list.portalId)
        : root && root.portalId != null
          ? String(root.portalId)
          : null,
    version: list.listVersion != null ? list.listVersion : null,
    processingType: typeof list.processingType === 'string' ? list.processingType : null,
    objectTypeId: typeof list.objectTypeId === 'string' ? list.objectTypeId : null,
    // null when the payload carries no filterBranch at all (a MANUAL list
    // legitimately has none); a number, possibly 0, when it does.
    filterCount: countFilters(list.filterBranch),
    referencedListIds: referencedListIds(list),
  };

  if (summary.listId == null) {
    summary.recognized = false;
    summary.reason = 'no listId in response';
  }

  return summary;
}
