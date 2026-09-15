/**
 * Operator wallet, built on the Midnight wallet SDK.
 *
 * The facade coordinates the three wallets a Midnight account needs — shielded
 * (Zswap coins), unshielded (NIGHT), and Dust (which pays fees) — and this
 * module adapts it to the `WalletProvider` / `MidnightProvider` pair that
 * midnight-js wants when it builds a contract transaction.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  // The wallet SDK relays over a node websocket, not the HTTP RPC endpoint.
  relayURL: new URL(config.nodeUrl.replace(/^http/, 'ws')),
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
  /** Where this wallet's synced state is cached. */
  readonly cachePath: string;
  /** Writes the synced wallet state so the next run does not replay the chain. */
  save(): Promise<void>;
  close(): Promise<void>;
};

/**
 * How often to checkpoint wallet state while a sync is still running.
 *
 * A first sync replays millions of shielded events, and the connection to the
 * indexer does not reliably survive that long. Saving only once the sync has
 * finished means an interrupted run persists nothing and the next one starts
 * from genesis again — which is why a fresh wallet appeared never to converge.
 * Checkpointing as it goes makes the progress cumulative: each run resumes from
 * the last checkpoint, so successive attempts reach the tip even if no single
 * one does.
 */
const CHECKPOINT_INTERVAL_MS = 30_000;

// Distinguishes concurrent temp files within a process; see `save`.
let saveSequence = 0;

/** Cached wallet state, keyed by network so profiles never cross-contaminate. */
type WalletCache = { shielded: string; unshielded: string; dust: string };

/**
 * One cache file per network *and* wallet. Keying by network alone meant a
 * second seed on the same network restored the first seed's state, which can
 * never sync, so the process sat waiting forever.
 */
