// The record page grammar, with no DOM in sight.
//
// Node environment on purpose: everything here is strings in, object out, and
// the DOM layer above it is tested separately in record-properties.test.js.

import { describe, expect, it } from 'vitest';
import {
  NAME_FROM,
  SURFACES,
  parsePropertyInputTestId,
  parseRecordPath,
  readRecordRow,
} from '../src/record-surfaces.js';

describe('parseRecordPath', () => {
  it('reads the objectTypeId out of a record path', () => {
    expect(parseRecordPath('/contacts/1/record/0-1/2')).toEqual({ ok: true, objectTypeId: '0-1' });
  });

  // The object type is a path segment, which is the whole reason one match
  // pattern covers stock and custom objects alike.
  it('reads a custom object type the same way', () => {
    expect(parseRecordPath('/contacts/1/record/2-98765/2')).toMatchObject({
      ok: true,
      objectTypeId: '2-98765',
    });
  });

  it('tolerates a path that ends at the object type', () => {
    expect(parseRecordPath('/contacts/1/record/0-1')).toMatchObject({ ok: true });
  });

  // The same match pattern loads the content script on CRM list pages. They must
  // read as "not a record page" rather than as an unrecognised one.
  it('refuses a list page', () => {
    expect(parseRecordPath('/contacts/1/objects/0-1/views/all/list')).toEqual({
      ok: false,
      reason: 'not-a-record-page',
    });
  });

  it('refuses a non-string', () => {
    expect(parseRecordPath(undefined)).toEqual({ ok: false, reason: 'no-path' });
  });
});

describe('parsePropertyInputTestId', () => {
  it('strips the prefix', () => {
    expect(parsePropertyInputTestId('property-input-lifecyclestage')).toEqual({
      ok: true,
      propertyName: 'lifecyclestage',
    });
  });

  // The prefix trap, and the reason test-id.js strips by length rather than
  // replacing or splitting on '-'. Both of these mangle under either.
  it('survives a property whose name repeats the prefix tail', () => {
    expect(parsePropertyInputTestId('property-input-input-240')).toMatchObject({
      ok: true,
      propertyName: 'input-240',
    });
    expect(parsePropertyInputTestId('property-input-label-foo')).toMatchObject({
      ok: true,
      propertyName: 'label-foo',
    });
  });

  it('refuses an id that is not a property input', () => {
    expect(parsePropertyInputTestId('QuickFiltersBar-item-hubspot_owner_id')).toEqual({
      ok: false,
      reason: 'not-a-property-input',
    });
    expect(parsePropertyInputTestId('create-engagement-email-button')).toMatchObject({
      ok: false,
      reason: 'not-a-property-input',
    });
  });

  it('refuses an empty name and a missing id', () => {
    expect(parsePropertyInputTestId('property-input-')).toMatchObject({ reason: 'empty-name' });
    expect(parsePropertyInputTestId(null)).toMatchObject({ reason: 'not-a-property-input' });
  });
});

describe('readRecordRow', () => {
  it('accepts two sources that agree', () => {
    expect(
      readRecordRow({ rowTestId: 'annualrevenue', inputTestId: 'property-input-annualrevenue' }),
    ).toEqual({ ok: true, propertyName: 'annualrevenue' });
  });

  it('accepts a hyphenated name, which is why no shape rule can be used', () => {
    expect(
      readRecordRow({ rowTestId: 'label-foo', inputTestId: 'property-input-label-foo' }),
    ).toMatchObject({ ok: true, propertyName: 'label-foo' });
  });

  it('refuses two sources that disagree', () => {
    expect(
      readRecordRow({ rowTestId: 'mismatch_a', inputTestId: 'property-input-mismatch_b' }),
    ).toEqual({ ok: false, reason: 'name-mismatch' });
  });

  // The owner case, seen live: a real property whose control renders no
  // property-input node. Both sources are required, so this is a skip.
  it('refuses a row with no second source', () => {
    expect(readRecordRow({ rowTestId: 'hubspot_owner_id', inputTestId: null })).toMatchObject({
      ok: false,
      reason: 'not-a-property-input',
    });
  });

  it('refuses a row with no name of its own', () => {
    expect(readRecordRow({ inputTestId: 'property-input-x' })).toEqual({
      ok: false,
      reason: 'no-row-name',
    });
    expect(readRecordRow()).toMatchObject({ ok: false, reason: 'no-row-name' });
  });

  it('refuses an implausible row name before comparing anything', () => {
    expect(readRecordRow({ rowTestId: 'has space', inputTestId: 'property-input-has space' })).toEqual(
      { ok: false, reason: 'name-has-whitespace' },
    );
  });
});

