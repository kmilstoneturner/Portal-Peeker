import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAiContext, checkAiContext, addAiContext, MODIFICATIONS } from '../src/ai-context.js';
import { trim } from '../src/trim.js';
import { addUiNumbers } from '../src/ui-numbers.js';
import { summarize } from '../src/summary.js';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name) => readFileSync(fixturesDir + name, 'utf8');

const CASES = fixture('synthetic/ui-number-cases.synthetic.json');
const TRIM_CASES = fixture('synthetic/trim-cases.synthetic.json');
const LOAD_V3 = fixture('synthetic/hybrid-get-v3.json');
const SAVE_V4 = fixture('synthetic/save-response-v4.json');
const REFRESH_V4 = fixture('synthetic/refresh-response-v4.json');
const LIST_GET = fixture('synthetic/inbounddb-list-get.json');

const ALL_FIXTURES = [
  ['ui-number cases', CASES],
  ['trim cases', TRIM_CASES],
  ['load v3', LOAD_V3],
  ['save v4', SAVE_V4],
  ['refresh v4', REFRESH_V4],
  ['list get', LIST_GET],
];

// Synthetic throughout: no identifier here is real, and none is long enough to
// look like one.
const META = {
  capturedAtIso: '2026-08-02T15:04:05.678Z',
  capturedFrom: 'editor load',
  flowId: '4242',
  flowName: 'Test flow',
  portalId: '9931',
  flowVersion: 3,
  extensionVersion: '1.0.0',
  modifications: {
    trimmedToWorkflowLogic: false,
    htmlStrippedFromEmailBodies: false,
    editorNumbersAdded: false,
  },
};

const flags = (trimmed, stripped, numbered) => ({
  trimmedToWorkflowLogic: trimmed,
  htmlStrippedFromEmailBodies: stripped,
  editorNumbersAdded: numbered,
});

// ------------------------------------------------------------------ insertion
//
// The whole design rests on one property: the block is a single contiguous span
// spliced into the text, so cutting that span back out restores the input byte
// for byte. Sliced by position, never by string replace: a payload could
// legitimately contain a second copy of the same substring.

describe('addAiContext inserts one span and changes nothing else', () => {
  for (const [label, raw] of ALL_FIXTURES) {
    it(`cutting the span back out restores the input byte for byte: ${label}`, () => {
      const result = addAiContext(raw, buildAiContext(META));
      expect(result.ok, result.reason || '').toBe(true);

      const at = raw.indexOf('{') + 1;
      expect(result.output.slice(at, at + result.inserted.length)).toBe(result.inserted);
      expect(result.output.slice(0, at) + result.output.slice(at + result.inserted.length)).toBe(raw);
    });

    it(`the block is the first key and the rest keep their order: ${label}`, () => {
      const output = addAiContext(raw, buildAiContext(META)).output;
      const keys = Object.keys(JSON.parse(output));
      expect(keys[0]).toBe('_aiContext');
      expect(keys.slice(1)).toEqual(Object.keys(JSON.parse(raw)));
    });
  }

  it('the parsed block is exactly what was passed in', () => {
    const block = buildAiContext(META);
    const output = addAiContext(LOAD_V3, block).output;
    expect(JSON.parse(output)._aiContext).toEqual(block);
  });

  it('works on trimmed and on numbered output, on top of the other two additions', () => {
    const trimmedText = trim(CASES).output;
    const numberedText = addUiNumbers(CASES, trimmedText).output;
    const result = addAiContext(numberedText, buildAiContext({ ...META, modifications: flags(true, false, true) }));
    expect(result.ok, result.reason || '').toBe(true);

    // Peel the two in-band additions off in reverse and the trim output is back.
    const parsed = JSON.parse(result.output);
    delete parsed._aiContext;
    for (const action of Object.values(parsed.actions)) delete action.uiNumber;
    expect(JSON.stringify(parsed)).toBe(trimmedText);
  });

  it('handles whitespace before the root brace and pretty-printed input', () => {
    for (const input of ['{"a":1}', ' \n\t{"a":1}', '{\n  "a": 1\n}\n']) {
      const result = addAiContext(input, buildAiContext(META));
      expect(result.ok, result.reason || '').toBe(true);
      expect(JSON.parse(result.output).a).toBe(1);
      const at = input.indexOf('{') + 1;
      expect(result.output.slice(0, at) + result.output.slice(at + result.inserted.length)).toBe(input);
    }
  });

  it('leaves out the separating comma when the root has no members', () => {
    for (const input of ['{}', '{ }', '{\n}']) {
      const result = addAiContext(input, buildAiContext(META));
      expect(result.ok, result.reason || '').toBe(true);
      expect(() => JSON.parse(result.output)).not.toThrow();
      expect(Object.keys(JSON.parse(result.output))).toEqual(['_aiContext']);
    }
  });

  it('does not disturb what the parser makes of the document', () => {
    const output = addAiContext(LOAD_V3, buildAiContext(META)).output;
    const before = summarize(LOAD_V3);
    const after = summarize(output);
    expect(after.recognized).toBe(true);
    expect(after.flowId).toBe(before.flowId);
    expect(after.name).toBe(before.name);
    expect(after.actionCount).toBe(before.actionCount);
  });

  it('is not mistaken for the flow when the real one is nested in an envelope', () => {
    // The block records a flowId and a name, which is exactly the shape the
    // flow finder looks for. On an envelope payload, whose root carries no
    // flowId, the block sits at a shallower depth than the flow it describes.
    const envelope = JSON.stringify({ results: [JSON.parse(LOAD_V3)] });
    const output = addAiContext(envelope, buildAiContext(META)).output;
    expect(summarize(output).flowId).toBe(summarize(LOAD_V3).flowId);
    expect(summarize(output).flowId).not.toBe(META.flowId);
  });
});

