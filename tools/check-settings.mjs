// Settings are user preferences, stored locally, and nothing else.
//
// The extension now asks for a storage permission, so what goes in that storage
// needs a guard rather than a promise. Three claims, checked against the built
// bundle and the one table that declares them:
//
//   1. The storage area is the declared one. sync would replicate settings
//      through Google's servers, which falsifies PRIVACY.md's "What leaves
//      your computer". session would silently change how long they last.
//   2. Every key written or read is a key the table declares, so nothing can
//      accumulate in storage that no code path admits to.
//   3. The table itself is coherent: no duplicates, every field present, and
//      no checkbox id that collides with the export options that
//      tools/check-ai-context.mjs counts.
//
// This is the same idiom as check-ai-context.mjs: read the source of truth,
// read the built output, and fail when they disagree.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { SETTINGS, STORAGE_AREA, STORAGE_KEYS } from '../packages/overlay/src/settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension/dist');

const AREAS = ['local', 'sync', 'session', 'managed'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const failures = [];

// ---------------------------------------------------------------- the table

for (const field of ['id', 'key', 'input', 'label', 'note']) {
  for (const setting of SETTINGS) {
    if (typeof setting[field] !== 'string' || setting[field] === '') {
      failures.push(`settings entry ${setting.id || '(unnamed)'} has no ${field}`);
    }
  }
  const values = SETTINGS.map((setting) => setting[field]);
  if (field !== 'label' && field !== 'note' && new Set(values).size !== values.length) {
    failures.push(`two settings entries share a ${field}`);
  }
}

for (const setting of SETTINGS) {
  if (typeof setting.default !== 'boolean') {
    failures.push(`settings entry ${setting.id} has no boolean default`);
  }
  // opt- belongs to the export options, which check-ai-context.mjs counts
  // against the MODIFICATIONS table. A settings checkbox borrowing that prefix
  // fails that check with a message about the AI context block, which sends the
  // next person down entirely the wrong trail.
  if (setting.input.startsWith('opt-')) {
    failures.push(
      `settings entry ${setting.id} uses the opt- prefix, which belongs to export options`,
    );
  }
}

// Pinned to local, not merely "consistent with whatever is declared". The
// checks further down compare the build against the declaration, which catches
// a stray chrome.storage.sync call but says nothing if the declaration itself
// is changed: the code would simply follow it and everything would agree.
//
// What is being protected is not internal consistency, it is a sentence.
// PRIVACY.md's "What leaves your computer" says one thing, only when you ask
// for it, and README says nothing else the extension does leaves your machine.
// sync would replicate settings through Google's servers automatically, which
// falsifies both. Changing this line is allowed, but it has to be a decision
// taken together with that copy rather than a one word edit nothing notices.
if (STORAGE_AREA !== 'local') {
  failures.push(
    `settings are declared to live in chrome.storage.${STORAGE_AREA}. Only local keeps ` +
      "PRIVACY.md's \"What leaves your computer\" section true. Changing this means " +
      'rewriting that section and the README privacy paragraph in the same commit.',
  );
}

// ---------------------------------------------------------------- the build

let files;
try {
  files = walk(DIST);
} catch {
  console.error('extension/dist not found. Run: npm run build');
  process.exit(1);
}

for (const file of files) {
  if (!['.js', '.html'].includes(extname(file))) continue;
  const rel = relative(ROOT, file);
  const source = stripComments(readFileSync(file, 'utf8'));

  for (const area of AREAS) {
    if (area === STORAGE_AREA) continue;
    if (new RegExp(`\\bchrome\\.storage\\.${area}\\b`).test(source)) {
      failures.push(
        `${rel}: uses chrome.storage.${area}, but settings are declared to live in ` +
          `chrome.storage.${STORAGE_AREA}`,
      );
    }
  }

  // Anything namespaced to this extension that the table does not declare.
  for (const match of source.matchAll(/'(portal-peeker\.[A-Za-z0-9_.-]+)'/g)) {
    const key = match[1];
    if (STORAGE_KEYS.includes(key)) continue;
    // The four export options predate this and live in the popup's own
    // localStorage, which is a different store and not what this guards.
    if (rel.endsWith('popup.js') || rel.endsWith('lib/settings.js')) continue;
    failures.push(`${rel}: writes the undeclared key ${key}`);
  }
}

if (failures.length) {
  console.error('settings check FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `settings check passed: ${SETTINGS.length} setting(s) in chrome.storage.${STORAGE_AREA}`,
);
