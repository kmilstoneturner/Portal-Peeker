import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTING, SETTINGS, defaultSettings } from '../src/settings.js';
import {
  onSettingsChanged,
  readSettings,
  settingsStoreAvailable,
  writeSetting,
} from '../src/settings-store.js';

const KEY = SETTINGS.find((setting) => setting.id === SETTING.API_NAMES).key;

/** Enough of chrome.storage to exercise the wrapper, and nothing more. */
function fakeChrome(initial = {}) {
  const data = { ...initial };
  const listeners = [];

  const local = {
    get: async (keys) => {
      const out = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    set: async (patch) => {
      Object.assign(data, patch);
      const changes = {};
      for (const [key, value] of Object.entries(patch)) changes[key] = { newValue: value };
      for (const listener of [...listeners]) listener(changes, 'local');
    },
  };

  return {
    storage: {
      local,
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        },
      },
    },
    data,
    listeners,
  };
}

const install = (stub) => {
  globalThis.chrome = stub;
  return stub;
};

afterEach(() => {
  delete globalThis.chrome;
});

describe('settingsStoreAvailable', () => {
  it('is true when chrome.storage is reachable', () => {
    install(fakeChrome());
    expect(settingsStoreAvailable()).toBe(true);
  });

  // The condition behind the confusing failure this was added for: an unpacked
  // extension whose popup files are current but whose loaded manifest predates
  // the storage permission. Writes go nowhere and the checkbox appears to reset
  // itself on every open. The popup asks this so it can say so instead.
  it('is false when there is no chrome at all', () => {
    expect(settingsStoreAvailable()).toBe(false);
  });

  it('is false when chrome exists but the permission was never granted', () => {
    install({});
    expect(settingsStoreAvailable()).toBe(false);
  });
});

describe('readSettings', () => {
  it('falls back to defaults with no storage available', async () => {
    await expect(readSettings()).resolves.toEqual(defaultSettings());
  });

  it('reads a stored value', async () => {
    install(fakeChrome({ [KEY]: true }));
    await expect(readSettings()).resolves.toMatchObject({ [SETTING.API_NAMES]: true });
  });

  it('falls back to defaults when the store throws', async () => {
    const stub = fakeChrome();
    stub.storage.local.get = async () => {
      throw new Error('quota');
    };
    install(stub);
    await expect(readSettings()).resolves.toEqual(defaultSettings());
  });
});

describe('writeSetting', () => {
  it('writes the key the table declares', async () => {
    const stub = install(fakeChrome());
    await writeSetting(SETTING.API_NAMES, true);
    expect(stub.data).toEqual({ [KEY]: true });
  });

  it('stores a boolean even when handed something else', async () => {
    const stub = install(fakeChrome());
    await writeSetting(SETTING.API_NAMES, 'yes');
    expect(stub.data[KEY]).toBe(true);
  });

  // A typo must be a no-op rather than a stray key nobody ever reads back.
  it('ignores an id the table does not declare', async () => {
    const stub = install(fakeChrome());
    await writeSetting('notASetting', true);
    expect(stub.data).toEqual({});
  });

  it('swallows a failing write', async () => {
    const stub = fakeChrome();
    stub.storage.local.set = async () => {
      throw new Error('quota');
    };
    install(stub);
    await expect(writeSetting(SETTING.API_NAMES, true)).resolves.toBeUndefined();
  });

  it('does nothing, and does not throw, with no storage available', async () => {
    await expect(writeSetting(SETTING.API_NAMES, true)).resolves.toBeUndefined();
  });
});

describe('onSettingsChanged', () => {
  // This is what makes the toggle take effect in every open tab without a
  // reload, and it is the whole reason the preference is in chrome.storage
  // rather than pushed at tabs from the popup.
  it('reports the new settings when a declared key changes', async () => {
    const stub = install(fakeChrome());
    const heard = vi.fn();
    onSettingsChanged(heard);

    await stub.storage.local.set({ [KEY]: true });
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());

    expect(heard.mock.calls[0][0]).toMatchObject({ [SETTING.API_NAMES]: true });
  });

  it('ignores a change in another storage area', async () => {
    const stub = install(fakeChrome());
    const heard = vi.fn();
    onSettingsChanged(heard);

    for (const listener of stub.listeners) listener({ [KEY]: { newValue: true } }, 'sync');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard).not.toHaveBeenCalled();
  });

  it('ignores a key the table does not declare', async () => {
    const stub = install(fakeChrome());
    const heard = vi.fn();
    onSettingsChanged(heard);

    await stub.storage.local.set({ 'portal-peeker.somethingElse': true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', async () => {
    const stub = install(fakeChrome());
    const heard = vi.fn();

    onSettingsChanged(heard)();
    expect(stub.listeners).toHaveLength(0);

    await stub.storage.local.set({ [KEY]: true });
    expect(heard).not.toHaveBeenCalled();
  });

  it('returns a usable unsubscribe even with no storage available', () => {
    expect(() => onSettingsChanged(vi.fn())()).not.toThrow();
  });
});
