// Pure. Flow JSON in, editor card numbers out. No chrome.*, no DOM, no network.
//
// The workflow editor labels every action card with a number (1, 2, 3...) and
// those numbers appear nowhere in the payload. They are the breadth-first order
// of the layout tree: the root is firstActionId, the edges are the STANDARD
// connections, and the number is the dequeue position. Visually that is reading
// order: row by row from the top, left to right within a row. Children of a
// LIST_BRANCH come in listBranches array order with defaultConnection last,
// which matches the left-to-right column order on the canvas. GOTO edges are
// skipped: they render as "go to action" pills, and the target card is placed
// by its one STANDARD parent.
//
// Evidence, August 2026: eight hand-checked anchors plus a screenshot readback
// of about 23 visible numbers on a 201-action production flow, exact on every
// card, and the unique match among 16 traversal variants tested (depth-first,
// reversed branch order, default-first, and GOTO-following all fail). The
// copilot payload independently ships a field named breadthFirstSearchActionOrder,
// HubSpot's own name for this order (findings page, section 6). When chirp
// capture exists, that field is the test oracle for this walker.
//
// The numbers are volatile by nature: adding, moving, or removing one action
// renumbers everything after it in reading order. They are only meaningful
// against the exact capture they were computed from. actionId is the stable
// handle across versions.
//
// Failure posture: never throws, and never half-numbers. An unrecognized
// connection shape or an action unreachable through STANDARD edges makes ok
// false so the caller can withdraw the option, because a file where some cards
// carry numbers and some do not looks complete while lying about the canvas.

import { findFlow } from './summary.js';

const EMPTY = {
  ok: false,
  reason: null,
  byActionId: {},
  byUiNumber: {},
  unnumbered: [],
  unknown: [],
};

/**
 * The outgoing edges of one action, in canvas order.
 *
 * Returns null when the connection carries a shape this module has never seen
 * (an unrecognized connectionType or edgeType). Guessing at an unrecognized
 * shape could misnumber every card after it, which is worse than refusing.
 */
function childEdges(action) {
  const connection = action && action.connection;
  if (!connection || typeof connection !== 'object') return [];

  const edges = [];
  const add = (conn) => {
    if (!conn || typeof conn !== 'object' || conn.nextActionId == null) return true;
    // A missing edgeType is treated as STANDARD: every observed connection
    // carries one, but its absence is not a new semantic the way a new string
    // value is. GOTO does not place the target. Anything else is unknown.
    const edgeType = conn.edgeType == null ? 'STANDARD' : conn.edgeType;
    if (edgeType === 'GOTO') return true;
    if (edgeType !== 'STANDARD') return false;
    edges.push(String(conn.nextActionId));
    return true;
  };

  if (connection.connectionType === 'LIST_BRANCH') {
    const branches = Array.isArray(connection.listBranches) ? connection.listBranches : [];
    for (const branch of branches) {
      if (!add(branch && branch.connection)) return null;
    }
    if (!add(connection.defaultConnection)) return null;
    return edges;
  }

  // SINGLE, or an older shape carrying nextActionId without a discriminator.
  if (connection.connectionType == null || connection.connectionType === 'SINGLE') {
    return add(connection) ? edges : null;
  }

  return null;
}

/**
 * Walk the STANDARD-edge tree breadth-first from firstActionId.
 *
 * @param {object} flow parsed flow object carrying actions and firstActionId
 * @returns {{ok: boolean, reason: string|null,
 *            byActionId: Record<string, number>,
 *            byUiNumber: Record<number, string>,
 *            unnumbered: string[], unknown: string[]}}
 */
export function computeUiNumbers(flow) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    return { ...EMPTY, reason: 'no flow object' };
  }
  const actions = flow.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    return { ...EMPTY, reason: 'no actions map in flow' };
  }
  if (flow.firstActionId == null) {
    return { ...EMPTY, reason: 'no firstActionId in flow' };
  }
  const rootId = String(flow.firstActionId);
  if (!actions[rootId] || typeof actions[rootId] !== 'object') {
    return { ...EMPTY, reason: 'firstActionId is not in the actions map' };
  }

  const byActionId = {};
  const byUiNumber = {};
  const unknown = [];
  const enqueued = new Set([rootId]);
  const queue = [rootId];
  let next = 0;

  while (queue.length > 0) {
    const id = queue.shift();
    next += 1;
    byActionId[id] = next;
    byUiNumber[next] = id;

    const edges = childEdges(actions[id]);
    if (edges === null) {
      unknown.push(id);
      continue;
    }
    for (const childId of edges) {
      if (!actions[childId] || enqueued.has(childId)) continue;
      enqueued.add(childId);
      queue.push(childId);
    }
  }

  const unnumbered = Object.keys(actions).filter((id) => !Object.hasOwn(byActionId, id));

  let reason = null;
  if (unknown.length) {
    reason = `unrecognized connection shape on action ${unknown.join(', ')}`;
  } else if (unnumbered.length) {
    reason = `${unnumbered.length} of ${Object.keys(actions).length} actions unreachable from firstActionId`;
  }

  return { ok: reason === null, reason, byActionId, byUiNumber, unnumbered, unknown };
}

/**
 * Compute numbers from a raw response body.
 *
 * Always from the raw capture, never from a trimmed copy, so no present or
 * future trim rule can move a number. Today the two would agree, because the
 * trim keeps every connection field the walk reads. That is a coincidence this
 * function declines to depend on.
 *
 * @param {string} rawText raw response body, verbatim
 */
export function uiNumbersFromText(rawText) {
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
  return computeUiNumbers(located.flow);
}

/**
 * Append each action's editor number to a flow JSON text as a uiNumber field.
 *
 * The target is the trimmed output, so this runs downstream of trim and is the
 * one step that makes the export a superset of what HubSpot sent: one appended
 * key per action, nothing else touched, original key order preserved. The
 * numbers still come from rawText.
 *
 * @param {string} rawText raw response body, the authority on the graph
 * @param {string} jsonText flow JSON to annotate, typically trim output
 * @returns {{ok: boolean, output: string|null, reason: string|null, count: number}}
 */
export function addUiNumbers(rawText, jsonText) {
  const refuse = (reason) => ({ ok: false, output: null, reason, count: 0 });

  const numbers = uiNumbersFromText(rawText);
  if (!numbers.ok) return refuse(numbers.reason);

  if (typeof jsonText !== 'string') return refuse('nothing to annotate');
  let target;
  try {
    target = JSON.parse(jsonText);
  } catch {
    return refuse('annotation target is not JSON');
  }
  const actions = target && typeof target === 'object' ? target.actions : null;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    return refuse('annotation target is not a flow at the root');
  }

  let count = 0;
  for (const [id, action] of Object.entries(actions)) {
    if (!action || typeof action !== 'object') continue;
    if (Object.hasOwn(action, 'uiNumber')) {
      // Has never been observed in a payload. If HubSpot ever ships this key,
      // overwriting it would destroy data and keeping ours beside it is
      // impossible, so the only honest move is to step aside.
      return refuse('payload already carries a uiNumber field');
    }
    const number = numbers.byActionId[id];
    if (number == null) {
      // ok was true, so every raw action has a number. A target action the raw
      // graph has never heard of means the two texts are not the same capture.
      return refuse(`action ${id} is not in the raw capture`);
    }
    action.uiNumber = number;
    count += 1;
  }

  try {
    return { ok: true, output: JSON.stringify(target), reason: null, count };
  } catch {
    return refuse('annotated flow would not serialize');
  }
}
