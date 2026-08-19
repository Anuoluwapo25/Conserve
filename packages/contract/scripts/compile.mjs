#!/usr/bin/env node
// Compiles conserve.compact into ./managed (contract JS/TS bindings, ZK IR,
// prover and verifier keys).
//
// Recompiling takes minutes, so the artifacts carry a stamp recording the hash
// of the source they were built from and the compiler that built them. A run
// whose stamp already matches is a no-op. Hashing the source rather than
// comparing timestamps matters: a fresh clone, a branch switch, or a CI cache
// restore all leave mtimes that say nothing useful about whether the artifacts
// are current.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(pkgRoot, 'src/conserve.compact');
const outDir = resolve(pkgRoot, 'managed/conserve');
const stampFile = resolve(outDir, 'compile-stamp.json');
const marker = resolve(outDir, 'contract/index.js');

/**
 * The selected compiler's version, or undefined if the toolchain is not on
 * PATH. Note this is `compact compile --version` (the compiler, e.g. 0.31.1),
 * not `compact --version` (the CLI wrapper, e.g. 0.5.1) — the wrapper's version
 * says nothing about which compiler `compact update` has selected, so stamping
 * it would let a compiler switch reuse artifacts built by a different one.
 */
const compilerVersion = () => {
  try {
    return execFileSync('compact', ['compile', '--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const missingToolchain = () => {
  console.error(
    'conserve: the `compact` toolchain was not found on PATH.\n' +
      'Install it with: curl --proto "=https" --tlsv1.2 -LsSf ' +
      'https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh',
  );
  process.exit(127);
};

const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');

const readStamp = () => {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return undefined;
  }
};

const artifactsPresent = () => {
  try {
    readFileSync(marker);
    return true;
  } catch {
    return false;
  }
};

if (process.env.COMPACT_FORCE !== '1' && artifactsPresent()) {
  const stamp = readStamp();
  if (stamp?.sourceHash === sourceHash) {
    const installed = compilerVersion();
    if (installed === undefined) {
      // A cache hit is the common case in CI, and it should not require
      // installing a toolchain just to confirm work that is already done.
      console.log(
        `conserve: artifacts match the current source (built with ${stamp.compiler}); ` +
          'skipping compile, no toolchain needed',
      );
      process.exit(0);
    }
    if (stamp.compiler === installed) {
      console.log('conserve: artifacts match the current source, skipping compile');
      process.exit(0);
    }
    console.log(`conserve: compiler changed (${stamp.compiler} -> ${installed}), recompiling`);
  }
}

const version = compilerVersion() ?? missingToolchain();
mkdirSync(outDir, { recursive: true });
console.log(`conserve: compiling ${source} with ${version}`);
execFileSync('compact', ['compile', source, outDir], { stdio: 'inherit' });
writeFileSync(stampFile, `${JSON.stringify({ sourceHash, compiler: version }, null, 2)}\n`);
