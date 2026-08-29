// Pure. JSON text in, the same JSON text with one block spliced in, out. No
// chrome.*, no DOM, no network: the popup passes in every environmental fact
// (extension version, capture time, flow metadata, which options ran).
//
// These exports get pasted into AI tools, and a model reading one has no way to
// know what it is holding: which portal, which version, how old, whether fields
// were removed, and above all whether "action 12" means the number painted on
// the canvas or an actionId. The block says so in the file itself, so the
// context survives being pasted somewhere this extension will never see.
//
// It is added by splicing text, never by parsing and re-serializing. With the
// trim off, the export is HubSpot's raw bytes, and JSON.parse followed by
// JSON.stringify would silently re-encode them: number formats, escapes, and
// key order are all round-trip hazards. Splicing keeps the guarantee provable
// in the other direction instead: the insertion is one contiguous span, so
// removing it restores the previous text byte for byte. The check and the
// splice themselves live in root-splice.js, shared with the related-captures
// bundle, so the two insertions cannot drift apart. Anything that fails the
// check withdraws the whole option rather than producing a file with a
// half-true block in it.

import { checkRootObject, spliceFirstKey } from './root-splice.js';

const CONTEXT_KEY = '_aiContext';

const WHAT_THIS_IS =
  'One HubSpot workflow, captured as JSON from the workflow editor by the Portal Peeker browser extension.';

const WHAT_THIS_IS_LIST =
  'One HubSpot segment (list): its definition and filter criteria, captured as JSON from the lists tool by the Portal Peeker browser extension.';

const LIST_FILTERS =
  'The filterBranch tree is the segment membership logic: filterBranches nest with filterBranchOperator (AND/OR), and each filters array holds the individual conditions.';

const REVERSIBLE =
  'Portal Peeker inserted this _aiContext block as the first key of the document: delete this one key and every remaining byte is exactly what was captured or exported without it.';

const SNAPSHOT_AT =
  'This is a snapshot taken at the capturedAt time above, not live state: edits made in the editor after that moment, or never saved, are not in it.';

const SNAPSHOT =
  'This is a snapshot of one moment, not live state: edits made in the editor afterwards, or never saved, are not in it.';

const UNMODIFIED =
  'No fields were removed or altered: apart from this block, the document is byte-for-byte what HubSpot sent.';

const TRIMMED =
  'Fields that carry no workflow logic (audit metadata, verified duplicates, nulls, empty collections) were removed before export; nothing that remains was renamed, reordered, or restructured.';

const STRIPPED =
  'HTML in email bodies was converted to plain text, so those body values are rewritten rather than verbatim.';

const NUMBERED =
  'Every action carries a uiNumber field: the number the workflow editor paints on that card on the canvas. When telling a person which action to look at, use uiNumber.';

const NUMBERED_CAVEAT =
  'uiNumber is a position in this capture only: it shifts when actions are added, moved, or removed. actionId is the stable identifier, so use it when correlating across versions or captures.';

const UNNUMBERED =
  'Editor card numbers are not present in this export. actionId is the stable handle for referring to an action.';

const RELATED_INSERTED =
  'A _related key was inserted next to this block, holding responses HubSpot\'s page loaded alongside this segment, each byte-for-byte as received: delete that one key and the rest of the document is exactly the export without it.';

const RELATED_BATCHES =
  'When present, _related.listBatches is an array of hydration responses; each element is one response body, itself an array of full definitions for lists this segment references through IN_LIST, association, or suppression criteria. A referenced list with no definition in there was not loaded by the page and lives in a separate capture.';

const RELATED_EXTRAS =
  'When present, _related.suppression and _related.membershipCounts are the raw suppression settings and membership counts responses for this segment.';

const RELATED_ABSENT =
  'Lists referenced through IN_LIST, association, or suppression criteria appear as ids only: their definitions are separate captures and are not in this file.';

/**
 * Every way an export can differ from what HubSpot sent.
 *
 * This is the list, and it is the only list. The popup takes its filename
 * marks, its status labels, and the flags it reports from here, so a new export
 * option cannot pick up a suffix without also picking up a sentence explaining
 * itself to whoever reads the file. `tools/check-ai-context.mjs` fails the
 * build if an option is added to the popup and not to this table.
 *
 * `tells` is what the block says when the option ran, `tellsWhenAbsent` what it
 * says when it did not. An entry with nothing to say fails its test: a
 * modification the reader is not told about is the thing this exists to
 * prevent.
 */
export const MODIFICATIONS = [
  // `domain` names the kind of capture an option applies to; absent means
  // flow. The block only speaks about options from the export's own domain,
  // because prose about editor cards in a segment file, or about referenced
  // lists in a workflow file, would describe features the file cannot have.
  {
    flag: 'trimmedToWorkflowLogic',
    mark: 'trimmed',
    label: 'trimmed',
    tells: [TRIMMED],
    tellsWhenAbsent: [],
  },
  {
    flag: 'htmlStrippedFromEmailBodies',
    mark: 'stripped',
    label: 'HTML stripped',
    tells: [STRIPPED],
    tellsWhenAbsent: [],
  },
  {
    flag: 'editorNumbersAdded',
    mark: 'numbered',
    label: 'numbered',
    tells: [NUMBERED, NUMBERED_CAVEAT],
    tellsWhenAbsent: [UNNUMBERED],
  },
  {
    flag: 'relatedCapturesIncluded',
    mark: 'related',
    label: 'related lists',
    domain: 'list',
    tells: [RELATED_INSERTED, RELATED_BATCHES, RELATED_EXTRAS],
    tellsWhenAbsent: [RELATED_ABSENT],
  },
];

