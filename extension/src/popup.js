// The popup owns no capture state. It asks the bridge content script in the
// active tab for the snapshot every time it opens, and asks again immediately
// before Copy or Download so a save that landed while it was open cannot ship
// stale bytes.
//
// Trimming happens here, downstream of capture, never in the bridge. The bridge
// serves raw and only raw. That is what keeps the capture path parser-free: a
// bug in the trim can cost an export, never a capture.
//
// Two stores, and the split is deliberate: the backend follows the consumer.
//
// The six export checkboxes are read by this page and nowhere else, and they
// describe a file this page builds. They stay in the popup's own localStorage.
//
// The Settings page toggles are obeyed by a content script running on
// hubspot.com, which has a different origin and cannot see this page's
// localStorage at all. Those live in chrome.storage.local, which is the one
// permission this extension asks for. Local, never sync, so settings do not
// leave the machine.
//
// Nothing about a capture is persisted in either.

import { POPUP_MSG, REFRESH_ERROR, CAPTURE_KIND, CAPTURE_DOMAIN } from './lib/protocol.js';
import { idsFromPageUrl } from './lib/endpoints.js';
import { summarize, listIdsInBatches } from './lib/summary.js';
import { trim, estimateTokens } from './lib/trim.js';
import { recordTrim } from './lib/record-trim.js';
import { uiNumbersFromText, addUiNumbers } from './lib/ui-numbers.js';
import { buildAiContext, checkAiContext, addAiContext, MODIFICATIONS } from './lib/ai-context.js';
import { addRelated, checkRelated } from './lib/related.js';
import { SETTINGS } from './lib/settings.js';
import { readSettings, writeSetting, settingsStoreAvailable } from './lib/settings-store.js';

const el = (id) => document.getElementById(id);

const view = {
  empty: el('empty'),
  emptyHint: el('empty-hint'),
  emptyStatus: el('empty-status'),
  fetch: el('fetch'),
  capture: el('capture'),
  kind: el('kind'),
  nameLabel: el('d-name'),
  idLabel: el('d-id'),
  versionLabel: el('d-version'),
  name: el('f-name'),
  flow: el('f-flow'),
  portal: el('f-portal'),
  version: el('f-version'),
  typeRow: el('row-type'),
  type: el('f-type'),
  filtersRow: el('row-filters'),
  filters: el('f-filters'),
  refsRow: el('row-refs'),
  refs: el('f-refs'),
  fetchRefs: el('fetch-refs'),
  when: el('f-when'),
  size: el('f-size'),
  tokens: el('f-tokens'),
  degraded: el('degraded'),
  status: el('status'),
  copy: el('copy'),
  download: el('download'),
  refresh: el('refresh'),
  trim: el('opt-trim'),
  trimLabel: el('opt-trim-label'),
  numbers: el('opt-numbers'),
  numbersInfo: el('numbers-info'),
  numbersTip: el('numbers-tip'),
  strip: el('opt-strip'),
  related: el('opt-related'),
  relatedInfo: el('related-info'),
  relatedTip: el('related-tip'),
  values: el('opt-values'),
  valuesLabel: el('opt-values-label'),
  valuesInfo: el('values-info'),
  valuesTip: el('values-tip'),
  context: el('opt-context'),
  contextInfo: el('context-info'),
  contextTip: el('context-tip'),
  navHome: el('nav-home'),
  navSettings: el('nav-settings'),
  pageHome: el('page-home'),
  pageSettings: el('page-settings'),
  settingsList: el('settings-list'),
  settingsFoot: el('set-foot'),
};

const STORAGE = {
  trim: 'portal-peeker.trim',
  strip: 'portal-peeker.stripHtml',
  numbers: 'portal-peeker.uiNumbers',
  related: 'portal-peeker.relatedCaptures',
  values: 'portal-peeker.propertyValues',
  context: 'portal-peeker.aiContext',
};

let tabId = null;
let snapshot = null;
/** trim results for the open capture, keyed by option combination. */
let variants = new Map();
/** Which page the rail is showing. The popup always opens on Home. */
let page = 'home';
/** Whether Home has a capture badge to show. Settings never does. */
let hasKind = false;

// ---------------------------------------------------------------- format

const num = (n) => n.toLocaleString();

function formatWhen(ms) {
  if (typeof ms !== 'number') return 'not found';
  const date = new Date(ms);
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 5) return `${clock} (just now)`;
  if (seconds < 90) return `${clock} (${seconds}s ago)`;
  return `${clock} (${Math.round(seconds / 60)} min ago)`;
}

