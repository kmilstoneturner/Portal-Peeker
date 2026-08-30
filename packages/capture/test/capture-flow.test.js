// End to end across the world boundary, against the actual built bundles.
//
// The unit tests cover URL matching. This covers the part that unit tests
// cannot: that the MAIN-world interceptor and the isolated-world bridge, as
// built, still agree on a message shape. That contract is the single easiest
// thing in this codebase to break silently, because the two halves cannot
// import each other and a mismatch produces no error anywhere. It just stops
// capturing.
//
// Two vm contexts stand in for the two worlds. They share nothing except the
// postMessage hop, which is exactly the real constraint.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { TextEncoder } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';

const dist = (name) => fileURLToPath(new URL(`../../../extension/dist/${name}`, import.meta.url));

const EDITOR_URL = 'https://app.hubspot.com/workflows/12345678/platform/flow/1000000001/edit';
const LIST_URL = 'https://app.hubspot.com/contacts/12345678/objectLists/4242/filters';
const ORIGIN = 'https://app.hubspot.com';
const HYBRID_GET = '/api/automationplatform/v1/hybrid/1000000001?portalId=12345678';
const SAVE_POST = '/api/automationplatform/v1/hybrid/batch?sourceapp=WORKFLOWS_APP';
const LIST_GET = '/api/inbounddb-lists/v1/lists/4242?portalId=12345678&clienttimeout=14000';

const FLOW_BODY = JSON.stringify({
  flowId: 1000000001,
  portalId: 12345678,
  name: 'Captured flow',
  isClassicWorkflow: true,
  version: 1,
  actions: { 1: { actionId: 1 } },
});

const LIST_BODY = JSON.stringify({
  portalId: 12345678,
  listId: 4242,
  listVersion: 3,
  objectTypeId: '0-1',
  processingType: 'DYNAMIC',
  name: 'Captured segment',
  filterBranch: { filterBranchOperator: 'OR', filters: [], filterBranches: [] },
});

if (!existsSync(dist('capture/interceptor.js'))) {
  throw new Error('extension/dist is missing. Run: npm run build');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DEFAULT_COOKIE = 'hubspotutk=x; csrf.app=csrf-token-value; other=1';

function harness({ cookie = DEFAULT_COOKIE, url = EDITOR_URL } = {}) {
  const sent = [];
  let popupHandler = null;
  let deliver = null;

  // ---- isolated world (bridge) ----
  const isolatedLocation = { href: url, origin: ORIGIN };
  const isolatedWindow = {
    addEventListener(type, fn) {
      if (type === 'message') deliver = fn;
    },
  };
  const refreshCalls = [];
  let refreshImpl = async () => {
    throw new Error('no refresh stubbed');
  };

  const isolated = createContext({
    window: isolatedWindow,
    location: isolatedLocation,
    document: { cookie },
    TextEncoder,
    URL,
    setTimeout,
    console,
    fetch: (url, init) => {
      refreshCalls.push({ url, init });
      return refreshImpl(url, init);
    },
    chrome: {
      runtime: {
        sendMessage: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
        onMessage: {
          addListener: (fn) => {
            popupHandler = fn;
          },
        },
      },
    },
  });

  // ---- main world (interceptor) ----
  const nativeCalls = [];
  let nativeImpl = null;

  class FakeXhr {
    constructor() {
      this.listeners = {};
      this.status = 200;
      this.responseText = '';
    }
    open() {}
    send() {}
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] || []) fn.call(this);
    }
  }

  const mainWindow = {
    location: { href: url, origin: ORIGIN },
    fetch: (...args) => {
      nativeCalls.push(args);
      return nativeImpl(...args);
    },
    postMessage: (data) => {
      // Real postMessage structured-clones. JSON round trip is close enough
      // here and would catch a value that cannot survive the hop.
      const cloned = JSON.parse(JSON.stringify(data));
      // In the isolated world, event.source is that world's view of the same
      // window, so it compares equal to its own `window`.
      deliver?.({ source: isolatedWindow, origin: ORIGIN, data: cloned });
    },
  };

  const main = createContext({
    window: mainWindow,
    XMLHttpRequest: FakeXhr,
    URL,
    console,
  });

  runInContext(readFileSync(dist('capture/bridge.js'), 'utf8'), isolated);
  runInContext(readFileSync(dist('capture/interceptor.js'), 'utf8'), main);

  const askPopup = (type, extra) =>
    new Promise((resolve) => {
      const returned = popupHandler({ type, ...extra }, {}, resolve);
      if (returned !== true) {
        // Synchronous responder already called resolve.
      }
    });

  return {
    sent,
    refreshCalls,
    isolatedLocation,
    askPopup,
    FakeXhr,
    setNativeFetch: (fn) => {
      nativeImpl = fn;
    },
    setRefresh: (fn) => {
      refreshImpl = fn;
    },
    pageFetch: (...args) => mainWindow.fetch(...args),
    makeXhr: () => new FakeXhr(),
    mainWindow,
  };
}

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  clone: () => ({ text: async () => body }),
});

