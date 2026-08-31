/**
 * Diagnostic: is the Preprod wallet sync actually progressing, or stuck?
 *
 * Subscribes to the facade's state observable and reports SyncProgress rather
 * than blocking on waitForSyncedState(). Also checkpoints the wallet cache as
 * it goes, so progress survives a restart instead of replaying from genesis.
 */

import { networkConfig } from '@conserve/api/config';
import { deriveKeys, seedFromHex } from '../packages/cli/dist/keys.js';
import { openWallet } from '../packages/cli/dist/wallet.js';

const config = networkConfig('preprod');
const keys = deriveKeys(seedFromHex(process.env.CONSERVE_SEED));

console.log('opening wallet…');
const wallet = await openWallet(config, keys);
console.log('wallet open, subscribing to state\n');

const started = Date.now();
let emissions = 0;
let lastSave = 0;
let lastLine = '';

const pct = (applied, highest) =>
  highest > 0n ? ((Number(applied) / Number(highest)) * 100).toFixed(4) : '0';

const sub = wallet.facade.state().subscribe({
  next: (state) => {
    emissions += 1;
    const s = state.shielded.progress;
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);

    const u = state.unshielded.progress;
    const d = state.dust.progress;
    const fmt = (name, p) =>
      `${name}=${p.appliedIndex}/${p.highestIndex} conn=${p.isConnected} ` +
      `complete=${p.isStrictlyComplete()}`;

    const line =
      `[${elapsed}s #${emissions}] ` +
      `${fmt('shielded', s)} | ${fmt('unshielded', u)} | ${fmt('dust', d)} ` +
      `|| isSynced=${state.isSynced}`;

    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }

    // Checkpoint at most every 30s so progress persists across runs.
    if (Date.now() - lastSave > 30_000) {
      lastSave = Date.now();
      wallet
        .save()
        .then(() => console.log(`    ↳ checkpoint saved at applied=${s.appliedIndex}`))
        .catch((e) => console.log(`    ↳ checkpoint FAILED: ${e?.message ?? e}`));
    }
  },
  error: (e) => console.log(`state() errored: ${e?.message ?? e}`),
});

const stop = async () => {
  sub.unsubscribe();
  try {
    await wallet.save();
    console.log('final checkpoint saved');
  } catch (e) {
    console.log(`final checkpoint failed: ${e?.message ?? e}`);
  }
  await wallet.close();
  process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
