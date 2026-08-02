import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeUiNumbers, uiNumbersFromText, addUiNumbers } from '../src/ui-numbers.js';
import { trim } from '../src/trim.js';
import { findFlow, summarize } from '../src/summary.js';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name) => readFileSync(fixturesDir + name, 'utf8');

const CASES = fixture('synthetic/ui-number-cases.synthetic.json');
const LOAD_V3 = fixture('synthetic/hybrid-get-v3.json');
const SAVE_V4 = fixture('synthetic/save-response-v4.json');
const REFRESH_V4 = fixture('synthetic/refresh-response-v4.json');

const flowOf = (raw) => findFlow(JSON.parse(raw)).flow;

// ------------------------------------------------------------------ the rule
//
// The fixture graph is built so that every wrong traversal produces a
// different numbering. Hand-computed breadth-first expectation:
//
//   row 0: 40            -> 1
//   row 1: 10            -> 2        (branch node)
//   row 2: 30, 50        -> 3, 4     (branch columns, then the default column)
//   row 3: 20            -> 5
//   row 4: 21, 23        -> 6, 7
//   row 5: 22            -> 8
//
// 10's first branch is a GOTO into 22, the deepest card. Following it would
// make 22 number 3. Depth-first would make 50 number 8. Default-first would
// make 50 number 3. Reversed branch order at 20 would swap 21 and 23.
const EXPECTED = { 40: 1, 10: 2, 30: 3, 50: 4, 20: 5, 21: 6, 23: 7, 22: 8 };

describe('breadth-first reading order of the STANDARD-edge tree', () => {
  const result = computeUiNumbers(flowOf(CASES));

  it('numbers every action, exactly as the canvas does', () => {
    expect(result.ok, result.reason || '').toBe(true);
    expect(result.byActionId).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([id, n]) => [id, n])),
    );
    expect(result.unnumbered).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('byUiNumber is the exact inverse', () => {
    for (const [id, n] of Object.entries(result.byActionId)) {
      expect(result.byUiNumber[n]).toBe(id);
    }
    expect(Object.keys(result.byUiNumber).length).toBe(Object.keys(result.byActionId).length);
  });

  it('does not follow a GOTO edge: the target is placed by its STANDARD parent', () => {
    // 10's first branch jumps to 22. If GOTO placed the target, 22 would be
    // number 3. It is number 8, placed under its real parent, 21.
    expect(result.byActionId['22']).toBe(8);
  });

  it('walks rows, not columns: a sibling column beats a deeper card', () => {
    // Depth-first would run 30's whole column (30, 20, 21, 22, 23) before the
    // default column, making 50 number 8. Breadth-first reaches 50 in row 2.
    expect(result.byActionId['50']).toBe(4);
    expect(result.byActionId['20']).toBe(5);
  });

  it('orders branch columns left to right, default last', () => {
    expect(result.byActionId['30']).toBe(3);
    expect(result.byActionId['30']).toBeLessThan(result.byActionId['50']);
    expect(result.byActionId['21']).toBeLessThan(result.byActionId['23']);
  });

  it('assigns numbers unrelated to actionId order', () => {
    // 23 numbers before 22 despite the larger id. The editor never sorts by id.
    expect(result.byActionId['23']).toBeLessThan(result.byActionId['22']);
  });
});

// ------------------------------------------------------------------ captures

describe('the scrubbed capture chain', () => {
  it('numbers the load capture 1..3 and both v4 captures 1..4', () => {
    expect(uiNumbersFromText(LOAD_V3).byActionId).toEqual({ 1: 1, 2: 2, 3: 3 });
    expect(uiNumbersFromText(SAVE_V4).byActionId).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4 });
    expect(uiNumbersFromText(REFRESH_V4).byActionId).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4 });
  });
});

// ------------------------------------------------------------------ annotate