describe('capture, end to end across the world boundary', () => {
  let h;

  beforeEach(() => {
    h = harness();
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
  });

  it('captures the editor-load GET and hands it to the popup', async () => {
    await h.pageFetch(HYBRID_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.kind).toBe('load');
    expect(status.flowId).toBe('1000000001');
    expect(status.raw).toBe(FLOW_BODY);
  });

  it('stores the raw bytes verbatim, not a reserialized copy', async () => {
    // Key order and whitespace have to survive: Copy and Download promise the
    // exact bytes HubSpot sent.
    const odd = '{ "flowId": 1,\n  "name": "spaced out",  "actions": {} }';
    h.setNativeFetch(async () => okResponse(odd));

    await h.pageFetch(HYBRID_GET);
    await flush();

    const payload = await h.askPopup('pp:payload');
    expect(payload.raw).toBe(odd);
  });

  it('tells the popup when the payload was captured and where it came from', async () => {
    // The export can stamp a block with these, so they travel with the payload
    // rather than only with the status the popup read when it opened.
    const before = Date.now();
    await h.pageFetch(HYBRID_GET);
    await flush();

    const payload = await h.askPopup('pp:payload');
    expect(payload.kind).toBe('load');
    expect(typeof payload.capturedAt).toBe('number');
    expect(payload.capturedAt).toBeGreaterThanOrEqual(before);
  });

  it('reports byte length in UTF-8 bytes, not characters', async () => {
    const body = '{"flowId":1,"name":"café ✓","actions":{}}';
    h.setNativeFetch(async () => okResponse(body));

    await h.pageFetch(HYBRID_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.byteLength).toBe(Buffer.byteLength(body, 'utf8'));
    expect(status.byteLength).toBeGreaterThan(body.length);
  });

  it('sets the badge exactly once per capture', async () => {
    await h.pageFetch(HYBRID_GET);
    await flush();
    expect(h.sent).toEqual([{ type: 'pp:captured' }]);
  });

  it('captures the save POST response and finds the flow ID in the body', async () => {
    // /hybrid/batch has no flow ID in its path.
    await h.pageFetch(SAVE_POST, { method: 'POST', body: '{}' });
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.kind).toBe('save');
    expect(status.flowId).toBe('1000000001');
  });

  it('captures through XHR as well as fetch', async () => {
    const xhr = h.makeXhr();
    xhr.open('GET', HYBRID_GET);
    xhr.send();
    xhr.responseText = FLOW_BODY;
    xhr.fire('load');
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.raw).toBe(FLOW_BODY);
  });

  it('ignores traffic it does not recognize', async () => {
    await h.pageFetch('/api/automationplatform/v1/output-fields/flow/1000000001/allOutputs');
    await h.pageFetch('/hubfs/logo.png');
    await flush();

    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('hands the page its response back unread', async () => {
    // If the interceptor consumed the body instead of cloning it, the editor
    // would break. That is the failure this whole design is avoiding.
    const response = okResponse(FLOW_BODY);
    h.setNativeFetch(async () => response);

    const returned = await h.pageFetch(HYBRID_GET);
    expect(returned).toBe(response);
  });

  it('lets a rejected fetch reject, and a failed response through untouched', async () => {
    h.setNativeFetch(async () => {
      throw new Error('offline');
    });
    await expect(h.pageFetch(HYBRID_GET)).rejects.toThrow('offline');

    h.setNativeFetch(async () => okResponse('nope', 500));
    await h.pageFetch(HYBRID_GET);
    await flush();
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
  });

  it('captures a body that will not parse rather than dropping it', async () => {
    h.setNativeFetch(async () => okResponse('<!doctype html>not json'));

    await h.pageFetch(HYBRID_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.raw).toBe('<!doctype html>not json');
    // Flow ID still known, because it came from the URL and not the parser.
    expect(status.flowId).toBe('1000000001');
  });
});

