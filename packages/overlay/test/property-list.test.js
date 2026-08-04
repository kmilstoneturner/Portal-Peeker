// @vitest-environment happy-dom
//
// The only test file in the repo that needs a DOM, so the environment is set
// here rather than in a config file. packages/core and packages/capture stay on
// the node environment and pay nothing for this.
//
// The fixture is parsed with DOMParser and adopted, and comparisons serialize
// through XMLSerializer. Neither this file nor anything it tests ever assigns
// markup from a string.
//
// What this cannot cover: happy-dom is not React. No DOM test can show that
// inserting a sibling does not upset a real reconciler. That risk is carried by
// the additive-only rule in api-name-node.js and by the manual pass on a live
// portal, and by nothing here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_NAME_SELECTOR, removeApiNames } from '../src/api-name-node.js';
import { annotatePropertyList, propertyTablePresent } from '../src/property-list.js';

// Resolved without `new URL`: happy-dom installs its own URL global, and
// resolving a relative path against import.meta.url through it does not yield
// something fileURLToPath will take.
const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURE = readFileSync(
  join(HERE, '__fixtures__', 'properties-table.synthetic.html'),
  'utf8',
);

const load = (html = FIXTURE) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
};

/** A stable string for the whole page, for the undo comparison. */
const serialize = () => new XMLSerializer().serializeToString(document.body);

const names = () => [...document.querySelectorAll(API_NAME_SELECTOR)].map((n) => n.textContent);

const cellFor = (testId) => document.querySelector(`td[data-test-id="${testId}"]`);
const tagIn = (cell) => cell.querySelector('small[data-test-id^="property-type-label-"]');

beforeEach(() => load());

describe('annotatePropertyList marks up the rows it can read', () => {
  it('annotates every row whose sources agree, and no others', () => {
    annotatePropertyList(document);
    expect(names()).toEqual(['annualrevenue', 'hs_lead_status', 'my_custom_prop', 'label-foo']);
  });

  // The whole point of the feature: the name sits between the label and the
  // field type, not appended somewhere convenient.
  it('places the name immediately before the field type tag', () => {
    annotatePropertyList(document);
    for (const testId of ['cell-name-0-1/annualrevenue', 'cell-name-0-1/hs_lead_status']) {
      const tag = tagIn(cellFor(testId));
      expect(tag.previousElementSibling.className, testId).toBe('pp-api-name');
    }
  });

  it('carries the objectTypeId on its own node without rendering it', () => {
    annotatePropertyList(document);
    const node = tagIn(cellFor('cell-name-2-98765/my_custom_prop')).previousElementSibling;
    expect(node.getAttribute('data-pp-object-type')).toBe('2-98765');
    expect(node.textContent).toBe('my_custom_prop');
  });

  it('reports what it did', () => {
    expect(annotatePropertyList(document)).toEqual({ rows: 7, inserted: 4, skipped: 3 });
  });
});

describe('rows it must not touch', () => {
  // Per row, not per page. A table row with no API name under it is visibly
  // missing and cannot mislead; the rows either side of it are still correct.
  it('skips a row whose two sources disagree, and still annotates its neighbours', () => {
    annotatePropertyList(document);

    // The tag always has a previous sibling: the div holding the label button.
    // What must not be there is one of ours, which is also why placeApiName
    // tests the class rather than trusting position.
    const before = tagIn(cellFor('cell-name-0-1/mismatch_a')).previousElementSibling;
    expect(before.className).not.toBe('pp-api-name');
    expect(names()).not.toContain('mismatch_a');
    expect(names()).not.toContain('mismatch_b');

    expect(names()).toContain('my_custom_prop');
    expect(names()).toContain('label-foo');
  });

  it('skips a row with no field type tag without throwing', () => {
    expect(() => annotatePropertyList(document)).not.toThrow();
    expect(names()).not.toContain('orphan');
  });

  it('skips a name cell carrying no objectTypeId', () => {
    annotatePropertyList(document);
    expect(names()).not.toContain('broken');
  });

  it('does nothing on a page with no properties table', () => {
    load('<p>Some other HubSpot page entirely.</p>');
    expect(propertyTablePresent(document)).toBe(false);
    expect(annotatePropertyList(document)).toMatchObject({ rows: 0, inserted: 0 });
    expect(names()).toEqual([]);
  });

  // Exact attribute match, not a prefix. A differently named table is a
  // different component and none of this grammar is promised to hold there.
  it('ignores a table whose test id merely starts the same way', () => {
    load(FIXTURE.replace('data-test-id="properties-table"', 'data-test-id="properties-table-v2"'));
    expect(propertyTablePresent(document)).toBe(false);
    annotatePropertyList(document);
    expect(names()).toEqual([]);
  });
});

describe('running more than once', () => {
  it('inserts nothing the second time', () => {
    annotatePropertyList(document);
    const first = document.querySelectorAll(API_NAME_SELECTOR).length;

    const second = annotatePropertyList(document);
    expect(second.inserted).toBe(0);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(first);
  });

  // React reuses row elements across renders. If rows are keyed by position,
  // the same <tr> serves a different property on page 2. Marking the row would
  // suppress the annotation on whatever replaced it; reading our own node
  // corrects it instead. This is the case that decided the design.
  it('corrects a node whose row was reused for a different property', () => {
    annotatePropertyList(document);

    const cell = cellFor('cell-name-0-1/annualrevenue');
    const tag = tagIn(cell);
    cell.setAttribute('data-test-id', 'cell-name-0-1/paged_in_name');
    tag.setAttribute('data-test-id', 'property-type-label-paged_in_name');
    cell
      .querySelector('button[data-test-id^="property-label-"]')
      .setAttribute('data-test-id', 'property-label-paged_in_name');

    const result = annotatePropertyList(document);

    expect(result.inserted).toBe(0);
    expect(tag.previousElementSibling.textContent).toBe('paged_in_name');
    expect(names().filter((n) => n === 'paged_in_name')).toHaveLength(1);
    expect(names()).not.toContain('annualrevenue');
  });

  it('handles rows appearing after the first pass', () => {
    annotatePropertyList(document);
    const body = document.querySelector('tbody');
    const first = document.querySelector('tbody tr');
    body.append(first.cloneNode(true));

    // The clone arrives carrying a copy of an already placed node, so it is
    // corrected rather than doubled. That is the same path a re-render takes.
    expect(() => annotatePropertyList(document)).not.toThrow();
    expect(names().filter((n) => n === 'annualrevenue')).toHaveLength(2);
  });
});

describe('removal puts the page back', () => {
  it('takes out every node it added and leaves the page as it found it', () => {
    const before = serialize();

    annotatePropertyList(document);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(4);

    expect(removeApiNames(document)).toBe(4);
    expect(document.querySelectorAll(API_NAME_SELECTOR).length).toBe(0);

    // The inverse property this repo already uses on the JSON insertions: undo
    // it and you have exactly what you started with. It is what proves we
    // removed only our own nodes and touched nothing of HubSpot's.
    expect(serialize()).toBe(before);
  });

  it('is safe to call when nothing was ever added', () => {
    expect(removeApiNames(document)).toBe(0);
  });
});
