// Pure. Raw response text in, smaller JSON text out. Never throws.
//
// Trim removes fields. It does not rename, restructure, reorder, or inflate
// anything, which makes the whole thing testable as one property: every leaf in
// the output exists in the input at the same path with an identical value. The
// optional HTML strip is the single exception and is why it is a separate
// toggle rather than part of the trim.
//
// The governing rule, learned the hard way:
//
//   NEVER drop a field because it is believed to duplicate another one.
//   Compare the two values and drop only on an actual match.
//
// Three rules derived from a four-action workflow were wrong when checked
// against a 201-action one. `filterBranchType` looked like a copy of
// `filterBranchOperator` and is actually a discriminator that disagrees in 20
// of 161 branches. `associatedLists[].filterBranch` looked redundant and holds
// unique goal criteria on a CLASSIC_GOAL_LIST. `inputValueFields` looked like
// pure duplication and carries the entire configuration of extension actions.
// Comparing at runtime turns each of those from a guess into a fact, and when
// HubSpot moves something the field simply stops being dropped.
//

import { summarize, findFlow } from './summary.js';
import { stripHtml, looksLikeHtml } from './strip-html.js';

// Bytes per token. A rough constant, deliberately one number rather than a
// per-field model: the figure exists to tell someone whether a payload will fit
// in a prompt, not to bill them.
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (text) =>
  typeof text === 'string' ? Math.round(text.length / CHARS_PER_TOKEN) : 0;

// Keys whose null is a fact rather than an absence.
//
//   defaultConnection: null  records failing every branch exit the workflow,
//                            which is a common silent bug and the single most
//                            diagnostic field in a branch action.
//   connection: null         terminal action.
const NULL_IS_MEANINGFUL = new Set(['defaultConnection', 'connection']);

// Direct children of actions.*.metadata whose empty array is an answer. An
// empty recipient list is the reason a notification reaches nobody, so deleting
// it turns "explicitly no one" into "not specified", which is a different and
// wrong claim. Scoped to depth one: below that, empty collections are
// structural placeholders rather than configuration.
const EMPTY_ARRAY_IS_MEANINGFUL = new Set([
  'userIds',
  'teamIds',
  'ownerProperties',
  'userIdsAndOwnerProperties',
  'recipientInputs',
  'suppressionListIds',
]);

// inputValueFields entries that are confirmed duplicates of a richer sibling.
// Everything else in that array is real action configuration and is kept, which
// is what stops the trim from silently gutting extension actions.
const EMBEDDED_DUPES = {
  // Lossy shadow of `connection`: the embedded copy nulls out filterBranch, so
  // it is never byte-equal. Drop it when the real connection object is present.
  hs_flow_branch_action_connections: (action) =>
    action.connection !== null && typeof action.connection === 'object',
  // Byte-identical to metadata.delay in every observed case, but verified
  // rather than assumed.
  hs_flow_action_time_delay: (action, parsedValue) =>
    deepEqual(parsedValue, action.metadata && action.metadata.delay),
};

export const PROFILES = {
  // For handing a workflow to a person or a model.
  reading: { keepProvenance: true },
  // For comparing two snapshots. updateMetadata changes on every save and its
  // request-side copy is stale, so it is pure false signal in a diff.
  diff: { keepProvenance: false },
};

// ---------------------------------------------------------------- helpers