describe('SPA staleness guard', () => {
  let h;

  beforeEach(async () => {
    h = harness();
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();
  });

  it('reports no capture after navigating to a different flow', async () => {
    h.isolatedLocation.href = 'https://app.hubspot.com/workflows/12345678/platform/flow/999/edit';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect((await h.askPopup('pp:payload')).hasCapture).toBe(false);
  });

  it('still reports the capture on a different page of the same flow', async () => {
    h.isolatedLocation.href = 'https://app.hubspot.com/workflows/12345678/platform/flow/1000000001/settings';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(true);
  });
});

describe('refresh', () => {
  let h;

  beforeEach(async () => {
    h = harness();
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();
  });

  it('sends the CSRF header, without which the GET returns 401', async () => {
    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => '{"flowId":1000000001}' }));

    await h.askPopup('pp:refresh');

    const call = h.refreshCalls[0];
    expect(call.init.headers['x-hubspot-csrf-hubspotapi']).toBe('csrf-token-value');
    expect(call.init.credentials).toBe('include');
    expect(call.url).toContain('/api/automationplatform/v1/hybrid/1000000001');
    expect(call.url).toContain('portalId=12345678');
    expect(call.url).not.toContain('hs_static_app');
  });

  it('replaces the snapshot on success', async () => {
    const fresher = '{"flowId":1000000001,"name":"Renamed","isClassicWorkflow":true,"actions":{}}';
    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => fresher }));

    const result = await h.askPopup('pp:refresh');
    expect(result.ok).toBe(true);

    const status = await h.askPopup('pp:status');
    expect(status.kind).toBe('refresh');
    expect(status.raw).toBe(fresher);

    const payload = await h.askPopup('pp:payload');
    expect(payload.kind).toBe('refresh');
    expect(payload.raw).toBe(fresher);
  });

  it('never overwrites the existing snapshot on an HTTP failure', async () => {
    h.setRefresh(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));

    const result = await h.askPopup('pp:refresh');
    expect(result).toEqual({ ok: false, error: 'http', status: 401 });
    expect((await h.askPopup('pp:status')).raw).toBe(FLOW_BODY);
  });

  it('never overwrites the existing snapshot on a network failure', async () => {
    h.setRefresh(async () => {
      throw new Error('offline');
    });

    const result = await h.askPopup('pp:refresh');
    expect(result.error).toBe('network');
    expect((await h.askPopup('pp:status')).raw).toBe(FLOW_BODY);
  });

  it('never overwrites the existing snapshot on an empty body', async () => {
    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => '' }));

    expect((await h.askPopup('pp:refresh')).error).toBe('empty');
    expect((await h.askPopup('pp:status')).raw).toBe(FLOW_BODY);
  });
});