// Local date, not UTC. A capture taken at 9pm should not be filed under
// tomorrow because the user is west of Greenwich.
function localDateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Filename slug of a resolved record name: lowercase, runs of anything outside
// a-z0-9 collapsed to single hyphens, capped at 40 characters, and dropped
// entirely when nothing survives (a fully non-ASCII name). The identifiers
// stay in the stem regardless, so the file is identifiable without it.
function nameSlug(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Render "before -> after", or just the one value when nothing changed.
 * Built from nodes rather than innerHTML: this page handles portal data and
 * has no business assembling markup from strings.
 */
function setDelta(node, before, after, suffix = '') {
  node.replaceChildren();
  if (after == null) {
    node.append(before + suffix);
    return;
  }
  const old = document.createElement('span');
  old.className = 'was';
  old.textContent = before;
  node.append(old, ' → ', after + suffix);
}

const KIND_LABEL = {
  [CAPTURE_KIND.LOAD]: 'on load',
  [CAPTURE_KIND.SAVE]: 'on save',
  [CAPTURE_KIND.REFRESH]: 'refreshed',
};

// How the context block names the same three kinds, written for a reader who
// has never seen this extension.
const CAPTURED_FROM = {
  [CAPTURE_KIND.LOAD]: 'editor load',
  [CAPTURE_KIND.SAVE]: 'save',
  [CAPTURE_KIND.REFRESH]: 'refresh',
};

// The rows above Portal ID name what was captured. One table per domain, so a
// segment is never presented under a "Flow" label or vice versa. The record
// row set is deliberately identifiers only: no property value, a person's
// name included, is ever rendered in the popup. The resolved display name
// exists for the AI context block and the download filename, where a human
// reads the file later, not for this screen.
const ROW_LABELS = {
  [CAPTURE_DOMAIN.FLOW]: { name: 'Flow', id: 'Flow ID', version: 'Version' },
  [CAPTURE_DOMAIN.LIST]: { name: 'Segment', id: 'List ID', version: 'Version' },
  [CAPTURE_DOMAIN.RECORD]: { name: 'Object type', id: 'Record ID', version: 'Properties' },
};

/**
 * processingType in HubSpot's own UI vocabulary. DYNAMIC is an active list;
 * SNAPSHOT and MANUAL are the two ways a list ends up static. The raw value
 * stays visible because it is what the JSON says.
 */
function processingTypeLabel(processingType) {
  if (typeof processingType !== 'string' || processingType === '') return null;
  const word =
    processingType === 'DYNAMIC' ? 'active' : processingType === 'SNAPSHOT' || processingType === 'MANUAL' ? 'static' : null;
  return word ? `${word} (${processingType})` : processingType;
}

/** Which domain a snapshot belongs to: the bridge's URL-derived word wins,
 * the parsed body fills in for a bridge from before that domain existed. */
function domainOf(source, summary) {
  if (source && source.domain === CAPTURE_DOMAIN.RECORD) return CAPTURE_DOMAIN.RECORD;
  if (source && source.domain === CAPTURE_DOMAIN.LIST) return CAPTURE_DOMAIN.LIST;
  if (source && source.domain === CAPTURE_DOMAIN.FLOW) return CAPTURE_DOMAIN.FLOW;
  if (summary && summary.domain === 'record') return CAPTURE_DOMAIN.RECORD;
  return summary && summary.domain === 'list' ? CAPTURE_DOMAIN.LIST : CAPTURE_DOMAIN.FLOW;
}

function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- trimming

function trimFor(raw, stripHtml) {
  const key = stripHtml ? 'strip' : 'plain';
  if (!variants.has(key)) variants.set(key, trim(raw, { stripHtml }));
  return variants.get(key);
}

/** Whether the open capture's graph can be numbered at all. */
function numbersFor(raw) {
  if (!variants.has('numbers')) variants.set('numbers', uiNumbersFromText(raw));
  return variants.get('numbers');
}

/** Annotated variant of an export, for the size and token rows. */
function numberedFor(key, raw, text) {
  if (!variants.has(key)) variants.set(key, addUiNumbers(raw, text));
  return variants.get(key);
}

/** Whether the open capture can carry a context block at all. */
function contextCheckFor(raw) {
  if (!variants.has('context')) variants.set('context', checkAiContext(raw));
  return variants.get('context');
}

/** Whether the open capture can carry a _related key at all. */
function relatedCheckFor(raw) {
  if (!variants.has('relatedCheck')) variants.set('relatedCheck', checkRelated(raw));
  return variants.get('relatedCheck');
}

/** Bundled variant of an export, for the size and token rows. */
function relatedFor(key, text, pieces) {
  if (!variants.has(key)) variants.set(key, addRelated(text, pieces));
  return variants.get(key);
}

/**
 * Whether the checkbox can be offered, and the title that says why not.
 * The bodies come from the bridge, so their presence is a fact about what the
 * page loaded, not about this payload's shape; the shape check is separate.
 */
function relatedStateFor(domain, source) {
  if (domain !== CAPTURE_DOMAIN.LIST) return { ok: false, reason: 'Segment captures only' };
  if (!source || !source.related) {
    return {
      ok: false,
      reason:
        'Nothing was captured alongside this segment. Reload the page to catch the responses that load next to it.',
    };
  }
  const check = relatedCheckFor(source.raw);
  if (!check.ok) return { ok: false, reason: `Referenced lists unavailable: ${check.reason}` };
  return { ok: true, reason: null };
}

function summaryFor(raw) {
  if (!variants.has('summary')) variants.set('summary', summarize(raw));
  return variants.get('summary');
}

/** Whether the open record capture can be reduced to property values. */
function recordTrimFor(raw) {
  if (!variants.has('values')) variants.set('values', recordTrim(raw));
  return variants.get('values');
}

/** Context-carrying variant of an export, for the size and token rows. */
function contextedFor(key, text, meta) {
  if (!variants.has(key)) variants.set(key, addAiContext(text, buildAiContext(meta)));
  return variants.get(key);
}

// A checkbox is obeyed only when it is both ticked and applicable. The
// widgets keep the user's stored preference even while disabled or hidden for
// the capture on screen, so viewing a segment can never cost a workflow
// preference, and vice versa.
const trimWanted = () => view.trim.checked && !view.trim.disabled;
const stripWanted = () => view.strip.checked && !view.strip.disabled;
const numbersWanted = () => view.numbers.checked && !view.numbers.disabled;
const relatedWanted = () => view.related.checked && !view.related.disabled;
const valuesWanted = () => view.values.checked && !view.values.disabled;
const contextWanted = () => view.context.checked && !view.context.disabled;

/**
 * Everything the block says about this export.
 *
 * Core computes none of it: the extension version, the clock, and which options
 * ran are all facts about this page, and a pure module has no business guessing
 * at any of them. Whatever is unknown is passed as null and left out.
 */
function contextMeta(summary, source, applied) {
  const shared = {
    capturedAtIso: Number.isFinite(source.capturedAt)
      ? new Date(source.capturedAt).toISOString()
      : null,
    capturedFrom: CAPTURED_FROM[source.kind] || null,
    portalId: summary.portalId,
    extensionVersion: manifestVersion(),
    modifications: applied,
  };

  const domain = domainOf(source, summary);

  if (domain === CAPTURE_DOMAIN.RECORD) {
    return {
      ...shared,
      domain: 'record',
      // "editor load" would describe a page this capture never saw.
      capturedFrom: source.kind === CAPTURE_KIND.LOAD ? 'record page load' : shared.capturedFrom,
      objectTypeId: summary.objectTypeId || source.objectTypeId || null,
      objectId: summary.objectId || source.objectId || null,
      recordName: summary.name,
    };
  }

  if (domain === CAPTURE_DOMAIN.LIST) {
    return {
      ...shared,
      domain: 'list',
      listId: summary.listId || source.listId || null,
      listName: summary.name,
      listVersion: summary.version,
      processingType: summary.processingType,
      objectTypeId: summary.objectTypeId,
    };
  }

  return {
    ...shared,
    domain: 'flow',
    flowId: summary.flowId || source.flowId || null,
    flowName: summary.name,
    flowVersion: summary.version,
  };
}

/**
 * What Copy and Download should actually emit.
 *
 * Returns { failed } instead of an export when a step refuses: shipping bytes
 * under a suffix that promises something else would be worse than an error.
 *
 * One function serves both the buttons and the size rows, so the rows can never
 * describe a file different from the one that gets written. Exports run it on a
 * freshly pulled body; the rows run it on the open snapshot, where cached lets
 * the expensive steps be reused across a toggle.
 *
 * @param {string} raw body to export from
 * @param {object} source snapshot or payload, for flowId, kind, capturedAt
 * @param {boolean} cached whether raw is the open snapshot
 */
function buildExport(raw, source, cached = false) {
  const marks = [];
  const labels = [];
  const applied = Object.fromEntries(MODIFICATIONS.map((m) => [m.flag, false]));
  let text = raw;

  // Filename mark, status label, and the flag the context block reports all
  // come from one entry, so a file can never carry a suffix the block does not
  // mention. tools/check-ai-context.mjs enforces the other direction.
  const note = (flag) => {
    const entry = MODIFICATIONS.find((m) => m.flag === flag);
    applied[flag] = true;
    marks.push(entry.mark);
    labels.push(entry.label);
  };
  const stageKey = () => marks.join('-') || 'raw';

  if (trimWanted()) {
    const stripHtml = stripWanted();
    const result = cached ? trimFor(raw, stripHtml) : trim(raw, { stripHtml });
    if (!result.ok) return { failed: 'trim' };

    text = result.output;
    note('trimmedToWorkflowLogic');
    if (stripHtml) note('htmlStrippedFromEmailBodies');
  }

  // The record trim. Its own if, not an else on the flow trim: both read
  // disabled state and are mutually exclusive by domain (renderOptions never
  // enables both), so at most one runs, and stating that as data flow rather
  // than control flow keeps it true if a domain is ever added.
  if (valuesWanted()) {
    const result = cached ? recordTrimFor(raw) : recordTrim(raw);
    if (!result.ok) return { failed: 'values' };
    text = result.output;
    note('trimmedToPropertyValues');
  }

  // Numbering inserts text rather than reserializing, so it runs on the raw
  // capture just as safely as on a trim. It is nobody's sub-option.
  if (numbersWanted()) {
    const numbered = cached
      ? numberedFor(`${stageKey()}-numbered`, raw, text)
      : addUiNumbers(raw, text);
    if (!numbered.ok) return { failed: 'numbers' };
    text = numbered.output;
    note('editorNumbersAdded');
  }

  // The related captures are an insertion too: one _related key holding the
  // verbatim sidecar bodies, so the export still degrades to the exact
  // capture by deleting a single key. Only offered on segment captures, which
  // renderOptions enforces through the disabled state this reads.
  if (relatedWanted()) {
    const pieces = source.related;
    if (!pieces) return { failed: 'related' };
    const bundled = cached ? relatedFor(`${stageKey()}-related`, text, pieces) : addRelated(text, pieces);
    if (!bundled.ok) return { failed: 'related' };
    text = bundled.output;
    note('relatedCapturesIncluded');
  }

  if (contextWanted()) {
    // The block reports what actually ran, not what is ticked. An option can be
    // ticked and withdrawn in the same breath.
    const meta = contextMeta(cached ? summaryFor(raw) : summarize(raw), source, applied);
    const contexted = cached
      ? contextedFor(`${stageKey()}-ai`, text, meta)
      : addAiContext(text, buildAiContext(meta));
    if (!contexted.ok) return { failed: 'context' };
    text = contexted.output;
    marks.push('ai');
    labels.push('AI context');
  }

  return {
    text,
    suffix: marks.length ? `-${marks.join('-')}` : '',
    label: labels.length ? ` (${labels.join(', ')})` : '',
  };
}

// ---------------------------------------------------------------- render

function showEmpty(hint, { canFetch = false } = {}) {
  view.capture.hidden = true;
  hasKind = false;
  view.kind.hidden = true;
  view.empty.hidden = false;
  if (hint) view.emptyHint.textContent = hint;
  view.fetch.hidden = !canFetch;
  sayIn(view.emptyStatus, '');
}

function renderSizes() {
  const raw = snapshot.raw;
  const rawBytes = snapshot.byteLength;
  const rawTokens = estimateTokens(raw);
  const domain = domainOf(snapshot, summaryFor(raw));

  // The percentage is shown whether or not the box is ticked, so the payoff is
  // visible before committing to it. Each trim's preview runs only on its own
  // domain: computing a doomed flow trim on every record render, or the
  // reverse, would be pure wasted work on every checkbox toggle.
  if (domain === CAPTURE_DOMAIN.FLOW) {
    const preview = trimFor(raw, view.strip.checked);
    if (preview.ok) {
      const pct = Math.round(100 - (preview.outputBytes / rawBytes) * 100);
      view.trimLabel.textContent = `Trim to workflow logic (est. ${pct}%)`;
    } else {
      view.trimLabel.textContent = 'Trim to workflow logic';
    }
  } else {
    view.trimLabel.textContent = 'Trim to workflow logic';
  }

  if (domain === CAPTURE_DOMAIN.RECORD) {
    const preview = recordTrimFor(raw);
    if (preview.ok) {
      const pct = Math.round(100 - (preview.outputBytes / rawBytes) * 100);
      view.valuesLabel.textContent = `Only export property values (est. ${pct}%)`;
    } else {
      view.valuesLabel.textContent = 'Only export property values';
    }
  } else {
    view.valuesLabel.textContent = 'Only export property values';
  }

  // The rows show the export as configured, whichever boxes are ticked, so the
  // context block's cost is visible too. With nothing ticked there is no second
  // figure to show, because there is no second file.
  const built = buildExport(raw, snapshot, true);

  if (built.failed || built.suffix === '') {
    setDelta(view.size, `${num(rawBytes)} bytes`, null, rawBytes < 1024 ? '' : ` (${(rawBytes / 1024).toFixed(1)} KB)`);
    setDelta(view.tokens, `~${num(rawTokens)}`, null);
    return;
  }

  const outputBytes = new TextEncoder().encode(built.text).length;
  setDelta(view.size, num(rawBytes), num(outputBytes), ' bytes');
  setDelta(view.tokens, `~${num(rawTokens)}`, `~${num(estimateTokens(built.text))}`);
}

function renderOptions(domain, trimmable, reason, numbersCheck, contextCheck, relatedState, valuesCheck) {
  // The box swaps by capture type. Trimming, stripping, and numbering are
  // workflow features (their rules and their walker only know flow
  // structure), bundling referenced lists is a segment feature, and the
  // property values trim is a record feature, so each capture shows only the
  // options that can apply to it, rather than a column of grey checkboxes
  // explaining the other domains. The hidden ones are also disabled, which is
  // what buildExport actually consults.
  //
  // Nothing here writes to a checkbox's checked state: the widgets carry the
  // user's stored preference, and a disabled box is simply not obeyed (the
  // *Wanted() guards). Forcing one off here would get persisted by the next
  // toggle and silently erase a preference for another domain.
  const isFlow = domain === CAPTURE_DOMAIN.FLOW;
  const isList = domain === CAPTURE_DOMAIN.LIST;
  const isRecord = domain === CAPTURE_DOMAIN.RECORD;

  view.trim.parentElement.hidden = !isFlow;
  view.strip.parentElement.hidden = !isFlow;
  view.numbers.parentElement.hidden = !isFlow;
  view.related.parentElement.hidden = !isList;
  view.values.parentElement.hidden = !isRecord;

  view.trim.disabled = !trimmable || !isFlow;
  view.trim.parentElement.classList.toggle('is-disabled', view.trim.disabled);

  // Stripping HTML rewrites values, which only a trim's output can absorb, so
  // it is the trim's sub-option and the only one.
  const onTopOfTrim = trimWanted();
  view.strip.disabled = !onTopOfTrim;
  view.strip.parentElement.classList.toggle('is-disabled', !onTopOfTrim);

  // Numbering stands on its own: it inserts text and rewrites nothing, so it
  // works on raw bytes. It is withdrawn only when the graph has a shape the
  // walker does not recognize, and then entirely rather than partially: a file
  // where some cards carry numbers and some do not looks complete while lying.
  const numbersOk = Boolean(numbersCheck && numbersCheck.ok) && isFlow;
  view.numbers.disabled = !numbersOk;
  view.numbers.parentElement.classList.toggle('is-disabled', !numbersOk);
  view.numbers.parentElement.title =
    numbersOk || !isFlow
      ? ''
      : `Editor numbers unavailable: ${numbersCheck ? numbersCheck.reason : 'no capture'}`;

  // The record trim withdraws whole, like every other option: an unrecognized
  // record shape disables the checkbox with the reason rather than shipping a
  // partial file that looks complete.
  const valuesOk = Boolean(valuesCheck && valuesCheck.ok) && isRecord;
  view.values.disabled = !valuesOk;
  view.values.parentElement.classList.toggle('is-disabled', !valuesOk);
  view.values.parentElement.title =
    valuesOk || !isRecord
      ? ''
      : `Property values trim unavailable: ${valuesCheck ? valuesCheck.reason : 'no capture'}`;

  // Bundling is available only when the bridge actually holds bodies captured
  // beside this segment. The title carries the reason when it does not, so a
  // grey checkbox always says why it is grey.
  const relatedOk = Boolean(relatedState && relatedState.ok);
  view.related.disabled = !relatedOk;
  view.related.parentElement.classList.toggle('is-disabled', !relatedOk);
  view.related.parentElement.title =
    relatedOk || !isList ? '' : relatedState ? relatedState.reason : 'no capture';

  // The context block rides on nothing: it is one inserted key, so it works on
  // a trimmed export and on raw bytes alike, for a segment as for a workflow.
  // It is withdrawn only when the payload cannot carry it, which is a fact
  // about the payload, not the trim.
  const contextOk = Boolean(contextCheck && contextCheck.ok);
  view.context.disabled = !contextOk;
  view.context.parentElement.classList.toggle('is-disabled', !contextOk);
  view.context.parentElement.title = contextOk ? '' : `AI context unavailable: ${contextCheck.reason}`;

  // A pinned tip belonging to a row that just hid would float over nothing.
  for (const tip of tips) tip.close();

  return reason;
}

function render(status) {
  view.empty.hidden = true;
  view.capture.hidden = false;
  hasKind = true;
  // The header is shared, but the capture badge belongs to Home. showPage owns
  // whether it is actually visible right now.
  view.kind.hidden = page !== 'home';
  view.kind.textContent = KIND_LABEL[status.kind] || 'captured';

  const summary = summaryFor(status.raw);
  const domain = domainOf(status, summary);
  const labels = ROW_LABELS[domain] || ROW_LABELS[CAPTURE_DOMAIN.FLOW];
  const isFlow = domain === CAPTURE_DOMAIN.FLOW;
  const isRecord = domain === CAPTURE_DOMAIN.RECORD;

  view.nameLabel.textContent = labels.name;
  view.idLabel.textContent = labels.id;
  view.versionLabel.textContent = labels.version;

  // On a record the first row is the raw objectTypeId, deliberately: the
  // popup never renders a property value, a person's name included, and a
  // friendly word for the type would need a type map this extension refuses
  // to maintain.
  view.name.textContent = isRecord
    ? summary.objectTypeId || status.objectTypeId || 'not found'
    : summary.name || 'Name not found in payload';
  // The bridge knows the id from the URL even when the body will not parse,
  // so prefer whichever is present.
  view.flow.textContent = isRecord
    ? summary.objectId || status.objectId || 'not found'
    : domain === CAPTURE_DOMAIN.LIST
      ? summary.listId || status.listId || 'not found'
      : summary.flowId || status.flowId || 'not found';
  view.portal.textContent = summary.portalId || 'not found';
  // Records have no version (objectVersion is null on every observed
  // payload), so their third row carries the property count instead.
  view.version.textContent = isRecord
    ? summary.propertyCount != null
      ? num(summary.propertyCount)
      : 'not found'
    : summary.version != null
      ? String(summary.version)
      : 'not found';
  view.when.textContent = formatWhen(status.capturedAt);

  // The two segment-only rows. Filters is the row this feature exists for:
  // the number of conditions the segment checks, counted from the
  // filterBranch tree. A static list with no filterBranch honestly says none.
  const isList = domain === CAPTURE_DOMAIN.LIST;
  view.typeRow.hidden = !isList;
  view.filtersRow.hidden = !isList;
  view.refsRow.hidden = !isList;
  if (isList) {
    view.type.textContent = processingTypeLabel(summary.processingType) || 'not found';
    view.filters.textContent =
      summary.filterCount != null
        ? num(summary.filterCount)
        : summary.processingType && summary.processingType !== 'DYNAMIC'
          ? 'none'
          : 'not found';

    // Coverage before export: how many lists this segment depends on, and how
    // many of their definitions were captured beside it. "3 lists (0
    // captured)" is the honest warning that a bundled export will still name
    // lists it cannot show, and the Fetch missing button is the way to close
    // the gap: the page names its suppression lists but never loads them.
    const refs = summary.referencedListIds || [];
    if (refs.length === 0) {
      view.refs.textContent = 'none';
      view.fetchRefs.hidden = true;
    } else {
      const captured = new Set(listIdsInBatches(relatedBodies(status.related)));
      const have = refs.filter((id) => captured.has(id)).length;
      view.refs.textContent = `${refs.length} list${refs.length === 1 ? '' : 's'} (${have} captured)`;
      view.fetchRefs.hidden = have >= refs.length;
      view.fetchRefs.disabled = false;
    }
  }

  // Each trim's availability is computed only for its own domain; the stub
  // for the other domains keeps renderOptions honest without running a trim
  // that is guaranteed to refuse.
  const trimCheck = isFlow ? trimFor(status.raw, view.strip.checked) : { ok: false, reason: null };
  renderOptions(
    domain,
    trimCheck.ok,
    trimCheck.reason,
    isFlow ? numbersFor(status.raw) : null,
    contextCheckFor(status.raw),
    relatedStateFor(domain, status),
    isRecord ? recordTrimFor(status.raw) : null,
  );

  // For a workflow, an unavailable trim is part of the degraded story. For a
  // segment or a record it is the normal state (that trim belongs to another
  // domain), so only the parser's own verdict decides the banner there. The
  // record trim carries its own withdrawal on its checkbox title instead.
  const healthy = isFlow ? summary.recognized && trimCheck.ok : summary.recognized;
  if (healthy) {
    view.degraded.hidden = true;
  } else {
    view.degraded.hidden = false;
    // Copy and Download keep working on raw bytes no matter what the parser
    // makes of the payload. Trimming does not: a partly trimmed file looks
    // complete while missing whatever the rules never reached, so it is
    // withdrawn rather than attempted.
    const detail = summary.recognized ? trimCheck.reason : summary.reason;
    view.degraded.textContent = isFlow
      ? `Shape not fully recognized: ${detail}. Copy and Download still work on the exact captured bytes. Trimming is unavailable for this payload.`
      : `Shape not fully recognized: ${detail}. Copy and Download still work on the exact captured bytes.`;
  }

  renderSizes();

  view.copy.disabled = false;
  view.download.disabled = false;
  view.refresh.disabled = false;
}

function sayIn(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('error', Boolean(isError));
}

// The capture card's status line. The empty state has its own (empty-status),
// because the two sections are never on screen together.
function say(text, isError = false) {
  sayIn(view.status, text, isError);
}

// ---------------------------------------------------------------- messaging

async function ask(type, extra) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type, ...extra });
  } catch {
    // No receiver: the tab predates the install, or it is not a capture page.
    return null;
  }
}

