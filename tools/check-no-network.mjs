// The extension makes zero network calls. This is the product's core claim,
// not a preference, so it is checked mechanically rather than by review.
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

// Documentation and schema URLs that are never fetched at runtime.
const IGNORED_PREFIXES = ['http://www.w3.org/', 'https://www.w3.org/'];

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
if ((manifest.permissions || []).length > 0) {
  failures.push(`the extension should request no extra permissions, found ${JSON.stringify(manifest.permissions)}`);
}

if (failures.length) {
  console.error('no-network check FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`no-network check passed across ${files.length} built files`);
