import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trim, estimateTokens } from '../src/trim.js';
import { summarize } from '../src/summary.js';
import { assertSubtractive } from './subtractive.js';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name) => readFileSync(fixturesDir + name, 'utf8');

const CASES = fixture('synthetic/trim-cases.synthetic.json');
const LOAD_V3 = fixture('synthetic/hybrid-get-v3.json');
const SAVE_V4 = fixture('synthetic/save-response-v4.json');

const trimmed = (raw, options) => {
  const result = trim(raw, options);
  expect(result.ok, result.reason || '').toBe(true);
  return JSON.parse(result.output);
};

const ruleIds = (raw, options) => trim(raw, options).rules.map((r) => r.id);

// ------------------------------------------------------------------ property
//
// assertSubtractive lives in ./subtractive.js now, shared with the record
// trim's suite: one definition of the property both trims are judged by.

describe('trim is subtractive', () => {
  for (const [label, raw] of [['kitchen sink', CASES], ['load v3', LOAD_V3], ['save v4', SAVE_V4]]) {
    it(`removes only, never rewrites: ${label}`, () => {
      assertSubtractive(JSON.parse(raw), trimmed(raw));
    });
  }

  it('output is still a recognizable flow', () => {
    const before = summarize(LOAD_V3);
    const after = summarize(trim(LOAD_V3).output);
    expect(after.recognized).toBe(true);
    expect(after.flowId).toBe(before.flowId);
    expect(after.name).toBe(before.name);
    expect(after.version).toBe(before.version);
    expect(after.actionCount).toBe(before.actionCount);
  });

  it('is idempotent', () => {
    const once = trim(LOAD_V3).output;
    expect(trim(once).output).toBe(once);
  });
});

// ------------------------------------------------------------------ drops

describe('what the trim drops', () => {
  const out = trimmed(CASES);

  it('drops envelope noise and allocator counters', () => {
    for (const key of ['uuid', 'nextAvailableActionId', 'flowType', 'scheduledDisableAt']) {
      expect(out[key]).toBeUndefined();
    }
  });

  it('reduces provenance to who and when, dropping the referrer', () => {
    expect(out.updateMetadata).toEqual({ updatedAt: 1780000900000, updatedBy: { userId: 5550002 } });
    expect(out.createMetadata).toEqual({
      updatedBy: { userId: 5550001 },
      templateMetadata: { templateId: 777 },
    });
  });

  it('drops per-action ids that repeat the root or the map key', () => {
    for (const action of Object.values(out.actions)) {
      expect(action.portalId).toBeUndefined();
      expect(action.flowId).toBeUndefined();
      expect(action.actionId).toBeUndefined();
      expect(action.flowVersion).toBeUndefined();
    }
  });

  it('drops metadata.actionType only when it matches the action', () => {
    expect(out.actions['1'].metadata.actionType).toBeUndefined();
    // Action 6 disagrees with its parent, so it is kept rather than assumed.
    expect(out.actions['6'].metadata.actionType).toBe('SOMETHING_ELSE');
  });

  it('drops branch nextActionId only when it matches the nested connection', () => {
    const [matching, mismatched] = out.actions['2'].connection.listBranches;
    expect(matching.nextActionId).toBeUndefined();
    expect(mismatched.nextActionId).toBe(99);
  });

  it('drops nulls and empty collections', () => {
    expect(out.triggers).toBeUndefined();
    expect(out.actions['1'].metadata.objectRequestOptions).toBeUndefined();
    expect(out.actions['1'].metadata.nestedConfig).toEqual({ keepMe: 'yes' });
    expect(out.flowEventFilters).toBeUndefined();
  });

  it('drops the enrollment list filterBranch when it really matches, ignoring key order', () => {
    const enrollmentList = out.associatedLists.find((l) => l.listTypes.includes('ENROLLMENT_LIST'));
    expect(enrollmentList.filterBranch).toBeUndefined();
    expect(enrollmentList.listId).toBe(17);
  });

  it('drops the two known embedded-JSON duplicates', () => {
    expect(out.actions['2'].metadata).toBeUndefined();
    expect(out.actions['3'].metadata.inputValueFields).toBeUndefined();
    expect(out.actions['3'].metadata.delay).toEqual({ unit: 'DAYS', value: 3 });
  });
});

// ------------------------------------------------------------------ keeps