describe('addUiNumbers is one appended key per action, nothing else', () => {
  // The property that lets the checkbox stand on its own: annotating the raw
  // capture leaves every original byte in place, so the export is HubSpot's
  // bytes plus N insertions and nothing else. Sliced out by position, because
  // a payload could legitimately contain the same substring elsewhere.
  for (const [label, raw] of [['cases', CASES], ['load v3', LOAD_V3], ['save v4', SAVE_V4], ['refresh v4', REFRESH_V4]]) {
    it(`cutting the inserted spans out of the raw capture restores it byte for byte: ${label}`, () => {
      const result = addUiNumbers(raw, raw);
      expect(result.ok, result.reason || '').toBe(true);
      expect(result.count).toBe(summarize(raw).actionCount);

      // Removing front to back: once the spans before it are gone, each
      // insertion sits at exactly the offset it was recorded at.
      let rebuilt = result.output;
      for (const { at, text } of result.insertions) {
        expect(rebuilt.slice(at, at + text.length)).toBe(text);
        rebuilt = rebuilt.slice(0, at) + rebuilt.slice(at + text.length);
      }
      expect(rebuilt).toBe(raw);
    });

    it(`annotating raw changes nothing but the numbers: ${label}`, () => {
      const annotated = JSON.parse(addUiNumbers(raw, raw).output);
      const original = JSON.parse(raw);
      for (const action of Object.values(findFlow(annotated).flow.actions)) {
        expect(typeof action.uiNumber).toBe('number');
        delete action.uiNumber;
      }
      expect(annotated).toEqual(original);
    });
  }

  for (const [label, raw] of [['cases', CASES], ['load v3', LOAD_V3], ['save v4', SAVE_V4]]) {
    it(`removing uiNumber restores the trim output byte for byte: ${label}`, () => {
      const trimmedText = trim(raw).output;
      const result = addUiNumbers(raw, trimmedText);
      expect(result.ok, result.reason || '').toBe(true);
      expect(result.count).toBe(summarize(raw).actionCount);

      const annotated = JSON.parse(result.output);
      for (const action of Object.values(annotated.actions)) {
        // Appended, so the last key. Original key order is untouched.
        expect(Object.keys(action).at(-1)).toBe('uiNumber');
        delete action.uiNumber;
      }
      expect(JSON.stringify(annotated)).toBe(trimmedText);
    });
  }

  it('finds the actions map through an envelope, not only at the root', () => {
    const envelope = JSON.stringify({ results: [JSON.parse(LOAD_V3)] });
    const result = addUiNumbers(LOAD_V3, envelope);
    expect(result.ok, result.reason || '').toBe(true);
    expect(result.count).toBe(summarize(LOAD_V3).actionCount);
    const actions = JSON.parse(result.output).results[0].actions;
    expect(Object.values(actions).map((a) => a.uiNumber)).toEqual([1, 2, 3]);
  });

  it('keeps the original formatting of a pretty-printed capture', () => {
    // Whitespace is the visible half of "insertion only": a re-serializing
    // implementation would silently minify the whole document.
    const output = addUiNumbers(CASES, CASES).output;
    expect(output).toContain('\n');
    expect(output.split('\n').length).toBe(CASES.split('\n').length);
  });

  it('numbers come from the raw graph regardless of the annotation target', () => {
    const fromRaw = addUiNumbers(CASES, CASES);
    const fromTrimmed = addUiNumbers(CASES, trim(CASES).output);
    const pick = (text) =>
      Object.fromEntries(
        Object.entries(JSON.parse(text).actions).map(([id, a]) => [id, a.uiNumber]),
      );
    expect(pick(fromTrimmed.output)).toEqual(pick(fromRaw.output));
    expect(pick(fromRaw.output)).toEqual(EXPECTED);
  });

  it('the annotated flow still summarizes like the trimmed one', () => {
    const trimmedText = trim(LOAD_V3).output;
    const annotated = addUiNumbers(LOAD_V3, trimmedText).output;
    const before = summarize(trimmedText);
    const after = summarize(annotated);
    expect(after.recognized).toBe(true);
    expect(after.flowId).toBe(before.flowId);
    expect(after.actionCount).toBe(before.actionCount);
  });
});

// ------------------------------------------------------------------ refusal
//
// The withdrawal cases. These matter more than the happy path: a file where
// some cards carry numbers and some do not looks complete while lying about
// the canvas, so anything unrecognized must make ok false.

const mutate = (change) => {
  const flow = JSON.parse(CASES);
  change(flow);
  return flow;
};