/** Every captured body that can hold list definitions: the page's own
 * hydration batches plus anything fetched on request. One list, so coverage
 * counting and export bundling can never disagree about what was captured. */
function relatedBodies(related) {
  if (!related) return [];
  return [...(related.listBatches || []), ...(related.fetchedLists || [])];
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;

  const onHubSpot = typeof tab?.url === 'string' && /:\/\/[^/]*hubspot\.com\//.test(tab.url);
  const pageIds = onHubSpot ? idsFromPageUrl(tab.url) : idsFromPageUrl('');
  const subject = pageIds.flowId
    ? 'workflow'
    : pageIds.listId
      ? 'segment'
      : pageIds.objectTypeId && pageIds.objectId
        ? 'record'
        : null;
  // Refresh replays the captured URL verbatim, and records deliberately
  // construct none (endpoints.js builds no record URL), so first-fetch is
  // only an offer the bridge can honor on a workflow or a segment.
  const canFetch = subject === 'workflow' || subject === 'segment';

  const status = await ask(POPUP_MSG.STATUS);

  if (!status || !status.hasCapture) {
    snapshot = null;
    variants = new Map();

    if (!status) {
      // No receiver: the tab predates the install, or the page is not one the
      // capture scripts run on. Fetching is not on offer, because there is
      // nothing on the other end to do it.
      showEmpty(
        subject || pageIds.app
          ? 'Reload this page. Portal Peeker only sees requests made after it loads.'
          : 'Already on one? Reload the page. Portal Peeker only sees requests made after it loads.',
      );
      return;
    }

    // The bridge is listening but saw nothing. When the URL names a workflow
    // or a segment, the bridge can fetch it on request, which beats asking the
    // user to reload and hope. A record gets the reload hint only: there is no
    // captured URL to repeat, so a Fetch button here could not work.
    showEmpty(
      subject === 'record'
        ? 'Nothing captured for this record yet. Reload the page.'
        : subject
          ? `Nothing captured for this ${subject} yet. Fetch it from HubSpot, or reload the page.`
          : pageIds.app === 'workflows'
            ? 'Nothing captured for this flow yet. Reload the page, or open the workflow again.'
            : 'Nothing captured yet. Open a workflow, a segment, or a record and reload the page.',
      { canFetch },
    );
    return;
  }

  snapshot = status;
  variants = new Map();
  render(status);
}

