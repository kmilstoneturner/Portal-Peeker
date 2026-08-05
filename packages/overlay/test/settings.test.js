import { describe, expect, it } from 'vitest';
import {
  SETTINGS,
  STORAGE_AREA,
  STORAGE_KEYS,
  defaultSettings,
  normalizeSettings,
  storageKeyFor,
} from '../src/settings.js';

describe('the settings table is well formed', () => {
  it('gives every entry the fields the popup and the guard read', () => {
    for (const setting of SETTINGS) {
      expect(typeof setting.id, setting.id).toBe('string');
      expect(typeof setting.key, setting.id).toBe('string');
      expect(typeof setting.input, setting.id).toBe('string');
      expect(typeof setting.label, setting.id).toBe('string');
      expect(typeof setting.note, setting.id).toBe('string');
      expect(typeof setting.default, setting.id).toBe('boolean');
    }
  });

  it('has no duplicate id, key, or input', () => {
    for (const field of ['id', 'key', 'input']) {
      const values = SETTINGS.map((setting) => setting[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  // tools/check-ai-context.mjs counts every <input id="opt-..."> in popup.html
  // and requires the count to match the MODIFICATIONS table. A settings
  // checkbox named opt-anything fails the build with a message about the AI
  // context block, which sends the next person down the wrong trail. The
  // convention is a comment in settings.js; this is the assertion.
  it('never names a checkbox with the opt- prefix, which belongs to export options', () => {
    for (const setting of SETTINGS) {
      expect(setting.input.startsWith('opt-'), setting.id).toBe(false);
      expect(setting.input.startsWith('set-'), setting.id).toBe(true);
    }
  });

  it('namespaces every storage key', () => {
    for (const setting of SETTINGS) {
      expect(setting.key.startsWith('portal-peeker.'), setting.id).toBe(true);
    }
  });

  it('lists a storage key for every entry', () => {
    expect(STORAGE_KEYS).toEqual(SETTINGS.map((setting) => setting.key));
  });

  // sync would replicate settings through Google's servers, which falsifies
  // PRIVACY.md's "What leaves your computer" section. tools/check-settings.mjs
  // enforces this against the built bundle; this pins the declaration itself.
  it('stores settings locally, never through sync', () => {
    expect(STORAGE_AREA).toBe('local');
  });
});

describe('normalizeSettings', () => {
  it('falls back to the declared defaults when storage is empty', () => {
    expect(normalizeSettings({})).toEqual(defaultSettings());
  });

  it.each([null, undefined, 'nonsense', 42, []])(
    'falls back to defaults for %o without throwing',
    (stored) => {
      expect(normalizeSettings(stored)).toEqual(defaultSettings());
    },
  );

  it('takes an explicit boolean over the default', () => {
    for (const setting of SETTINGS) {
      const flipped = normalizeSettings({ [setting.key]: !setting.default });
      expect(flipped[setting.id], setting.id).toBe(!setting.default);
    }
  });

  // A stored 'false' read as truthy would silently switch a feature on, and an
  // older build is exactly where a wrong type comes from. Anything that is not
  // a boolean is treated as absent rather than coerced.
  it.each(['true', 'false', 0, 1, null, {}])('treats the non-boolean %o as absent', (value) => {
    const setting = SETTINGS[0];
    expect(normalizeSettings({ [setting.key]: value })[setting.id]).toBe(setting.default);
  });

  it('ignores keys nothing declares', () => {
    expect(normalizeSettings({ 'portal-peeker.somethingElse': true })).toEqual(defaultSettings());
  });
});

describe('storageKeyFor', () => {
  it('resolves every declared id', () => {
    for (const setting of SETTINGS) expect(storageKeyFor(setting.id)).toBe(setting.key);
  });

  it('returns null for an id nothing declares', () => {
    expect(storageKeyFor('notASetting')).toBeNull();
  });
});
