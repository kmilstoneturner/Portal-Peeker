import { describe, expect, it } from 'vitest';
import {
  parseCellNameTestId,
  parseLabelTestId,
  parseTypeLabelTestId,
  readPropertyRow,
} from '../src/property-rows.js';

/** The three attributes one healthy row carries. */
const row = (objectTypeId, name, overrides = {}) => ({
  cellNameTestId: `cell-name-${objectTypeId}/${name}`,
  typeLabelTestId: `property-type-label-${name}`,
  labelTestId: `property-label-${name}`,
  ...overrides,
});

describe('parseCellNameTestId splits on the objectTypeId, not on the first slash', () => {
  it('reads a stock contact property', () => {
    expect(parseCellNameTestId('cell-name-0-1/annualrevenue')).toEqual({
      ok: true,
      objectTypeId: '0-1',
      propertyName: 'annualrevenue',
    });
  });

  it('reads a company property', () => {
    expect(parseCellNameTestId('cell-name-0-2/name')).toMatchObject({
      objectTypeId: '0-2',
      propertyName: 'name',
    });
  });

  it('reads a custom object property', () => {
    expect(parseCellNameTestId('cell-name-2-98765/my_custom_prop')).toMatchObject({
      objectTypeId: '2-98765',
      propertyName: 'my_custom_prop',
    });
  });

  // The reason the split is anchored on the objectTypeId's shape rather than on
  // "the first hyphen": a hyphen inside the name is not a delimiter.
  it('keeps a hyphen inside the property name', () => {
    expect(parseCellNameTestId('cell-name-0-1/odd-name')).toMatchObject({
      objectTypeId: '0-1',
      propertyName: 'odd-name',
    });
  });

  // The name half is greedy, so only the objectTypeId's own slash is a split.
  it('keeps a slash inside the property name', () => {
    expect(parseCellNameTestId('cell-name-0-1/weird/name')).toMatchObject({
      objectTypeId: '0-1',
      propertyName: 'weird/name',
    });
  });

  it.each([
    ['not this cell at all', 'cell-fillRate-0-1/annualrevenue', 'not-a-name-cell'],
    ['no objectTypeId', 'cell-name-annualrevenue', 'no-object-type-id'],
    ['objectTypeId but no name', 'cell-name-0-1/', 'no-object-type-id'],
    ['whitespace in the name', 'cell-name-0-1/annual revenue', 'name-has-whitespace'],
  ])('refuses %s', (_label, value, reason) => {
    expect(parseCellNameTestId(value)).toEqual({ ok: false, reason });
  });

  it('refuses a name past the length ceiling', () => {
    const long = 'a'.repeat(513);
    expect(parseCellNameTestId(`cell-name-0-1/${long}`)).toEqual({
      ok: false,
      reason: 'name-too-long',
    });
  });

  // The DOM hands back null for a missing attribute, and a row mid-render can
  // hand back anything. None of it is allowed to throw.
  it.each([null, undefined, 42, '', {}, []])('refuses %o without throwing', (value) => {
    expect(parseCellNameTestId(value)).toMatchObject({ ok: false });
  });
});

describe('prefix stripping is positional, not a replace', () => {
  // A property genuinely named `label-foo` produces `property-label-label-foo`.
  // A global replace or a split on '-' mangles it; slicing by prefix length
  // does not. This is the case that decides how afterPrefix is written.
  it('handles a property named label-foo', () => {
    expect(parseLabelTestId('property-label-label-foo')).toEqual({
      ok: true,
      propertyName: 'label-foo',
    });
    expect(parseTypeLabelTestId('property-type-label-label-foo')).toEqual({
      ok: true,
      propertyName: 'label-foo',
    });
    expect(parseCellNameTestId('cell-name-0-1/label-foo')).toMatchObject({
      propertyName: 'label-foo',
    });
  });

  // property-label- and property-type-label- diverge at index 9, so neither
  // prefix can swallow the other. Asserted rather than assumed, because it
  // stops being true the moment someone renames a constant.
  it('does not let the label prefix match a type label', () => {
    expect(parseLabelTestId('property-type-label-annualrevenue')).toEqual({
      ok: false,
      reason: 'not-a-label',
    });
  });

  it('does not let the type label prefix match a label', () => {
    expect(parseTypeLabelTestId('property-label-annualrevenue')).toEqual({
      ok: false,
      reason: 'not-a-type-label',
    });
  });
});

describe('readPropertyRow requires two sources to agree', () => {
  it('reads a healthy row', () => {
    expect(readPropertyRow(row('0-1', 'annualrevenue'))).toEqual({
      ok: true,
      objectTypeId: '0-1',
      propertyName: 'annualrevenue',
    });
  });

  it('reads a row with underscores', () => {
    expect(readPropertyRow(row('0-1', 'hs_lead_status'))).toMatchObject({
      propertyName: 'hs_lead_status',
    });
  });

  // The headline negative. Two sources that disagree mean the row is not what
  // it looks like, and a name shown confidently would be worse than none.
  it('refuses when the cell and the type tag disagree', () => {
    const mismatched = row('0-1', 'annualrevenue', {
      typeLabelTestId: 'property-type-label-annualrevenue2',
    });
    expect(readPropertyRow(mismatched)).toEqual({ ok: false, reason: 'name-mismatch' });
  });

  it('refuses when the label button disagrees with the other two', () => {
    const mismatched = row('0-1', 'annualrevenue', {
      labelTestId: 'property-label-something_else',
    });
    expect(readPropertyRow(mismatched)).toEqual({ ok: false, reason: 'name-mismatch' });
  });

  // One source is never enough, even when it parses cleanly.
  it('refuses when the type tag is missing entirely', () => {
    expect(readPropertyRow(row('0-1', 'annualrevenue', { typeLabelTestId: null }))).toMatchObject({
      ok: false,
    });
  });

  // The button is corroboration, not a requirement: a read-only property can
  // render its label as something other than a button.
  it('accepts a row with no label button', () => {
    expect(readPropertyRow(row('0-1', 'annualrevenue', { labelTestId: null }))).toMatchObject({
      ok: true,
      propertyName: 'annualrevenue',
    });
  });

  it('accepts a row whose label button is some other element', () => {
    expect(
      readPropertyRow(row('0-1', 'annualrevenue', { labelTestId: 'some-other-thing' })),
    ).toMatchObject({ ok: true });
  });

  it('refuses an empty call without throwing', () => {
    expect(readPropertyRow()).toMatchObject({ ok: false });
  });
});
