// Assembles extension/dist, the directory you point "Load unpacked" at.
//
// Why a build step exists at all: content scripts are not ES modules. A file
// declared in manifest.content_scripts is executed as a classic script, so it
// cannot import anything. But protocol.js and endpoints.js are needed by both
// the MAIN-world interceptor and the isolated-world bridge, and duplicating
// them is exactly how the two halves of a message channel drift apart.
//
// So: sources are authored as plain ES modules (one concern per file, directly
// testable in Vitest), and this script concatenates each content-script entry
// with its dependencies into one classic IIFE. Dependency lists are written out
// by hand below rather than discovered by parsing imports. Four files do not
// justify a module graph, and an explicit list is one less thing that can
// surprise you.
//
// Everything else (popup, service worker) loads as a real module and is copied
// verbatim.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ICON_SIZES, renderIcon } from './make-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension/dist');

const CAPTURE = 'packages/capture/src';
const CORE = 'packages/core/src';
const OVERLAY = 'packages/overlay/src';
const EXTENSION = 'extension/src';
const MANIFEST = 'extension/manifest.json';

// Each content-script entry, in load order. Order is the dependency order.
//
// capturesFetch marks the pair that wraps window.fetch. It is what the
// document_start assertion below keys on: that timing rule protects the
// interception race and says nothing about a script that only reads the DOM.
const BUNDLES = [
  {
    out: 'capture/interceptor.js',
    world: 'MAIN',
    capturesFetch: true,
    sources: [`${CAPTURE}/protocol.js`, `${CAPTURE}/endpoints.js`, `${CAPTURE}/interceptor.js`],
  },
  {
    out: 'capture/bridge.js',
    world: 'ISOLATED',
    capturesFetch: true,
    sources: [`${CAPTURE}/protocol.js`, `${CAPTURE}/endpoints.js`, `${CAPTURE}/bridge.js`],
  },
  {
    // MAIN world, document_start, and both are required. The properties
    // response is fetched once during page load and cached, so a script that
    // arrives at document_idle has already missed it. Measured, not assumed.
    out: 'overlay/property-names.js',
    world: 'MAIN',
    capturesFetch: true,
    sources: [
      `${OVERLAY}/property-names-protocol.js`,
      `${OVERLAY}/property-names-interceptor.js`,
    ],
  },
  {
    out: 'overlay/overlay.js',
    world: 'ISOLATED',
    capturesFetch: false,
    sources: [
      `${OVERLAY}/settings.js`,
      `${OVERLAY}/settings-store.js`,
      `${OVERLAY}/test-id.js`,
      `${OVERLAY}/property-rows.js`,
      `${OVERLAY}/property-names-protocol.js`,
      `${OVERLAY}/property-names.js`,
      `${OVERLAY}/property-names-store.js`,
      // Ahead of record-surfaces.js, and it has to be: the SURFACES table names
      // a PLACEMENT at module scope, and these fragments share one scope in load
      // order. Behind it, that read hits the temporal dead zone and the overlay
      // throws on load rather than at any point a test would reach.
      `${OVERLAY}/api-name-node.js`,
      `${OVERLAY}/record-surfaces.js`,
      `${OVERLAY}/property-list.js`,
      `${OVERLAY}/create-form.js`,
      `${OVERLAY}/record-properties.js`,
      `${OVERLAY}/overlay.js`,
    ],
  },
];

// Copied as-is. These load as ES modules and can import each other.
const COPIES = [
  [`${EXTENSION}/popup.html`, 'popup.html'],
  [`${EXTENSION}/popup.css`, 'popup.css'],
  [`${EXTENSION}/popup.js`, 'popup.js'],
  [`${EXTENSION}/service-worker.js`, 'service-worker.js'],
  [`${CAPTURE}/protocol.js`, 'lib/protocol.js'],
  // The popup reads the page URL the same way the bridge does (whose workflow
  // or segment is this tab on?), and two URL parsers is how they would drift.
  [`${CAPTURE}/endpoints.js`, 'lib/endpoints.js'],
  // Same trick as protocol.js above: one source, copied for the popup's module
  // loader and concatenated into the content-script bundle. That is what stops
  // the two sides of the settings contract from drifting apart.
  [`${OVERLAY}/settings.js`, 'lib/settings.js'],
  [`${OVERLAY}/settings-store.js`, 'lib/settings-store.js'],
  [`${OVERLAY}/overlay.css`, 'overlay/overlay.css'],
  [`${CORE}/summary.js`, 'lib/summary.js'],
  [`${CORE}/trim.js`, 'lib/trim.js'],
  // trim.js and record-trim.js both import the kit, so it rides along the same
  // way. All three are popup-side only: the capture bundles stay parser free.
  [`${CORE}/trim-kit.js`, 'lib/trim-kit.js'],
  [`${CORE}/record-trim.js`, 'lib/record-trim.js'],
  [`${CORE}/strip-html.js`, 'lib/strip-html.js'],
  [`${CORE}/json-span.js`, 'lib/json-span.js'],
  [`${CORE}/ui-numbers.js`, 'lib/ui-numbers.js'],
  [`${CORE}/ai-context.js`, 'lib/ai-context.js'],
  [`${CORE}/related.js`, 'lib/related.js'],
  [`${CORE}/root-splice.js`, 'lib/root-splice.js'],
  [MANIFEST, 'manifest.json'],
  // Ships inside the package, not merely in the repo. Chrome Web Store
  // Developer Agreement 5.2 grants every installer a perpetual worldwide
  // licence to use the product UNLESS the product itself carries a EULA, which
  // then governs "in lieu" of that grant. A LICENSE that stays in the repo is
  // not in the product, so PolyForm Internal Use would simply be overridden for
  // anyone who installs from the store. This one line is what keeps our terms
  // the terms.
  ['LICENSE', 'LICENSE'],
];