describe('the SURFACES table', () => {
  it('declares the fields every surface needs', () => {
    for (const surface of SURFACES) {
      for (const field of ['id', 'container', 'row', 'nameFrom']) {
        expect(typeof surface[field], `${surface.id}.${field}`).toBe('string');
        expect(surface[field], `${surface.id}.${field}`).not.toBe('');
      }
      expect(Object.values(NAME_FROM), surface.id).toContain(surface.nameFrom);
      // Optional, but never something other than a selector when present.
      expect(['string', 'object'], `${surface.id}.anchor`).toContain(typeof surface.anchor);
    }
  });

  // A label surface reads no id at all, so declaring one would mean a reader
  // that silently prefers an attribute over the lookup. It owes a label
  // selector instead, and owes nothing else.
  it('makes label surfaces read a label and no id', () => {
    for (const surface of SURFACES.filter((s) => s.nameFrom === NAME_FROM.LABEL)) {
      expect(typeof surface.label, `${surface.id}.label`).toBe('string');
      expect(surface.rowAttribute, `${surface.id}.rowAttribute`).toBeUndefined();
      expect(surface.prefix, `${surface.id}.prefix`).toBeUndefined();
      expect(surface.source, `${surface.id}.source`).toBeUndefined();
    }
  });

  // The converse: a surface that reads an id must not also carry a label
  // selector, or which one wins becomes a question nobody can answer from the
  // table.
  it('keeps id surfaces free of a label selector', () => {
    for (const surface of SURFACES.filter((s) => s.nameFrom !== NAME_FROM.LABEL)) {
      expect(typeof surface.rowAttribute, `${surface.id}.rowAttribute`).toBe('string');
      expect(typeof surface.prefix, `${surface.id}.prefix`).toBe('string');
      expect(surface.label, `${surface.id}.label`).toBeUndefined();
    }
  });

  // A cross-check surface reads a BARE row id, which identifies nothing on its
  // own, so it owes the extra apparatus: a second source to agree with, a list
  // to be a direct child of, and a per-row marker. A prefixed surface owes none
  // of it, because its id says what it is. Getting this backwards in the table
  // is how a bare name would quietly ship on one source.
  it('makes cross-check surfaces carry the structure their bare id needs', () => {
    for (const surface of SURFACES.filter((s) => s.nameFrom === NAME_FROM.CROSS_CHECK)) {
      for (const field of ['list', 'rowMarker', 'source', 'sourceAttribute']) {
        expect(typeof surface[field], `${surface.id}.${field}`).toBe('string');
      }
      expect(surface.row, `${surface.id}.row`).toMatch(/^:scope >/);
      expect(surface.rowMarker, `${surface.id}.rowMarker`).toMatch(/^:scope >/);
    }
  });

  // The converse, and the one that matters most: a surface reading a single id
  // must be reading a PREFIXED one. A prefix that did not end in a separator, or
  // a row selector matching bare ids, would put this surface back in the
  // position the Key information card is deliberately not in.
  it('makes every single-source surface read a prefixed id', () => {
    for (const surface of SURFACES.filter((s) => s.nameFrom === NAME_FROM.PREFIX)) {
      expect(surface.prefix, `${surface.id}.prefix`).toMatch(/-$/);
      expect(surface.row, `${surface.id}.row`).toContain(`^="${surface.prefix}"`);
      expect(surface.source, `${surface.id}.source`).toBeUndefined();
    }
  });


  it('gives every surface a distinct id', () => {
    const ids = SURFACES.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Class names on HubSpot's pages are styled-components hashes that change on
  // every build. Selecting on one is a feature that breaks silently, so the ban
  // is asserted rather than trusted to review.
  it('never selects on a class', () => {
    for (const surface of SURFACES) {
      for (const [field, value] of Object.entries(surface)) {
        if (typeof value !== 'string') continue;
        expect(value, `${surface.id}.${field}`).not.toMatch(/\.[A-Za-z_-]/);
      }
    }
  });

});