/**
 * Order-insensitive deep equality.
 *
 * Key order matters here: the server reorders arrays and object keys with no
 * semantic meaning, and two responses with identical content have been observed
 * differing only in key order. A JSON.stringify comparison would report those as
 * different and quietly stop deduplicating.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

const weigh = (key, value) => {
  try {
    return JSON.stringify(value ?? null).length + String(key).length + 3;
  } catch {
    return 0;
  }
};

/** Records what each rule removed. This is the schema-drift alarm. */
function ledger() {
  const rules = new Map();
  return {
    hit(id, key, value) {
      const entry = rules.get(id) || { id, count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += weigh(key, value);
      rules.set(id, entry);
    },
    list: () => [...rules.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/** delete obj[key], recording it, only when `when` holds. */
function dropIf(log, id, obj, key, when = true) {
  if (!obj || !Object.hasOwn(obj, key) || !when) return false;
  log.hit(id, key, obj[key]);
  delete obj[key];
  return true;
}

// ---------------------------------------------------------------- rules

function reduceProvenance(log, flow, profile) {
  // updateMetadata keeps its timestamp: "last saved four minutes ago" is real
  // context. createMetadata does not: a creation date answers nothing about how
  // the flow behaves, and it is on the always-strip list for diffing anyway.
  for (const [field, keepTimestamp] of [['updateMetadata', true], ['createMetadata', false]]) {
    const envelope = flow[field];
    if (!envelope || typeof envelope !== 'object') continue;

    if (!profile.keepProvenance) {
      dropIf(log, 'provenance:drop', flow, field);
      continue;
    }

    // Keep who and when, drop the rest. The referrer alone is a third of this
    // object and leaks the editor sub-path the user happened to be on.
    const kept = {};
    if (keepTimestamp && envelope.updatedAt != null) kept.updatedAt = envelope.updatedAt;
    if (envelope.updatedBy && envelope.updatedBy.userId != null) {
      kept.updatedBy = { userId: envelope.updatedBy.userId };
    }
    if (envelope.templateMetadata && envelope.templateMetadata.templateId != null) {
      kept.templateMetadata = { templateId: envelope.templateMetadata.templateId };
    }

    log.hit('provenance:reduce', field, envelope);
    if (Object.keys(kept).length) flow[field] = kept;
    else delete flow[field];
  }
}

function dropEnvelopeNoise(log, flow) {
  for (const key of ['uuid', 'nextAvailableActionId', 'flowType', 'scheduledDisableAt']) {
    dropIf(log, 'envelope:noise', flow, key);
  }

  // Verified dedupe only. flowObjectType ("CONTACT") and objectTypeId ("0-1")
  // are different encodings that cannot be compared without a type map, so
  // both survive; enrolledType.objectTypeId can be compared, so the flat copy
  // goes when they agree.
  const nested = flow.enrolledType && flow.enrolledType.objectTypeId;
  dropIf(log, 'dedupe:objectTypeId', flow, 'objectTypeId', nested != null && nested === flow.objectTypeId);

  const triggerType = flow.enrollmentCriteria && flow.enrollmentCriteria.triggerType;
  dropIf(
    log,
    'dedupe:enrollmentTrigger',
    flow,
    'enrollmentTrigger',
    triggerType != null && triggerType === flow.enrollmentTrigger,
  );
}

function trimActions(log, flow, profile) {
  const actions = flow.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return;

  for (const [actionKey, action] of Object.entries(actions)) {
    if (!action || typeof action !== 'object') continue;

    dropIf(log, 'action:portalId', action, 'portalId', action.portalId === flow.portalId);
    dropIf(log, 'action:flowId', action, 'flowId', action.flowId === flow.flowId);
    dropIf(log, 'action:actionId', action, 'actionId', String(action.actionId) === actionKey);
    dropIf(log, 'action:flowVersion', action, 'flowVersion');

    const metadata = action.metadata;
    if (metadata && typeof metadata === 'object') {
      dropIf(
        log,
        'dedupe:metadata.actionType',
        metadata,
        'actionType',
        metadata.actionType != null && metadata.actionType === action.actionType,
      );
      trimInputValueFields(log, action, metadata);
    }

    // listBranches[].nextActionId repeats connection.nextActionId, and the
    // nested one is richer because it also carries edgeType.
    for (const branch of (action.connection && action.connection.listBranches) || []) {
      if (!branch || typeof branch !== 'object') continue;
      const nested = branch.connection && branch.connection.nextActionId;
      dropIf(
        log,
        'dedupe:branch.nextActionId',
        branch,
        'nextActionId',
        nested != null && nested === branch.nextActionId,
      );
    }
  }
}

function trimInputValueFields(log, action, metadata) {
  const fields = metadata.inputValueFields;
  if (!Array.isArray(fields) || fields.length === 0) return;

  const kept = fields.filter((field) => {
    const key = field && field.fieldKey;
    const test = key && Object.hasOwn(EMBEDDED_DUPES, key) ? EMBEDDED_DUPES[key] : null;
    if (!test) return true; // unknown key: real configuration, keep it

    let parsed = null;
    const rawValue = field.fieldValue && field.fieldValue.value;
    if (typeof rawValue === 'string') {
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        return true; // will not parse, so it cannot be shown to be a duplicate
      }
    }

    if (!test(action, parsed)) return true;
    log.hit(`embedded:${key}`, key, field);
    return false;
  });

  if (kept.length === fields.length) return;
  if (kept.length === 0) delete metadata.inputValueFields;
  else metadata.inputValueFields = kept;
}

function trimAssociatedLists(log, flow) {
  const lists = flow.associatedLists;
  if (!Array.isArray(lists)) return;

  const enrollmentFilter = flow.enrollmentCriteria && flow.enrollmentCriteria.filterBranch;

  for (const entry of lists) {
    if (!entry || typeof entry !== 'object') continue;
    dropIf(log, 'list:portalId', entry, 'portalId', entry.portalId === flow.portalId);
    dropIf(log, 'list:flowId', entry, 'flowId', entry.flowId === flow.flowId);

    // Only on an enrollment list, and only when it genuinely matches. A
    // CLASSIC_GOAL_LIST carries the workflow's goal criteria, which is unique
    // business logic and 5 percent of a large payload.
    const isEnrollmentList = Array.isArray(entry.listTypes) && entry.listTypes.includes('ENROLLMENT_LIST');
    dropIf(
      log,
      'dedupe:list.filterBranch',
      entry,
      'filterBranch',
      isEnrollmentList && enrollmentFilter != null && deepEqual(entry.filterBranch, enrollmentFilter),
    );
  }
}

function trimDataSources(log, flow) {
  const sources = (flow.dataSources && flow.dataSources.dataSources) || [];
  if (!Array.isArray(sources)) return;

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    dropIf(log, 'dataSource:portalId', source, 'portalId', source.portalId === flow.portalId);
    dropIf(log, 'dataSource:flowId', source, 'flowId', source.flowId === flow.flowId);
    dropIf(log, 'dataSource:timestamps', source, 'createdAt');
    dropIf(log, 'dataSource:timestamps', source, 'updatedAt');
    dropIf(log, 'dataSource:emptyLabel', source, 'label', source.label === '');
  }
}

function applyStripHtml(log, flow) {
  const actions = flow.actions;
  if (!actions || typeof actions !== 'object') return;

  for (const action of Object.values(actions)) {
    const metadata = action && action.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    if (!looksLikeHtml(metadata.body)) continue;

    const stripped = stripHtml(metadata.body);
    if (stripped === metadata.body) continue;
    log.hit('html:body', 'body', metadata.body.slice(0, metadata.body.length - stripped.length));
    metadata.body = stripped;
  }
}

/**
 * Drop nulls and empty collections, bottom-up so a container emptied by an
 * earlier rule collapses too.
 *
 * @param {boolean} inActionMetadata true for the direct children of an action's
 *   metadata object, where an empty array is configuration rather than noise.
 */
function prune(log, node, inActionMetadata = false) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) prune(log, item, false);
    return;
  }

  for (const value of Object.values(node)) prune(log, value, false);

  for (const [key, value] of Object.entries(node)) {
    if (value === null) {
      if (NULL_IS_MEANINGFUL.has(key)) continue;
      log.hit('prune:null', key, value);
      delete node[key];
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      if (inActionMetadata && EMPTY_ARRAY_IS_MEANINGFUL.has(key)) continue;
      log.hit('prune:emptyArray', key, value);
      delete node[key];
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      log.hit('prune:emptyObject', key, value);
      delete node[key];
    }
  }
}

