// Isolated-world content script, document_start, loaded immediately before
// bridge.js on every page the capture pair runs on.
//
// Capture ships off. The user turns it on from the notice on the popup's Home
// page, and that choice lives in chrome.storage.local so a script on
// hubspot.com can obey it. The bridge and the interceptor are forbidden from
// mentioning chrome.storage at all (tools/check-no-network.mjs greps the built
// files), because that grep is how "nothing about a capture is persisted" is
// checked rather than promised. So the read happens here instead: one script
// whose whole job is one boolean, and which never sees a response.
//
// That last part is structural, not a habit. This file registers no window
// message listener, which is the only way a captured body reaches the isolated
// world, and the build fails if it ever grows one. The script that can touch
// storage cannot see a capture, and the scripts that see captures cannot touch
// storage.
//
// It publishes through a global rather than a message. See GATE_GLOBAL in
// protocol.js for why.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { GATE_GLOBAL } from './protocol.js';
import { SETTING } from '../../overlay/src/settings.js';
import { readSettings, onSettingsChanged } from '../../overlay/src/settings-store.js';

const subscribers = new Set();

const captureGate = {
  // null until storage has answered. Unknown is not a yes: the bridge keeps
  // nothing and the interceptor reads nothing until this is exactly true.
  open: null,

  /**
   * Hear the answer now if there is one, and every change after it.
   *
   * @param {(open: boolean) => void} listener
   */
  subscribe(listener) {
    subscribers.add(listener);
    if (captureGate.open !== null) listener(captureGate.open);
  },
};

function publish(settings) {
  // Exactly true. normalizeSettings has already turned anything that is not a
  // boolean into the default, which is off, so a stored 'true' string or a 1
  // from some other build cannot read as consent.
  const open = settings[SETTING.CAPTURE] === true;
  if (captureGate.open === open) return;
  captureGate.open = open;
  for (const listener of [...subscribers]) {
    try {
      listener(open);
    } catch {
      // A listener that throws must not stop the others hearing the answer.
    }
  }
}

globalThis[GATE_GLOBAL] = captureGate;

// The change listener first, so a switch flipped while the first read is in
// flight is not lost. readSettings never rejects: a storage failure costs the
// defaults, and the default here is off.
onSettingsChanged(publish);
readSettings().then(publish);
