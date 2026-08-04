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

/** Every name the Key information card yields, in document order. */
const SIDEBAR = [
  'verticalmarket',
  'annualrevenue',
  'hs_lead_status',
  'label-foo',
  'notes_last_contacted',
  'hs_pipeline_stage',
];

/** The highlights strip and the All properties panel, both NAME_FROM.PREFIX. */
const HIGHLIGHTS = ['hs_full_name_or_email', 'jobtitle', 'email'];
const MODAL = ['annualrevenue', 'label-foo', 'hs_email_domain', 'fax'];

const ANNOTATED = [...SIDEBAR, ...HIGHLIGHTS, ...MODAL];

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
    for (const name of SIDEBAR) {
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
    // 5 containers accepted across the three surfaces. Two carry rows: the Key
    // information card and the custom card with the bare numeric id. The rest
    // are the highlight card (which the sidebar surface also matches and finds
    // nothing in), the highlights container, and the All properties panel.
    //
    // The panel's eight rows are four real ones plus the two skeletons and the
    // nested control that only the anchor check turns away.
    expect(annotateRecordProperties(document)).toEqual({
      cards: 5,
      rows: 21,
      inserted: 13,
      skipped: 8,
    });
  });

  // "Must not contradict the URL", not "must declare an object type". Nearly
  // every card on a real client record is a custom one whose id is a bare
  // number, and requiring a declaration skipped all of them.
  it('reads a custom card whose id declares no object type', () => {
    annotateRecordProperties(document);
    expect(names()).toContain('verticalmarket');
  });

  it('still refuses a card that declares a different object', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('wrong_object');
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

// NAME_FROM.PREFIX. These surfaces read one id because it identifies itself:
// rename the prefix and the selector matches nothing, which is a missing line
// rather than a wrong one. That is the guarantee ADR-009 was after, reached by a
// prefix instead of by agreement. See ADR-010.
describe('the surfaces that read one prefixed id', () => {
  it('annotates the All properties panel across its groups', () => {
    annotateRecordProperties(document);
    for (const name of MODAL) expect(names(), name).toContain(name);
  });

  it('annotates the highlights strip', () => {
    annotateRecordProperties(document);
    for (const name of HIGHLIGHTS) expect(names(), name).toContain(name);
  });

  it('strips the prefix by length here too', () => {
    annotateRecordProperties(document);
    const row = document.querySelector('[data-test-id="property-input-label-foo"]');
    expect(anchorIn(row).previousElementSibling.textContent).toBe('label-foo');
  });

  // The strip has no label/value pair to sit between, so the name goes
  // immediately before the value node itself.
  it('places a highlight name before the value node', () => {
    annotateRecordProperties(document);
    const row = document.querySelector('[data-test-id="highlight-property-display-jobtitle"]');
    expect(row.previousElementSibling.className).toBe('pp-api-name');
    expect(row.previousElementSibling.textContent).toBe('jobtitle');
  });

  // highlight-property-item- looks like a second source and is not one: this id
  // is two properties joined. It is never selected on.
  it('never reads the composite highlight-property-item id', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('jobtitle-and-company');
  });

  // The prefix says "a property input". Only the container says "a property
  // input belonging to the record you are looking at".
  it('leaves an association card property-input alone', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('name');
  });

  it('skips a prefixed row with nowhere to put the name', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('no_anchor_modal');
  });

  // Both measured on a live panel. The anchor is what excludes them, which is
  // why it must never become a fallback that puts the name somewhere else.
  it('skips loading placeholders wearing the prefix', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('skeleton');
  });

  it('skips a control nested inside another property row', () => {
    annotateRecordProperties(document);
    expect(names()).not.toContain('phone-button');
    // ...and the row it is nested in is still annotated correctly.
    expect(names()).toContain('fax');
  });

  // The panel declares no object of its own, so the URL is the only statement
  // of which record is on screen. Off a record page it must read nothing.
  it('reads nothing in the panel when the page is not a record', () => {
    at(LIST_URL);
    annotateRecordProperties(document);
    expect(names()).toEqual([]);
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
    expect(names().filter((n) => n === 'swapped_in')).toHaveLength(1);
    // Still one annualrevenue on the page, but it is the All properties row now,
    // not this one. The reused sidebar row was corrected rather than duplicated.
    expect(names().filter((n) => n === 'annualrevenue')).toHaveLength(1);
  });
});

// Seen live on the highlights strip: `jobtitle` printed twice. React re-rendered
// the value node and put the new one AHEAD of the node already placed, so the
// previous-sibling test missed and the next pass inserted a second.
describe('a re-render that moves our node', () => {
  const jobtitle = () => document.querySelector('[data-test-id="highlight-property-display-jobtitle"]');

  it('does not double up when the anchor moves ahead of our node', () => {
    annotateRecordProperties(document);
    const row = jobtitle();
    const ours = row.previousElementSibling;
    expect(ours.className).toBe('pp-api-name');

    // The reorder, in the smallest form that reproduces it.
    row.parentElement.insertBefore(row, ours);
    annotateRecordProperties(document);

    expect(names().filter((n) => n === 'jobtitle')).toHaveLength(1);
    expect(jobtitle().previousElementSibling.className).toBe('pp-api-name');
  });

  it('leaves exactly one behind however many times it happens', () => {
    for (let i = 0; i < 4; i += 1) {
      annotateRecordProperties(document);
      const row = jobtitle();
      row.parentElement.insertBefore(row, row.previousElementSibling);
    }
    annotateRecordProperties(document);
    expect(names().filter((n) => n === 'jobtitle')).toHaveLength(1);
  });
});

describe('removal puts the page back', () => {
  it('takes out every node it added and leaves the page as it found it', () => {
    const before = serialize();

    annotateRecordProperties(document);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(ANNOTATED.length);

    expect(removeApiNames(document)).toBe(ANNOTATED.length);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(0);

    // The inverse property this repo uses on its JSON insertions, applied to the
    // DOM: undo it and you have exactly what you started with. It is what shows
    // only our own nodes were ever added.
    expect(serialize()).toBe(before);
  });
});
