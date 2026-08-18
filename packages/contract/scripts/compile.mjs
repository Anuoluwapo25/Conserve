#!/usr/bin/env node
// Compiles conserve.compact into ./managed (contract JS/TS bindings, ZK IR,
// prover and verifier keys). Skips the work when the artifacts are already
// newer than the source, which keeps `npm test` fast on repeat runs.

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(pkgRoot, 'src/conserve.compact');
const outDir = resolve(pkgRoot, 'managed/conserve');
const marker = resolve(outDir, 'contract/index.js');

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

if (process.env.COMPACT_FORCE !== '1' && mtime(marker) > mtime(source)) {
  console.log('conserve: artifacts are up to date, skipping compile');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
console.log(`conserve: compiling ${source}`);
try {
  execFileSync('compact', ['compile', source, outDir], { stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(
      'conserve: the `compact` toolchain was not found on PATH.\n' +
        'Install it with: curl --proto "=https" --tlsv1.2 -LsSf ' +
        'https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh',
    );
    process.exit(127);
  }
  throw error;
}