describe('what the trim must never drop', () => {
  const out = trimmed(CASES);

  it('keeps defaultConnection: null, the silent-bug signal', () => {
    // Records failing every branch exit the workflow. Deleting this turns the
    // most diagnostic field in a branch action into an absence.
    expect(Object.hasOwn(out.actions['2'].connection, 'defaultConnection')).toBe(true);
    expect(out.actions['2'].connection.defaultConnection).toBeNull();
  });

  it('keeps connection: null on a terminal action', () => {
    expect(Object.hasOwn(out.actions['6'], 'connection')).toBe(true);
    expect(out.actions['6'].connection).toBeNull();
  });

  it('keeps empty recipient lists, which answer "who gets notified"', () => {
    const metadata = out.actions['1'].metadata;
    expect(metadata.userIds).toEqual([]);
    expect(metadata.teamIds).toEqual([]);
    expect(metadata.ownerProperties).toEqual([]);
    expect(metadata.userIdsAndOwnerProperties).toEqual([]);
  });

  it('drops an empty array nested below action metadata, which is structural', () => {
    expect(out.actions['1'].metadata.nestedConfig.innerEmptyList).toBeUndefined();
  });

  it('keeps the graph and the trigger', () => {
    expect(out.firstActionId).toBe(1);
    expect(out.isEnabled).toBe(true);
    expect(out.isClassicWorkflow).toBe(true);
    expect(out.flowObjectType).toBe('CONTACT');
    expect(out.portalId).toBe(111111111);
    expect(out.flowId).toBe(2222222222);
    expect(out.enrollmentCriteria.filterBranch).toBeDefined();
    expect(out.classicEnrollmentSettings.workflowId).toBe(88888888);
  });
});

// ------------------------------------------------------------------ retractions

describe('rules retracted after the 201-action flow disproved them', () => {
  const out = trimmed(CASES);

  it('keeps filterBranchType: it is a discriminator, not a copy of the operator', () => {
    // Identical in all 6 branches of a 4-action flow, different in 20 of 161
    // branches of a 201-action one (ASSOCIATION, UNIFIED_EVENTS). Dropping it
    // would erase what kind of thing the branch filters on.
    const [assoc, events] = out.actions['2'].connection.listBranches;
    expect(assoc.filterBranch.filterBranchType).toBe('ASSOCIATION');
    expect(assoc.filterBranch.filterBranchOperator).toBe('AND');
    expect(events.filterBranch.filterBranchType).toBe('UNIFIED_EVENTS');
  });

  it('keeps a CLASSIC_GOAL_LIST filterBranch: it is unique business logic', () => {
    const goal = out.associatedLists.find((l) => l.listTypes.includes('CLASSIC_GOAL_LIST'));
    expect(goal.filterBranch).toBeDefined();
    expect(goal.filterBranch.filters[0].property).toBe('lifecyclestage');
  });

  it('keeps inputValueFields that are not known duplicates', () => {
    // Extension actions carry their entire configuration here. Dropping the
    // array wholesale would leave the action shell looking complete.
    const keys = out.actions['5'].metadata.inputValueFields.map((f) => f.fieldKey);
    expect(keys).toEqual(['object_to_enrich', 'bi_enrichment_overwrite']);
  });

  it('keeps a delay blob that does not actually match metadata.delay', () => {
    const keys = out.actions['4'].metadata.inputValueFields.map((f) => f.fieldKey);
    expect(keys).toEqual(['hs_flow_action_time_delay']);
  });
});

// ------------------------------------------------------------------ refusal

