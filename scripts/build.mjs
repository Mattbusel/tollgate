// Build the channels contract to res/tollgate_channels.wasm with cargo-near (non-reproducible,
// no embedded ABI: the ABI step links a native library, which fails on Windows; the wasm is the same).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync('cargo', ['near', 'build', 'non-reproducible-wasm', '--no-abi', '--out-dir', path.join(root, 'res')], {
  cwd: path.join(root, 'contracts', 'channels'),
  stdio: 'inherit',
});
const wasm = path.join(root, 'res', 'tollgate_channels.wasm');
console.log(`built ${wasm} (${fs.statSync(wasm).size} bytes)`);
