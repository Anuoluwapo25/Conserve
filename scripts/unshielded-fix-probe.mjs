/**
 * Restores the shielded and dust wallets from the cache but starts the
 * unshielded wallet fresh, to test whether a restored unshielded state is why
 * funded NIGHT never appears.
 */

import { readFile } from 'node:fs/promises';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  PublicKey,
  UnshieldedAddress,
  UnshieldedWallet,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { networkConfig } from '@conserve/api/config';
import { deriveKeys, seedFromHex } from '../packages/cli/dist/keys.js';
import { walletConfiguration } from '../packages/cli/dist/wallet.js';

const config = networkConfig('preprod');
const keys = deriveKeys(seedFromHex(process.env.CONSERVE_SEED));
const cache = JSON.parse(await readFile('.conserve-state/wallet-preprod.json', 'utf8'));

const configuration = walletConfiguration(config);
const dustParameters = ledger.LedgerParameters.initialParameters().dust;
const nightKeystore = createKeystore(keys.nightSecret, config.networkId);

const facade = await WalletFacade.init({
  configuration,
  shielded: (c) => ShieldedWallet(c).restore(cache.shielded),
  // The one difference: start rather than restore.
  unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(nightKeystore)),
  dust: (c) => DustWallet(c).restore(cache.dust),
});

await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);

const started = Date.now();
let last = '';
let printedAddress = false;
const sub = facade.state().subscribe((state) => {
  if (!printedAddress) {
    printedAddress = true;
    try {
      const encoded = UnshieldedAddress.codec.encode(config.networkId, state.unshielded.address);
      console.log(`WALLET UNSHIELDED ADDRESS: ${encoded}`);
    } catch (e) {
      console.log(`address encode failed: ${e?.message ?? e}`, state.unshielded.address);
    }
  }
  const night = Object.values(state.unshielded.balances).reduce((a, b) => a + b, 0n);
  const coins = state.unshielded.availableCoins ?? [];
  const line =
    `NIGHT=${night} coins=${coins.length} ` +
    `unshieldedApplied=${state.unshielded.progress.appliedIndex} ` +
    `conn=${state.unshielded.progress.isConnected} isSynced=${state.isSynced}`;
  if (line !== last) {
    console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${line}`);
    last = line;
  }
  if (night > 0n) {
    console.log(
      'FUNDS VISIBLE:',
      JSON.stringify(coins, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    sub.unsubscribe();
    facade.stop().then(() => process.exit(0));
  }
});

setTimeout(async () => {
  sub.unsubscribe();
  await facade.stop();
  process.exit(0);
}, Number(process.env.PROBE_SECONDS ?? 180) * 1000);