/** Drop null and undefined members. Returns null when nothing is left. */
function compact(fields) {
  const kept = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * The context block for one export.
 *
 * Every field is optional. A payload the parser did not recognize still gets a
 * block: the unknown fields are omitted rather than guessed at or filled with
 * "not found", because a reader can tell the difference between a missing key
 * and a wrong value.
 *
 * @param {object} meta
 * @param {'flow'|'list'} [meta.domain] what the capture is of; flow if absent
 * @param {string|null} [meta.capturedAtIso] capture time, ISO 8601
 * @param {string|null} [meta.capturedFrom] 'editor load' | 'save' | 'refresh'
 * @param {string|null} [meta.flowId]
 * @param {string|null} [meta.flowName]
 * @param {number|string|null} [meta.flowVersion]
 * @param {string|null} [meta.listId]
 * @param {string|null} [meta.listName]
 * @param {number|string|null} [meta.listVersion]
 * @param {string|null} [meta.processingType]
 * @param {string|null} [meta.objectTypeId]
 * @param {string|null} [meta.portalId]
 * @param {string|null} [meta.extensionVersion]
 * @param {object} [meta.modifications] which export options actually ran
 * @returns {object}
 */
export function buildAiContext(meta = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const flags = source.modifications && typeof source.modifications === 'object' ? source.modifications : {};
  const isList = source.domain === 'list';

  const modifications = {};
  for (const entry of MODIFICATIONS) modifications[entry.flag] = Boolean(flags[entry.flag]);

  const howToUse = [REVERSIBLE, source.capturedAtIso ? SNAPSHOT_AT : SNAPSHOT];

  // Only options from the export's own domain get a voice, in the untouched
  // line as in the per-option prose: workflow prose (actionId, editor cards)
  // in a segment file, or segment prose in a workflow file, would explain
  // features the file cannot have, and a flag from the other domain cannot
  // have run against this file at all.
  const domainEntries = MODIFICATIONS.filter(
    (entry) => (entry.domain || 'flow') === (isList ? 'list' : 'flow'),
  );
  if (domainEntries.every((entry) => !modifications[entry.flag])) howToUse.push(UNMODIFIED);
  for (const entry of domainEntries) {
    howToUse.push(...(modifications[entry.flag] ? entry.tells : entry.tellsWhenAbsent));
  }
  if (isList) howToUse.push(LIST_FILTERS);

  const subject = isList
    ? compact({
        listId: source.listId,
        name: source.listName,
        portalId: source.portalId,
        version: source.listVersion,
        processingType: source.processingType,
        objectTypeId: source.objectTypeId,
      })
    : compact({
        flowId: source.flowId,
        name: source.flowName,
        portalId: source.portalId,
        version: source.flowVersion,
      });
  const capture = compact({
    capturedAt: source.capturedAtIso,
    capturedFrom: source.capturedFrom,
  });

  const block = { whatThisIs: isList ? WHAT_THIS_IS_LIST : WHAT_THIS_IS, tool: 'Portal Peeker' };
  if (source.extensionVersion != null) block.extensionVersion = source.extensionVersion;
  if (subject) block[isList ? 'list' : 'workflow'] = subject;
  if (capture) block.capture = capture;
  block.modifications = modifications;
  block.howToUse = howToUse;

  return block;
}

/**
 * Whether a body can carry a context block at all.
 *
 * Parses to find out and discards the result. Never throws.
 *
 * @param {string} jsonText
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkAiContext(jsonText) {
  return checkRootObject(jsonText, CONTEXT_KEY, 'an');
}

/**
 * Splice a context block in as the first key of a JSON object document.
 *
 * @param {string} jsonText the export so far, raw or trimmed
 * @param {object} contextObject typically from buildAiContext
 * @returns {{ok: boolean, output: string|null, reason: string|null, inserted: string|null}}
 */
export function addAiContext(jsonText, contextObject) {
  const refuse = (reason) => ({ ok: false, output: null, reason, inserted: null });

  const check = checkAiContext(jsonText);
  if (!check.ok) return refuse(check.reason);

  if (!contextObject || typeof contextObject !== 'object' || Array.isArray(contextObject)) {
    return refuse('context block is not a plain object');
  }
  let serialized;
  try {
    serialized = JSON.stringify(contextObject);
  } catch {
    return refuse('context block would not serialize');
  }
  if (typeof serialized !== 'string') return refuse('context block would not serialize');

  const { output, inserted } = spliceFirstKey(jsonText, `"${CONTEXT_KEY}":${serialized}`);
  return { ok: true, output, reason: null, inserted };
}
