// Pure. Raw record capture in, smaller JSON text out. Never throws.
//
// The record trim backs the "Only export property values" checkbox. A record
// capture is mostly per-property provenance: every property arrives wrapped in
// a change-history entry (versions) and ten metadata fields describing how and
// when its value was written. Measured on a live custom object, that wrapping
// is 87 percent of the payload. This removes it, collapses each property to
// its bare value keyed by the property name, and drops the viewing user's
// currentUserPermissions block, which describes the session rather than the
// record.
//
// The governing property is a mapped variant of the workflow trim's: every
// property name in the input appears in the output, each carrying either the
// captured value itself, byte-exact, or (when the entry's shape was not
// recognized) a subtractive residue of the original entry; and every leaf
// outside the properties map survives at the same path with an identical
// value, minus the two named envelope drops. Values are never altered. The
// collapse is the one structural change in either trim, and it fires only
// when what remains after the provenance sweep is exactly {value} holding a
// scalar: anything surprising keeps its original wrapped entry, visibly, so
// no shape is ever guessed at.
//
// Two rules about the rules, both load bearing:
//
//   The walk is exactly two levels, root[objectId].properties[name], with no
//   recursion. `timestamp` and `source` are generic words: a recursive sweep
//   would delete the timestamp inside archivalHistory and the source inside
//   objectStates, which are the only things those entries say. The absence of
//   recursion is what keeps the rule auditable.
//
//   Null and empty values are never pruned. A property whose value is null or
//   "" is a fact ("this field is empty"), and dropping it would turn
//   "explicitly empty" into "not present". They flatten like any other value:
//   the name stays, carrying null or "".
//
// Unlike the raw path, the output is reserialized (JSON.stringify, minified,
// same as the workflow trim). Two consequences, both acceptable because a
// trimmed export is explicitly not byte-identical: integer-like keys are
// reordered first (invisible with a single-record map, which the envelope
// check guarantees in practice), and duplicate keys, which HubSpot has been
// observed emitting, collapse to last-wins. Byte fidelity lives on the raw
// path, and _aiContext splices text rather than reserializing, for exactly
// this reason.

import { isRecordEnvelope } from './summary.js';
import { ledger, dropIf, byteLength, refusal } from './trim-kit.js';

// The per-property metadata fields, dropped wherever present. versions is that
// property's stored history entry; under the allPropertiesFetchMode the record
// page uses (latest_version) it holds exactly one entry near-duplicating the
// parent fields, so nothing historical is lost by dropping it: real property
// history is not in this payload at all.
const PROVENANCE = [
  'versions',
  'sourceUpstreamDeployable',
  'persistenceTimestamp',
  'requestId',
  'maskedSubstrings',
  'sensitivityLevel',
  'updatedByUserId',
  'sourceId',
  'isEncrypted',
  'timestamp',
  'source',
];

/**
 * @param {string} rawText raw record capture, verbatim
 * @returns {{ok: boolean, output: string|null, reason: string|null,
 *            inputBytes: number, outputBytes: number,
 *            rules: Array<{id: string, count: number, bytes: number}>}}
 */
export function recordTrim(rawText) {
  const inputBytes = typeof rawText === 'string' ? byteLength(rawText) : 0;
  const refuse = (reason) => refusal(inputBytes, reason);

  if (typeof rawText !== 'string' || rawText.trim() === '') return refuse('empty body');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return refuse('body is not JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('response root is not a JSON object');
  }

  // The same predicate summarize uses to recognize a record, so the checkbox
  // and the summary can never disagree about what a record is. Withdrawal is
  // whole, never partial: a half-trimmed file looks complete while lying.
  if (!isRecordEnvelope(parsed)) return refuse('record shape not recognized');

  try {
    const log = ledger();

    for (const [key, record] of Object.entries(parsed)) {
      // Preserved untouched, so the trim is safe to run on a previously
      // exported file that already carries a context block or a bundle.
      if (key === '_aiContext' || key === '_related') continue;

      // Session data, not record data: what the viewing user may do to the
      // record says nothing about the record, and a file handed to a
      // colleague or a model should not carry the exporter's permissions.
      dropIf(log, 'record:permissions', record, 'currentUserPermissions');

      for (const [name, property] of Object.entries(record.properties)) {
        if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
        dropIf(log, 'record:versions', property, 'versions');
        for (const field of PROVENANCE) {
          if (field === 'versions') continue;
          dropIf(log, 'record:provenance', property, field);
        }

        // Collapse {value: X} to X, keyed by the property name. Only when the
        // provenance sweep left exactly that shape holding a scalar (every
        // observed value is a JSON string; null and "" are facts and flatten
        // like any other value). A residue with more in it, or a value that
        // is itself an object, keeps its wrapped entry: a visibly different
        // shape rather than a guess. The ledger weighs the ten bytes of
        // wrapper ({"value":}) this removes, which is what weigh('value','')
        // happens to come to.
        const keys = Object.keys(property);
        if (keys.length === 1 && keys[0] === 'value' && (property.value === null || typeof property.value !== 'object')) {
          record.properties[name] = property.value;
          log.hit('record:flattened', 'value', '');
        }
      }
    }

    // Minified, same as the workflow trim: the entire point is token economy.
    const output = JSON.stringify(parsed);
    return {
      ok: true,
      output,
      reason: null,
      inputBytes,
      outputBytes: byteLength(output),
      rules: log.list(),
    };
  } catch (error) {
    return refuse(`trim failed: ${String(error && error.message ? error.message : error)}`);
  }
}
