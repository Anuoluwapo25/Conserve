/**
 * Reports NIGHT and DUST balances from the cached wallet state without waiting
 * for a strictly synced state, so we can tell whether a deploy could already
 * afford its fee.
 */

import { networkConfig } from '@conserve/api/config';
import { deriveKeys, seedFromHex } from '../packages/cli/dist/keys.js';
import { openWallet } from '../packages/cli/dist/wallet.js';

const config = networkConfig('preprod');
const keys = deriveKeys(seedFromHex(process.env.CONSERVE_SEED));

const wallet = await openWallet(config, keys);

const sub = wallet.facade.state().subscribe((state) => {
  const night = Object.values(state.unshielded.balances).reduce((a, b) => a + b, 0n);
  let dust = 0n;
  try {
    dust = state.dust.balance(new Date());
  } catch (e) {
    dust = `ERROR: ${e?.message ?? e}`;
  }
  const coins = state.unshielded.availableCoins ?? [];
  const registered = coins.filter((c) => c.meta?.registeredForDustGeneration).length;
  console.log(
    `NIGHT=${night} DUST=${dust} unshieldedCoins=${coins.length} registeredCoins=${registered} ` +
      `shieldedBalances=${JSON.stringify(state.shielded.balances ?? {})} ` +
      `isSynced=${state.isSynced} ` +
      `unshieldedComplete=${state.unshielded.progress.isStrictlyComplete()} ` +
      `dustApplied=${state.dust.progress.appliedIndex}`,
  );
  if (coins.length > 0) {
    console.log('  COINS:', JSON.stringify(coins.slice(0, 3), (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
});

const stop = async () => {
  sub.unsubscribe();
  await wallet.save();
  await wallet.close();
  process.exit(0);
};

setTimeout(stop, Number(process.env.PROBE_SECONDS ?? 25) * 1000);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