// ---------------------------------------------------------------- options

function restoreOptions() {
  try {
    view.trim.checked = localStorage.getItem(STORAGE.trim) === 'true';
    view.strip.checked = localStorage.getItem(STORAGE.strip) === 'true';
    // The property values trim defaults off like the workflow trim: both
    // change bytes, and only the two pure insertions earn a default of on.
    view.values.checked = localStorage.getItem(STORAGE.values) === 'true';
    // Numbers, referenced lists, and the context block default on: only an
    // explicit untick, stored as 'false', turns them off. Absent means
    // checked, matching the markup.
    view.numbers.checked = localStorage.getItem(STORAGE.numbers) !== 'false';
    view.related.checked = localStorage.getItem(STORAGE.related) !== 'false';
    view.context.checked = localStorage.getItem(STORAGE.context) !== 'false';
  } catch {
    // Private mode or blocked storage. Defaults are fine.
  }
}

function persistOptions() {
  try {
    localStorage.setItem(STORAGE.trim, String(view.trim.checked));
    localStorage.setItem(STORAGE.strip, String(view.strip.checked));
    localStorage.setItem(STORAGE.numbers, String(view.numbers.checked));
    localStorage.setItem(STORAGE.related, String(view.related.checked));
    localStorage.setItem(STORAGE.values, String(view.values.checked));
    localStorage.setItem(STORAGE.context, String(view.context.checked));
  } catch {
    /* preference is not worth an error message */
  }
}

