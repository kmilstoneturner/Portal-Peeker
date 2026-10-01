import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordTrim } from '../src/record-trim.js';
import { summarize } from '../src/summary.js';
import { assertSubtractive } from './subtractive.js';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name) => readFileSync(fixturesDir + name, 'utf8');

const CONTACT = fixture('synthetic/crm-objects-batch-contact.json');
const CUSTOM = fixture('synthetic/crm-objects-batch-custom.json');

const trimmed = (raw) => {
  const result = recordTrim(raw);
  expect(result.ok, result.reason || '').toBe(true);
  return JSON.parse(result.output);
};

/**
 * The record trim's governing property, a mapped variant of assertSubtractive.
 *
 * Everything outside the properties map is plain subtraction at the same path.
 * The property map keeps every name, and each entry is either the captured
 * value itself (the recognized shape, collapsed) or a subtractive residue of
 * the captured entry (the shape the trim declined to guess at). Values are
 * never altered either way.
 */
function assertValuesProjection(rawIn, rawOut) {
  const input = JSON.parse(rawIn);
  const output = JSON.parse(rawOut);
  expect(Object.keys(output).sort()).toEqual(Object.keys(input).sort());

  for (const [key, outRecord] of Object.entries(output)) {
    if (key === '_aiContext' || key === '_related') {
      expect(outRecord, key).toEqual(input[key]);
      continue;
    }
    const { properties: outProps, ...outRest } = outRecord;
    const { properties: inProps, ...inRest } = input[key];
    assertSubtractive(inRest, outRest, `$.${key}`);

    expect(Object.keys(outProps).sort(), `$.${key}.properties lost or gained a name`).toEqual(
      Object.keys(inProps).sort(),
    );
    for (const [name, entry] of Object.entries(outProps)) {
      const original = inProps[name];
      if (entry !== null && typeof entry === 'object') {
        assertSubtractive(original, entry, `$.${key}.properties.${name}`);
      } else if (original !== null && typeof original === 'object') {
        expect(entry, `$.${key}.properties.${name}`).toEqual(original.value);
      } else {
        expect(entry, `$.${key}.properties.${name}`).toEqual(original);
      }
    }
  }
}

/** One record, hand-assembled, for the cases the committed fixtures cannot
 * carry: provenance words outside properties, null and empty values, and the
 * shapes the collapse must decline. */
const HANDMADE = JSON.stringify({
  9505: {
    portalId: 12345678,
    objectTypeId: '0-1',
    objectId: 9505,
    properties: {
      firstname: {
        versions: [{ value: 'Fixture', timestamp: 1780000000000 }],
        value: 'Fixture',
        timestamp: 1780000000000,
        source: 'API',
        sourceId: 'x',
        sourceUpstreamDeployable: 'y',
        isEncrypted: false,
        updatedByUserId: 5550001,
        requestId: null,
        maskedSubstrings: [],
        persistenceTimestamp: 1780000600000,
        sensitivityLevel: 'STANDARD',
      },
      // Explicitly empty is a fact, not noise. Both flatten like any other
      // value: the name stays, carrying null or "".
      hs_next_activity: { value: null, timestamp: null },
      jobtitle: { value: '', source: 'CRM_UI' },
      // A property whose entry is not an object is left alone, whatever it is.
      odd_shape: 'bare string',
      // A field beside value that is not provenance: the collapse declines,
      // and the residue keeps both, wrapped and visible.
      mystery: { value: 'x', futureNote: 'y' },
      // A value that is itself an object has never been observed; the
      // collapse declines rather than making "wrapped" ambiguous.
      weird_value: { value: { nested: true } },
    },
    // The same words at envelope depth say different things, and the
    // two-level walk must never reach them: timestamp here is when the state
    // changed, source is what changed it, and they are the only content
    // these entries have.
    objectStates: [{ state: 'CREATED', timestamp: 1780000900000, source: 'MIGRATION' }],
    archivalHistory: [{ archived: false, timestamp: 1780001200000 }],
    secondaryIdentifier: null,
    currentUserPermissions: { canView: true, canEdit: true },
  },
});