// ------------------------------------------------------------------ refusal

describe('withdraws rather than writing a block into something it does not understand', () => {
  it('refuses a body it cannot parse as a JSON object', () => {
    expect(checkAiContext('').reason).toBe('empty body');
    expect(checkAiContext('   ').reason).toBe('empty body');
    expect(checkAiContext('not json').reason).toBe('body is not JSON');
    // A byte order mark is not JSON whitespace, so this is refused at the parse
    // rather than reaching the splice.
    expect(checkAiContext('﻿{}').reason).toBe('body is not JSON');
    for (const text of ['[1,2]', '"x"', '42', 'null', 'true']) {
      expect(checkAiContext(text).reason).toBe('response root is not a JSON object');
    }
  });

  it('steps aside if the payload already carries the key', () => {
    expect(checkAiContext('{"_aiContext":1}').reason).toBe('payload already carries an _aiContext field');
    // Nested is not a collision: only the root key would be overwritten.
    expect(checkAiContext('{"a":{"_aiContext":1}}').ok).toBe(true);
  });

  it('refuses a block it cannot serialize as an object', () => {
    for (const block of [null, undefined, 'text', 42, [1, 2]]) {
      expect(addAiContext('{"a":1}', block).reason).toBe('context block is not a plain object');
    }
    const cyclic = {};
    cyclic.self = cyclic;
    expect(addAiContext('{"a":1}', cyclic).reason).toBe('context block would not serialize');
  });

  it('never throws, and never returns half an output', () => {
    for (const text of ['', 'not json', '[]', null, undefined, 42, {}]) {
      expect(() => addAiContext(text, buildAiContext(META))).not.toThrow();
      const result = addAiContext(text, buildAiContext(META));
      if (!result.ok) {
        expect(result.output).toBeNull();
        expect(result.inserted).toBeNull();
      }
    }
  });
});

// ------------------------------------------------------------------ the block

