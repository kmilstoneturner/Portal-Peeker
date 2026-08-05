// The built overlay bundle, evaluated.
//
// Same reason capture-flow.test.js runs the built capture pair rather than the
// sources: the unit tests import ES modules, where the loader resolves every
// dependency for you. The shipped file is not that. tools/build.mjs strips the
// imports and concatenates the fragments into ONE shared scope, in the order
// listed in BUNDLES, so a module that reads another's binding at module scope
// depends on that list being right.
//
// SURFACES does exactly that: it names a PLACEMENT while it is being built. Put
// api-name-node.js after record-surfaces.js and the bundle throws
// "Cannot access 'PLACEMENT' before initialization" the moment Chrome loads it,
// which is the overlay dead on every record page in a customer's CRM. Every
// unit test still passes, because none of them touches the built file. This is
// the only thing that does.
//
// A bare context on purpose. Nothing here should need a DOM or a chrome.*: the
// bundle's last line starts the feature only when chrome.storage exists, so
// evaluating it must be inert. If this ever needs a global added to pass, that
// is a module doing work at load time and worth a look rather than a shim.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const dist = (name) => fileURLToPath(new URL(`../../../extension/dist/${name}`, import.meta.url));

if (!existsSync(dist('overlay/overlay.js'))) {
  throw new Error('extension/dist is missing. Run: npm run build');
}

describe('the built overlay bundle', () => {
  // Reported as a string rather than with .not.toThrow(), which prints only the
  // error's class. The message is the whole diagnosis here: "Cannot access X
  // before initialization" is a bundle ordering problem, and "Identifier X has
  // already been declared" is two modules each holding a private const of the
  // same name, which is legal ES modules and illegal in one flattened scope.
  // Both have happened. Neither is guessable from the word SyntaxError.
  it('evaluates without touching a global it was not given', () => {
    const source = readFileSync(dist('overlay/overlay.js'), 'utf8');

    let failure = null;
    try {
      runInContext(source, createContext({}));
    } catch (error) {
      failure = `${error.name}: ${error.message}`;
    }

    expect(failure).toBeNull();
  });

  // The failure above is a ReferenceError from the temporal dead zone, and it
  // reads nothing like "your bundle list is in the wrong order". Naming the
  // cause here is what turns a confusing stack into a one-line fix.
  it('orders api-name-node.js ahead of record-surfaces.js', () => {
    const source = readFileSync(dist('overlay/overlay.js'), 'utf8');
    const at = (path) => source.indexOf(`// ---- packages/overlay/src/${path} ----`);

    expect(at('api-name-node.js')).toBeGreaterThan(-1);
    expect(at('record-surfaces.js')).toBeGreaterThan(-1);
    expect(at('api-name-node.js')).toBeLessThan(at('record-surfaces.js'));
  });
});
