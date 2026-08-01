// Fails the build if anything that looks like real HubSpot portal data is about
// to be committed.
//
// This check exists because it was needed. A set of captures was published with
// a live portal id, flow id, user id, and legacy workflow id in them, and the
// only thing standing between that and a public repo was somebody remembering.
// Remembering is not a control.
//
// The approach is an allowlist, not a blocklist. Every large integer that may
// appear in a committed fixture is enumerated below. Anything else fails, which
// means a fresh capture dropped into __fixtures__ without scrubbing cannot pass,
// even though nobody predicted what its ids would be.
//
// Real captures belong in __fixtures__/private, which is gitignored and skipped
// here.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every synthetic identifier permitted to appear in a committed file. Adding to
// this list is a deliberate act: pick a value that is obviously invented.
const ALLOWED_IDS = new Set([
  // synthetic/trim-cases
  111111111, 2222222222, 5550001, 5550002, 88888888, 177946906, 4242, 999000111,
  // synthetic captures, scrubbed from a trial portal
  12345678, 1000000001, 60000001, 70000001, 80000001, 80000002, 80000003,
  1780000000000, 1780000600000, 1780001200000, 1780000900000,
  // synthetic legacy workflow id used in the endpoints tests
  771000001,
  // structural constants that are not identifiers
  30000, 1024,
]);

// A HubSpot portal id is six or more digits. Anything shorter is a list id,
// an association type, or an action id, none of which identify a portal.
const MIN_SUSPICIOUS = 100000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'private']);
const SCAN_EXT = new Set(['.json', '.js', '.mjs', '.md', '.html', '.yml']);

// package-lock is npm's, full of integrity hashes and unrelated numbers. This
// file is skipped because it necessarily contains the allowlist itself.
const SKIP_FILES = new Set(['package-lock.json', 'check-no-portal-data.mjs']);

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXT.has(extname(full))) continue;
    scan(full);
  }
}

function scan(file) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');

  for (const [index, line] of text.split('\n').entries()) {
    // Any run of digits long enough to be a portal, flow, or user id.
    for (const match of line.matchAll(/\d{6,}/g)) {
      const value = Number(match[0]);
      if (!Number.isFinite(value) || value < MIN_SUSPICIOUS) continue;
      if (ALLOWED_IDS.has(value)) continue;
      failures.push(
        `${rel}:${index + 1} unrecognized ${match[0].length}-digit identifier ${match[0]}\n` +
          `    If this is synthetic, add it to ALLOWED_IDS in tools/check-no-portal-data.mjs.\n` +
          `    If it came from a real portal, it must not be committed. Scrub it, or move the\n` +
          `    file to packages/core/__fixtures__/private/ which is gitignored.`,
      );
    }

    // A hubspot.com URL carrying an identifier-length number is a portal-scoped
    // link. Short digits like the "v1" in an API path are not.
    for (const url of line.matchAll(/https?:\/\/[^\s"'`)]*hubspot\.com[^\s"'`)]*/g)) {
      const ids = [...url[0].matchAll(/\d{6,}/g)].map((m) => Number(m[0]));
      const unknown = ids.filter((id) => !ALLOWED_IDS.has(id));
      if (unknown.length) {
        failures.push(
          `${rel}:${index + 1} hubspot.com URL containing unrecognized identifiers ` +
            `${unknown.join(', ')}: ${url[0]}`,
        );
      }
    }
  }
}

walk(ROOT);

if (failures.length) {
  console.error('portal-data check FAILED:\n');
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log('portal-data check passed: no unrecognized identifiers in tracked files');