describe('segment capture, end to end on a list page', () => {
  let h;

  beforeEach(() => {
    h = harness({ url: LIST_URL });
    h.setNativeFetch(async () => okResponse(LIST_BODY));
  });

  it('captures the definition GET and hands it to the popup with its domain', async () => {
    await h.pageFetch(LIST_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.domain).toBe('list');
    expect(status.kind).toBe('load');
    expect(status.listId).toBe('4242');
    expect(status.flowId).toBeNull();
    expect(status.raw).toBe(LIST_BODY);

    const payload = await h.askPopup('pp:payload');
    expect(payload.domain).toBe('list');
    expect(payload.listId).toBe('4242');
  });

  it('classifies a write to the same path as a save', async () => {
    await h.pageFetch(LIST_GET, { method: 'PUT', body: LIST_BODY });
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.kind).toBe('save');
    expect(status.domain).toBe('list');
  });

  it('keeps the responses that load beside the definition aside, never as the snapshot', async () => {
    // All observed firing when a list opens. Treating any of them as the
    // subject would replace the definition with counts, views, or an array of
    // other lists, so they land beside it: no snapshot, no badge, and the
    // bodies only ride along once the definition itself is captured.
    await h.pageFetch('/api/inbounddb-lists/v1/lists/getBatch?portalId=12345678');
    await h.pageFetch('/api/inbounddb-lists/v1/lists/4242/suppression?portalId=12345678');
    await h.pageFetch('/api/inbounddb-lists/v1/list-membership-search/list/4242/3/current-state');
    await h.pageFetch('/api/sales/v4/views/0-1/all?namespace=LISTS&portalId=12345678');
    await flush();

    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect(h.sent).toEqual([]);

    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.related).not.toBeNull();
  });

  it('refuses a hydration fetch for a different list, before and after the subject', async () => {
    // The page also fetches lists its filters refer to, through the same
    // endpoint. The page URL names the subject, so only the subject lands.
    h.setNativeFetch(async () => okResponse(JSON.stringify({ listId: 999, processingType: 'DYNAMIC' })));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/999?portalId=12345678');
    await flush();
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);

    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();

    h.setNativeFetch(async () => okResponse(JSON.stringify({ listId: 999, processingType: 'DYNAMIC' })));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/999?portalId=12345678');
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.listId).toBe('4242');
    expect(status.raw).toBe(LIST_BODY);
  });

  it('captures through XHR as well as fetch', async () => {
    const xhr = h.makeXhr();
    xhr.open('GET', LIST_GET);
    xhr.send();
    xhr.responseText = LIST_BODY;
    xhr.fire('load');
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.domain).toBe('list');
  });

  it('guards the subject on the newer segments root the same way', async () => {
    // The provisional id read from /segments/{portal}/{listId} is what lets
    // the hydration guard fire here at all.
    const root = harness({ url: 'https://app.hubspot.com/segments/12345678/4242' });
    root.setNativeFetch(async () => okResponse(JSON.stringify({ listId: 999, processingType: 'DYNAMIC' })));
    await root.pageFetch('/api/inbounddb-lists/v1/lists/999?portalId=12345678');
    await flush();
    expect((await root.askPopup('pp:status')).hasCapture).toBe(false);

    root.setNativeFetch(async () => okResponse(LIST_BODY));
    await root.pageFetch(LIST_GET);
    await flush();
    const status = await root.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.listId).toBe('4242');
  });
});

describe('sidecar captures beside a segment', () => {
  const BATCH_BODY = JSON.stringify([{ listId: 4243, processingType: 'DYNAMIC', name: 'Referenced' }]);
  const SUPP_BODY = JSON.stringify({ suppressionLists: [] });
  const MEMB_BODY = JSON.stringify({ crmListSize: 4242 });

  const SUPPRESSION_GET = '/api/inbounddb-lists/v1/lists/4242/suppression?portalId=12345678';
  const MEMBERSHIP_GET = '/api/inbounddb-lists/v1/list-membership-search/list/4242/3/current-state';
  const BATCH_GET = '/api/inbounddb-lists/v1/lists/getBatch?portalId=12345678';

  async function loadSubject(h) {
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();
  }

  it('hands the popup every sidecar body, verbatim, under its own key', async () => {
    const h = harness({ url: LIST_URL });
    await loadSubject(h);

    h.setNativeFetch(async () => okResponse(BATCH_BODY));
    await h.pageFetch(BATCH_GET);
    h.setNativeFetch(async () => okResponse(SUPP_BODY));
    await h.pageFetch(SUPPRESSION_GET);
    h.setNativeFetch(async () => okResponse(MEMB_BODY));
    await h.pageFetch(MEMBERSHIP_GET);
    await flush();

    for (const message of ['pp:status', 'pp:payload']) {
      const answer = await h.askPopup(message);
      expect(answer.related, message).toEqual({
        listBatches: [BATCH_BODY],
        fetchedLists: [],
        suppression: SUPP_BODY,
        membershipCounts: MEMB_BODY,
      });
    }
  });

  it('keeps one copy of a byte-identical batch refire', async () => {
    const h = harness({ url: LIST_URL });
    await loadSubject(h);

    h.setNativeFetch(async () => okResponse(BATCH_BODY));
    await h.pageFetch(BATCH_GET);
    await h.pageFetch(BATCH_GET);
    await flush();

    expect((await h.askPopup('pp:status')).related.listBatches).toEqual([BATCH_BODY]);
  });

  it('refuses a suppression body for a different list than the page names', async () => {
    const h = harness({ url: LIST_URL });
    await loadSubject(h);

    h.setNativeFetch(async () => okResponse(SUPP_BODY));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/999/suppression?portalId=12345678');
    await flush();

    expect((await h.askPopup('pp:status')).related).toBeNull();
  });

  it('refuses a batch on a page whose URL does not name the segment', async () => {
    // The batch carries no id of its own, so on the lists index there is no
    // honest way to say whose lists these are.
    const h = harness({ url: 'https://app.hubspot.com/contacts/12345678/objectLists' });
    h.setNativeFetch(async () => okResponse(BATCH_BODY));
    await h.pageFetch(BATCH_GET);
    await flush();

    // Nothing was kept: opening a list afterwards starts clean rather than
    // inheriting a batch nobody can attribute.
    h.isolatedLocation.href = LIST_URL;
    h.mainWindow.location.href = LIST_URL;
    await loadSubject(h);
    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.related).toBeNull();
  });

  it('refuses sidecars on a workflows page', async () => {
    const h = harness();
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();

    h.setNativeFetch(async () => okResponse(BATCH_BODY));
    await h.pageFetch(BATCH_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.domain).toBe('flow');
    expect(status.related == null).toBe(true);
  });

  it('never hands one segment sidecars captured for another', async () => {
    const h = harness({ url: LIST_URL });
    await loadSubject(h);
    h.setNativeFetch(async () => okResponse(BATCH_BODY));
    await h.pageFetch(BATCH_GET);
    await flush();

    // The SPA moves to another list: its suppression arrives first, then its
    // definition. The old batch belongs to 4242 and must not ride along.
    h.isolatedLocation.href = 'https://app.hubspot.com/contacts/12345678/objectLists/999/filters';
    h.mainWindow.location.href = h.isolatedLocation.href;
    h.setNativeFetch(async () => okResponse(SUPP_BODY));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/999/suppression?portalId=12345678');
    h.setNativeFetch(async () => okResponse(JSON.stringify({ listId: 999, processingType: 'DYNAMIC' })));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/999?portalId=12345678');
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.listId).toBe('999');
    expect(status.related).toEqual({
      listBatches: [],
      fetchedLists: [],
      suppression: SUPP_BODY,
      membershipCounts: null,
    });
  });
});

