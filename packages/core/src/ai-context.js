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
// removing it restores the previous text byte for byte.
//
// The text is still parsed once, as a validity check whose result is thrown
// away. That check is what makes indexOf('{') safe: in a JSON document whose
// root is an object, nothing but whitespace can precede the root brace, since
// JSON has no comments and no prologue. Anything that fails the check withdraws
// the whole option rather than producing a file with a half-true block in it.

const CONTEXT_KEY = '_aiContext';

const WHAT_THIS_IS =
  'One HubSpot workflow, captured as JSON from the workflow editor by the Portal Peeker browser extension.';

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
 * @param {string|null} [meta.capturedAtIso] capture time, ISO 8601
 * @param {string|null} [meta.capturedFrom] 'editor load' | 'save' | 'refresh'
 * @param {string|null} [meta.flowId]
 * @param {string|null} [meta.flowName]
 * @param {string|null} [meta.portalId]
 * @param {number|string|null} [meta.flowVersion]
 * @param {string|null} [meta.extensionVersion]
 * @param {object} [meta.modifications] which export options actually ran
 * @returns {object}
 */
export function buildAiContext(meta = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const flags = source.modifications && typeof source.modifications === 'object' ? source.modifications : {};

  const modifications = {};
  for (const entry of MODIFICATIONS) modifications[entry.flag] = Boolean(flags[entry.flag]);

  const howToUse = [REVERSIBLE, source.capturedAtIso ? SNAPSHOT_AT : SNAPSHOT];

  if (MODIFICATIONS.every((entry) => !modifications[entry.flag])) howToUse.push(UNMODIFIED);
  for (const entry of MODIFICATIONS) {
    howToUse.push(...(modifications[entry.flag] ? entry.tells : entry.tellsWhenAbsent));
  }

  const workflow = compact({
    flowId: source.flowId,
    name: source.flowName,
    portalId: source.portalId,
    version: source.flowVersion,
  });
  const capture = compact({
    capturedAt: source.capturedAtIso,
    capturedFrom: source.capturedFrom,
  });

  const block = { whatThisIs: WHAT_THIS_IS, tool: 'Portal Peeker' };
  if (source.extensionVersion != null) block.extensionVersion = source.extensionVersion;
  if (workflow) block.workflow = workflow;
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
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    return { ok: false, reason: 'empty body' };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'response root is not a JSON object' };
  }
  if (Object.hasOwn(parsed, CONTEXT_KEY)) {
    // Either the file has already been through this extension, or HubSpot has
    // started shipping the key. Overwriting would destroy data and two blocks
    // cannot both be the first key, so the only honest move is to step aside.
    return { ok: false, reason: `payload already carries an ${CONTEXT_KEY} field` };
  }
  return { ok: true, reason: null };
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

  // Safe because the parse above succeeded with an object at the root: the only
  // characters that can precede the root brace are JSON whitespace. indexOf
  // rather than a regex on purpose, since the JS \s class matches characters
  // (U+FEFF among them) that the JSON grammar does not.
  const at = jsonText.indexOf('{') + 1;
  const rest = jsonText.slice(at);
  // {} has no members to separate, so no comma. Rare, and invalid JSON without
  // this branch.
  const emptyRoot = /^[ \t\n\r]*\}/.test(rest);
  const inserted = `"${CONTEXT_KEY}":${serialized}${emptyRoot ? '' : ','}`;

  return { ok: true, output: jsonText.slice(0, at) + inserted + rest, reason: null, inserted };
}