function onOptionChange() {
  persistOptions();
  if (!snapshot) return;
  const domain = domainOf(snapshot, summaryFor(snapshot.raw));
  const isFlow = domain === CAPTURE_DOMAIN.FLOW;
  const isRecord = domain === CAPTURE_DOMAIN.RECORD;
  const trimCheck = isFlow ? trimFor(snapshot.raw, view.strip.checked) : { ok: false, reason: null };
  renderOptions(
    domain,
    trimCheck.ok,
    trimCheck.reason,
    isFlow ? numbersFor(snapshot.raw) : null,
    contextCheckFor(snapshot.raw),
    relatedStateFor(domain, snapshot),
    isRecord ? recordTrimFor(snapshot.raw) : null,
  );
  renderSizes();
  say('');
}

view.trim.addEventListener('change', onOptionChange);
view.strip.addEventListener('change', onOptionChange);
view.numbers.addEventListener('change', onOptionChange);
view.related.addEventListener('change', onOptionChange);
view.values.addEventListener('change', onOptionChange);
view.context.addEventListener('change', onOptionChange);

// ---------------------------------------------------------------- nav

const PAGES = [
  { id: 'home', tab: view.navHome, panel: view.pageHome },
  { id: 'settings', tab: view.navSettings, panel: view.pageSettings },
];

