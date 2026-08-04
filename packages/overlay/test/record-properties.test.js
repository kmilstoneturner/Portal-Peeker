/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://app-x.hubspot.com/contacts/1/record/0-1/2" }
 */

// The record page DOM layer.
//
// The URL is part of the fixture here, not decoration: a card is only read when
// the objectTypeId it declares matches the one in the path, so the environment
// has to be on a record page for any of this to happen at all.
//
// The fixture is parsed with DOMParser and adopted, and comparisons serialize
// through XMLSerializer. Neither this file nor anything it tests ever assigns
// markup from a string.
//
// Same limit as property-list.test.js: happy-dom is not React. No DOM test can
// show that inserting a sibling leaves a real reconciler alone. That risk is
// carried by the additive-only rule in api-name-node.js and by the manual pass
// on a live portal, and by nothing here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_NAME_SELECTOR, removeApiNames } from '../src/api-name-node.js';
import { annotateRecordProperties, recordSurfacesPresent } from '../src/record-properties.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, '__fixtures__', 'record-sidebar.synthetic.html'), 'utf8');

const RECORD_URL = 'https://app-x.hubspot.com/contacts/1/record/0-1/2';
const LIST_URL = 'https://app-x.hubspot.com/contacts/1/objects/0-1/views/all/list';

const load = (html = FIXTURE) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
};

const at = (url) => window.happyDOM.setURL(url);

const serialize = () => new XMLSerializer().serializeToString(document.body);
const names = () => [...document.querySelectorAll(API_NAME_SELECTOR)].map((n) => n.textContent);
const rowFor = (name) => document.querySelector(`span[data-test-id="${name}"]`);
const anchorIn = (row) => row.querySelector('[data-test-id="hover-content-wrapper"]');

/** Every name the fixture is built to yield, in document order. */
const ANNOTATED = [
  'annualrevenue',
  'hs_lead_status',
  'label-foo',
  'notes_last_contacted',
  'hs_pipeline_stage',
];

beforeEach(() => {
  at(RECORD_URL);
  load();
});

describe('recordSurfacesPresent', () => {
  it('is true on a record page showing a properties card', () => {
    expect(recordSurfacesPresent(document)).toBe(true);
  });

  // The same match pattern loads this script on every CRM list page. The path
  // test is the first thing present() does, so a list page costs one regex.
  it('is false on a list page, before touching the DOM', () => {
    at(LIST_URL);
    expect(recordSurfacesPresent(document)).toBe(false);
  });

  it('is false on a record page with no properties card', () => {
    load('<p>Some other HubSpot page entirely.</p>');
    expect(recordSurfacesPresent(document)).toBe(false);
  });
});

describe('annotateRecordProperties marks up the rows it can read', () => {
  it('annotates every row whose sources agree, and no others', () => {
    annotateRecordProperties(document);
    expect(names()).toEqual(ANNOTATED);
  });

  it('places the name immediately before the anchor, between label and value', () => {
    annotateRecordProperties(document);
    for (const name of ANNOTATED) {
      const anchor = anchorIn(rowFor(name));
      expect(anchor.previousElementSibling.className, name).toBe('pp-api-name');
      expect(anchor.previousElementSibling.textContent, name).toBe(name);
    }
  });

  it('carries the card objectTypeId on its own node without rendering it', () => {
    annotateRecordProperties(document);
    const node = anchorIn(rowFor('annualrevenue')).previousElementSibling;
    expect(node.getAttribute('data-pp-object-type')).toBe('0-1');
    expect(node.textContent).toBe('annualrevenue');
  });

  it('reports what it did', () => {
    expect(annotateRecordProperties(document)).toEqual({
      cards: 1,
      rows: 9,
      inserted: 5,
      skipped: 4,
    });
  });

  it('annotates a read-only row like any other', () => {
    annotateRecordProperties(document);
    expect(names()).toContain('notes_last_contacted');
  });

  // Display mode puts the second source on a span; input mode moves it to a
  // button one layer deeper, under an extra wrapper. Matched by attribute only.
  it('annotates a row that is being edited', () => {
    annotateRecordProperties(document);
    expect(names()).toContain('hs_pipeline_stage');
  });
});

describe('rows and nodes it must not touch', () => {
  // The case the live page produced: badge and dropdown-caret are nested inside
  // a property's own value. A subtree query would offer both as rows, and no
  // character-shape rule could reject them, because label-foo proves property
  // names may be hyphenated.
  it('never treats a nested test id as a property row', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('badge');
    expect(names()).not.toContain('dropdown-caret');
    expect(names()).not.toContain('hover-content-wrapper');
  });

  it('leaves nav chrome alone even though it is shaped like a property', () => {
    annotateRecordProperties(document);
    for (const decoy of ['deals', 'contacts', 'tasks']) {
      expect(names()).not.toContain(decoy);
    }
  });

  it('leaves the engagement buttons and the timeline filter alone', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('create-engagement-email');
    expect(names()).not.toContain('activity-button-icon-email');
    expect(names()).not.toContain('hubspot_owner_id');
  });

  it('skips a row whose two sources disagree, and still annotates its neighbours', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('mismatch_a');
    expect(names()).not.toContain('mismatch_b');
    expect(names()).toContain('label-foo');
    expect(names()).toContain('notes_last_contacted');
  });

  it('skips a row carrying no per-row marker', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('no_marker');
  });

  it('skips a readable row with nowhere to put the name', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('no_anchor');
  });

  // Withdrawal is per row everywhere except here. Being the right card is what
  // makes a bare name inside it trustworthy, so a card for another object has no
  // weaker reading to fall back on.
  it('skips a whole card whose objectTypeId disagrees with the URL', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('wrong_object');
  });

  it('never walks a properties list with no card above it', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('outside_card');
  });

  it('does nothing at all on a list page', () => {
    at(LIST_URL);
    expect(annotateRecordProperties(document)).toMatchObject({ cards: 0, rows: 0, inserted: 0 });
    expect(names()).toEqual([]);
  });
});

describe('running more than once', () => {
  it('inserts nothing the second time', () => {
    annotateRecordProperties(document);
    const first = document.querySelectorAll(API_NAME_SELECTOR).length;

    expect(annotateRecordProperties(document).inserted).toBe(0);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(first);
  });

  // React reuses row elements across renders. Reading our own node rather than
  // marking HubSpot's is what makes the pass self-correcting when a reused row
  // comes back holding a different property.
  it('corrects a node whose row was reused for a different property', () => {
    annotateRecordProperties(document);

    const row = rowFor('annualrevenue');
    row.setAttribute('data-test-id', 'swapped_in');
    row
      .querySelector('[data-selenium-test^="property-input-"]')
      .setAttribute('data-selenium-test', 'property-input-swapped_in');

    expect(annotateRecordProperties(document).inserted).toBe(0);
    expect(anchorIn(row).previousElementSibling.textContent).toBe('swapped_in');
    expect(names()).not.toContain('annualrevenue');
    expect(names().filter((n) => n === 'swapped_in')).toHaveLength(1);
  });
});

describe('removal puts the page back', () => {
  it('takes out every node it added and leaves the page as it found it', () => {
    const before = serialize();

    annotateRecordProperties(document);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(5);

    expect(removeApiNames(document)).toBe(5);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(0);

    // The inverse property this repo uses on its JSON insertions, applied to the
    // DOM: undo it and you have exactly what you started with. It is what shows
    // only our own nodes were ever added.
    expect(serialize()).toBe(before);
  });
});