// ------------------------------------------------------------------ property

describe('record trim projects values and never alters one', () => {
  for (const [label, raw] of [['contact', CONTACT], ['custom object', CUSTOM], ['handmade', HANDMADE]]) {
    it(`holds the projection property: ${label}`, () => {
      assertValuesProjection(raw, recordTrim(raw).output);
    });
  }

  it('output is still a recognizable record capture, name included', () => {
    const before = summarize(CONTACT);
    const after = summarize(recordTrim(CONTACT).output);
    expect(after.recognized).toBe(true);
    expect(after.domain).toBe('record');
    expect(after.objectTypeId).toBe(before.objectTypeId);
    expect(after.objectId).toBe(before.objectId);
    expect(after.name).toBe(before.name);
    expect(after.propertyCount).toBe(before.propertyCount);
  });

  it('is idempotent', () => {
    const once = recordTrim(HANDMADE).output;
    expect(recordTrim(once).output).toBe(once);
    const contact = recordTrim(CONTACT).output;
    expect(recordTrim(contact).output).toBe(contact);
  });
});

// ------------------------------------------------------------------ drops

describe('what the record trim drops and collapses, and only there', () => {
  const out = trimmed(HANDMADE);
  const record = out['9505'];

  it('collapses each recognized property to its bare value under its name', () => {
    expect(record.properties.firstname).toBe('Fixture');
  });

  it('never prunes null or empty values: explicitly empty is not absent', () => {
    expect(record.properties.hs_next_activity).toBeNull();
    expect(Object.hasOwn(record.properties, 'hs_next_activity')).toBe(true);
    expect(record.properties.jobtitle).toBe('');
    expect(record.properties.odd_shape).toBe('bare string');
  });

  it('declines the collapse on any shape it has not seen, keeping the entry wrapped', () => {
    // An unknown field beside value is kept, visibly, rather than guessed
    // away; a value that is itself an object stays wrapped so a flat entry
    // can never be mistaken for one.
    expect(record.properties.mystery).toEqual({ value: 'x', futureNote: 'y' });
    expect(record.properties.weird_value).toEqual({ value: { nested: true } });
  });

  it('drops the viewing user permissions block: session data, not record data', () => {
    expect(Object.hasOwn(record, 'currentUserPermissions')).toBe(false);
    const contact = trimmed(CONTACT)['9101'];
    expect(Object.hasOwn(contact, 'currentUserPermissions')).toBe(false);
  });

  it('does not recurse: the same words outside properties survive', () => {
    // timestamp and source are generic words. A blind sweep would delete the
    // only things objectStates and archivalHistory say; the two-level walk is
    // what keeps the rule auditable.
    expect(record.objectStates[0].timestamp).toBe(1780000900000);
    expect(record.objectStates[0].source).toBe('MIGRATION');
    expect(record.archivalHistory[0].timestamp).toBe(1780001200000);
  });

  it('keeps the rest of the envelope: identity and state stay', () => {
    const contact = trimmed(CONTACT)['9101'];
    for (const key of [
      'portalId',
      'objectTypeId',
      'objectId',
      'objectStates',
      'reverseReferences',
      'mergeAudits',
      'archivalHistory',
      'secondaryIdentifier',
      'state',
      'archivalState',
    ]) {
      expect(Object.hasOwn(contact, key), key).toBe(true);
    }
    // And the fixture's own objectStates carry provenance-named fields at
    // envelope depth, untouched: the live proof of the non-recursion rule.
    expect(Object.hasOwn(contact.objectStates[0], 'timestamp')).toBe(true);
    expect(Object.hasOwn(contact.objectStates[0], 'sourceId')).toBe(true);
  });

  it('leaves _aiContext and _related untouched, so an exported file re-trims safely', () => {
    const parsed = JSON.parse(HANDMADE);
    const wrapped = JSON.stringify({
      _aiContext: { whatThisIs: 'x', timestamp: 1, source: 'y' },
      _related: { source: 'z' },
      ...parsed,
    });
    const out = trimmed(wrapped);
    expect(out._aiContext).toEqual({ whatThisIs: 'x', timestamp: 1, source: 'y' });
    expect(out._related).toEqual({ source: 'z' });
    expect(out['9505'].properties.firstname).toBe('Fixture');
  });
});