describe('fetching referenced definitions the page never loaded', () => {
  const definitionFor = (url) =>
    JSON.stringify({ listId: Number(new URL(url).pathname.split('/').pop()), processingType: 'DYNAMIC' });

  async function subject(h) {
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();
  }

  it('fetches each missing id through the definition endpoint, with the CSRF header', async () => {
    const h = harness({ url: LIST_URL });
    await subject(h);
    h.setRefresh(async (url) => ({ ok: true, status: 200, text: async () => definitionFor(url) }));

    const result = await h.askPopup('pp:fetch-referenced', { listIds: ['20', '21'] });
    expect(result).toEqual({ ok: true, fetched: 2, failed: [] });

    expect(h.refreshCalls).toHaveLength(2);
    for (const [index, id] of [['0', '20'], ['1', '21']].map(([i, id]) => [Number(i), id])) {
      const url = new URL(h.refreshCalls[index].url);
      expect(url.pathname).toBe(`/api/inbounddb-lists/v1/lists/${id}`);
      expect(url.searchParams.get('portalId')).toBe('12345678');
      expect(h.refreshCalls[index].init.headers['x-hubspot-csrf-hubspotapi']).toBe('csrf-token-value');
    }

    const status = await h.askPopup('pp:status');
    expect(status.related.fetchedLists).toHaveLength(2);
    expect(JSON.parse(status.related.fetchedLists[0]).listId).toBe(20);
  });

  it('skips ids already fetched, and the subject its own id', async () => {
    const h = harness({ url: LIST_URL });
    await subject(h);
    h.setRefresh(async (url) => ({ ok: true, status: 200, text: async () => definitionFor(url) }));

    await h.askPopup('pp:fetch-referenced', { listIds: ['20'] });
    const again = await h.askPopup('pp:fetch-referenced', { listIds: ['20', '4242'] });
    // '4242' is the subject itself and never even qualifies; '20' is already
    // held, so the answer is an honest nothing-new, with no request made.
    expect(again).toEqual({ ok: true, fetched: 0, failed: [] });
    expect(h.refreshCalls).toHaveLength(1);

    expect((await h.askPopup('pp:status')).related.fetchedLists).toHaveLength(1);
  });

  it('keeps what succeeded and names what failed', async () => {
    const h = harness({ url: LIST_URL });
    await subject(h);
    h.setRefresh(async (url) =>
      url.includes('/lists/21')
        ? { ok: false, status: 403, text: async () => 'nope' }
        : { ok: true, status: 200, text: async () => definitionFor(url) },
    );

    const result = await h.askPopup('pp:fetch-referenced', { listIds: ['20', '21', '22'] });
    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(2);
    // The status rides along: it is the difference between "system-internal
    // list with no fetchable definition" and "you were not allowed".
    expect(result.failed).toEqual([{ id: '21', status: 403 }]);
    expect((await h.askPopup('pp:status')).related.fetchedLists).toHaveLength(2);
  });

  it('refuses without a segment capture to attach to', async () => {
    const empty = harness({ url: LIST_URL });
    expect(await empty.askPopup('pp:fetch-referenced', { listIds: ['20'] })).toEqual({
      ok: false,
      error: 'no-id',
    });
    expect(empty.refreshCalls).toEqual([]);

    const flow = harness();
    flow.setNativeFetch(async () => okResponse(FLOW_BODY));
    await flow.pageFetch(HYBRID_GET);
    await flush();
    expect(await flow.askPopup('pp:fetch-referenced', { listIds: ['20'] })).toEqual({
      ok: false,
      error: 'no-id',
    });
    expect(flow.refreshCalls).toEqual([]);
  });

  it('rejects ids that are not bare numbers rather than building URLs from them', async () => {
    const h = harness({ url: LIST_URL });
    await subject(h);
    const result = await h.askPopup('pp:fetch-referenced', {
      listIds: ['../../evil', '20/suppression', '', null],
    });
    expect(result).toEqual({ ok: false, error: 'no-id' });
    expect(h.refreshCalls).toEqual([]);
  });
});

