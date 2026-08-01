// Pure. JSON text in, plain object out. No chrome.*, no DOM, no network, so the
// whole thing is testable in Vitest without loading the extension.
//
// This is the only parsing v1 does, and it exists for one reason: the six rows
// at the top of the popup. It runs downstream of capture and is never imported
// into the capture path. A failure here degrades the popup to "shape not fully
// recognized" and must never block a capture, a copy, or a download, which is
// why nothing in this file throws.

/**
 * @typedef {object} FlowSummary
 * @property {boolean} recognized  false means show the degraded popup state
 * @property {string|null} reason  why it was not recognized
 * @property {string|null} name
 * @property {string|null} flowId
 * @property {string|null} portalId
 * @property {number|string|null} version
 * @property {boolean|null} isClassicWorkflow
 * @property {string|null} legacyWorkflowId
 * @property {number|null} actionCount
 * @property {boolean|null} enabled
 */

const EMPTY = {
  recognized: false,
  reason: null,
  name: null,
  flowId: null,
  portalId: null,
  version: null,
  isClassicWorkflow: null,
  legacyWorkflowId: null,
  actionCount: null,
  enabled: null,
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
 */
export function findFlow(root) {
  const queue = [{ node: root, depth: 0 }];
  let fallback = null;
  let guard = 0;

  while (queue.length && guard++ < 500) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 4) continue;

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 25)) queue.push({ node: item, depth: depth + 1 });
      continue;
    }

    if (node.flowId != null && typeof node.flowId !== 'object') {
      const looksLikeFlow =
        'actions' in node || 'name' in node || 'isClassicWorkflow' in node;
      if (looksLikeFlow) return { flow: node, direct: node === root };
      if (!fallback) fallback = node;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
    }
  }

  return fallback ? { flow: fallback, direct: false } : null;
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
 * @returns {FlowSummary}
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

  const located = findFlow(parsed);
  if (!located) {
    return { ...EMPTY, reason: 'no flow object found in response' };
  }

  const flow = located.flow;

  const summary = {
    recognized: true,
    reason: null,
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
