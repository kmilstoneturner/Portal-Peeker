import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addRelated, checkRelated } from '../src/related.js';
import { addAiContext, buildAiContext } from '../src/ai-context.js';
import { summarize, listIdsInBatches } from '../src/summary.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

const LIST_GET = fixture('synthetic/inbounddb-list-get.json');
const BATCH = fixture('synthetic/inbounddb-list-getbatch.json');

const SUPPRESSION = '{"suppressionLists":[],"exclusionRules":{"excludeUnsubscribers":false}}';
const MEMBERSHIP = '{"crmListSize":4242,"ilsListSize":4242}';

const PIECES = { listBatches: [BATCH], suppression: SUPPRESSION, membershipCounts: MEMBERSHIP };

// ------------------------------------------------------------------ insertion
//
// Same property the context block lives by: one contiguous span spliced into
// the text, so cutting it back out restores the input byte for byte, and every
// embedded body appears verbatim inside the span.

describe('addRelated inserts one span and changes nothing else', () => {
  it('cutting the span back out restores the input byte for byte', () => {
    const result = addRelated(LIST_GET, PIECES);
    expect(result.ok, result.reason || '').toBe(true);

    const at = LIST_GET.indexOf('{') + 1;
    expect(result.output.slice(at, at + result.inserted.length)).toBe(result.inserted);
    expect(result.output.slice(0, at) + result.output.slice(at + result.inserted.length)).toBe(LIST_GET);
  });

  it('embeds every body verbatim, not a reserialized copy', () => {
    const odd = '[\n  { "listId": 4243,  "name":"spaced out" }\n]';
    const result = addRelated(LIST_GET, { listBatches: [odd] });
    expect(result.ok).toBe(true);
    expect(result.output.includes(odd)).toBe(true);
  });

  it('is the first key and the subject keys keep their order', () => {
    const output = addRelated(LIST_GET, PIECES).output;
    const keys = Object.keys(JSON.parse(output));
    expect(keys[0]).toBe('_related');
    expect(keys.slice(1)).toEqual(Object.keys(JSON.parse(LIST_GET)));
  });

  it('parses to exactly the pieces it was given', () => {
    const parsed = JSON.parse(addRelated(LIST_GET, PIECES).output)._related;
    expect(Object.keys(parsed)).toEqual(['listBatches', 'suppression', 'membershipCounts']);
    expect(parsed.listBatches).toEqual([JSON.parse(BATCH)]);
    expect(parsed.suppression).toEqual(JSON.parse(SUPPRESSION));
    expect(parsed.membershipCounts).toEqual(JSON.parse(MEMBERSHIP));
  });

  it('omits members whose body was never captured, rather than writing null', () => {
    const parsed = JSON.parse(addRelated(LIST_GET, { listBatches: [BATCH] }).output)._related;
    expect(Object.keys(parsed)).toEqual(['listBatches']);

    const counts = JSON.parse(
      addRelated(LIST_GET, { listBatches: [], suppression: null, membershipCounts: MEMBERSHIP }).output,
    )._related;
    expect(Object.keys(counts)).toEqual(['membershipCounts']);
  });

  it('carries multiple batches as separate elements', () => {
    const second = '[{"listId":4245,"processingType":"DYNAMIC"}]';
    const parsed = JSON.parse(addRelated(LIST_GET, { listBatches: [BATCH, second] }).output)._related;
    expect(parsed.listBatches).toHaveLength(2);
    expect(parsed.listBatches[1]).toEqual(JSON.parse(second));
  });

  it('does not disturb what the parser makes of the subject', () => {
    const before = summarize(LIST_GET);
    const after = summarize(addRelated(LIST_GET, PIECES).output);
    expect(after.domain).toBe('list');
    expect(after.listId).toBe(before.listId);
    expect(after.filterCount).toBe(before.filterCount);
    expect(after.referencedListIds).toEqual(before.referencedListIds);
  });

  it('composes with the context block, in either splice order', () => {
    // The export pipeline bundles first and stamps context last, so the block
    // lands as the first key with _related right behind it.
    const bundled = addRelated(LIST_GET, PIECES).output;
    const both = addAiContext(bundled, buildAiContext({ domain: 'list', listId: '4242' }));
    expect(both.ok, both.reason || '').toBe(true);
    const keys = Object.keys(JSON.parse(both.output));
    expect(keys[0]).toBe('_aiContext');
    expect(keys[1]).toBe('_related');
    // Peel both spans off in reverse and the capture is back exactly.
    const withoutContext = both.output.slice(0, LIST_GET.indexOf('{') + 1) +
      both.output.slice(LIST_GET.indexOf('{') + 1 + both.inserted.length);
    expect(withoutContext).toBe(bundled);
  });
});

// ------------------------------------------------------------------ refusal

describe('withdraws rather than writing a bundle it cannot stand behind', () => {
  it('refuses a subject it cannot parse as a JSON object', () => {
    expect(checkRelated('').reason).toBe('empty body');
    expect(checkRelated('not json').reason).toBe('body is not JSON');
    for (const text of ['[1,2]', '"x"', '42', 'null']) {
      expect(checkRelated(text).reason).toBe('response root is not a JSON object');
    }
  });

  it('steps aside if the payload already carries the key', () => {
    expect(checkRelated('{"_related":{}}').reason).toBe('payload already carries a _related field');
    expect(checkRelated('{"a":{"_related":1}}').ok).toBe(true);
  });

  it('refuses a body that is not JSON rather than corrupting the document', () => {
    expect(addRelated(LIST_GET, { listBatches: ['not json'] }).reason).toBe(
      'a referenced-list batch body is not JSON',
    );
    expect(addRelated(LIST_GET, { suppression: '{broken' }).reason).toBe('the suppression body is not JSON');
    expect(addRelated(LIST_GET, { membershipCounts: '<!doctype html>' }).reason).toBe(
      'the membership counts body is not JSON',
    );
  });

  it('refuses when there is nothing to include', () => {
    expect(addRelated(LIST_GET, {}).reason).toBe('no related captures to include');
    expect(addRelated(LIST_GET, { listBatches: [] }).reason).toBe('no related captures to include');
    expect(addRelated(LIST_GET, null).reason).toBe('related captures are not a plain object');
  });

  it('never throws, and never returns half an output', () => {
    for (const [text, pieces] of [
      ['', PIECES],
      ['not json', PIECES],
      [LIST_GET, undefined],
      [LIST_GET, 42],
      [LIST_GET, { listBatches: 'nope' }],
    ]) {
      expect(() => addRelated(text, pieces)).not.toThrow();
      const result = addRelated(text, pieces);
      if (!result.ok) {
        expect(result.output).toBeNull();
        expect(result.inserted).toBeNull();
      }
    }
  });
});

// ------------------------------------------------------------------ coverage

describe('the bundle answers the coverage question the popup asks', () => {
  it('the batch fixture covers exactly what the subject fixture references', () => {
    // The subject references 4243 (IN_LIST) and 4244 (association); the batch
    // holds the definitions of both.
    expect(summarize(LIST_GET).referencedListIds).toEqual(['4243', '4244']);
    expect(listIdsInBatches([BATCH]).sort()).toEqual(['4243', '4244']);
  });
});
