// The isolated-world end of the property-names channel.
//
// Holds one label index in memory for as long as the page lives. Nothing is
// written to chrome.storage, here or anywhere: the settings table is the only
// thing this extension persists, and tools/check-settings.mjs fails the build on
// any key it does not declare.
//
// Indexes are keyed by objectTypeId and handed out only to a caller asking for
// that same type. A contact's labels resolving a company's rows would be a
// confident wrong answer, which is the one outcome this feature is built to
// avoid.
//
// One index PER TYPE, not one index plus the type it happens to be for. A record
// page fetches the properties endpoint for more than one object type: a live
// deal record asked for 0-3 at 609ms and 0-4 at 3719ms. Holding a single slot
// meant the second arrival evicted the first, so the page ended up with an index
// for line items while showing a deal, and every label surface went quiet. The
// keyed lookup below is the same guarantee it always was, now stated as a lookup
// rather than resting on which response happened to land last.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { PROPERTY_NAMES_CHANNEL, PROPERTY_NAMES_MSG } from './property-names-protocol.js';
import { parsePropertyNames } from './property-names.js';

const loaded = new Map();
let listening = false;

/**
 * Start listening for the interceptor's message.
 *
 * @param {() => void} [onLoaded] called once an index is available, so the host
 *   can run a pass. The response arrives during page load, which may well be
 *   after the last mutation the observer sees, so waiting for another one is not
 *   good enough.
 * @returns {() => void} unsubscribe
 */
export function startPropertyNames(onLoaded) {
  if (listening) return () => {};

  const handler = (event) => {
    // Same-window only. A message from a frame or another origin is not ours,
    // whatever it claims in its channel field.
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.channel !== PROPERTY_NAMES_CHANNEL) return;
    if (data.type !== PROPERTY_NAMES_MSG.LOADED) return;
    if (typeof data.objectTypeId !== 'string') return;

    const parsed = parsePropertyNames(data.body);
    // A shape nobody recognises costs the label surfaces and nothing else. The
    // surfaces that read the name off the page are unaffected.
    if (!parsed.ok) return;

    loaded.set(data.objectTypeId, parsed.index);

    try {
      if (onLoaded) onLoaded();
    } catch {
      /* a consumer that throws must not kill the listener */
    }
  };

  window.addEventListener('message', handler);
  listening = true;

  // Ask. Until this, the interceptor holds what it saw and sends nothing, so a
  // user who never switches the setting on never has it cross the boundary.
  // Safe in either order: if the response has not arrived yet the interceptor
  // remembers the ask and sends when it does.
  try {
    window.postMessage(
      { channel: PROPERTY_NAMES_CHANNEL, type: PROPERTY_NAMES_MSG.REQUEST },
      window.location.origin,
    );
  } catch {
    /* no index, so the label surfaces sit this page out */
  }

  return () => {
    window.removeEventListener('message', handler);
    listening = false;
  };
}

/**
 * The label index for one object type, or null.
 *
 * Null is the normal state for the first moment of a page's life, and for every
 * page where the response never arrived. Callers skip rather than wait.
 */
export function propertyNameIndex(objectTypeId) {
  if (typeof objectTypeId !== 'string') return null;
  return loaded.get(objectTypeId) || null;
}

/** Drop every index. Used by tests, and by nothing else. */
export function resetPropertyNames() {
  loaded.clear();
}
