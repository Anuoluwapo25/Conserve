/**
 * Operator wallet, built on the Midnight wallet SDK.
 *
 * The facade coordinates the three wallets a Midnight account needs — shielded
 * (Zswap coins), unshielded (NIGHT), and Dust (which pays fees) — and this
 * module adapts it to the `WalletProvider` / `MidnightProvider` pair that
 * midnight-js wants when it builds a contract transaction.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  PublicKey,
  UnshieldedWallet,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { NetworkConfig } from '@conserve/api';
import type { OperatorKeys } from './keys.js';

/** How far ahead of now a Conserve transaction stays valid. */
const TX_TTL_MINUTES = 30;

/** NIGHT and DUST are quoted in their smallest unit. */
const UNIT_DECIMALS = 1_000_000n;

export const formatUnits = (amount: bigint): string => {
  const whole = amount / UNIT_DECIMALS;
  const fraction = (amount % UNIT_DECIMALS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
};

export const walletConfiguration = (config: NetworkConfig) => ({
  networkId: config.networkId,
  indexerClientConnection: {
    indexerHttpUrl: config.indexerUrl,
    indexerWsUrl: config.indexerWsUrl,
    // Without a keepalive the indexer drops an idle subscription and the SDK
    // treats the close as a sync failure, retrying in a tight loop.
    keepAlive: 10_000,
  },
  // A first sync replays every shielded event since genesis — on Preprod that
  // is millions. The defaults (size 10, spacing 4ms) let those events pile up
  // faster than they are applied and exhaust the heap. Larger batches applied
  // with more space between them keep peak memory bounded at the cost of a
  // slower first run; later runs restore from the cached state instead.
  batchUpdates: { size: 200, timeout: 50, spacing: 25 },
  relayURL: new URL(config.nodeUrl),
  provingServerUrl: new URL(config.proofServerUrl),
  txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  // Fees are paid in DUST, which accrues against registered NIGHT. The margin
  // is how many blocks of headroom to leave when deciding a transaction is
  // affordable.
  costParameters: { feeBlocksMargin: 5 },
});

export type OperatorWallet = {
  readonly facade: WalletFacade;
  readonly keys: OperatorKeys;
  /** Writes the synced wallet state so the next run does not replay the chain. */
  save(): Promise<void>;
  close(): Promise<void>;
};

/** Cached wallet state, keyed by network so profiles never cross-contaminate. */
type WalletCache = { shielded: string; unshielded: string; dust: string };

const cachePath = (config: NetworkConfig, dir: string): string =>
  resolve(dir, `wallet-${config.networkId}.json`);

const readCache = async (path: string): Promise<WalletCache | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as WalletCache;
  } catch {
    return undefined;
  }
};

export const openWallet = async (
  config: NetworkConfig,
  keys: OperatorKeys,
  stateDir = '.conserve-state',
): Promise<OperatorWallet> => {
  const configuration = walletConfiguration(config);
  const dustParameters = ledger.LedgerParameters.initialParameters().dust;
  const nightKeystore = createKeystore(keys.nightSecret, config.networkId);
  const path = cachePath(config, stateDir);
  const cache = await readCache(path);

  const facade = await WalletFacade.init({
    configuration,
    shielded: (c) =>
      cache === undefined
        ? ShieldedWallet(c).startWithSecretKeys(keys.shieldedSecretKeys)
        : ShieldedWallet(c).restore(cache.shielded),
    unshielded: (c) =>
      cache === undefined
        ? UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(nightKeystore))
        : UnshieldedWallet(c).restore(cache.unshielded),
    dust: (c) =>
      cache === undefined
        ? DustWallet(c).startWithSecretKey(keys.dustSecretKey, dustParameters)
        : DustWallet(c).restore(cache.dust),
  });

  await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);

  return {
    facade,
    keys,
    save: async () => {
      await mkdir(stateDir, { recursive: true });
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      // Holds observed chain state rather than keys, but it does reveal which
      // coins are yours, so keep it owner-readable.
      await writeFile(path, `${JSON.stringify({ shielded, unshielded, dust })}\n`, {
        mode: 0o600,
      });
    },
    close: () => facade.stop(),
  };
};

const ttl = (): Date => new Date(Date.now() + TX_TTL_MINUTES * 60_000);

/**
 * Adapts the facade to midnight-js.
 *
 * midnight-js hands us an unbound transaction carrying the Conserve call and
 * expects it back balanced and finalized; the facade covers fees from DUST and
 * signs the NIGHT segment along the way.
 */
export const walletProviders = (
  wallet: OperatorWallet,
): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } => {
  const secretKeys = {
    shieldedSecretKeys: wallet.keys.shieldedSecretKeys,
    dustSecretKey: wallet.keys.dustSecretKey,
  };
  const sign = (data: Uint8Array): ledger.Signature =>
    ledger.signData(wallet.keys.nightSigningKey, data);

  return {
    walletProvider: {
      getCoinPublicKey: () => wallet.keys.shieldedSecretKeys.coinPublicKey as never,
      getEncryptionPublicKey: () => wallet.keys.shieldedSecretKeys.encryptionPublicKey as never,
      balanceTx: async (tx, deadline) => {
        const recipe = await wallet.facade.balanceUnboundTransaction(tx as never, secretKeys, {
          ttl: deadline ?? ttl(),
        });
        const signed = await wallet.facade.signRecipe(recipe, sign);
        return (await wallet.facade.finalizeRecipe(signed)) as never;
      },
    },
    midnightProvider: {
      submitTx: (tx) => wallet.facade.submitTransaction(tx as never) as never,
    },
  };
};

export type WalletSummary = {
  readonly night: bigint;
  readonly dust: bigint;
  readonly synced: boolean;
};

export const summariseWallet = async (wallet: OperatorWallet): Promise<WalletSummary> => {
  const state = await wallet.facade.waitForSyncedState();
  const night = (Object.values(state.unshielded.balances) as bigint[]).reduce((a, b) => a + b, 0n);
  // DUST accrues over time against registered NIGHT, so its balance is a
  // function of the moment you ask.
  const dust = state.dust.balance(new Date());
  return { night, dust, synced: state.isSynced };
};