function showPage(id, { focus = false } = {}) {
  page = id;
  for (const entry of PAGES) {
    const on = entry.id === id;
    entry.panel.hidden = !on;
    entry.tab.setAttribute('aria-selected', String(on));
    // Roving tabindex: one stop for the whole rail, arrows move within it.
    entry.tab.tabIndex = on ? 0 : -1;
    if (on && focus) entry.tab.focus();
  }
  view.kind.hidden = !(id === 'home' && hasKind);
}

function onRailKeydown(event) {
  const index = PAGES.findIndex((entry) => entry.tab === event.target);
  if (index === -1) return;

  const moves = {
    ArrowDown: index + 1,
    ArrowRight: index + 1,
    ArrowUp: index - 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: PAGES.length - 1,
  };
  if (!(event.key in moves)) return;

  event.preventDefault();
  const next = (moves[event.key] + PAGES.length) % PAGES.length;
  showPage(PAGES[next].id, { focus: true });
}

for (const entry of PAGES) {
  entry.tab.addEventListener('click', () => showPage(entry.id));
  entry.tab.addEventListener('keydown', onRailKeydown);
}

// ---------------------------------------------------------------- settings

/**
 * Build the Settings page from the table, so adding a setting is one entry in
 * packages/overlay/src/settings.js and nothing here.
 *
 * Nodes, not markup from strings, same rule as setDelta above.
 */
