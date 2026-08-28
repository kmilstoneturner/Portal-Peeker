// MAIN-world content script, document_start.
//
// This file runs in the page's own JS world, sharing the page's window. That is
// not a convenience, it is the only thing that works: a normal content script
// gets an isolated world with its own window, and patching fetch there patches
// a copy nothing calls. document_start matters just as much, because HubSpot's
// bundle grabs a reference to the original fetch as it initialises.
//
// Consequences of living here, all of them load-bearing:
//
//   - No chrome.* of any kind. The only exit is window.postMessage.
//   - Every hook is wrapped in try/catch and always returns the original value.
//     A bug in an inspector must never break a customer's workflow editor.
//   - Nothing is parsed. Raw response text goes over the wire verbatim.
//
// Do not merge this file with bridge.js. They cannot run in the same world.

import { WINDOW_CHANNEL, PAGE_MSG } from './protocol.js';
import { classifyUrl } from './endpoints.js';

const origin = window.location.origin;

function emit(hit, status, bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return;
  try {
    window.postMessage(
      {
        channel: WINDOW_CHANNEL,
        // Sidecars ride a separate message type so an older bridge ignores
        // them rather than storing one as the subject.
        type: hit.role === 'sidecar' ? PAGE_MSG.SIDECAR : PAGE_MSG.CAPTURE,
        kind: hit.kind,
        domain: hit.domain,
        sidecarKind: hit.sidecarKind,
        url: hit.url,
        flowIdFromUrl: hit.flowId,
        listIdFromUrl: hit.listId,
        status,
        capturedAt: Date.now(),
        body: bodyText,
      },
      origin,
    );
  } catch {
    // A payload that will not structured-clone is a dropped capture, not a
    // broken page.
  }
}

function urlOf(input) {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url; // Request
  } catch {
    /* fall through */
  }
  return null;
}

// The list endpoint serves reads and writes on one path, so the method is part
// of classification. fetch carries it in two places: init wins over a Request
// object's own method, which is fetch's own precedence.
function methodOf(input, init) {
  try {
    if (init && typeof init.method === 'string') return init.method;
    if (input && typeof input.method === 'string') return input.method; // Request
  } catch {
    /* fall through */
  }
  return 'GET';
}

// ---------------------------------------------------------------- fetch

const nativeFetch = window.fetch;

if (typeof nativeFetch === 'function') {
  window.fetch = function patchedFetch(input, init) {
    const pending = nativeFetch.apply(this, arguments);

    let hit = null;
    try {
      hit = classifyUrl(urlOf(input), window.location.href, undefined, methodOf(input, init));
    } catch {
      hit = null;
    }
    if (!hit) return pending;

    // Only onFulfilled, so rejections propagate untouched.
    return pending.then((response) => {
      try {
        if (response && response.ok) {
          // clone() so the page still gets an unread body. Only reached on a
          // matched URL, so the memory cost is bounded to flow payloads.
          response
            .clone()
            .text()
            .then((text) => emit(hit, response.status, text))
            .catch(() => {});
        }
      } catch {
        /* never interfere with the page's response */
      }
      return response;
    });
  };
}

// ---------------------------------------------------------------- XHR
//
// HubSpot's editor uses fetch today. XHR is covered anyway because a bundle
// swap is invisible to us and a silently dead capture is the worst outcome.

const nativeOpen = XMLHttpRequest.prototype.open;
const nativeSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
  try {
    this.__portalPeekerUrl = typeof url === 'string' ? url : urlOf(url);
    this.__portalPeekerMethod = typeof method === 'string' ? method : 'GET';
  } catch {
    /* ignore */
  }
  return nativeOpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function patchedSend() {
  try {
    const hit = classifyUrl(
      this.__portalPeekerUrl,
      window.location.href,
      undefined,
      this.__portalPeekerMethod,
    );
    if (hit) {
      this.addEventListener('load', function onLoad() {
        try {
          if (this.status < 200 || this.status >= 300) return;
          // responseText throws when responseType is not '' or 'text'.
          emit(hit, this.status, this.responseText);
        } catch {
          /* ignore */
        }
      });
    }
  } catch {
    /* ignore */
  }
  return nativeSend.apply(this, arguments);
};
