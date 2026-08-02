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

const dist = (name) => fileURLToPath(new URL(`../../../apps/free/dist/${name}`, import.meta.url));

const EDITOR_URL = 'https://app.hubspot.com/workflows/12345678/platform/flow/1000000001/edit';
const ORIGIN = 'https://app.hubspot.com';
const HYBRID_GET = '/api/automationplatform/v1/hybrid/1000000001?portalId=12345678';
const SAVE_POST = '/api/automationplatform/v1/hybrid/batch?sourceapp=WORKFLOWS_APP';

const FLOW_BODY = JSON.stringify({
  flowId: 1000000001,
  portalId: 12345678,
  name: 'Captured flow',
  isClassicWorkflow: true,
  version: 1,
  actions: { 1: { actionId: 1 } },
});

if (!existsSync(dist('capture/interceptor.js'))) {
  throw new Error('apps/free/dist is missing. Run: npm run build');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DEFAULT_COOKIE = 'hubspotutk=x; csrf.app=csrf-token-value; other=1';

function harness({ cookie = DEFAULT_COOKIE } = {}) {
  const sent = [];
  let popupHandler = null;
  let deliver = null;

  // ---- isolated world (bridge) ----
  const isolatedLocation = { href: EDITOR_URL, origin: ORIGIN };
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
    location: { href: EDITOR_URL, origin: ORIGIN },
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

  const askPopup = (type) =>
    new Promise((resolve) => {
      const returned = popupHandler({ type }, {}, resolve);
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
