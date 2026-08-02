// The popup owns no capture state. It asks the bridge content script in the
// active tab for the snapshot every time it opens, and asks again immediately
// before Copy or Download so a save that landed while it was open cannot ship
// stale bytes.
//
// Trimming happens here, downstream of capture, never in the bridge. The bridge
// serves raw and only raw. That is what keeps the capture path parser-free: a
// bug in the trim can cost an export, never a capture.
//
// The preferences this page owns (the four checkboxes) live in localStorage
// rather than chrome.storage, which keeps the extension at zero permissions.
// Nothing about a capture is ever persisted anywhere.

import { POPUP_MSG, REFRESH_ERROR, CAPTURE_KIND } from './lib/protocol.js';
import { summarize } from './lib/summary.js';
import { trim, estimateTokens } from './lib/trim.js';
import { uiNumbersFromText, addUiNumbers } from './lib/ui-numbers.js';
import { buildAiContext, checkAiContext, addAiContext, MODIFICATIONS } from './lib/ai-context.js';

const el = (id) => document.getElementById(id);

const view = {
  empty: el('empty'),
  emptyHint: el('empty-hint'),
  capture: el('capture'),
  kind: el('kind'),
  name: el('f-name'),
  flow: el('f-flow'),
  portal: el('f-portal'),
  version: el('f-version'),
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
  context: el('opt-context'),
  contextInfo: el('context-info'),
  contextTip: el('context-tip'),
};

const STORAGE = {
  trim: 'portal-peeker.trim',
  strip: 'portal-peeker.stripHtml',
  numbers: 'portal-peeker.uiNumbers',
  context: 'portal-peeker.aiContext',
};

let tabId = null;
let snapshot = null;
/** trim results for the open capture, keyed by option combination. */
let variants = new Map();

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

function summaryFor(raw) {
  if (!variants.has('summary')) variants.set('summary', summarize(raw));
  return variants.get('summary');
}

/** Context-carrying variant of an export, for the size and token rows. */
function contextedFor(key, text, meta) {
  if (!variants.has(key)) variants.set(key, addAiContext(text, buildAiContext(meta)));
  return variants.get(key);
}

const numbersWanted = () => view.numbers.checked && !view.numbers.disabled;
const contextWanted = () => view.context.checked && !view.context.disabled;

/**
 * Everything the block says about this export.
 *
 * Core computes none of it: the extension version, the clock, and which options
 * ran are all facts about this page, and a pure module has no business guessing
 * at any of them. Whatever is unknown is passed as null and left out.
 */