function renderSettings() {
  view.settingsList.replaceChildren();

  for (const setting of SETTINGS) {
    const label = document.createElement('label');
    label.className = 'check';
    label.htmlFor = setting.input;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = setting.input;
    input.checked = setting.default;
    input.addEventListener('change', () => writeSetting(setting.id, input.checked));

    const text = document.createElement('span');
    text.textContent = setting.label;

    label.append(input, text);

    const note = document.createElement('p');
    note.className = 'set-note';
    note.textContent = setting.note;

    view.settingsList.append(label, note);
  }

  // Empty unless something is wrong. Where settings live is stated in
  // PRIVACY.md and the README, which is where someone goes to check it, and
  // repeating it on every visit to a two-line panel was not earning its space.
  view.settingsFoot.textContent = '';

  // A checkbox that silently resets is worse than one that says why. This can
  // only happen on a stale unpacked load, where Chrome serves these files fresh
  // from disk but still runs a manifest from before the storage permission
  // existed. Withdrawn with the reason, same posture as the export options.
  if (!settingsStoreAvailable()) {
    for (const setting of SETTINGS) {
      const input = el(setting.input);
      if (!input) continue;
      input.disabled = true;
      input.parentElement.classList.add('is-disabled');
    }
    view.settingsFoot.textContent =
      'Settings cannot be saved right now. Reload Portal Peeker in chrome://extensions, ' +
      'then reopen this popup.';
  }
}

/**
 * Fill the checkboxes in from storage.
 *
 * Async, unlike restoreOptions: chrome.storage is promise based. That is
 * invisible because the Settings page is hidden when the popup opens, and the
 * table's defaults are already rendered before this resolves.
 */
async function restoreSettings() {
  const values = await readSettings();
  for (const setting of SETTINGS) {
    const input = el(setting.input);
    if (input) input.checked = values[setting.id];
  }
}

// ---------------------------------------------------------------- info tip

// Hover previews the explanation, click pins it open (touch and keyboard have
// no hover). The button sits inside the label, and an interactive descendant
// of a label does not activate its control, so clicking it never toggles the
// checkbox.
//
// Every tip occupies the same overlay slot, so opening one closes the others.
const tips = [];

function wireTip(button, panel) {
  let pinned = false;

  const show = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  const tip = { close: () => { pinned = false; show(false); } };
  const open = () => {
    for (const other of tips) if (other !== tip) other.close();
    show(true);
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    pinned = !pinned;
    if (pinned) open();
    else show(false);
  });
  button.addEventListener('mouseenter', open);
  button.addEventListener('mouseleave', () => {
    if (!pinned) show(false);
  });
  button.addEventListener('focus', open);
  button.addEventListener('blur', () => {
    if (!pinned) show(false);
  });

  tips.push(tip);
  return tip;
}

wireTip(view.numbersInfo, view.numbersTip);
wireTip(view.relatedInfo, view.relatedTip);
wireTip(view.valuesInfo, view.valuesTip);
wireTip(view.contextInfo, view.contextTip);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') for (const tip of tips) tip.close();
});

// ---------------------------------------------------------------- actions

async function freshPayload() {
  const payload = await ask(POPUP_MSG.PAYLOAD);
  if (!payload || !payload.hasCapture) {
    say('The capture is gone. Reload the page and try again.', true);
    return null;
  }
  return payload;
}

// Named by the step that refused, so the message points at the checkbox to
// untick rather than at the export in general.
const FAILURE = {
  trim: 'Could not trim this payload.',
  numbers: 'Could not number this payload.',
  related: 'Could not bundle the referenced lists.',
  values: 'Could not trim this record to property values.',
  context: 'Could not add the AI context block.',
};

const failureText = (failed, ending) => `${FAILURE[failed] || 'Could not build this export.'} ${ending}`;

view.copy.addEventListener('click', async () => {
  const payload = await freshPayload();
  if (!payload) return;

  // Built from the freshly pulled body, never from a cached result.
  const output = buildExport(payload.raw, payload);
  if (output.failed) {
    say(failureText(output.failed, 'Nothing was copied.'), true);
    return;
  }

  try {
    await navigator.clipboard.writeText(output.text);
    say(`Copied ${num(output.text.length)} characters${output.label}.`);
  } catch {
    const area = document.createElement('textarea');
    area.value = output.text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    say(ok ? `Copied${output.label}.` : 'Could not write to the clipboard.', !ok);
  }
});