describe('trim refuses rather than half-working', () => {
  it('refuses an unrecognized shape', () => {
    const result = trim('{"status":"error"}');
    expect(result.ok).toBe(false);
    expect(result.output).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('refuses a platform flow, whose envelope has never been captured', () => {
    const result = trim(JSON.stringify({ flowId: 1, name: 'p', isClassicWorkflow: false, actions: {} }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('platform flow envelope not yet supported');
  });

  it('refuses a flow nested inside an envelope rather than guessing', () => {
    const nested = { results: [{ flow: { flowId: 42, name: 'n', isClassicWorkflow: true, actions: { 1: {} } } }] };
    const result = trim(JSON.stringify(nested));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flow is not at the response root');
  });

  it('refuses a segment or a record with the cross-domain reason, not an accident', () => {
    // Once summarize recognizes these domains they are recognized: true, so
    // without the domain guard the refusal would fall through to "flow is not
    // at the response root", which is findFlow returning null rather than a
    // decision, and it names the wrong problem.
    const record = JSON.stringify({
      9101: { objectTypeId: '0-1', objectId: 9101, properties: { firstname: { value: 'F' } } },
    });
    const list = JSON.stringify({ portalId: 1, listId: 4242, processingType: 'DYNAMIC', name: 'L' });
    for (const raw of [record, list]) {
      const result = trim(raw);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('trimming to workflow logic applies to workflow captures only');
    }
  });

  it('never throws, and reports input size even when refusing', () => {
    for (const input of ['', null, undefined, 'not json', '[]', '{}']) {
      expect(() => trim(input)).not.toThrow();
      expect(trim(input).ok).toBe(false);
    }
    const result = trim('not json');
    expect(result.inputBytes).toBe(8);
    expect(result.outputBytes).toBe(8);
  });
});

// ------------------------------------------------------------------ html + profiles

describe('stripHtml option', () => {
  it('converts bodies only when asked', () => {
    expect(trimmed(CASES).actions['1'].metadata.body).toContain('<strong>');
    const stripped = trimmed(CASES, { stripHtml: true }).actions['1'].metadata.body;
    expect(stripped).not.toContain('<strong>');
    expect(stripped).toContain('**{{ contact.firstname }}**');
    expect(stripped).toContain('- First step');
    expect(stripped).toContain('[the doc](https://example.invalid/doc)');
  });

  it('is the one thing that breaks the subtractive property, by design', () => {
    const input = JSON.parse(CASES);
    const output = trimmed(CASES, { stripHtml: true });
    expect(() => assertSubtractive(input, output)).toThrow();
  });

  it('reports the html rule separately so its cost is visible', () => {
    expect(ruleIds(CASES, { stripHtml: true })).toContain('html:body');
    expect(ruleIds(CASES)).not.toContain('html:body');
  });
});

describe('profiles', () => {
  it('reading keeps reduced provenance, diff drops it entirely', () => {
    expect(trimmed(CASES, { profile: 'reading' }).updateMetadata).toBeDefined();
    expect(trimmed(CASES, { profile: 'diff' }).updateMetadata).toBeUndefined();
    expect(trimmed(CASES, { profile: 'diff' }).createMetadata).toBeUndefined();
  });

  it('falls back to reading for an unknown profile', () => {
    expect(trimmed(CASES, { profile: 'nonsense' }).updateMetadata).toBeDefined();
  });
});

// ------------------------------------------------------------------ reporting

describe('rule ledger and sizing', () => {
  it('reports every rule that fired, largest first', () => {
    const rules = trim(CASES).rules;
    expect(rules.length).toBeGreaterThan(10);
    expect(rules).toEqual([...rules].sort((a, b) => b.bytes - a.bytes));
    for (const rule of rules) expect(rule.count).toBeGreaterThan(0);
  });

  it('reports honest before and after sizes', () => {
    const result = trim(LOAD_V3);
    // Measured, not pinned to a magic number: the committed fixtures are
    // scrubbed copies, so their exact size is an artefact of the scrubbing
    // rather than a fact about HubSpot.
    expect(result.inputBytes).toBe(Buffer.byteLength(LOAD_V3, 'utf8'));
    expect(result.outputBytes).toBe(Buffer.byteLength(result.output, 'utf8'));
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
  });

  it('estimates tokens from one constant', () => {
    expect(estimateTokens('x'.repeat(350))).toBe(100);
    expect(estimateTokens(null)).toBe(0);
  });
});

// ------------------------------------------------------------------ real captures

describe('real trial-portal captures', () => {
  it('trims the load and save captures to roughly half', () => {
    for (const raw of [LOAD_V3, SAVE_V4]) {
      const result = trim(raw);
      expect(result.ok).toBe(true);
      expect(result.outputBytes / result.inputBytes).toBeLessThan(0.6);
    }
  });

  it('keeps the empty recipient lists that explain why nobody is notified', () => {
    // All three notification actions in this flow have no recipients
    // configured, which is the answer to "why does this not email me".
    const out = trimmed(SAVE_V4);
    const notifications = Object.values(out.actions).filter((a) => /NOTIFICATION/.test(a.actionType));
    expect(notifications.length).toBe(3);
    for (const action of notifications) expect(action.metadata.userIds).toEqual([]);
  });

  it('keeps the legacy workflow id, the join key for the old API', () => {
    expect(trimmed(LOAD_V3).classicEnrollmentSettings.workflowId).toBe(70000001);
  });
});

// ------------------------------------------------------------------ private

// Client-portal captures are never committed. Drop them in __fixtures__/private
// (gitignored) and these assertions run against real scale locally. Skipped
// silently in CI, where the directory is empty.
//
// Filename convention: record captures are named record-*.json and belong to
// record-trim.test.js's own private loop. This loop skips them, because the
// flow trim rightly refuses a record and a refusal here would read as a break.
const privateDir = fixturesDir + 'private/';
const privateFiles = existsSync(privateDir)
  ? readdirSync(privateDir).filter((f) => f.endsWith('.json') && !f.startsWith('record-'))
  : [];

describe.skipIf(privateFiles.length === 0)('private fixtures', () => {
  for (const file of privateFiles) {
    it(`trims ${file} without violating the subtractive property`, () => {
      const raw = readFileSync(privateDir + file, 'utf8');
      const result = trim(raw);
      expect(result.ok, result.reason || '').toBe(true);
      assertSubtractive(JSON.parse(raw), JSON.parse(result.output));
      expect(result.outputBytes).toBeLessThan(result.inputBytes);
    });
  }
});
