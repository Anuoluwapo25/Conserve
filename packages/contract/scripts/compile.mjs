#!/usr/bin/env node
// Compiles the package's Compact contracts into ./managed/<name> (contract
// JS/TS bindings, ZK IR, prover and verifier keys): conserve.compact, the
// payroll contract, and demo-dollar.compact, the test token it pays in on
// networks without one.
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
const CONTRACTS = ['conserve', 'demo-dollar'];

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

/** Compiles one contract unless its artifacts already match its source. */
const compile = (name, installed) => {
  const source = resolve(pkgRoot, `src/${name}.compact`);
  const outDir = resolve(pkgRoot, `managed/${name}`);
  const stampFile = resolve(outDir, 'compile-stamp.json');
  const marker = resolve(outDir, 'contract/index.js');
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
      if (installed === undefined) {
        // A cache hit is the common case in CI, and it should not require
        // installing a toolchain just to confirm work that is already done.
        console.log(
          `${name}: artifacts match the current source (built with ${stamp.compiler}); ` +
            'skipping compile, no toolchain needed',
        );
        return;
      }
      if (stamp.compiler === installed) {
        console.log(`${name}: artifacts match the current source, skipping compile`);
        return;
      }
      console.log(`${name}: compiler changed (${stamp.compiler} -> ${installed}), recompiling`);
    }
  }

  const version = installed ?? missingToolchain();
  mkdirSync(outDir, { recursive: true });
  console.log(`${name}: compiling ${source} with ${version}`);
  execFileSync('compact', ['compile', source, outDir], { stdio: 'inherit' });
  writeFileSync(stampFile, `${JSON.stringify({ sourceHash, compiler: version }, null, 2)}\n`);
};

const installed = compilerVersion();
for (const name of CONTRACTS) {
  compile(name, installed);
}
