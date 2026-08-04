// The record page grammar, with no DOM in sight.
//
// Node environment on purpose: everything here is strings in, object out, and
// the DOM layer above it is tested separately in record-properties.test.js.

import { describe, expect, it } from 'vitest';
import {
  NAME_FROM,
  OBJECT_TYPE_FROM,
  SURFACES,
  parseContainerId,
  parsePropertyInputTestId,
  parseRecordPath,
  readRecordRow,
  readSurfaceContainer,
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

describe('parseContainerId', () => {
  it('reads the objectTypeId out of a card id', () => {
    expect(parseContainerId('PROPERTIES_V3/0-1/V2')).toEqual({ ok: true, objectTypeId: '0-1' });
  });

  it('does not require a variant segment', () => {
    expect(parseContainerId('PROPERTIES_LIST/2-98765')).toMatchObject({
      ok: true,
      objectTypeId: '2-98765',
    });
  });

  // Anchored on the \d+-\d+ shape, not on "the segment after the first slash",
  // so an incidental slash cannot invent an object type.
  it('refuses a card id carrying no object type', () => {
    expect(parseContainerId('MARKETING_LEAD_SCORES/summary')).toEqual({
      ok: false,
      reason: 'no-object-type-id',
    });
  });

  it('refuses a non-string', () => {
    expect(parseContainerId(null)).toEqual({ ok: false, reason: 'no-container-id' });
  });
});

describe('readSurfaceContainer', () => {
  it('accepts a card for the object the page is showing', () => {
    expect(
      readSurfaceContainer({ containerId: 'PROPERTIES_V3/0-1/V2', pathname: '/contacts/1/record/0-1/2' }),
    ).toEqual({ ok: true, objectTypeId: '0-1' });
  });

  // The case that matters: a card left in the DOM for a different object, or an
  // SPA navigation caught mid-swap. Nothing inside it may be read.
  it('refuses a card for a different object', () => {
    expect(
      readSurfaceContainer({
        containerId: 'PROPERTIES_V3/2-98765/V2',
        pathname: '/contacts/1/record/0-1/2',
      }),
    ).toEqual({ ok: false, reason: 'object-type-mismatch' });
  });

  it('refuses when the page is not a record page', () => {
    expect(
      readSurfaceContainer({
        containerId: 'PROPERTIES_V3/0-1/V2',
        pathname: '/contacts/1/objects/0-1/views/all/list',
      }),
    ).toMatchObject({ ok: false, reason: 'not-a-record-page' });
  });

  it('refuses with no arguments at all', () => {
    expect(readSurfaceContainer()).toMatchObject({ ok: false });
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
      for (const field of ['id', 'container', 'row', 'rowAttribute', 'prefix', 'nameFrom', 'objectTypeFrom']) {
        expect(typeof surface[field], `${surface.id}.${field}`).toBe('string');
        expect(surface[field], `${surface.id}.${field}`).not.toBe('');
      }
      expect([NAME_FROM.CROSS_CHECK, NAME_FROM.PREFIX]).toContain(surface.nameFrom);
      expect([OBJECT_TYPE_FROM.CONTAINER, OBJECT_TYPE_FROM.PATH]).toContain(surface.objectTypeFrom);
      // Optional, but never something other than a selector when present.
      expect(['string', 'object'], `${surface.id}.anchor`).toContain(typeof surface.anchor);
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

  it('declares a container attribute exactly when it cross-checks the object type', () => {
    for (const surface of SURFACES) {
      const needed = surface.objectTypeFrom === OBJECT_TYPE_FROM.CONTAINER;
      expect(typeof surface.containerAttribute === 'string', `${surface.id}`).toBe(needed);
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