view.download.addEventListener('click', async () => {
  const payload = await freshPayload();
  if (!payload) return;

  const output = buildExport(payload.raw, payload);
  if (output.failed) {
    say(failureText(output.failed, 'Nothing was saved.'), true);
    return;
  }

  // The suffix is the only marker that a file is not a verbatim capture. The
  // extension adds exactly three keys in band, uiNumber, _related, and
  // _aiContext, each behind its own checkbox, and a file carrying one always
  // carries the matching suffix (the property values trim only removes, so
  // that claim is untouched by it). Segment files carry a list- prefix on the
  // id, and record files a record- prefix on the type and id pair, because a
  // bare number in a filename no longer says which kind of export it is.
  //
  // Fresh summarize, not summaryFor: the payload was just pulled and may
  // postdate the snapshot the variants cache describes.
  const summary = summarize(payload.raw);
  const domain = domainOf(payload, summary);
  let stem;
  if (domain === CAPTURE_DOMAIN.RECORD) {
    // Identifiers first, slug last, so the file stays identifiable when the
    // slug drops out. This is the one place a resolved record name reaches
    // the filesystem; the popup itself never displays it.
    const slug = nameSlug(summary.name);
    const typeId = summary.objectTypeId || payload.objectTypeId || 'unknown';
    const recordId = summary.objectId || payload.objectId || 'unknown';
    stem = `record-${typeId}-${recordId}${slug ? `-${slug}` : ''}`;
  } else if (domain === CAPTURE_DOMAIN.LIST) {
    stem = `list-${payload.listId || 'unknown'}`;
  } else {
    stem = payload.flowId || 'unknown-flow';
  }
  const name = `${localDateStamp()}-${stem}${output.suffix}.json`;
  const url = URL.createObjectURL(new Blob([output.text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  say(`Saved ${name}`);
});

view.refresh.addEventListener('click', async () => {
  view.refresh.disabled = true;
  say('Refetching...');

  const result = await ask(POPUP_MSG.REFRESH);
  view.refresh.disabled = false;

  if (!result) {
    say('The page is not responding. Reload it and try again.', true);
    return;
  }

  if (!result.ok) {
    say(refreshErrorText(result), true);
    return;
  }

  await load();
  // Refetch returns saved state. If the user has edits they have not saved,
  // this will not show them, and saying nothing would be claiming a currency we
  // do not have.
  say('Refreshed. This is the last saved state, not unsaved edits.');
});

// The empty state's first fetch. Same bridge message as Refresh, same single
// user-initiated GET to HubSpot; only the surrounding copy differs, because
// here there is no previous capture to fall back to.
view.fetch.addEventListener('click', async () => {
  view.fetch.disabled = true;
  sayIn(view.emptyStatus, 'Fetching from HubSpot...');

  const result = await ask(POPUP_MSG.REFRESH);
  view.fetch.disabled = false;

  if (!result) {
    sayIn(view.emptyStatus, 'The page is not responding. Reload it and try again.', true);
    return;
  }

  if (!result.ok) {
    sayIn(view.emptyStatus, refreshErrorText(result), true);
    return;
  }

  await load();
  say('Fetched. This is the last saved state, not unsaved edits.');
});

// Fetch missing on the Referenced row: one GET per referenced list whose
// definition is not in the bundle yet. The bridge does the fetching (cookies
// and CSRF live there); this side only knows which ids are missing, from the
// same arithmetic the row displays.
view.fetchRefs.addEventListener('click', async () => {
  if (!snapshot) return;
  const summary = summaryFor(snapshot.raw);
  const refs = summary.referencedListIds || [];
  const captured = new Set(listIdsInBatches(relatedBodies(snapshot.related)));
  const missing = refs.filter((id) => !captured.has(id));
  if (!missing.length) return;

  view.fetchRefs.disabled = true;
  say(`Fetching ${num(missing.length)} referenced list${missing.length === 1 ? '' : 's'}...`);

  const result = await ask(POPUP_MSG.FETCH_REFERENCED, { listIds: missing });
  view.fetchRefs.disabled = false;

  if (!result) {
    say('The page is not responding. Reload it and try again.', true);
    return;
  }
  if (!result.ok) {
    say(refreshErrorText(result), true);
    return;
  }

  await load();
  const failed = Array.isArray(result.failed) ? result.failed : [];
  // Each failure carries what HubSpot answered, because the number is the
  // diagnosis: 404 has meant a system-managed internal list with no fetchable
  // definition, which is a different situation from a 403 or a dropped
  // connection.
  const named = failed.map((f) =>
    f && typeof f === 'object' ? `list ${f.id} (${f.status})` : `list ${f}`,
  );
  say(
    failed.length
      ? `Fetched ${num(result.fetched)}; could not fetch ${named.join(', ')}.`
      : `Fetched ${num(result.fetched)} referenced list definition${result.fetched === 1 ? '' : 's'}.`,
    failed.length > 0,
  );
});

function refreshErrorText(result) {
  switch (result.error) {
    case REFRESH_ERROR.CSRF_UNREADABLE:
      return 'Could not read the csrf.app cookie. Reload the page and try again.';
    case REFRESH_ERROR.NO_ID:
      return 'Could not tell which workflow, segment, or record this is. Open one and try again.';
    case REFRESH_ERROR.NO_CAPTURED_URL:
      return 'Reload the page to capture this record. Refresh repeats the exact request the page made, so it needs a capture first.';
    case REFRESH_ERROR.HTTP:
      return result.status === 401
        ? 'HubSpot returned 401. Reload the page and try again. Your previous capture is untouched.'
        : `HubSpot returned ${result.status}. Your previous capture is untouched.`;
    case REFRESH_ERROR.EMPTY:
      return 'HubSpot returned an empty body. Your previous capture is untouched.';
    default:
      return 'Refetch failed. Your previous capture is untouched.';
  }
}

restoreOptions();
renderSettings();
restoreSettings();
showPage('home');
load();