const cachePath = (config: NetworkConfig, dir: string, keys: OperatorKeys): string =>
  resolve(
    dir,
    `wallet-${config.networkId}-${keys.shieldedSecretKeys.coinPublicKey.slice(0, 16)}.json`,
  );

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
  stateDir = process.env.CONSERVE_STATE_DIR ?? '.conserve-state',
): Promise<OperatorWallet> => {
  const configuration = walletConfiguration(config);
  const dustParameters = ledger.LedgerParameters.initialParameters().dust;
  const nightKeystore = createKeystore(keys.nightSecret, config.networkId);
  const path = cachePath(config, stateDir, keys);
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

  // Serialise every save through one chain. The timer's own re-entry guard is
  // not enough: an explicit `save()` can land mid-checkpoint, and both calls
  // derive the same `.<pid>.tmp` path, so they interleave writes into one file
  // and the loser's rename fails with ENOENT after the winner consumed it.
  // Queueing makes each write-then-rename indivisible, which is what the
  // atomicity below is actually promising.
  let saving: Promise<void> = Promise.resolve();

  const writeState = async (): Promise<void> => {
    await mkdir(stateDir, { recursive: true });
    const [shielded, unshielded, dust] = await Promise.all([
      facade.shielded.serializeState(),
      facade.unshielded.serializeState(),
      facade.dust.serializeState(),
    ]);
    // Write to a sibling and rename rather than onto the cache directly. The
    // dust state alone runs to megabytes, so a write interrupted partway --
    // Ctrl-C, an OOM kill, a second CLI running concurrently -- would leave
    // truncated JSON behind. Since the cache is what makes a sync resumable,
    // corrupting it costs the entire replay it exists to avoid, and rename is
    // atomic on POSIX.
    const temporary = `${path}.${process.pid}.${++saveSequence}.tmp`;
    // Holds observed chain state rather than keys, but it does reveal which
    // coins are yours, so keep it owner-readable.
    await writeFile(temporary, `${JSON.stringify({ shielded, unshielded, dust })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  };

  const save = (): Promise<void> => {
    saving = saving.then(writeState, writeState);
    return saving;
  };

  // Checkpoint on a timer rather than on every state emission: the observable
  // fires many times a second during a replay, and serialising the whole wallet
  // that often would cost more than the sync itself. `unref` keeps the timer
  // from holding the process open once the work is done.
  let checkpointing = false;
  const checkpoint = setInterval(() => {
    if (checkpointing) return;
    checkpointing = true;
    void save()
      .catch(() => {
        // A failed checkpoint costs progress, not correctness — the next one
        // will try again, and the sync itself is unaffected.
      })
      .finally(() => {
        checkpointing = false;
      });
  }, CHECKPOINT_INTERVAL_MS);
  checkpoint.unref();

  return {
    facade,
    keys,
    cachePath: path,
    save,
    close: async () => {
      clearInterval(checkpoint);
      await facade.stop();
    },
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
  /** Shielded balance per token type, e.g. the Demo Dollars a payout delivered. */
  readonly shielded: Readonly<Record<string, bigint>>;
  readonly synced: boolean;
};

export const summariseWallet = async (wallet: OperatorWallet): Promise<WalletSummary> => {
  const state = await waitForSync(wallet);
  const night = (Object.values(state.unshielded.balances) as bigint[]).reduce((a, b) => a + b, 0n);
  // DUST accrues over time against registered NIGHT, so its balance is a
  // function of the moment you ask.
  const dust = state.dust.balance(new Date());
  return { night, dust, shielded: { ...state.shielded.balances }, synced: state.isSynced };
};

export type DustRegistration =
  | { readonly status: 'already-registered' }
  | { readonly status: 'submitted'; readonly utxoCount: number; readonly txId: string };

/**
 * Registers every NIGHT UTXO not already registered for DUST generation.
 *
 * Fees are paid in DUST, and DUST only accrues against NIGHT that has gone
 * through this. A freshly funded wallet has NIGHT and no way to spend it
 * until this transaction lands.
 */
export const registerForDust = async (wallet: OperatorWallet): Promise<DustRegistration> => {
  const state = await wallet.facade.waitForSyncedState();
  const unregistered = state.unshielded.availableCoins.filter(
    (coin) => !coin.meta.registeredForDustGeneration,
  );
  if (unregistered.length === 0) {
    return { status: 'already-registered' };
  }

  const sign = (data: Uint8Array): ledger.Signature =>
    ledger.signData(wallet.keys.nightSigningKey, data);
  const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
    unregistered,
    wallet.keys.nightVerifyingKey,
    sign,
  );
  const finalized = await wallet.facade.finalizeRecipe(recipe);
  const txId = await wallet.facade.submitTransaction(finalized);
  return { status: 'submitted', utxoCount: unregistered.length, txId };
};

/**
 * Polls until at least one DUST coin is spendable, not merely accruing.
 *
 * `state.dust.balance()` goes positive as soon as the registration lands, but
 * a coin is not mintable until the chain produces blocks that account for the
 * accrual — submitting a transaction before then fails with "insufficient
 * DUST" even though the balance already reads non-zero.
 */
export const waitForSpendableDust = async (
  wallet: OperatorWallet,
  timeoutMs = 180_000,
  pollMs = 5_000,
): Promise<bigint> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await wallet.facade.waitForSyncedState();
    if (state.dust.availableCoins.length > 0) {
      return state.dust.balance(new Date());
    }
    if (Date.now() >= deadline) {
      throw new Error(`no spendable DUST coin within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};

/** How long sync may go without applying a single event before it is declared stuck. */
const SYNC_STALL_MS = 10 * 60 * 1000;

/**
 * Waits for a strictly synced wallet, and fails instead of waiting forever.
 *
 * A cache can fall out of step with the chain — after a network upgrade that
 * re-indexes history, for instance — and the SDK then rejects every update
 * ("values inserted non-linearly into … commitment tree") while reporting
 * nothing to the caller. `waitForSyncedState` never resolves, and a command
 * that looks busy has in fact stopped. Watching the applied indices turns that
 * into an error with a remedy.
 */
export const waitForSync = async (
  wallet: OperatorWallet,
  stallMs = SYNC_STALL_MS,
): Promise<Awaited<ReturnType<OperatorWallet['facade']['waitForSyncedState']>>> => {
  let lastProgress = '';
  let lastChange = Date.now();
  let stalled: (() => void) | undefined;
  const stall = new Promise<never>((_, reject) => {
    stalled = () =>
      reject(
        new Error(
          `wallet sync made no progress for ${Math.round(stallMs / 60_000)} minute${Math.round(stallMs / 60_000) === 1 ? '' : 's'}. ` +
            `The cached state in ${wallet.cachePath} is probably out of step with the chain; ` +
            'move it aside and run the command again to resync from genesis.',
        ),
      );
  });
  const subscription = wallet.facade.state().subscribe((state) => {
    const progress = [
      state.shielded.progress?.appliedIndex,
      state.dust.progress?.appliedIndex,
      state.unshielded.progress?.appliedId,
    ].join('/');
    if (progress !== lastProgress) {
      lastProgress = progress;
      lastChange = Date.now();
    }
  });
  const timer = setInterval(() => {
    if (Date.now() - lastChange > stallMs) stalled?.();
  }, 15_000);
  try {
    return await Promise.race([wallet.facade.waitForSyncedState(), stall]);
  } finally {
    clearInterval(timer);
    subscription.unsubscribe();
  }
};
