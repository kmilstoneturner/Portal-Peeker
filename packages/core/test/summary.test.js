import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarize, countFilters } from '../src/summary.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

// Real captures from a trial portal, July 31 2026. The chain is:
//   hybrid-get-v3      editor load, version 3, three actions
//   save-response-v4   after adding an email notification, version 4
//   refresh-response-v4  a Refresh immediately after, byte-identical to the save
const LOAD_V3 = fixture('synthetic/hybrid-get-v3.json');
const SAVE_V4 = fixture('synthetic/save-response-v4.json');
const REFRESH_V4 = fixture('synthetic/refresh-response-v4.json');
// A scrubbed mirror of GET /api/inbounddb-lists/v1/lists/{listId}: the segment
// definition the lists tool fetches when a list opens.
const LIST_GET = fixture('synthetic/inbounddb-list-get.json');

describe('summarize: editor-load capture', () => {
  const result = summarize(LOAD_V3);

  it('recognizes the classic envelope', () => {
    expect(result.recognized).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.isClassicWorkflow).toBe(true);
  });

  it('reads the popup rows', () => {
    expect(result.name).toBe('Notify the team when a form is submitted');
    expect(result.flowId).toBe('1000000001');
    expect(result.portalId).toBe('12345678');
    expect(result.version).toBe(3);
    expect(result.enabled).toBe(false);
  });

  it('counts actions from the map, not an array', () => {
    expect(result.actionCount).toBe(3);
  });

  it('keeps the legacy workflow id separate from the flow id', () => {
    // The join key for the legacy v3 workflows API and old-UI URLs.
    expect(result.legacyWorkflowId).toBe('70000001');
    expect(result.legacyWorkflowId).not.toBe(result.flowId);
  });
});

describe('summarize: save and refresh captures', () => {
  it('reports the incremented concurrency token and the new action', () => {
    const result = summarize(SAVE_V4);
    expect(result.version).toBe(4);
    expect(result.actionCount).toBe(4);
  });

  it('reads a refresh identically to the save it followed', () => {
    // These two were captured byte for byte identical: Refresh returns exactly
    // the state the save produced.
    expect(summarize(REFRESH_V4)).toEqual(summarize(SAVE_V4));
  });
});

describe('summarize: segment (list) capture', () => {
  const result = summarize(LIST_GET);

  it('recognizes the inbounddb-lists envelope and says which domain it is', () => {
    expect(result.recognized).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.domain).toBe('list');
  });

  it('reads the popup rows', () => {
    expect(result.name).toBe('Contacts at partner resellers');
    expect(result.listId).toBe('4242');
    expect(result.portalId).toBe('12345678');
    expect(result.version).toBe(3);
    expect(result.processingType).toBe('DYNAMIC');
    expect(result.objectTypeId).toBe('0-1');
  });

  it('leaves every workflow field null', () => {
    expect(result.flowId).toBeNull();
    expect(result.actionCount).toBeNull();
    expect(result.isClassicWorkflow).toBeNull();
  });

  it('counts leaf filters across nested and ASSOCIATION branches', () => {
    // One PROPERTY filter, one IN_LIST reference, and one PROPERTY filter
    // nested inside an ASSOCIATION branch: three conditions.
    expect(result.filterCount).toBe(3);
  });

  it('marks the flow fields null on a flow capture, and vice versa', () => {
    const flow = summarize(LOAD_V3);
    expect(flow.domain).toBe('flow');
    expect(flow.listId).toBeNull();
    expect(flow.processingType).toBeNull();
    expect(flow.filterCount).toBeNull();
  });

  it('finds a list inside the public v3 envelope too', () => {
    const wrapped = JSON.stringify({ list: JSON.parse(LIST_GET) });
    const result = summarize(wrapped);
    expect(result.domain).toBe('list');
    expect(result.listId).toBe('4242');
  });

  it('does not mistake an IN_LIST filter or a bare id for the list', () => {
    // listId appears inside filters; only an object that looks like a
    // definition may summarize.
    const raw = JSON.stringify({ results: [{ listId: 999 }], total: 1 });
    expect(summarize(raw).recognized).toBe(false);
  });

  it('reports a MANUAL list without filters honestly', () => {
    const raw = JSON.stringify({ portalId: 12345678, listId: 4242, processingType: 'MANUAL', name: 'Hand-picked' });
    const result = summarize(raw);
    expect(result.recognized).toBe(true);
    expect(result.processingType).toBe('MANUAL');
    expect(result.filterCount).toBeNull();
  });

  it('a workflow that references lists is still a flow capture', () => {
    // associatedLists carry listId and filterBranch; the flow wins.
    const raw = JSON.stringify({
      flowId: 100,
      name: 'Flow with goal list',
      isClassicWorkflow: true,
      actions: { 1: {} },
      associatedLists: [{ listId: 4242, listType: 'CLASSIC_GOAL_LIST', filterBranch: {} }],
    });
    const result = summarize(raw);
    expect(result.domain).toBe('flow');
    expect(result.flowId).toBe('100');
  });
});