describe('buildAiContext says only what it was told', () => {
  it('omits what it does not know rather than guessing', () => {
    const block = buildAiContext({});
    expect(block.workflow).toBeUndefined();
    expect(block.capture).toBeUndefined();
    expect(block.extensionVersion).toBeUndefined();
    expect(block.whatThisIs).toBeTruthy();
    expect(block.modifications).toEqual(
      Object.fromEntries(MODIFICATIONS.map((m) => [m.flag, false])),
    );
    expect(block.howToUse.length).toBeGreaterThan(0);
    expect(() => buildAiContext()).not.toThrow();
    expect(() => buildAiContext(null)).not.toThrow();
  });

  it('reports every field it was given', () => {
    const block = buildAiContext(META);
    expect(block.workflow).toEqual({ flowId: '4242', name: 'Test flow', portalId: '9931', version: 3 });
    expect(block.capture).toEqual({ capturedAt: META.capturedAtIso, capturedFrom: 'editor load' });
    expect(block.extensionVersion).toBe('1.0.0');
  });

  it('drops a sub-object entirely when every one of its fields is missing', () => {
    const block = buildAiContext({ flowId: '4242', capturedFrom: null, capturedAtIso: null });
    expect(block.workflow).toEqual({ flowId: '4242' });
    expect(block.capture).toBeUndefined();
  });

  it('keeps the capture time as the string it was handed', () => {
    // The popup owns the clock. Core never calls Date, so a timestamp cannot
    // drift between the block and the row in the popup that reported it.
    expect(buildAiContext(META).capture.capturedAt).toBe('2026-08-02T15:04:05.678Z');
  });

  it('tells the truth about every combination of trim, strip, and numbering', () => {
    for (let bits = 0; bits < 8; bits += 1) {
      const trimmed = Boolean(bits & 1);
      const stripped = Boolean(bits & 2);
      const numbered = Boolean(bits & 4);
      const block = buildAiContext({ ...META, modifications: flags(trimmed, stripped, numbered) });
      const prose = block.howToUse.join(' ');
      const label = `${trimmed}/${stripped}/${numbered}`;

      // toMatchObject, not toEqual: a fourth option added later is not this
      // test's business, and should fail the table's own tests instead.
      expect(block.modifications, label).toMatchObject(flags(trimmed, stripped, numbered));
      expect(prose.includes('uiNumber'), label).toBe(numbered);
      expect(prose.includes('Editor card numbers are not present'), label).toBe(!numbered);
      expect(prose.includes('byte-for-byte what HubSpot sent'), label).toBe(
        !trimmed && !stripped && !numbered,
      );
      expect(prose.includes('were removed before export'), label).toBe(trimmed);
      expect(prose.includes('converted to plain text'), label).toBe(stripped);
      // actionId is named as the stable handle either way, since that is the
      // half of the guidance that never depends on an option.
      expect(prose.includes('actionId'), label).toBe(true);
    }
  });

  it('says the block is removable, and says so whatever else ran', () => {
    for (let bits = 0; bits < 8; bits += 1) {
      const block = buildAiContext({
        ...META,
        modifications: flags(Boolean(bits & 1), Boolean(bits & 2), Boolean(bits & 4)),
      });
      expect(block.howToUse[0]).toContain('delete this one key');
    }
  });

  it('never claims currency, and adapts when it has no capture time', () => {
    expect(buildAiContext(META).howToUse[1]).toContain('capturedAt time above');
    const undated = buildAiContext({ ...META, capturedAtIso: null });
    expect(undated.howToUse[1]).toContain('snapshot of one moment');
    expect(undated.howToUse[1]).not.toContain('capturedAt');
  });

  // ---------------------------------------------------------------- segments

  it('describes a segment export as a segment, under a list key', () => {
    const block = buildAiContext({
      ...META,
      domain: 'list',
      listId: '4242',
      listName: 'Test segment',
      listVersion: 3,
      processingType: 'DYNAMIC',
      objectTypeId: '0-1',
    });
    expect(block.whatThisIs).toContain('segment');
    expect(block.workflow).toBeUndefined();
    expect(block.list).toEqual({
      listId: '4242',
      name: 'Test segment',
      portalId: '9931',
      version: 3,
      processingType: 'DYNAMIC',
      objectTypeId: '0-1',
    });
  });

  it('gives a list reader filter guidance instead of workflow guidance', () => {
    const block = buildAiContext({ ...META, domain: 'list', listId: '4242' });
    const prose = block.howToUse.join(' ');
    // No modification can run on a segment, so the block says untouched...
    expect(prose).toContain('byte-for-byte what HubSpot sent');
    // ...explains the filter tree...
    expect(prose).toContain('filterBranch');
    // ...and never talks about actionId or editor cards, which do not exist
    // in this file.
    expect(prose).not.toContain('actionId');
    expect(prose).not.toContain('Editor card numbers');
    // Removability holds regardless of domain.
    expect(block.howToUse[0]).toContain('delete this one key');
  });

  it('describes the bundle when referenced lists were included', () => {
    const block = buildAiContext({
      ...META,
      domain: 'list',
      listId: '4242',
      modifications: { relatedCapturesIncluded: true },
    });
    const prose = block.howToUse.join(' ');
    expect(block.modifications.relatedCapturesIncluded).toBe(true);
    expect(prose).toContain('_related');
    expect(prose).toContain('listBatches');
    expect(prose).toContain('fetchedLists');
    // Something beyond the block was inserted, so the untouched line is gone...
    expect(prose).not.toContain('byte-for-byte what HubSpot sent');
    // ...and so is the ids-only caveat the bundle exists to answer.
    expect(prose).not.toContain('appear as ids only');
  });

  it('says the references are ids only when the bundle did not run', () => {
    const prose = buildAiContext({ ...META, domain: 'list', listId: '4242' }).howToUse.join(' ');
    expect(prose).toContain('appear as ids only');
    expect(prose).toContain('byte-for-byte what HubSpot sent');
  });

  it('keeps the list prose as plain as the flow prose', () => {
    for (const related of [false, true]) {
      const block = buildAiContext({
        ...META,
        domain: 'list',
        listId: '4242',
        modifications: { relatedCapturesIncluded: related },
      });
      const prose = [block.whatThisIs, ...block.howToUse].join(' ');
      expect(prose).toMatch(/^[\x20-\x7E]*$/);
      expect(prose).not.toMatch(/https?:\/\//);
      expect(prose).not.toMatch(/\bscrub|\bclean|\bsafe|\bsanitiz|\bredact/i);
    }
  });

  it('splices into a real segment capture without disturbing what the parser reads', () => {
    const result = addAiContext(LIST_GET, buildAiContext({ ...META, domain: 'list', listId: '4242' }));
    expect(result.ok, result.reason || '').toBe(true);
    const after = summarize(result.output);
    expect(after.domain).toBe('list');
    expect(after.listId).toBe('4242');
    expect(after.filterCount).toBe(summarize(LIST_GET).filterCount);
  });

  // ---------------------------------------------------------------- the table
  //
  // These are the tests that have to keep passing when someone adds a fifth
  // checkbox a year from now. They are written against the MODIFICATIONS table
  // rather than against the three entries that happen to be in it today, so a
  // new entry is tested the moment it exists, and a new export option that
  // never reaches the table is caught by tools/check-ai-context.mjs instead.

  it('gives every modification a distinct flag, mark, and label', () => {
    const unique = (key) => new Set(MODIFICATIONS.map((m) => m[key])).size;
    expect(MODIFICATIONS.length).toBeGreaterThan(0);
    expect(unique('flag')).toBe(MODIFICATIONS.length);
    expect(unique('mark')).toBe(MODIFICATIONS.length);
    expect(unique('label')).toBe(MODIFICATIONS.length);
    for (const entry of MODIFICATIONS) {
      expect(typeof entry.flag, JSON.stringify(entry)).toBe('string');
      expect(entry.mark).toMatch(/^[a-z]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('has something to say about every modification it reports', () => {
    for (const entry of MODIFICATIONS) {
      expect(Array.isArray(entry.tells), entry.flag).toBe(true);
      expect(entry.tells.length, `${entry.flag} changes the file and says nothing about it`)
        .toBeGreaterThan(0);
      expect(Array.isArray(entry.tellsWhenAbsent), entry.flag).toBe(true);
    }
  });

  it('changes what it says when any one modification changes', () => {
    // Baseline has everything on, so the all-false line is out of the way and
    // the difference can only come from the flag under test. Each entry is
    // toggled inside a block of its own domain, because the block only speaks
    // about options from the export's domain: flipping a segment option in a
    // workflow block is supposed to change nothing.
    const all = Object.fromEntries(MODIFICATIONS.map((m) => [m.flag, true]));
    const metaFor = (domain) =>
      domain === 'list' ? { ...META, domain: 'list', listId: '4242' } : META;

    for (const entry of MODIFICATIONS) {
      const meta = metaFor(entry.domain || 'flow');
      const withAll = buildAiContext({ ...meta, modifications: all }).howToUse.join(' ');
      const withoutOne = buildAiContext({
        ...meta,
        modifications: { ...all, [entry.flag]: false },
      }).howToUse.join(' ');
      expect(withoutOne, `turning off ${entry.flag} does not change the block`).not.toBe(withAll);
    }
  });

  it('an option from the other domain changes nothing, on or off', () => {
    const flowProse = (flags) => buildAiContext({ ...META, modifications: flags }).howToUse.join(' ');
    expect(flowProse({ relatedCapturesIncluded: true })).toBe(flowProse({}));
    expect(flowProse({})).not.toContain('_related');
  });

  it('reports every flag in the table and nothing else', () => {
    const block = buildAiContext(META);
    expect(Object.keys(block.modifications)).toEqual(MODIFICATIONS.map((m) => m.flag));
    // An unknown flag handed in is not smuggled through into the report.
    const spiked = buildAiContext({ ...META, modifications: { somethingNew: true } });
    expect(Object.keys(spiked.modifications)).toEqual(MODIFICATIONS.map((m) => m.flag));
  });

  it('keeps the prose plain: ASCII, no links, and never calls anything safe', () => {
    for (let bits = 0; bits < 2 ** MODIFICATIONS.length; bits += 1) {
      const block = buildAiContext({
        ...META,
        modifications: Object.fromEntries(
          MODIFICATIONS.map((m, i) => [m.flag, Boolean(bits & (1 << i))]),
        ),
      });
      const prose = [block.whatThisIs, ...block.howToUse].join(' ');
      // No em dashes, no smart quotes, nothing that survives a copy and paste
      // badly.
      expect(prose).toMatch(/^[\x20-\x7E]*$/);
      expect(prose).not.toMatch(/https?:\/\//);
      // Trimming is about size. Describing it as scrubbing, cleaning, or making
      // anything safe would be a claim this extension does not make.
      expect(prose).not.toMatch(/\bscrub|\bclean|\bsafe|\bsanitiz|\bredact/i);
    }
  });
});