describe('withdraws rather than half-numbering', () => {
  it('an unrecognized connectionType poisons the walk', () => {
    const result = computeUiNumbers(mutate((f) => {
      f.actions['20'].connection.connectionType = 'AB_BRANCH';
    }));
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['20']);
    expect(result.reason).toContain('unrecognized connection shape');
    // 20 itself still got a number before its shape was inspected; its hidden
    // children did not, and that asymmetry is exactly why ok must be false.
    expect(result.byActionId['20']).toBe(5);
    expect(result.byActionId['21']).toBeUndefined();
  });

  it('an unrecognized edgeType poisons the walk', () => {
    const result = computeUiNumbers(mutate((f) => {
      f.actions['30'].connection.edgeType = 'TELEPORT';
    }));
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['30']);
  });

  it('an action reachable only through a GOTO is unreachable, not misplaced', () => {
    // Cutting 30's connection strands 20's whole subtree. 22 is still the
    // target of 10's GOTO branch, and a GOTO must not place it.
    const result = computeUiNumbers(mutate((f) => {
      f.actions['30'].connection = null;
    }));
    expect(result.ok).toBe(false);
    expect([...result.unnumbered].sort()).toEqual(['20', '21', '22', '23']);
    expect(result.reason).toContain('4 of 8 actions unreachable');
  });

  it('refuses a flow without a firstActionId, or with a bogus one', () => {
    expect(computeUiNumbers(mutate((f) => delete f.firstActionId)).reason).toBe(
      'no firstActionId in flow',
    );
    expect(computeUiNumbers(mutate((f) => (f.firstActionId = 77))).reason).toBe(
      'firstActionId is not in the actions map',
    );
  });

  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 42, 'x', [], {}, { actions: [] }, { actions: {}, firstActionId: 1 }]) {
      expect(() => computeUiNumbers(input)).not.toThrow();
      expect(computeUiNumbers(input).ok).toBe(false);
    }
    for (const text of ['', 'not json', '[]', '{}', null]) {
      expect(() => uiNumbersFromText(text)).not.toThrow();
      expect(uiNumbersFromText(text).ok).toBe(false);
    }
  });

  it('addUiNumbers propagates a failed numbering and rejects a broken target', () => {
    expect(addUiNumbers('not json', trim(CASES).output).ok).toBe(false);
    expect(addUiNumbers(CASES, 'not json').reason).toBe('annotation target is not JSON');
    expect(addUiNumbers(CASES, '{"noActions":true}').reason).toBe(
      'no flow object found in the annotation target',
    );
    expect(addUiNumbers(CASES, '{"flowId":1,"name":"x"}').reason).toBe(
      'annotation target carries no actions map',
    );
  });

  it('refuses a target whose actions map the scanner cannot read cleanly', () => {
    // A duplicated key is valid JSON that two readers disagree about: the
    // scanner sees the first, JSON.parse keeps the last. Refuse rather than
    // pick.
    const doubled = '{"flowId":1,"name":"x","firstActionId":"1","actions":{"1":{}},"actions":{"1":{}}}';
    expect(addUiNumbers(CASES, doubled).ok).toBe(false);
  });

  it('steps aside if a payload ever ships its own uiNumber field', () => {
    const target = JSON.parse(trim(CASES).output);
    target.actions['40'].uiNumber = 'theirs';
    const result = addUiNumbers(CASES, JSON.stringify(target));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('payload already carries a uiNumber field');
  });

  it('rejects a target action the raw graph has never heard of', () => {
    const target = JSON.parse(trim(CASES).output);
    target.actions['99'] = { actionType: 'EMAIL' };
    const result = addUiNumbers(CASES, JSON.stringify(target));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('action 99 is not in the raw capture');
  });
});

// ------------------------------------------------------------------ private

// Real captures dropped into __fixtures__/private (gitignored) get the
// structural checks that need scale: every action numbered exactly once,
// numbers forming 1..N, the first action always 1. Skipped silently in CI.
const privateDir = fixturesDir + 'private/';
const privateFiles = existsSync(privateDir)
  ? readdirSync(privateDir).filter((f) => f.endsWith('.json'))
  : [];

describe.skipIf(privateFiles.length === 0)('private fixtures', () => {
  for (const file of privateFiles) {
    it(`numbers ${file} completely, 1..N from the first action`, () => {
      const raw = readFileSync(privateDir + file, 'utf8');
      const result = uiNumbersFromText(raw);
      expect(result.ok, result.reason || '').toBe(true);

      const flow = flowOf(raw);
      const numbers = Object.values(result.byActionId).sort((a, b) => a - b);
      expect(numbers.length).toBe(Object.keys(flow.actions).length);
      expect(numbers[0]).toBe(1);
      expect(numbers.at(-1)).toBe(numbers.length);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(result.byActionId[String(flow.firstActionId)]).toBe(1);
    });
  }
});