// ------------------------------------------------------------------ reporting

describe('record trim ledger and sizing', () => {
  it('reports every rule with honest counts and measured sizes', () => {
    const result = recordTrim(CONTACT);
    const ids = result.rules.map((r) => r.id);
    for (const id of ['record:versions', 'record:provenance', 'record:flattened', 'record:permissions']) {
      expect(ids).toContain(id);
    }
    for (const rule of result.rules) {
      expect(rule.count).toBeGreaterThan(0);
      expect(rule.bytes).toBeGreaterThan(0);
    }
    // Measured, never pinned: the committed fixtures are scrubbed copies, so
    // their byte counts are artefacts of the scrubbing.
    expect(result.inputBytes).toBe(Buffer.byteLength(CONTACT, 'utf8'));
    expect(result.outputBytes).toBe(Buffer.byteLength(result.output, 'utf8'));
  });

  it('removes most of the payload: the wrapping was measured at 87 percent live', () => {
    for (const raw of [CONTACT, CUSTOM]) {
      const result = recordTrim(raw);
      expect(result.outputBytes / result.inputBytes).toBeLessThan(0.5);
    }
  });
});

// ------------------------------------------------------------------ refusal

describe('record trim refuses rather than half-working', () => {
  it('refuses a flow and a list body: this trim is a record feature', () => {
    const flow = fixture('synthetic/hybrid-get-v3.json');
    const list = fixture('synthetic/inbounddb-list-get.json');
    for (const raw of [flow, list]) {
      const result = recordTrim(raw);
      expect(result.ok).toBe(false);
      expect(result.output).toBeNull();
      expect(result.reason).toBe('record shape not recognized');
    }
  });

  it('names each early refusal', () => {
    expect(recordTrim('').reason).toBe('empty body');
    expect(recordTrim(undefined).reason).toBe('empty body');
    expect(recordTrim('not json').reason).toBe('body is not JSON');
    expect(recordTrim('[]').reason).toBe('response root is not a JSON object');
    expect(recordTrim('"text"').reason).toBe('response root is not a JSON object');
    expect(recordTrim('{}').reason).toBe('record shape not recognized');
  });

  it('never throws, and reports input size even when refusing', () => {
    for (const input of ['', null, undefined, 'not json', '[]', '{}', '{"a":1}']) {
      expect(() => recordTrim(input)).not.toThrow();
      expect(recordTrim(input).ok).toBe(false);
    }
    expect(recordTrim('not json').inputBytes).toBe(8);
    expect(recordTrim('not json').outputBytes).toBe(8);
  });
});

// ------------------------------------------------------------------ private

// Same convention as trim.test.js: record captures from client portals are
// never committed. Drop them in __fixtures__/private as record-*.json and the
// property runs against real payloads locally; CI skips silently.
const privateDir = fixturesDir + 'private/';
const privateFiles = existsSync(privateDir)
  ? readdirSync(privateDir).filter((f) => f.endsWith('.json') && f.startsWith('record-'))
  : [];

describe.skipIf(privateFiles.length === 0)('private record fixtures', () => {
  for (const file of privateFiles) {
    it(`trims ${file} without violating the projection property`, () => {
      const raw = readFileSync(privateDir + file, 'utf8');
      const result = recordTrim(raw);
      expect(result.ok, result.reason || '').toBe(true);
      assertValuesProjection(raw, result.output);
      expect(result.outputBytes).toBeLessThan(result.inputBytes);
    });
  }
});
