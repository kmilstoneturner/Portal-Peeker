// The AI context block tells whoever reads an export what was done to it. That
// claim is only worth anything if it stays true as the extension grows, and the
// failure mode is silent: someone adds a fifth checkbox, ships it, and every
// file exported from then on carries a block that describes the file as it was
// two features ago. Nothing about that looks broken.
//
// So the block's list of modifications is the single source of truth
// (MODIFICATIONS in packages/core/src/ai-context.js), the popup takes its
// filename marks, status labels, and reported flags from that list, and this
// check fails the build when the popup grows an export option the list has
// never heard of.
//
// Three checks against the popup sources:
//
//   1. Every export option checkbox in popup.html corresponds to an entry in
//      MODIFICATIONS, or is the AI context checkbox itself.
//   2. Every flag the popup reports is a flag the table declares.
//   3. The popup does not hand-write filename marks, apart from the block's
//      own, since a hand-written mark is a modification with no entry.
//
// The vitest side covers the other half: every entry in the table has prose,
// and toggling any entry changes what the block says.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { MODIFICATIONS } from '../packages/core/src/ai-context.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POPUP_HTML = 'extension/src/popup.html';
const POPUP_JS = 'extension/src/popup.js';

// The checkbox that adds the block. It is not a modification of the payload:
// it is the thing that reports them, so it has no MODIFICATIONS entry.
const CONTEXT_CHECKBOX = 'opt-context';
const CONTEXT_MARK = 'ai';

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const matchAll = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);

const failures = [];
const html = read(POPUP_HTML);
const js = read(POPUP_JS);

// 1. Checkboxes.
const checkboxes = matchAll(html, /<input[^>]*\bid="(opt-[a-z-]+)"/g);
const expected = MODIFICATIONS.length + 1;
if (checkboxes.length !== expected) {
  failures.push(
    `${POPUP_HTML} has ${checkboxes.length} export option checkboxes (${checkboxes.join(', ')}), ` +
      `but MODIFICATIONS declares ${MODIFICATIONS.length}, plus ${CONTEXT_CHECKBOX}.\n` +
      '    An export option that is not in the table means the AI context block will describe\n' +
      '    the file inaccurately. Add an entry to MODIFICATIONS in packages/core/src/ai-context.js\n' +
      '    with a flag, a mark, a label, and a sentence for tells, then wire the popup to it.',
  );
}
if (!checkboxes.includes(CONTEXT_CHECKBOX)) {
  failures.push(`${POPUP_HTML} is missing the ${CONTEXT_CHECKBOX} checkbox.`);
}

// 2. Flags the popup reports.
const declared = new Set(MODIFICATIONS.map((m) => m.flag));
const reported = new Set(matchAll(js, /\bnote\('([A-Za-z]+)'\)/g));
if (reported.size === 0) {
  failures.push(
    `${POPUP_JS} reports no modification flags. This check reads note('flag') calls; if that\n` +
      '    helper was renamed, update this script so the guard keeps working.',
  );
}
for (const flag of reported) {
  if (!declared.has(flag)) {
    failures.push(`${POPUP_JS} reports a flag the table does not declare: ${flag}`);
  }
}
for (const flag of declared) {
  if (!reported.has(flag)) {
    failures.push(
      `MODIFICATIONS declares ${flag}, but ${POPUP_JS} never reports it. The block would\n` +
        '    always call it false.',
    );
  }
}

// 3. Hand-written marks.
for (const mark of matchAll(js, /marks\.push\('([a-z]+)'\)/g)) {
  if (mark !== CONTEXT_MARK) {
    failures.push(
      `${POPUP_JS} writes the filename mark '${mark}' by hand. Marks come from MODIFICATIONS so\n` +
        '    that a suffix and a sentence in the block can never disagree.',
    );
  }
}

if (failures.length) {
  console.error('ai-context check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\n${failures.length} problem${failures.length === 1 ? '' : 's'}. See tools/check-ai-context.mjs for what this guards.`,
  );
  process.exit(1);
}

console.log(
  `ai-context check passed: ${MODIFICATIONS.length} modifications, each declared, reported, and explained`,
);
