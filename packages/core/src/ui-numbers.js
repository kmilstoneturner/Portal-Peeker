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
//
// The annotation is an insertion into the text, never a re-serialization, so it
// works on the raw capture as well as on trim output. That is what lets the
// checkbox stand on its own rather than riding on top of the trim.

import { findFlow } from './summary.js';
import { spanAt, objectMembers, applyInsertions } from './json-span.js';

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
 * Add each action's editor number to a flow JSON text as a uiNumber field.
 *
 * The annotation is inserted as text, one span per action, immediately before
 * that action's closing brace. Every other byte of the target survives, so the
 * target can be the raw capture just as safely as trim output: the export is a
 * superset of what HubSpot sent, in the literal sense that the original bytes
 * are all still in it, in order. Removing the inserted spans returns the input,
 * and that is the test.
 *
 * Re-serializing was the obvious alternative and is quietly destructive on raw:
 * JSON.stringify would drop the original whitespace, normalize numbers, and
 * sort the actions map numerically, since its keys are action IDs.
 *
 * The numbers still come from rawText, whatever the target is.
 *
 * @param {string} rawText raw response body, the authority on the graph
 * @param {string} jsonText flow JSON to annotate, raw or trim output
 * @returns {{ok: boolean, output: string|null, reason: string|null, count: number,
 *            insertions: Array<{at: number, text: string}>}}
 */
export function addUiNumbers(rawText, jsonText) {
  const refuse = (reason) => ({ ok: false, output: null, reason, count: 0, insertions: [] });

  const numbers = uiNumbersFromText(rawText);
  if (!numbers.ok) return refuse(numbers.reason);

  if (typeof jsonText !== 'string') return refuse('nothing to annotate');
  let target;
  try {
    target = JSON.parse(jsonText);
  } catch {
    return refuse('annotation target is not JSON');
  }

  const located = findFlow(target);
  if (!located) return refuse('no flow object found in the annotation target');
  const actions = located.flow.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    return refuse('annotation target carries no actions map');
  }

  const span = spanAt(jsonText, [...located.path, 'actions']);
  if (!span) return refuse('could not locate the actions map in the annotation target');
  const members = objectMembers(jsonText, span.start);
  if (!members || members.length !== Object.keys(actions).length) {
    return refuse('could not locate every action in the annotation target');
  }

  const insertions = [];
  for (const member of members) {
    const action = actions[member.key];
    if (!action || typeof action !== 'object') continue;
    if (Object.hasOwn(action, 'uiNumber')) {
      // Has never been observed in a payload. If HubSpot ever ships this key,
      // overwriting it would destroy data and keeping ours beside it is
      // impossible, so the only honest move is to step aside.
      return refuse('payload already carries a uiNumber field');
    }
    const number = numbers.byActionId[member.key];
    if (number == null) {
      // ok was true, so every raw action has a number. A target action the raw
      // graph has never heard of means the two texts are not the same capture.
      return refuse(`action ${member.key} is not in the raw capture`);
    }

    const fields = objectMembers(jsonText, member.valueStart);
    if (!fields) return refuse(`could not read action ${member.key} in the annotation target`);
    // Inserted before the closing brace, so uiNumber is the last key and the
    // original key order is untouched. An action with no fields at all takes
    // no separating comma.
    insertions.push({
      at: member.valueEnd - 1,
      text: `${fields.length ? ',' : ''}"uiNumber":${number}`,
    });
  }

  return {
    ok: true,
    output: applyInsertions(jsonText, insertions),
    reason: null,
    count: insertions.length,
    insertions,
  };
}
