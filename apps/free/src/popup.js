// The popup owns no capture state. It asks the bridge content script in the
// active tab for the snapshot every time it opens, and asks again immediately
// before Copy or Download so a save that landed while it was open cannot ship
// stale bytes.
//
// Trimming happens here, downstream of capture, never in the bridge. The bridge
// serves raw and only raw. That is what keeps the capture path parser-free: a
// bug in the trim can cost an export, never a capture.
//
// The one preference this page owns (the two checkboxes) lives in localStorage
// rather than chrome.storage, which keeps the extension at zero permissions.
// Nothing about a capture is ever persisted anywhere.

import { POPUP_MSG, REFRESH_ERROR, CAPTURE_KIND } from './lib/protocol.js';
import { summarize } from './lib/summary.js';
import { trim, estimateTokens } from './lib/trim.js';

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
  strip: el('opt-strip'),
};

const STORAGE = { trim: 'portal-peeker.trim', strip: 'portal-peeker.stripHtml' };

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

// ---------------------------------------------------------------- trimming

function trimFor(raw, stripHtml) {
  const key = stripHtml ? 'strip' : 'plain';
  if (!variants.has(key)) variants.set(key, trim(raw, { stripHtml }));
  return variants.get(key);
}

/** What Copy and Download should actually emit, for a freshly pulled body. */
function exportFor(raw) {
  if (!view.trim.checked) {
    return { text: raw, suffix: '', label: '' };
  }
  const stripHtml = view.strip.checked;
  const result = trim(raw, { stripHtml });
  if (!result.ok) return null;
  return {
    text: result.output,
    suffix: stripHtml ? '-trimmed-stripped' : '-trimmed',
    label: stripHtml ? ' (trimmed, HTML stripped)' : ' (trimmed)',
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

  if (!view.trim.checked || !preview.ok) {
    setDelta(view.size, `${num(rawBytes)} bytes`, null, rawBytes < 1024 ? '' : ` (${(rawBytes / 1024).toFixed(1)} KB)`);
    setDelta(view.tokens, `~${num(rawTokens)}`, null);
    return;
  }

  setDelta(view.size, num(rawBytes), num(preview.outputBytes), ' bytes');
  setDelta(view.tokens, `~${num(rawTokens)}`, `~${num(estimateTokens(preview.output))}`);
}

function renderOptions(trimmable, reason) {
  view.trim.disabled = !trimmable;
  view.trim.parentElement.classList.toggle('is-disabled', !trimmable);
  if (!trimmable) view.trim.checked = false;

  // Stripping HTML rewrites values, so it is only offered on top of a trim.
  // With the trim off, output is byte-identical to what HubSpot sent, always.
  const stripAvailable = trimmable && view.trim.checked;
  view.strip.disabled = !stripAvailable;
  view.strip.parentElement.classList.toggle('is-disabled', !stripAvailable);

  return reason;
}

function render(status) {
  view.empty.hidden = true;
  view.capture.hidden = false;
  view.kind.hidden = false;
  view.kind.textContent = KIND_LABEL[status.kind] || 'captured';

  const summary = summarize(status.raw);

  view.name.textContent = summary.name || 'Name not found in payload';
  // The bridge knows the flow ID from the URL even when the body will not
  // parse, so prefer whichever is present.
  view.flow.textContent = summary.flowId || status.flowId || 'not found';
  view.portal.textContent = summary.portalId || 'not found';
  view.version.textContent = summary.version != null ? String(summary.version) : 'not found';
  view.when.textContent = formatWhen(status.capturedAt);

  const trimCheck = trimFor(status.raw, view.strip.checked);
  renderOptions(trimCheck.ok, trimCheck.reason);

  if (summary.recognized && trimCheck.ok) {
    view.degraded.hidden = true;
  } else {
    view.degraded.hidden = false;
    // Copy and Download keep working on raw bytes no matter what the parser
    // makes of the payload. Trimming does not: a partly trimmed file looks
    // complete while missing whatever the rules never reached, so it is
    // withdrawn rather than attempted.
    const detail = summary.recognized ? trimCheck.reason : summary.reason;
    view.degraded.textContent = `Shape not fully recognized: ${detail}. Copy and Download still give you the exact bytes. Trimming is unavailable for this payload.`;
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
  } catch {
    // Private mode or blocked storage. Defaults are fine.
  }
}

function persistOptions() {
  try {
    localStorage.setItem(STORAGE.trim, String(view.trim.checked));
    localStorage.setItem(STORAGE.strip, String(view.strip.checked));
  } catch {
    /* preference is not worth an error message */
  }
}

function onOptionChange() {
  persistOptions();
  if (!snapshot) return;
  const trimCheck = trimFor(snapshot.raw, view.strip.checked);
  renderOptions(trimCheck.ok, trimCheck.reason);
  renderSizes();
  say('');
}

view.trim.addEventListener('change', onOptionChange);
view.strip.addEventListener('change', onOptionChange);

// ---------------------------------------------------------------- actions

async function freshPayload() {
  const payload = await ask(POPUP_MSG.PAYLOAD);
  if (!payload || !payload.hasCapture) {
    say('The capture is gone. Reload the page and try again.', true);
    return null;
  }
  return payload;
}

view.copy.addEventListener('click', async () => {
  const payload = await freshPayload();
  if (!payload) return;

  // Trimmed from the freshly pulled body, never from a cached result.
  const output = exportFor(payload.raw);
  if (!output) {
    say('Could not trim this payload. Nothing was copied.', true);
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

  const output = exportFor(payload.raw);
  if (!output) {
    say('Could not trim this payload. Nothing was saved.', true);
    return;
  }

  // The suffix is the only marker that a file is not a verbatim capture.
  // Writing a marker key into the JSON would break the guarantee that every
  // value in a trimmed file came from HubSpot.
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