describe('a list body on a workflows page is hydration, not the subject', () => {
  it('is refused, so it can never replace a flow capture', async () => {
    const h = harness();
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();

    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.domain).toBe('flow');
    expect(status.raw).toBe(FLOW_BODY);
  });

  it('is refused even with no flow captured yet', async () => {
    const h = harness();
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();

    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe('segment SPA staleness guard', () => {
  let h;

  beforeEach(async () => {
    h = harness({ url: LIST_URL });
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();
  });

  it('reports no capture after navigating to a different list', async () => {
    h.isolatedLocation.href = 'https://app.hubspot.com/contacts/12345678/objectLists/999/filters';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect((await h.askPopup('pp:payload')).hasCapture).toBe(false);
  });

  it('still reports the capture on a different page of the same list', async () => {
    h.isolatedLocation.href = 'https://app.hubspot.com/contacts/12345678/objectLists/4242/performance';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(true);
  });
});

describe('segment refresh', () => {
  it('refetches the exact URL the page itself used, with the CSRF header', async () => {
    const h = harness({ url: LIST_URL });
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    await flush();

    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => LIST_BODY }));
    const result = await h.askPopup('pp:refresh');
    expect(result.ok).toBe(true);

    const call = h.refreshCalls[0];
    // Verbatim: that URL demonstrably works, query params and all.
    expect(call.url).toBe(`${ORIGIN}${LIST_GET}`);
    expect(call.init.headers['x-hubspot-csrf-hubspotapi']).toBe('csrf-token-value');
    expect(call.init.credentials).toBe('include');

    const status = await h.askPopup('pp:status');
    expect(status.kind).toBe('refresh');
    expect(status.domain).toBe('list');
  });

  it('constructs the definition URL from the page when nothing was captured yet', async () => {
    // The popup's first-fetch path: the bridge is present but the load was
    // missed, and the page URL names the list.
    const h = harness({ url: LIST_URL });
    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => LIST_BODY }));

    const result = await h.askPopup('pp:refresh');
    expect(result.ok).toBe(true);

    const url = new URL(h.refreshCalls[0].url);
    expect(url.pathname).toBe('/api/inbounddb-lists/v1/lists/4242');
    expect(url.searchParams.get('portalId')).toBe('12345678');
    expect(url.searchParams.get('clienttimeout')).toBe('14000');
    expect(url.searchParams.get('hs_static_app')).toBeNull();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.domain).toBe('list');
    expect(status.listId).toBe('4242');
  });

  it('answers no-id on a page that names neither a workflow nor a segment', async () => {
    const h = harness({ url: 'https://app.hubspot.com/contacts/12345678/objectLists' });
    const result = await h.askPopup('pp:refresh');
    expect(result).toEqual({ ok: false, error: 'no-id' });
    expect(h.refreshCalls).toEqual([]);
  });
});

