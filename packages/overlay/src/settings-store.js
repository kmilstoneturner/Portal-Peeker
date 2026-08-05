// Reading and writing settings, from either side of the origin boundary.
//
// This is the one file the storage decision touches, and the reason the
// extension asks for a permission at all. The popup's localStorage belongs to
// the extension origin; a content script running on hubspot.com has its own.
// Neither can see the other, so a preference the popup sets and a content
// script obeys has to live somewhere both can reach. chrome.storage is that
// place, and it costs one permission that produces no install warning.
//
// The area is `local`, declared in settings.js and taken from there. Never
// sync: it would replicate through Google's servers, which falsifies
// PRIVACY.md's "What leaves your computer". tools/check-settings.mjs enforces
// that against the built bundle.
//
// Nothing about a capture is stored here or anywhere. What this holds is the
// state of the checkboxes on the Settings page, and nothing else.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { STORAGE_AREA, STORAGE_KEYS, normalizeSettings, storageKeyFor } from './settings.js';

/** The storage area, or null where chrome.storage is not reachable. */
function area() {
  try {
    return chrome.storage[STORAGE_AREA] || null;
  } catch {
    // No chrome at all: a test importing this module, or a context that has no
    // extension APIs. Callers fall back to the declared defaults.
    return null;
  }
}

/**
 * Whether settings can be persisted at all right now.
 *
 * False means chrome.storage is not reachable from this context. In a properly
 * loaded extension that cannot happen, since the permission is declared; in
 * practice it means a stale unpacked load, where Chrome serves the popup files
 * fresh from disk but is still running a manifest from before the permission
 * existed. The popup uses this to say so instead of silently resetting.
 */
export function settingsStoreAvailable() {
  return area() !== null;
}

/**
 * Every setting, with defaults filled in.
 *
 * Never rejects. A settings read that throws should cost the defaults, not the
 * feature it gates.
 */
export async function readSettings() {
  const store = area();
  if (!store) return normalizeSettings(null);
  try {
    return normalizeSettings(await store.get(STORAGE_KEYS));
  } catch {
    return normalizeSettings(null);
  }
}

/**
 * Write one setting.
 *
 * Only ids the table declares can be written, so a typo is a no-op rather than
 * a stray key nobody reads. Swallows its own errors: a preference is not worth
 * an error message.
 */
export async function writeSetting(id, value) {
  const key = storageKeyFor(id);
  const store = area();
  if (!key || !store) return;
  try {
    await store.set({ [key]: Boolean(value) });
  } catch {
    /* private mode, quota, or no extension context */
  }
}

/**
 * Call back whenever a setting changes, in any tab or from the popup.
 *
 * This is what makes the toggle take effect live in every open tab without a
 * reload, and it is the payoff for putting the preference in chrome.storage
 * rather than pushing messages at tabs that happen to be open.
 *
 * @returns {() => void} unsubscribe
 */
export function onSettingsChanged(handler) {
  let listener = null;
  try {
    listener = (changes, areaName) => {
      if (areaName !== STORAGE_AREA) return;
      if (!STORAGE_KEYS.some((key) => key in changes)) return;
      readSettings().then(handler);
    };
    chrome.storage.onChanged.addListener(listener);
  } catch {
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      /* already gone */
    }
  };
}
