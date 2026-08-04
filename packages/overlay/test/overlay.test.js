// @vitest-environment happy-dom
//
// The host: does turning the setting on annotate, does turning it off clean up,
// and does the observer catch what arrives after the first pass.
//
// overlay.js only bootstraps itself when a real chrome.storage is present, so
// importing it here starts no observer and reaches for no extension API. apply()
// is driven directly instead.
//
// Same limit as property-list.test.js: happy-dom is not React, so none of this
// says anything about how a real reconciler reacts to an inserted sibling.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_NAME_SELECTOR } from '../src/api-name-node.js';
import { apply } from '../src/overlay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(HERE, '__fixtures__', 'properties-table.synthetic.html'),
  'utf8',
);
const RECORD_FIXTURE = readFileSync(
  join(HERE, '__fixtures__', 'record-sidebar.synthetic.html'),
  'utf8',
);

// The default environment URL is not a HubSpot record page, so the record
// feature's present() is false throughout the cases above. The block at the
// bottom of this file is the one that puts it on.
const RECORD_URL = 'https://app-x.hubspot.com/contacts/1/record/0-1/2';
const NOWHERE_URL = 'https://app-x.hubspot.com/property-settings/1/contact';

const load = (html = FIXTURE) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
};

/** Long enough for a scheduled frame plus the pass it triggers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const count = () => document.querySelectorAll(API_NAME_SELECTOR).length;

beforeEach(() => load());
// Every test leaves the host switched off, or the observer outlives its case.
afterEach(() => apply(false));

describe('apply', () => {
  it('annotates the page when switched on', async () => {
    expect(count()).toBe(0);
    apply(true);
    await settle();
    expect(count()).toBe(4);
  });

  it('takes every node back out when switched off', async () => {
    apply(true);
    await settle();
    expect(count()).toBe(4);

    apply(false);
    expect(count()).toBe(0);
  });

  it('does nothing at all while switched off', async () => {
    await settle();
    expect(count()).toBe(0);
  });

  it('is idempotent in both directions', async () => {
    apply(true);
    apply(true);
    await settle();
    expect(count()).toBe(4);

    apply(false);
    expect(() => apply(false)).not.toThrow();
    expect(count()).toBe(0);
  });

  it('survives a page with no properties table', async () => {
    load('<p>Some other HubSpot page entirely.</p>');
    apply(true);
    await settle();
    expect(count()).toBe(0);
  });
});

describe('the observer', () => {
  // Pagination, sorting, searching, and switching object type all arrive as a
  // replaced tbody. This is that, in the smallest form that still exercises it.
  it('annotates rows that arrive after the first pass', async () => {
    apply(true);
    await settle();
    expect(count()).toBe(4);

    const template = document.querySelector('tbody tr').cloneNode(true);
    const cell = template.querySelector('td[data-test-id^="cell-name-"]');
    const tag = template.querySelector('small[data-test-id^="property-type-label-"]');
    // A row the first pass never saw, and with our node stripped out of the
    // clone so this is a genuine insertion rather than a correction.
    template.querySelector(API_NAME_SELECTOR)?.remove();
    cell.setAttribute('data-test-id', 'cell-name-0-1/arrived_later');
    tag.setAttribute('data-test-id', 'property-type-label-arrived_later');
    template
      .querySelector('button[data-test-id^="property-label-"]')
      .setAttribute('data-test-id', 'property-label-arrived_later');

    document.querySelector('tbody').append(template);
    await settle();

    expect(count()).toBe(5);
    expect([...document.querySelectorAll(API_NAME_SELECTOR)].map((n) => n.textContent)).toContain(
      'arrived_later',
    );
  });

  // Our own insertions are mutations and re-enter the observer. The pass is
  // idempotent, so the follow-up finds nothing to do and no third pass happens.
  // If that ever stopped being true this test would hang rather than settle.
  it('converges instead of looping on its own insertions', async () => {
    apply(true);
    await settle();
    const afterFirst = count();

    await settle();
    expect(count()).toBe(afterFirst);
  });

  it('stops observing once switched off', async () => {
    apply(true);
    await settle();
    apply(false);

    const row = document.querySelector('tbody tr').cloneNode(true);
    row.querySelector(API_NAME_SELECTOR)?.remove();
    document.querySelector('tbody').append(row);
    await settle();

    expect(count()).toBe(0);
  });
});

// Two surfaces registered at once. The host is meant to own no page knowledge,
// so what is being checked is that adding a feature costs the first one nothing:
// each still bails on its own, each annotates its own, and one switch clears
// both.
describe('more than one feature', () => {
  const bothPages = () => load(`${FIXTURE}\n${RECORD_FIXTURE}`);

  afterEach(() => window.happyDOM.setURL(NOWHERE_URL));

  it('annotates both surfaces when both are on the page', async () => {
    window.happyDOM.setURL(RECORD_URL);
    bothPages();

    apply(true);
    await settle();

    // 4 from the properties table, 12 across the three record surfaces.
    expect(count()).toBe(16);
  });

  it('takes both back out with one switch', async () => {
    window.happyDOM.setURL(RECORD_URL);
    bothPages();

    apply(true);
    await settle();
    expect(count()).toBe(16);

    apply(false);
    expect(count()).toBe(0);
  });

  // Each feature's present() is its own bail, so a page carrying one surface
  // must not pay for the other and must not be annotated by it.
  it('annotates only the surface that is actually present', async () => {
    window.happyDOM.setURL(NOWHERE_URL);
    bothPages();

    apply(true);
    await settle();

    // The record card is in the DOM, but this is not a record page.
    expect(count()).toBe(4);
  });
});