function contextMeta(summary, source, applied) {
  return {
    capturedAtIso: Number.isFinite(source.capturedAt)
      ? new Date(source.capturedAt).toISOString()
      : null,
    capturedFrom: CAPTURED_FROM[source.kind] || null,
    flowId: summary.flowId || source.flowId || null,
    flowName: summary.name,
    portalId: summary.portalId,
    flowVersion: summary.version,
    extensionVersion: manifestVersion(),
    modifications: applied,
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

  if (view.trim.checked) {
    const stripHtml = view.strip.checked;
    const result = cached ? trimFor(raw, stripHtml) : trim(raw, { stripHtml });
    if (!result.ok) return { failed: 'trim' };

    text = result.output;
    note('trimmedToWorkflowLogic');
    if (stripHtml) note('htmlStrippedFromEmailBodies');
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

function showEmpty(hint) {
  view.capture.hidden = true;
  view.kind.hidden = true;
  view.empty.hidden = false;
  if (hint) view.emptyHint.textContent = hint;
}

function renderSizes() {
  const raw = snapshot.raw;
  const rawBytes = snapshot.byteLength;
  const rawTokens = estimateTokens(raw);

  // The percentage is shown whether or not the box is ticked, so the payoff is
  // visible before committing to it.
  const preview = trimFor(raw, view.strip.checked);
  if (preview.ok) {
    const pct = Math.round(100 - (preview.outputBytes / rawBytes) * 100);
    view.trimLabel.textContent = `Trim to workflow logic (est. ${pct}%)`;
  } else {
    view.trimLabel.textContent = 'Trim to workflow logic';
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

function renderOptions(trimmable, reason, numbersCheck, contextCheck) {
  view.trim.disabled = !trimmable;
  view.trim.parentElement.classList.toggle('is-disabled', !trimmable);
  if (!trimmable) view.trim.checked = false;

  // Stripping HTML rewrites values, which only a trim's output can absorb, so
  // it is the trim's sub-option and the only one.
  const onTopOfTrim = trimmable && view.trim.checked;
  view.strip.disabled = !onTopOfTrim;
  view.strip.parentElement.classList.toggle('is-disabled', !onTopOfTrim);

  // Numbering stands on its own: it inserts text and rewrites nothing, so it
  // works on raw bytes. It is withdrawn only when the graph has a shape the
  // walker does not recognize, and then entirely rather than partially: a file
  // where some cards carry numbers and some do not looks complete while lying.
  const numbersOk = Boolean(numbersCheck && numbersCheck.ok);
  view.numbers.disabled = !numbersOk;
  view.numbers.parentElement.classList.toggle('is-disabled', !numbersOk);
  view.numbers.parentElement.title = numbersOk
    ? ''
    : `Editor numbers unavailable: ${numbersCheck ? numbersCheck.reason : 'no capture'}`;

  // The context block rides on nothing: it is one inserted key, so it works on
  // a trimmed export and on raw bytes alike. It is withdrawn only when the
  // payload cannot carry it, which is a fact about the payload, not the trim.
  const contextOk = Boolean(contextCheck && contextCheck.ok);
  view.context.disabled = !contextOk;
  view.context.parentElement.classList.toggle('is-disabled', !contextOk);
  view.context.parentElement.title = contextOk ? '' : `AI context unavailable: ${contextCheck.reason}`;

  return reason;
}

function render(status) {
  view.empty.hidden = true;
  view.capture.hidden = false;
  view.kind.hidden = false;
  view.kind.textContent = KIND_LABEL[status.kind] || 'captured';

  const summary = summaryFor(status.raw);

  view.name.textContent = summary.name || 'Name not found in payload';
  // The bridge knows the flow ID from the URL even when the body will not
  // parse, so prefer whichever is present.
  view.flow.textContent = summary.flowId || status.flowId || 'not found';
  view.portal.textContent = summary.portalId || 'not found';
  view.version.textContent = summary.version != null ? String(summary.version) : 'not found';
  view.when.textContent = formatWhen(status.capturedAt);

  const trimCheck = trimFor(status.raw, view.strip.checked);
  renderOptions(trimCheck.ok, trimCheck.reason, numbersFor(status.raw), contextCheckFor(status.raw));

  if (summary.recognized && trimCheck.ok) {
    view.degraded.hidden = true;
  } else {
    view.degraded.hidden = false;
    // Copy and Download keep working on raw bytes no matter what the parser
    // makes of the payload. Trimming does not: a partly trimmed file looks
    // complete while missing whatever the rules never reached, so it is
    // withdrawn rather than attempted.
    const detail = summary.recognized ? trimCheck.reason : summary.reason;
    view.degraded.textContent = `Shape not fully recognized: ${detail}. Copy and Download still work on the exact captured bytes. Trimming is unavailable for this payload.`;
  }

  renderSizes();

  view.copy.disabled = false;
  view.download.disabled = false;
  view.refresh.disabled = false;
}

function say(text, isError = false) {
  view.status.textContent = text;
  view.status.classList.toggle('error', Boolean(isError));
}

// ---------------------------------------------------------------- messaging

async function ask(type) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    // No receiver: the tab predates the install, or it is not a workflow page.
    return null;
  }
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;

  const onWorkflowPage = typeof tab?.url === 'string' && /:\/\/[^/]*hubspot\.com\/workflows\//.test(tab.url);

  const status = await ask(POPUP_MSG.STATUS);

  if (!status || !status.hasCapture) {
    snapshot = null;
    variants = new Map();
    showEmpty(
      onWorkflowPage
        ? status
          ? 'Nothing captured for this flow yet. Reload the page, or open the workflow again.'
          : 'Reload this page. Portal Peeker only sees requests made after it loads.'
        : 'Already on one? Reload the page. Portal Peeker only sees requests made after it loads.',
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
    // Numbers and the context block default on: only an explicit untick, stored
    // as 'false', turns them off. Absent means checked, matching the markup.
    view.numbers.checked = localStorage.getItem(STORAGE.numbers) !== 'false';
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
    localStorage.setItem(STORAGE.context, String(view.context.checked));
  } catch {
    /* preference is not worth an error message */
  }
}

function onOptionChange() {
  persistOptions();
  if (!snapshot) return;
  const trimCheck = trimFor(snapshot.raw, view.strip.checked);
  renderOptions(trimCheck.ok, trimCheck.reason, numbersFor(snapshot.raw), contextCheckFor(snapshot.raw));
  renderSizes();
  say('');
}

view.trim.addEventListener('change', onOptionChange);
view.strip.addEventListener('change', onOptionChange);
view.numbers.addEventListener('change', onOptionChange);
view.context.addEventListener('change', onOptionChange);

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
  // extension adds exactly two keys in band, uiNumber and _aiContext, each
  // behind its own checkbox, and a file carrying one always carries the
  // matching suffix.
  const name = `${localDateStamp()}-${payload.flowId || 'unknown-flow'}${output.suffix}.json`;
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

function refreshErrorText(result) {
  switch (result.error) {
    case REFRESH_ERROR.CSRF_UNREADABLE:
      return 'Could not read the csrf.app cookie. Reload the page and try again.';
    case REFRESH_ERROR.NO_FLOW_ID:
      return 'Could not tell which flow this is. Open the workflow editor and try again.';
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
load();
