// MAIN-world content script, document_start. Reads one response HubSpot already
// fetches, and does nothing else.
//
// This file runs in the page's own JS world, sharing the page's window. That is
// not a convenience, it is the only thing that works: a normal content script
// gets an isolated world with its own window, and patching fetch there patches
// a copy nothing calls. Same reasoning as packages/capture/src/interceptor.js,
// and the two must never be merged.
//
// document_start is required and was measured, not assumed. On a live record the
// properties response is fetched once during load and cached for the rest of the
// session: sixty seconds of clicking around produced zero further requests. A
// script arriving at document_idle has already missed it.
//
// Consequences of living here, all load bearing:
//
//   - No chrome.* of any kind. The only exit is window.postMessage, and
//     tools/build.mjs fails the build if this file so much as mentions it.
//   - Every hook is wrapped and always returns the original value. A bug in an
//     inspector must never break a customer's CRM.
//   - Nothing is parsed. Raw response text goes over the wire verbatim, and the
//     isolated world decides what it means.
//   - Nothing is stored, here or anywhere. The index lives in the overlay's
//     memory for as long as the page does.
//
// WHAT THIS DOES NOT DO
//
// It issues no request of its own. That distinction is the product's headline
// claim: the only request Portal Peeker makes is Refresh, on an explicit click.
// Refetching this endpoint ourselves would have been simpler and was rejected
// for exactly that reason.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { PROPERTY_NAMES_CHANNEL, PROPERTY_NAMES_MSG } from './property-names-protocol.js';

// GET /api/properties/v{n}/groups/{objectTypeId}/properties
//
// The version is matched loosely because it will move, and the objectTypeId is
// captured because a contact's labels must never be used on a company record.
const PROPERTIES_PATH = /\/api\/properties\/v\d+\/groups\/(\d+-\d+)\/properties$/;

const origin = window.location.origin;

// The last response seen, and whether anyone has asked for it. Nothing is sent
// until the overlay asks, which it does only when the user has the setting on.
let buffered = null;
let requested = false;

/** The objectTypeId this URL is asking about, or null for everything else. */
function objectTypeFor(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(PROPERTIES_PATH);
  return match ? match[1] : null;
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

function send() {
  if (!requested || !buffered) return;
  try {
    window.postMessage(
      {
        channel: PROPERTY_NAMES_CHANNEL,
        type: PROPERTY_NAMES_MSG.LOADED,
        objectTypeId: buffered.objectTypeId,
        body: buffered.body,
      },
      origin,
    );
  } catch {
    // A payload that will not structured-clone is a lookup we do not get, not a
    // broken page.
  }
}

/** Hold it. Send only if someone has already asked. */
function emit(objectTypeId, bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return;
  buffered = { objectTypeId, body: bodyText };
  send();
}

// The overlay asks when the user switches the setting on, which may be long
// after the response arrived, or before it does. Either order works: the ask
// sets the flag and flushes whatever is already held.
window.addEventListener('message', (event) => {
  try {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== PROPERTY_NAMES_CHANNEL) return;
    if (data.type !== PROPERTY_NAMES_MSG.REQUEST) return;
    requested = true;
    send();
  } catch {
    /* a malformed message is not our problem */
  }
});

// ---------------------------------------------------------------- fetch

const nativeFetch = window.fetch;

if (typeof nativeFetch === 'function') {
  window.fetch = function patchedFetch(input, init) {
    const response = nativeFetch.apply(this, arguments);
    try {
      const objectTypeId = objectTypeFor(urlOf(input));
      if (objectTypeId) {
        response
          .then((result) => {
            // clone() so the page's own consumer still gets an unread body.
            // Reading the original would break the page outright.
            try {
              if (result && result.ok) result.clone().text().then((text) => emit(objectTypeId, text)).catch(() => {});
            } catch {
              /* a response that will not clone is one we skip */
            }
            return null;
          })
          .catch(() => {});
      }
    } catch {
      /* never let a hook change what the caller sees */
    }
    return response;
  };
}

// ---------------------------------------------------------------- XHR
//
// HubSpot uses both. The properties call was observed as an XHR, and relying on
// that staying true is exactly the kind of assumption that rots.

const proto = typeof XMLHttpRequest === 'function' ? XMLHttpRequest.prototype : null;

if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
  const nativeOpen = proto.open;
  const nativeSend = proto.send;

  proto.open = function patchedOpen(method, url) {
    try {
      this.__ppObjectType = objectTypeFor(typeof url === 'string' ? url : urlOf(url));
    } catch {
      this.__ppObjectType = null;
    }
    return nativeOpen.apply(this, arguments);
  };

  proto.send = function patchedSend() {
    try {
      const objectTypeId = this.__ppObjectType;
      if (objectTypeId) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300) emit(objectTypeId, this.responseText);
          } catch {
            /* responseText throws on some responseTypes; that is a skip */
          }
        });
      }
    } catch {
      /* never let a hook change what the caller sees */
    }
    return nativeSend.apply(this, arguments);
  };
}