describe('record capture, end to end on a record page', () => {
  const RECORD_URL = 'https://app.hubspot.com/contacts/12345678/record/0-1/9101';
  const RECORD_GET =
    '/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678&allPropertiesFetchMode=latest_version&includeAllProperties=true&flpViewValidation=false&id=9101';
  const RECORD_BODY = JSON.stringify({
    9101: {
      objectTypeId: '0-1',
      objectId: 9101,
      portalId: 12345678,
      properties: { firstname: { value: 'Fixture' } },
    },
  });

  it('captures the batch GET and hands it to the popup with its ids', async () => {
    const h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse(RECORD_BODY));
    await h.pageFetch(RECORD_GET);
    await flush();

    const status = await h.askPopup('pp:status');
    expect(status.hasCapture).toBe(true);
    expect(status.domain).toBe('record');
    expect(status.kind).toBe('load');
    expect(status.objectTypeId).toBe('0-1');
    expect(status.objectId).toBe('9101');
    expect(status.flowId).toBeNull();
    expect(status.listId).toBeNull();
    expect(status.raw).toBe(RECORD_BODY);
    expect(h.sent).toEqual([{ type: 'pp:captured' }]);

    const payload = await h.askPopup('pp:payload');
    expect(payload.domain).toBe('record');
    expect(payload.objectTypeId).toBe('0-1');
    expect(payload.objectId).toBe('9101');
    expect(payload.raw).toBe(RECORD_BODY);
  });

  it('lets the observed double-fire settle last-write-wins', async () => {
    // Record pages fire the batch endpoint twice (a validation variant rides
    // second). Both match the guard, both are the same record: the later body
    // simply replaces the earlier one.
    const h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse(RECORD_BODY));
    await h.pageFetch(RECORD_GET);
    const second = JSON.stringify({ 9101: { objectTypeId: '0-1', objectId: 9101, properties: {} } });
    h.setNativeFetch(async () => okResponse(second));
    await h.pageFetch(
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678&flpViewValidation=true&id=9101',
    );
    await flush();

    expect((await h.askPopup('pp:status')).raw).toBe(second);
  });

  it('refuses a batch for a sibling type or another record of the same type', async () => {
    const h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse('{"9303":{}}'));
    await h.pageFetch('/api/inbounddb-objects/v1/crm-objects/0-2/batch?portalId=12345678&id=9303');
    await h.pageFetch('/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678&id=9303');
    await flush();

    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('refuses a record body on a page whose URL names no record: fail closed', async () => {
    // The deliberate opposite of the flow guard. The same document outlives
    // the record it belongs to (SPA navigation, measured live), so a body
    // that cannot be tied to the page pair is never kept, badge included.
    for (const url of [
      'https://app.hubspot.com/contacts/12345678/objects/0-1/views/all/list',
      LIST_URL,
      EDITOR_URL,
    ]) {
      const h = harness({ url });
      h.setNativeFetch(async () => okResponse(RECORD_BODY));
      await h.pageFetch(RECORD_GET);
      await flush();

      expect((await h.askPopup('pp:status')).hasCapture, url).toBe(false);
      expect(h.sent, url).toEqual([]);
    }
  });

  it('refuses a list body and list sidecars on a record page', async () => {
    // The regression this domain closes: before records existed, a list
    // definition fetched on a record page passed every guard (ids.listId is
    // null there, so the mismatch check never fired) and became the snapshot,
    // and storeSidecar kept suppression bodies the same way. A segment export
    // offered on a person's record, with a _related bundle.
    const h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse(LIST_BODY));
    await h.pageFetch(LIST_GET);
    h.setNativeFetch(async () => okResponse('[]'));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/getBatch?portalId=12345678');
    h.setNativeFetch(async () => okResponse('{}'));
    await h.pageFetch('/api/inbounddb-lists/v1/lists/4242/suppression?portalId=12345678');
    await flush();

    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect(h.sent).toEqual([]);

    // And the record itself still lands cleanly afterwards, with nothing
    // inherited.
    h.setNativeFetch(async () => okResponse(RECORD_BODY));
    await h.pageFetch(RECORD_GET);
    await flush();
    const status = await h.askPopup('pp:status');
    expect(status.domain).toBe('record');
    expect(status.related == null).toBe(true);
  });
});

