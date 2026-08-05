// The label index, with no DOM in sight.
//
// The response shape here is the real one, reduced: an array of groups, each
// with propertyDefinitions, each of those wrapping the property one level down.
// Nothing in this file came from a portal. Names and labels are synthetic except
// where a HubSpot-defined one is the point of the case.

import { describe, expect, it } from 'vitest';
import { labelKey, lookupPropertyName, parsePropertyNames } from '../src/property-names.js';

const body = (groups) => JSON.stringify(groups);

const group = (...properties) => ({
  name: 'contactinformation',
  propertyDefinitions: properties.map((property) => ({ property })),
});

const SAMPLE = body([
  group(
    { name: 'company', label: 'Company Name', type: 'string' },
    { name: 'city', label: 'City', type: 'string' },
    { name: 'zip', label: 'Postal Code', type: 'string' },
  ),
  group(
    { name: 'email', label: 'Email', type: 'string' },
    // The one real duplicate observed live: two properties, one label.
    { name: 'hs_bounce_a', label: 'Email hard bounce reason', type: 'string' },
    { name: 'hs_bounce_b', label: 'Email hard bounce reason', type: 'string' },
  ),
]);

const indexOf = (text = SAMPLE) => {
  const parsed = parsePropertyNames(text);
  expect(parsed.ok).toBe(true);
  return parsed.index;
};

describe('labelKey', () => {
  it('folds case and collapses whitespace', () => {
    expect(labelKey('Company Name')).toBe('company name');
    expect(labelKey('  Postal   Code ')).toBe('postal code');
  });

  it('refuses a label with nothing in it', () => {
    expect(labelKey('   ')).toBeNull();
    expect(labelKey(null)).toBeNull();
  });
});

describe('parsePropertyNames', () => {
  it('indexes every property it can read', () => {
    const parsed = parsePropertyNames(SAMPLE);
    expect(parsed.ok).toBe(true);
    expect(parsed.properties).toBe(6);
  });

  it('tolerates a results envelope', () => {
    const wrapped = JSON.stringify({ results: JSON.parse(SAMPLE) });
    expect(parsePropertyNames(wrapped)).toMatchObject({ ok: true, properties: 6 });
  });

  it('skips a definition missing a name or a label', () => {
    const parsed = parsePropertyNames(body([group({ name: 'ok', label: 'Ok' }, { name: 'no_label' }, { label: 'No Name' })]));
    expect(parsed).toMatchObject({ ok: true, properties: 1 });
  });

  // The same plausibility rules the rest of the package uses. A name with a
  // space in it is not a name, wherever it arrived from.
  it('skips an implausible name', () => {
    const parsed = parsePropertyNames(body([group({ name: 'fine', label: 'Fine' }, { name: 'has space', label: 'Spaced' })]));
    expect(parsed.ok).toBe(true);
    expect(lookupPropertyName(parsed.index, 'Spaced')).toMatchObject({ ok: false });
  });

  it('refuses a body it cannot read', () => {
    expect(parsePropertyNames('')).toEqual({ ok: false, reason: 'empty-body' });
    expect(parsePropertyNames('not json')).toEqual({ ok: false, reason: 'not-json' });
    expect(parsePropertyNames('{"nope":1}')).toEqual({ ok: false, reason: 'unrecognized-shape' });
  });

  // A response that parses to nothing is a shape change, not an empty portal.
  it('refuses a response carrying no properties at all', () => {
    expect(parsePropertyNames(body([group()]))).toEqual({ ok: false, reason: 'no-properties' });
  });
});

describe('lookupPropertyName', () => {
  it('resolves a label that matches exactly', () => {
    expect(lookupPropertyName(indexOf(), 'City')).toEqual({ ok: true, propertyName: 'city' });
  });

  // The case that decided the design. The card renders "Company name" while the
  // property is labelled "Company Name". Exact matching resolved 3 of 6 rows on
  // a live card; folding case resolved 6 of 6.
  it('resolves a label whose casing differs from the property label', () => {
    expect(lookupPropertyName(indexOf(), 'Company name')).toMatchObject({ propertyName: 'company' });
    expect(lookupPropertyName(indexOf(), 'postal code')).toMatchObject({ propertyName: 'zip' });
  });

  // The whole reason one source is enough here. Two properties sharing a label
  // is a row declined, never a name picked.
  it('refuses a label two properties share', () => {
    expect(lookupPropertyName(indexOf(), 'Email hard bounce reason')).toEqual({
      ok: false,
      reason: 'label-ambiguous',
    });
  });

  it('refuses a label no property carries', () => {
    expect(lookupPropertyName(indexOf(), 'Not A Real Label')).toEqual({
      ok: false,
      reason: 'label-not-found',
    });
  });

  it('refuses with no index and with no label', () => {
    expect(lookupPropertyName(null, 'City')).toEqual({ ok: false, reason: 'no-index' });
    expect(lookupPropertyName(indexOf(), '  ')).toEqual({ ok: false, reason: 'empty-label' });
  });

  // Two entries sharing a label must not poison a third that does not.
  it('leaves unambiguous labels alone when another is ambiguous', () => {
    expect(lookupPropertyName(indexOf(), 'Email')).toMatchObject({ ok: true, propertyName: 'email' });
  });
});
