/**
 * Node globals the SDK expects to exist in a browser.
 *
 * Parts of the Midnight stack reach for `Buffer` and `process` as globals
 * rather than importing them — the private-state store and the address codecs
 * both do. Vite bundles the packages but adds no globals, so the first call
 * fails with `ReferenceError: Buffer is not defined`, surfacing as a
 * transaction that cannot be built.
 *
 * This module must be imported before anything that touches them: imports are
 * evaluated in order, so it comes first in `main.tsx`.
 */

import { Buffer } from 'buffer';

declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof import('buffer').Buffer;
}

const globals = globalThis as unknown as {
  Buffer?: typeof Buffer;
  process?: { env: Record<string, string | undefined>; browser?: boolean };
};

globals.Buffer ??= Buffer;
// Only the shape that gets read: a `process.env` to look keys up in.
globals.process ??= { env: {}, browser: true };