describe('countFilters', () => {
  it('returns null for a missing branch and 0 for an empty one', () => {
    expect(countFilters(null)).toBeNull();
    expect(countFilters(undefined)).toBeNull();
    expect(countFilters({ filterBranchOperator: 'OR', filters: [], filterBranches: [] })).toBe(0);
  });

  it('never throws on shapes it has not seen', () => {
    expect(countFilters({ filters: 'not an array', filterBranches: { odd: true } })).toBe(0);
    expect(countFilters(42)).toBeNull();
  });
});

describe('summarize: degraded shapes never throw', () => {
  it('handles a body that is not JSON', () => {
    const result = summarize('<!doctype html><title>401</title>');
    expect(result.recognized).toBe(false);
    expect(result.reason).toBe('body is not JSON');
    expect(result.flowId).toBeNull();
  });

  it('handles an empty body', () => {
    expect(summarize('').reason).toBe('empty body');
    expect(summarize(undefined).reason).toBe('empty body');
  });

  it('handles JSON with no flow in it', () => {
    expect(summarize('{"status":"error","message":"nope"}').recognized).toBe(false);
  });

  it('flags a platform flow instead of guessing at it', () => {
    const raw = JSON.stringify({ flowId: 1, name: 'Platform flow', isClassicWorkflow: false, actions: {} });
    const result = summarize(raw);
    expect(result.recognized).toBe(false);
    expect(result.reason).toBe('platform flow envelope not yet supported');
    // Degraded, not blank: the popup still has something to show.
    expect(result.flowId).toBe('1');
    expect(result.name).toBe('Platform flow');
  });

  it('preserves an unknown connectionType rather than choking on it', () => {
    const raw = JSON.stringify({
      flowId: 1,
      name: 'Odd branch',
      isClassicWorkflow: true,
      actions: { 1: { connection: { connectionType: 'AB_BRANCH' } } },
    });
    expect(summarize(raw).recognized).toBe(true);
    expect(summarize(raw).actionCount).toBe(1);
  });
});

describe('summarize: envelope hunting', () => {
  it('finds a flow nested inside a wrapper', () => {
    // The POST /hybrid/batch envelope has not been pinned down. This asserts
    // the search is tolerant, not that the envelope looks like this.
    const raw = JSON.stringify({
      results: [{ flow: { flowId: 42, name: 'Nested', isClassicWorkflow: true, actions: { 1: {} } } }],
    });
    const result = summarize(raw);
    expect(result.flowId).toBe('42');
    expect(result.name).toBe('Nested');
  });

  it('does not mistake an action for the flow', () => {
    // Actions carry a redundant flowId.
    const raw = JSON.stringify({
      flowId: 100,
      name: 'Real flow',
      isClassicWorkflow: true,
      actions: { 7: { actionId: 7, flowId: 100, portalId: 5 } },
    });
    expect(summarize(raw).flowId).toBe('100');
    expect(summarize(raw).name).toBe('Real flow');
  });

  it('falls back to an action portalId when the root omits one', () => {
    const raw = JSON.stringify({
      flowId: 100,
      name: 'No root portal',
      isClassicWorkflow: true,
      actions: { 7: { actionId: 7, portalId: 12345678 } },
    });
    expect(summarize(raw).portalId).toBe('12345678');
  });
});
