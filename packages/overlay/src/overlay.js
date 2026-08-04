// The content-script host: a feature registry, one observer, one lifecycle.
//
// This file owns the setting, the observer, the debounce, and the cycle
// breaker. It owns no knowledge of any particular page. Each feature supplies
// present(), annotate(), and remove(). Record pages were the first surface added
// after this shape was chosen, and they cost one import, one FEATURES entry, and
// one match pattern, which is what the registry was for. register() stays for a
// caller outside this module.
//
// Runs in the ISOLATED world, so it shares the page's DOM but not its window,
// and it does have chrome.* available. Nothing here patches or reads anything
// the page owns beyond the DOM it annotates.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { SETTING } from './settings.js';
import { readSettings, onSettingsChanged } from './settings-store.js';
import { propertyListFeature } from './property-list.js';
import { recordPropertiesFeature } from './record-properties.js';

const FEATURES = [propertyListFeature, recordPropertiesFeature];

// A background tab is served no animation frames, so a rAF-only debounce would
// stall there until it is looked at. 200ms is imperceptible on a tab nobody is
// watching.
const HIDDEN_TAB_DELAY = 200;

// The cycle breaker. If something on the page re-renders in response to our own
// insertions, passes that insert will keep arriving. Above this many in one
// window, stop observing and retry on a timer instead: an annotation that comes
// back slowly is a nuisance, one that never comes back until a reload is a bug
// report.
const RUN_BUDGET = 20;
const BUDGET_WINDOW = 1000;
const BACKOFF_DELAY = 2000;

let enabled = false;
let observer = null;
let scheduled = false;
let backoff = null;
let windowStartedAt = 0;
let insertingPasses = 0;

const now = () => Date.now();

/** Register a surface. Exported so a second one is additive. */
export function register(feature) {
  if (feature && !FEATURES.includes(feature)) FEATURES.push(feature);
}

/**
 * One sweep across every registered feature.
 *
 * Each feature's present() is its own cheap bail, so a surface that is not on
 * screen costs one querySelector. Every feature is wrapped: one that throws
 * must not cost the others their pass, and must never reach the page.
 */
function pass() {
  let inserted = 0;
  for (const feature of FEATURES) {
    try {
      if (!feature.present(document)) continue;
      const result = feature.annotate(document);
      inserted += result && result.inserted ? result.inserted : 0;
    } catch {
      /* this feature sits out this pass */
    }
  }
  return inserted;
}

/**
 * Run a pass and decide whether the page is fighting us.
 *
 * Our own insertions are mutations and will re-enter the observer. That is
 * fine, and it is handled by convergence rather than suppression: the next pass
 * finds every row already annotated, inserts nothing, and so produces no pass
 * after it.
 *
 * Deliberately NOT disconnecting and reconnecting around the pass. That is the
 * reflex fix for a self-triggering observer and it is wrong here: it drops any
 * HubSpot mutation that lands inside the window, trading a loop that stops
 * itself for a row that silently never gets annotated.
 */
function fire() {
  scheduled = false;
  if (!enabled) return;

  const inserted = pass();
  if (!inserted) return;

  const at = now();
  if (at - windowStartedAt > BUDGET_WINDOW) {
    windowStartedAt = at;
    insertingPasses = 0;
  }

  insertingPasses += 1;
  if (insertingPasses > RUN_BUDGET) startBackoff();
}

function startBackoff() {
  disconnect();
  if (backoff) return;
  backoff = setTimeout(() => {
    backoff = null;
    insertingPasses = 0;
    windowStartedAt = 0;
    if (enabled) connect();
  }, BACKOFF_DELAY);
}

function schedule() {
  if (scheduled || !enabled) return;
  scheduled = true;
  if (typeof document !== 'undefined' && document.hidden) {
    setTimeout(fire, HIDDEN_TAB_DELAY);
    return;
  }
  requestAnimationFrame(fire);
}

function connect() {
  if (observer) return;
  observer = new MutationObserver(schedule);
  // The callback ignores the record list entirely and only schedules, so this
  // is O(1) per batch however large the batch is.
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}

function disconnect() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
}

/** Turn the annotation on or off. Idempotent in both directions. */
export function apply(on) {
  if (on === enabled) return;
  enabled = on;

  if (on) {
    connect();
    return;
  }

  disconnect();
  if (backoff) {
    clearTimeout(backoff);
    backoff = null;
  }
  for (const feature of FEATURES) {
    try {
      feature.remove(document);
    } catch {
      /* leaving a node behind is better than throwing into the page */
    }
  }
}

/** Read the setting, obey it, and keep obeying it as it changes. */
export async function start() {
  onSettingsChanged((settings) => apply(settings[SETTING.API_NAMES]));
  const settings = await readSettings();
  apply(settings[SETTING.API_NAMES]);
}

// Bootstrap only inside a real extension page. Guarded so the module can be
// imported by a test without starting an observer or reaching for chrome.*.
if (typeof chrome !== 'undefined' && chrome.storage) start();