describe('record SPA staleness guard', () => {
  const RECORD_URL = 'https://app.hubspot.com/contacts/12345678/record/0-3/9202';
  const RECORD_GET = '/api/inbounddb-objects/v1/crm-objects/0-3/batch?portalId=12345678&id=9202';
  const RECORD_BODY = '{"9202":{"objectTypeId":"0-3","objectId":9202,"properties":{}}}';

  let h;
  beforeEach(async () => {
    h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse(RECORD_BODY));
    await h.pageFetch(RECORD_GET);
    await flush();
  });

  it('reports no capture after the SPA moves to a different record', async () => {
    // Measured live: same document, two records' batch responses in one
    // lifetime. Without this the popup offers the deal's JSON on the
    // company's page.
    h.isolatedLocation.href = 'https://app.hubspot.com/contacts/12345678/record/0-2/9301';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
    expect((await h.askPopup('pp:payload')).hasCapture).toBe(false);
  });

  it('reports no capture once the page no longer names a record at all', async () => {
    // Fail closed, unlike the flow guard: no pair in the URL means no answer,
    // not a benefit of the doubt.
    h.isolatedLocation.href = 'https://app.hubspot.com/contacts/12345678/objects/0-3/views/all/list';
    expect((await h.askPopup('pp:status')).hasCapture).toBe(false);
  });

  it('still reports the capture while the pair matches, query params aside', async () => {
    // SPA navigation appends query params (portalId, clienttimeout) to the
    // page URL; the pair is read from the pathname and still matches.
    h.isolatedLocation.href = `${RECORD_URL}?portalId=12345678&clienttimeout=14000`;
    expect((await h.askPopup('pp:status')).hasCapture).toBe(true);
  });
});

describe('record refresh', () => {
  const RECORD_URL = 'https://app.hubspot.com/contacts/12345678/record/0-1/9101';
  const RECORD_GET =
    '/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678&includeAllProperties=true&id=9101';
  const RECORD_BODY = '{"9101":{"objectTypeId":"0-1","objectId":9101,"properties":{}}}';

  it('repeats the exact URL the page used, and keeps the ids on the new snapshot', async () => {
    const h = harness({ url: RECORD_URL });
    h.setNativeFetch(async () => okResponse(RECORD_BODY));
    await h.pageFetch(RECORD_GET);
    await flush();

    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => RECORD_BODY }));
    const result = await h.askPopup('pp:refresh');
    expect(result.ok).toBe(true);

    const call = h.refreshCalls[0];
    // Verbatim, params and all: the batch endpoint's query params are
    // shape-bearing, and a constructed set could silently return fewer
    // properties than the passive capture did.
    expect(call.url).toBe(`${ORIGIN}${RECORD_GET}`);
    expect(call.init.headers['x-hubspot-csrf-hubspotapi']).toBe('csrf-token-value');

    const status = await h.askPopup('pp:status');
    expect(status.kind).toBe('refresh');
    expect(status.domain).toBe('record');
    expect(status.objectTypeId).toBe('0-1');
    expect(status.objectId).toBe('9101');
  });

  it('answers no-captured-url rather than constructing a first fetch', async () => {
    // There is deliberately no crmObjectsBatchUrl builder, so with nothing
    // captured there is nothing to repeat, and no request goes out.
    const h = harness({ url: RECORD_URL });
    const result = await h.askPopup('pp:refresh');
    expect(result).toEqual({ ok: false, error: 'no-captured-url' });
    expect(h.refreshCalls).toEqual([]);
  });
});

describe('refresh without a readable csrf.app cookie', () => {
  it('gets its own error code rather than a generic failure', async () => {
    // A distinct code, because the fix is "reload the page", not "check your
    // connection". HubSpot answers a missing CSRF header with 401, so folding
    // this into a generic failure sends people hunting an expired session that
    // is perfectly fine.
    const h = harness({ cookie: 'hubspotutk=x; other=1' });
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();

    const result = await h.askPopup('pp:refresh');
    expect(result).toEqual({ ok: false, error: 'csrf-unreadable' });

    // No request was attempted, and the snapshot is untouched.
    expect(h.refreshCalls).toEqual([]);
    expect((await h.askPopup('pp:status')).raw).toBe(FLOW_BODY);
  });

  it('does not mistake a cookie whose name merely ends in csrf.app', async () => {
    const h = harness({ cookie: 'not-csrf.app=decoy; csrf.app=real-token' });
    h.setNativeFetch(async () => okResponse(FLOW_BODY));
    await h.pageFetch(HYBRID_GET);
    await flush();

    h.setRefresh(async () => ({ ok: true, status: 200, text: async () => FLOW_BODY }));
    await h.askPopup('pp:refresh');

    expect(h.refreshCalls[0].init.headers['x-hubspot-csrf-hubspotapi']).toBe('real-token');
  });
});
