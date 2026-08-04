// The extension talks to no host but hubspot.com. This is the product's core
// claim, not a preference, so it is checked mechanically rather than by review.
//
// Three checks against the built bundle:
//
//   1. No absolute URL to any host other than hubspot.com.
//   2. No import of anything under packages/server-client.
//   3. host_permissions is exactly hubspot.com, so a user can verify the claim
//      themselves in chrome://extensions without taking our word for it.
//
// A build that does talk to a server would live in a separate branch or repo
// and carry its own check. The allowlist below is deliberately the stronger
// form: it fails on any third-party host, including one nobody has thought of.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension/dist');

const ALLOWED_HOSTS = [/(^|\.)hubspot\.com$/];
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.mjs']);

// Documentation and schema URLs that are never fetched at runtime. polyform is
// here for the LICENSE that ships in the package: it has no extension so it is
// skipped today, but the exemption should be a decision rather than an accident
// of TEXT_EXTENSIONS.
const IGNORED_PREFIXES = [
  'http://www.w3.org/',
  'https://www.w3.org/',
  'https://polyformproject.org/',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const failures = [];

let files;
try {
  files = walk(DIST);
} catch {
  console.error('extension/dist not found. Run: npm run build');
  process.exit(1);
}

for (const file of files) {
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');

  for (const match of text.matchAll(/https?:\/\/[^\s'"`)<>\\]+/g)) {
    const url = match[0];
    if (IGNORED_PREFIXES.some((prefix) => url.startsWith(prefix))) continue;

    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!ALLOWED_HOSTS.some((pattern) => pattern.test(host))) {
      failures.push(`${rel}: absolute URL to a non-hubspot host: ${url}`);
    }
  }

  if (/server-client/.test(text)) {
    failures.push(`${rel}: references server-client, which must never reach the extension`);
  }
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const hosts = JSON.stringify(manifest.host_permissions);
if (hosts !== JSON.stringify(['*://*.hubspot.com/*'])) {
  failures.push(`manifest host_permissions must be exactly ["*://*.hubspot.com/*"], found ${hosts}`);
}
// An exact set, not "empty". storage holds the state of the Settings page
// checkboxes and has no network dimension at all, so failing on it would be
// this check measuring the wrong thing: the claim is "no host but hubspot.com".
// The claim the empty list used to stand in for, that nothing about a capture
// is persisted, is checked directly below instead.
const ALLOWED_PERMISSIONS = ['storage'];
const permissions = manifest.permissions || [];
if (JSON.stringify(permissions) !== JSON.stringify(ALLOWED_PERMISSIONS)) {
  failures.push(
    `manifest permissions must be exactly ${JSON.stringify(ALLOWED_PERMISSIONS)}, ` +
      `found ${JSON.stringify(permissions)}`,
  );
}

// Optional permissions are a way to widen scope after review, which defeats the
// point of a user being able to verify the grant in chrome://extensions.
for (const key of ['optional_permissions', 'optional_host_permissions']) {
  if (manifest[key]) failures.push(`manifest declares ${key}; scope must not be widenable later`);
}

// PRIVACY.md: the capture is held in one content script's memory and is "not
// written to chrome.storage". Now that a storage permission exists, that
// sentence needs a guard of its own rather than resting on there being no
// permission at all. Comments stripped first, same reason as the MAIN-world
// grep in tools/build.mjs: a check that cannot tell prose from code is a check
// nobody trusts for long.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const file of ['capture/bridge.js', 'capture/interceptor.js']) {
  const source = stripComments(readFileSync(join(DIST, file), 'utf8'));
  if (/\bchrome\.storage\b/.test(source)) {
    failures.push(`${file} references chrome.storage; the capture path persists nothing`);
  }
}

if (failures.length) {
  console.error('no-network check FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`no-network check passed across ${files.length} built files`);
