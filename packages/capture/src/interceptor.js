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
//   - Nothing is read until the bridge says the user has turned capture on.
//
// Do not merge this file with bridge.js. They cannot run in the same world.

import { WINDOW_CHANNEL, PAGE_MSG, GATE_MSG } from './protocol.js';
import { classifyUrl } from './endpoints.js';

const origin = window.location.origin;

// ---------------------------------------------------------------- the gate
//
// Capture ships off. This script still has to be on the page from
// document_start, or there would be nothing to switch on later, but until the
// bridge says capture is on it reads no response at all: on a matched request
// the body is not cloned, not read, and not posted anywhere.
//
// Three states, and the middle one matters. For the first few milliseconds of
// a page neither side knows the answer, because the bridge learns it from an
// asynchronous storage read. A response arriving in that window is held as an
// unread clone and then either read (capture is on) or let go still unread
// (it is off). Without that, someone who turned capture on would now and then
// lose the capture on a fast page for no reason they could see.
//
// The hold is bounded twice over, by count and by time, because this runs in
// a customer's page and an orphaned script (the extension reloaded under an
// open tab) would otherwise wait on an answer that is never coming.
//
// This is not the check that keeps a capture out of the extension's hands.
// That one is in the bridge, which a page script cannot reach. This one is
// what makes "nothing is read while capture is off" true rather than
// "everything is read and then thrown away".

/** @type {boolean | null} null until the bridge has said either way. */
let gateOpen = null;
/** @type {Array<{read: () => void, release: () => void}>} */
let held = [];
const HELD_MAX = 8;
const GATE_PATIENCE_MS = 5000;

/** Run `read` now, later, or never, depending on what the gate says. */
function whenAllowed(read, release) {
  if (gateOpen === true) {
    read();
    return;
  }
  if (gateOpen === false || held.length >= HELD_MAX) {
    release();
    return;
  }
  held.push({ read, release });
}

function setGate(open) {
  gateOpen = open;
  const waiting = held;
  held = [];
  for (const entry of waiting) {
    try {
      if (open) entry.read();
      else entry.release();
    } catch {
      /* one held response must not cost the others */
    }
  }
}

try {
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== WINDOW_CHANNEL) return;
      if (data.type === GATE_MSG.OPEN) setGate(true);
      else if (data.type === GATE_MSG.CLOSED) setGate(false);
    } catch {
      /* never let a stray message throw into the page */
    }
  });
  // In case the bridge already knew and said so before this listener existed.
  window.postMessage({ channel: WINDOW_CHANNEL, type: GATE_MSG.QUERY }, origin);
  // No answer is treated as no. A later OPEN still opens it.
  setTimeout(() => {
    if (gateOpen === null) setGate(false);
  }, GATE_PATIENCE_MS);
} catch {
  // Could not even ask. Stay shut.
  gateOpen = false;
}

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
        objectTypeIdFromUrl: hit.objectTypeId,
        objectIdFromUrl: hit.objectId,
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
        // With capture off there is no clone at all: the response goes back to
        // the page exactly as it would with no extension installed.
        if (response && response.ok && gateOpen !== false) {
          // clone() so the page still gets an unread body. Only reached on a
          // matched URL, so the memory cost is bounded to flow payloads. The
          // clone has to be taken now, while the body is still unread; whether
          // it is ever read is the gate's decision.
          const copy = response.clone();
          whenAllowed(
            () => {
              copy
                .text()
                .then((text) => emit(hit, response.status, text))
                .catch(() => {});
            },
            () => {
              // Let go unread. Cancelling releases what the clone buffered
              // rather than leaving it for the garbage collector to find.
              const cancelled = copy.body && copy.body.cancel();
              if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
            },
          );
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
          const xhr = this;
          whenAllowed(
            () => {
              try {
                // responseText throws when responseType is not '' or 'text'.
                emit(hit, xhr.status, xhr.responseText);
              } catch {
                /* ignore */
              }
            },
            // Nothing to let go of: the page owns the request, and with
            // capture off its responseText is simply never touched.
            () => {},
          );
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