// ---------------------------------------------------------------- helpers

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function write(relative, contents) {
  const target = join(OUT, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * Turn one ES module into a fragment that can live inside a shared IIFE.
 *
 * Deliberately dumb: single-line imports get dropped, a leading `export ` gets
 * removed, and anything else that still looks like module syntax afterwards is
 * a hard error. A bundler that silently half-works on a content script produces
 * a page that mostly loads and an extension that mostly captures, which is a
 * far worse afternoon than a build failure.
 */
function toClassicFragment(relativePath) {
  const lines = read(relativePath).split('\n');
  const kept = [];

  for (const [index, line] of lines.entries()) {
    if (/^import\s/.test(line)) {
      if (!/;?\s*$/.test(line) || (line.includes('{') && !line.includes('}'))) {
        throw new Error(
          `${relativePath}:${index + 1} has a multi-line import. Keep imports on one line: ` +
            'the bundler in tools/build.mjs is intentionally line based.',
        );
      }
      continue;
    }
    kept.push(line.replace(/^export\s+(?=(const|let|var|function|class|async)\b)/, ''));
  }

  const body = kept.join('\n');
  const leftover = body.split('\n').find((line) => /^(import|export)\s/.test(line));
  if (leftover) {
    throw new Error(`${relativePath}: module syntax survived bundling: ${leftover.trim()}`);
  }

  return `// ---- ${relativePath} ----\n${body}`;
}

// ---------------------------------------------------------------- build

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const [from, to] of COPIES) {
  if (!existsSync(join(ROOT, from))) throw new Error(`missing source file: ${from}`);
  write(to, read(from));
}

for (const bundle of BUNDLES) {
  const header = [
    '// Generated by tools/build.mjs. Do not edit.',
    `// ${bundle.world}-world content script, assembled from:`,
    ...bundle.sources.map((s) => `//   ${s}`),
    '',
  ].join('\n');

  const fragments = bundle.sources.map(toClassicFragment).join('\n\n');
  write(bundle.out, `${header}(() => {\n'use strict';\n\n${fragments}\n})();\n`);
}

for (const size of ICON_SIZES) {
  write(`icons/icon-${size}.png`, renderIcon(size));
}

// ---------------------------------------------------------------- assertions
//
// Cheap structural checks. The build is the last place these are free.

const manifest = JSON.parse(read(MANIFEST));

if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['*://*.hubspot.com/*'])) {
  throw new Error('host_permissions must be exactly ["*://*.hubspot.com/*"]');
}

const worlds = manifest.content_scripts.map((cs) => cs.world);
if (!worlds.includes('MAIN') || !worlds.includes('ISOLATED')) {
  throw new Error('the extension needs one MAIN-world and one ISOLATED-world content script');
}

// document_start is a rule about the capture pair specifically: HubSpot's
// bundle grabs the original fetch the moment it runs, so an interceptor that
// loads later patches a copy nothing uses. It says nothing about a script that
// only reads the DOM, and forcing one to document_start would just mean running
// before there is a body to read. Every entry must still state run_at, though:
// an implicit default is how a script quietly changes its own timing.
const RUN_AT = new Set(['document_start', 'document_end', 'document_idle']);
const CAPTURE_BUNDLES = new Set(BUNDLES.filter((b) => b.capturesFetch).map((b) => b.out));

for (const cs of manifest.content_scripts) {
  if (!RUN_AT.has(cs.run_at)) {
    throw new Error(`content script ${cs.js.join(', ')} must state run_at explicitly`);
  }
  // Same reasoning as run_at, and learned the same way. HubSpot renders the
  // create-record dialog inside an iframe (nav-object-create-ui), so a script
  // that does not say all_frames simply never sees it, and nothing anywhere
  // reports that: the feature is just absent. An entry that states false is
  // making a choice; an entry that omits it is inheriting one.
  if (typeof cs.all_frames !== 'boolean') {
    throw new Error(`content script ${cs.js.join(', ')} must state all_frames explicitly`);
  }
  if (cs.js.some((file) => CAPTURE_BUNDLES.has(file)) && cs.run_at !== 'document_start') {
    throw new Error(
      'the capture content scripts must run at document_start, or HubSpot captures the original fetch first',
    );
  }
  for (const file of [...cs.js, ...(cs.css || [])]) {
    if (!existsSync(join(OUT, file))) throw new Error(`manifest references a missing file: ${file}`);
  }
}

// The MAIN-world script has no chrome.* access at all. Referencing it there is
// not a runtime warning, it is a thrown ReferenceError inside a customer's
// workflow editor.
// Comments stripped first: this file and protocol.js both talk about chrome.*
// in prose, and a check that cannot tell prose from code is a check nobody
// trusts for long.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const bundle of BUNDLES.filter((b) => b.world === 'MAIN')) {
  const source = stripComments(readFileSync(join(OUT, bundle.out), 'utf8'));
  if (/\bchrome\./.test(source)) {
    throw new Error(
      `${bundle.out} references chrome.*; it runs in the page world and has none`,
    );
  }
}

console.log(`built ${OUT}`);
for (const bundle of BUNDLES) {
  const bytes = readFileSync(join(OUT, bundle.out)).length;
  console.log(`  ${bundle.out.padEnd(24)} ${String(bytes).padStart(6)} bytes  (${bundle.world})`);
}
