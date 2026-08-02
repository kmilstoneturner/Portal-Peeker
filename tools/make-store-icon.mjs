// Writes the Chrome Web Store listing icon to store-assets/.
//
// Separate from the build on purpose. extension/dist is the package, and a
// listing asset that ends up inside the package is 984 bytes of dead weight
// plus one more file for a reviewer to wonder about. store-assets/ is
// gitignored for the same reason the repo carries no other binaries: it is
// generated, so generate it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { renderStoreIcon } from './make-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store-assets');

mkdirSync(OUT, { recursive: true });

const png = renderStoreIcon();
const target = join(OUT, 'store-icon-128.png');
writeFileSync(target, png);

console.log(`wrote ${target} (${png.length} bytes, 128x128, 96x96 art, 16px padding)`);
