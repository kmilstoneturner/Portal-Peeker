/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://app-x.hubspot.com/contacts/1/objects/0-3/views/all/list" }
 */

// The create-record dialog.
//
// The URL is part of the fixture, and it is deliberately a LIST page. That is
// the whole reason this is a feature of its own rather than an entry in
// SURFACES: the dialog opens over an index, a board, or another object's record,
// and record-properties.js bails on anything without a /record/ segment. A test
// run on a record path would pass without proving that.
//
// Same limit as the other DOM tests here: happy-dom is not React, so no test can
// show that inserting a sibling leaves a real reconciler alone. That risk is
// carried by the additive-only rule in api-name-node.js and by a pass on a live
// portal, and by nothing here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_NAME_SELECTOR, removeApiNames } from '../src/api-name-node.js';
import {
  annotateCreateForm,
  createFormPresent,
  creatorObjectType,
  readFieldName,
} from '../src/create-form.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, '__fixtures__', 'create-form.synthetic.html'), 'utf8');

const load = (html = FIXTURE) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
};

const serialize = () => new XMLSerializer().serializeToString(document.body);
const names = () => [...document.querySelectorAll(API_NAME_SELECTOR)].map((n) => n.textContent);

/** Every field the dialog yields, in document order. */
const ANNOTATED = ['domain', 'label-foo', 'hubspot_owner_id', 'city'];

beforeEach(() => load());

describe('readFieldName', () => {
  it('strips the prefix', () => {
    expect(readFieldName(['property-input-domain'])).toEqual({ ok: true, propertyName: 'domain' });
  });

  // Stripped by length, never by replace or a split on '-'. Both mangle this.
  it('survives a name that repeats the prefix tail', () => {
    expect(readFieldName(['property-input-label-foo'])).toMatchObject({ propertyName: 'label-foo' });
    expect(readFieldName(['property-input-input-40'])).toMatchObject({ propertyName: 'input-40' });
  });

  // The label's own id contains the prefix and is not a name. It is refused for
  // free, because the value has to START with the prefix.
  it('refuses the label id, which merely contains the prefix', () => {
    expect(readFieldName(['FormControl-property-input-input-40'])).toEqual({
      ok: false,
      reason: 'not-a-property-input',
    });
  });

  it('refuses a field with no source', () => {
    expect(readFieldName([])).toEqual({ ok: false, reason: 'no-source' });
    expect(readFieldName(undefined)).toMatchObject({ reason: 'no-source' });
  });

  // Never the first of several. Picking one would be a guess, and the All
  // properties panel proves the nested-control shape is real.
  it('refuses a field holding two prefixed controls', () => {
    expect(readFieldName(['property-input-fax', 'property-input-phone-button'])).toEqual({
      ok: false,
      reason: 'ambiguous-source',
    });
  });

  it('refuses an empty name', () => {
    expect(readFieldName(['property-input-'])).toMatchObject({ reason: 'empty-name' });
  });
});

describe('creatorObjectType', () => {
  it('reads the type out of the editor link', () => {
    expect(creatorObjectType('/object-manager-settings/1/creator-editor/0-2')).toBe('0-2');
  });

  it('reads a custom object type the same way', () => {
    expect(creatorObjectType('/object-manager-settings/1/creator-editor/2-98765')).toBe('2-98765');
  });

  // Absent is a normal answer, not a failure: the link is an admin affordance.
  it('is null when there is no link and when the href says nothing', () => {
    expect(creatorObjectType(null)).toBeNull();
    expect(creatorObjectType('/object-manager-settings/1/other')).toBeNull();
  });
});

describe('createFormPresent', () => {
  it('is true while a create dialog is open', () => {
    expect(createFormPresent(document)).toBe(true);
  });

  it('is false on a page with no dialog', () => {
    load('<p>Some other HubSpot page entirely.</p>');
    expect(createFormPresent(document)).toBe(false);
  });
});

describe('annotateCreateForm', () => {
  // The gate this feature deliberately does not have. The environment URL is a
  // list page, so record-properties.js would refuse the whole document.
  it('annotates on a page that is not a record page', () => {
    expect(annotateCreateForm(document).inserted).toBeGreaterThan(0);
  });

  it('annotates every field it can read, and no others', () => {
    annotateCreateForm(document);
    expect(names()).toEqual(ANNOTATED);
  });

  it('places the name between the label and the control', () => {
    annotateCreateForm(document);
    const anchor = document
      .querySelector('[data-selenium-test="property-input-domain"]')
      .closest('[data-test-id="FormControl"]')
      .querySelector('[data-test-id="hover-content-wrapper"]');

    expect(anchor.previousElementSibling.textContent).toBe('domain');
    expect(anchor.previousElementSibling.getAttribute('data-pp-object-type')).toBe('0-2');
  });

  // A dropdown renders its control as a button with a caret and a typeahead item
  // nested inside. Matched on the attribute alone, never on tag or position.
  it('reads a dropdown field, whose control is a button', () => {
    annotateCreateForm(document);
    expect(names()).toContain('hubspot_owner_id');
  });

  // The whole secondary fieldset renders disabled until a name is typed, which
  // is how the form spends its first seconds. Those are real properties.
  it('reads a disabled field', () => {
    annotateCreateForm(document);
    expect(names()).toContain('city');
  });

  it('never walks a FormControl outside the dialog', () => {
    annotateCreateForm(document);
    expect(names()).not.toContain('outside_dialog');
  });

  it('declines a field with two sources, and not its neighbours', () => {
    annotateCreateForm(document);
    expect(names()).not.toContain('fax');
    expect(names()).not.toContain('phone-button');
    expect(names()).toContain('city');
  });

  it('reports what it did', () => {
    // 7 fields in the dialog, 4 readable. Ambiguous, no-source, and no-anchor
    // are the three skips. The loose FormControl outside is not counted at all,
    // because the container scope means it is never walked.
    expect(annotateCreateForm(document)).toEqual({
      forms: 1,
      fields: 7,
      inserted: 4,
      skipped: 3,
    });
  });

  it('converges after one pass and never doubles up', () => {
    annotateCreateForm(document);
    expect(annotateCreateForm(document).inserted).toBe(0);
    annotateCreateForm(document);
    expect(names()).toEqual(ANNOTATED);
  });

  // A non-admin never sees the editor link. The name comes from a prefixed id
  // that identifies itself, so the annotation is unaffected; only the debug
  // attribute has nothing to say, and an absent fact must be an absent
  // attribute rather than the word "null" on somebody's screen.
  it('still annotates when the object type cannot be read', () => {
    document.querySelector('[data-selenium-test="creator-editor-link"]').remove();
    annotateCreateForm(document);

    expect(names()).toEqual(ANNOTATED);
    for (const node of document.querySelectorAll(API_NAME_SELECTOR)) {
      expect(node.hasAttribute('data-pp-object-type')).toBe(false);
    }
  });

  it('survives a document it cannot walk', () => {
    expect(annotateCreateForm(null)).toEqual({ forms: 0, fields: 0, inserted: 0, skipped: 0 });
  });
});

describe('removal puts the dialog back', () => {
  it('takes out every node it added and leaves the markup as it found it', () => {
    const before = serialize();

    annotateCreateForm(document);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(ANNOTATED.length);

    expect(removeApiNames(document)).toBe(ANNOTATED.length);
    expect(serialize()).toBe(before);
  });
});
