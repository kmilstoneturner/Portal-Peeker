// Builds the upload artefact: a ZIP whose root is manifest.json.
//
// The packaging mistake that matters is archiving the directory instead of its
// contents. Chrome rejects an archive where the manifest sits one level down,
// and nothing in the message it gives you says which of the two you did. So
// this zips from inside dist and then reads the archive back and compares its
// entries against the files the build actually produced. A missing entry is a
// broken extension; an extra one is a file nobody reviewed.
//
// Runs after verify rather than instead of it. The point of shipping from
// extension/dist is that these exact bytes passed the no-network check.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension/dist');

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('extension/dist/manifest.json not found. Run: npm run build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const out = join(ROOT, `portal-peeker-${manifest.version}.zip`);

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(relative(DIST, full));
  }
  return found;
}

// Dotfiles are excluded from the archive, so they have to be excluded from the
// expectation too, or the comparison below fails on a .DS_Store that Finder
// left behind between build and package.
const present = walk(DIST).sort();
const dotfiles = present.filter((name) => name.split('/').some((part) => part.startsWith('.')));
const expected = present.filter((name) => !dotfiles.includes(name));

if (dotfiles.length) {
  console.log(`skipping ${dotfiles.length} dotfile(s): ${dotfiles.join(', ')}`);
}

rmSync(out, { force: true });

const run = (command, args, options) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options });
  } catch (error) {
    console.error(`could not run ${command}: ${error.message}`);
    process.exit(1);
  }
};

// -X drops the extra attribute blocks (uid, gid, extended attributes). They are
// noise in an archive that is about to be unpacked by a build server.
run('zip', ['--quiet', '--recurse-paths', '-X', out, '.', '--exclude', '.*', '--exclude', '*/.*'], {
  cwd: DIST,
});

const archived = run('unzip', ['-Z1', out])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.endsWith('/'))
  .sort();

const missing = expected.filter((name) => !archived.includes(name));
const extra = archived.filter((name) => !expected.includes(name));

const failures = [];
if (missing.length) failures.push(`missing from the archive: ${missing.join(', ')}`);
if (extra.length) failures.push(`unexpected in the archive: ${extra.join(', ')}`);
if (!archived.includes('manifest.json')) {
  failures.push('manifest.json is not at the archive root, which Chrome will reject');
}
if (!archived.includes('LICENSE')) {
  // Developer Agreement 5.2: without a EULA inside the product, Google's own
  // grant to users governs instead of PolyForm Internal Use.
  failures.push('LICENSE is not in the archive; see the note in tools/build.mjs');
}

if (failures.length) {
  console.error('package check FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  rmSync(out, { force: true });
  process.exit(1);
}

const bytes = statSync(out).size;
console.log(`packaged ${relative(ROOT, out)}`);
console.log(`  ${archived.length} files, ${bytes.toLocaleString()} bytes, manifest.json at the root`);
console.log(`  version ${manifest.version}. Every upload must carry a higher version than the last.`);