function pruneFlow(log, flow) {
  const actions = flow.actions;

  // Action metadata first, with the recipient exemption in force, then hide it
  // from the general sweep so the exemption is not undone.
  const parked = [];
  if (actions && typeof actions === 'object' && !Array.isArray(actions)) {
    for (const action of Object.values(actions)) {
      if (!action || typeof action !== 'object') continue;
      const metadata = action.metadata;
      if (!metadata || typeof metadata !== 'object') continue;
      prune(log, metadata, true);
      if (Object.keys(metadata).length === 0) {
        log.hit('prune:emptyObject', 'metadata', metadata);
        delete action.metadata;
      } else {
        parked.push([action, metadata]);
        delete action.metadata;
      }
    }
  }

  prune(log, flow, false);

  for (const [action, metadata] of parked) action.metadata = metadata;
}

// ---------------------------------------------------------------- entry

/**
 * @param {string} rawText raw response body, verbatim
 * @param {{stripHtml?: boolean, profile?: 'reading'|'diff'}} [options]
 * @returns {{ok: boolean, output: string|null, reason: string|null,
 *            inputBytes: number, outputBytes: number,
 *            rules: Array<{id: string, count: number, bytes: number}>}}
 */
export function trim(rawText, options = {}) {
  const profile = PROFILES[options.profile] || PROFILES.reading;
  const inputBytes = typeof rawText === 'string' ? byteLength(rawText) : 0;
  const refuse = (reason) => ({
    ok: false,
    output: null,
    reason,
    inputBytes,
    outputBytes: inputBytes,
    rules: [],
  });

  const summary = summarize(rawText);
  if (!summary.recognized) {
    // No partial trims. A half-trimmed payload looks complete while missing
    // whatever the rules never reached, which is worse than not trimming.
    return refuse(summary.reason || 'shape not recognized');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return refuse('body is not JSON');
  }

  const located = findFlow(parsed);
  if (!located || !located.direct) {
    // Every capture observed so far has the flow at the response root. Trimming
    // inside an envelope nobody has seen would be guesswork.
    return refuse('flow is not at the response root');
  }

  try {
    const flow = located.flow;
    const log = ledger();

    dropEnvelopeNoise(log, flow);
    reduceProvenance(log, flow, profile);
    trimActions(log, flow, profile);
    trimAssociatedLists(log, flow);
    trimDataSources(log, flow);
    if (options.stripHtml) applyStripHtml(log, flow);
    pruneFlow(log, flow);

    // Minified: the entire point is token economy.
    const output = JSON.stringify(flow);
    return {
      ok: true,
      output,
      reason: null,
      inputBytes,
      outputBytes: byteLength(output),
      rules: log.list(),
    };
  } catch (error) {
    return refuse(`trim failed: ${String(error && error.message ? error.message : error)}`);
  }
}

function byteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}
