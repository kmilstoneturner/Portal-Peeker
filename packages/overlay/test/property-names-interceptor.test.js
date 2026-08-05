/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://app-x.hubspot.com/contacts/1/record/0-1/2" }
 */

// The MAIN-world interceptor, and specifically the thing that makes it
// acceptable: it sends nothing until asked.
//
// The setting is off by default, and the overlay only asks once it is on. So on
// a record page belonging to a user who never enabled the feature, no response
// crosses the world boundary at all. That is a privacy claim in PRIVACY.md, not
// an implementation detail, so it is pinned here.
//
// window.fetch is replaced BEFORE the module is imported, because the module
// captures the native reference at import time. That is the same reason it has
// to be a document_start script in the browser.

import { beforeAll, describe, expect, it } from 'vitest';
import { PROPERTY_NAMES_CHANNEL, PROPERTY_NAMES_MSG } from '../src/property-names-protocol.js';

const PROPERTIES_URL = '/api/properties/v4/groups/0-1/properties?portalId=1';
const BODY = JSON.stringify([
  { name: 'g', propertyDefinitions: [{ property: { name: 'city', label: 'City' } }] },
]);

/** Just enough Response for the interceptor: ok, and a clonable body. */
const fakeResponse = (body = BODY) => ({
  ok: true,
  clone: () => ({ text: () => Promise.resolve(body) }),
});

const sent = [];

beforeAll(async () => {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.channel === PROPERTY_NAMES_CHANNEL && data.type === PROPERTY_NAMES_MSG.LOADED) {
      sent.push(data);
    }
  });

  window.fetch = () => Promise.resolve(fakeResponse());
  await import('../src/property-names-interceptor.js');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const ask = () =>
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { channel: PROPERTY_NAMES_CHANNEL, type: PROPERTY_NAMES_MSG.REQUEST },
    }),
  );

describe('before anyone asks', () => {
  it('sends nothing, even after seeing the response', async () => {
    await window.fetch(PROPERTIES_URL);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('ignores a URL that is not the properties endpoint', async () => {
    await window.fetch('/api/crm/v3/objects/contacts/1');
    await settle();
    expect(sent).toHaveLength(0);
  });

  // The live sequence, and the order matters. The setting is read
  // asynchronously at document_idle, so the ask can land after several of these
  // responses have already arrived: on a deal record, 0-3 finished at 609ms and
  // 0-4 at 3719ms. Everything seen in that window has to still be there when the
  // ask finally comes.
  it('holds every object type it sees, not just the most recent', async () => {
    await window.fetch('/api/properties/v4/groups/0-3/properties');
    await settle();
    await window.fetch('/api/properties/v4/groups/0-4/properties');
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe('once asked', () => {
  // All three, because holding one slot is what put an index for line items in
  // front of a page showing a deal, and took every label surface with it. It
  // failed safe and so failed silently, which is the worst way to find out.
  it('flushes everything it already held', async () => {
    ask();
    await settle();
    expect(sent.map((message) => message.objectTypeId)).toEqual(['0-1', '0-3', '0-4']);
    expect(sent[0]).toMatchObject({ objectTypeId: '0-1', body: BODY });
  });

  it('sends what arrives afterwards too', async () => {
    const before = sent.length;
    await window.fetch(PROPERTIES_URL);
    await settle();
    expect(sent.length).toBe(before + 1);
  });

  // The objectTypeId is carried so a contact's labels can never resolve a
  // company's rows. The store checks it; the interceptor has to supply it.
  it('carries the objectTypeId from the path', async () => {
    await window.fetch('/api/properties/v4/groups/2-98765/properties');
    await settle();
    expect(sent[sent.length - 1].objectTypeId).toBe('2-98765');
  });

  it('keeps sending each type as it arrives, once the ask has been made', async () => {
    const before = sent.length;
    await window.fetch('/api/properties/v4/groups/0-5/properties');
    await settle();
    await window.fetch('/api/properties/v4/groups/0-7/properties');
    await settle();

    expect(sent.slice(before).map((message) => message.objectTypeId)).toEqual(['0-5', '0-7']);
  });

  it('still ignores everything that is not the properties endpoint', async () => {
    const before = sent.length;
    await window.fetch('/api/properties/v4/groups/0-1/other');
    await window.fetch('/some/page');
    await settle();
    expect(sent.length).toBe(before);
  });
});

describe('what it hands back to the page', () => {
  // A hook that changes what the caller sees is a broken CRM, not an inspector.
  it('returns the original response untouched', async () => {
    const result = await window.fetch(PROPERTIES_URL);
    expect(result.ok).toBe(true);
    expect(await result.clone().text()).toBe(BODY);
  });

  it('survives a response it cannot read', async () => {
    const previous = window.fetch;
    // The patched fetch wraps whatever it was given; make the inner one hostile.
    const hostile = () => Promise.resolve({ ok: true, clone: () => { throw new Error('no clone'); } });
    window.fetch = hostile;
    await expect(previous(PROPERTIES_URL)).resolves.toBeDefined();
    window.fetch = previous;
  });
});
