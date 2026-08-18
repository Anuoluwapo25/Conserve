/**
 * Headless wallet for the operator: builds a wallet from a seed, waits for it
 * to sync, and adapts it to the `WalletProvider` / `MidnightProvider` pair that
 * midnight-js expects.
 */

import { WalletBuilder } from '@midnight-ntwrk/wallet';
import type { Wallet, WalletState } from '@midnight-ntwrk/wallet-api';
import type { Resource } from '@midnight-ntwrk/wallet';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { NetworkConfig } from '@conserve/api';
import { filter, firstValueFrom, interval, map, take, tap, throwError, timeout } from 'rxjs';
import { concat, of } from 'rxjs';

export type OperatorWallet = Wallet & Resource;

/** tDUST is quoted in the smallest unit; this is the display divisor. */
export const DUST_DECIMALS = 1_000_000n;

export const formatDust = (amount: bigint): string => {
  const whole = amount / DUST_DECIMALS;
  const fraction = (amount % DUST_DECIMALS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
};

export const buildWallet = async (
  config: NetworkConfig,
  seed: string,
): Promise<OperatorWallet> => {
  const wallet = await WalletBuilder.build(
    config.indexerUrl,
    config.indexerWsUrl,
    config.proofServerUrl,
    config.nodeUrl,
    seed,
    config.networkId as never,
    'error',
  );
  wallet.start();
  return wallet;
};

/**
 * Blocks until the wallet has caught up with the chain tip. A wallet that is
 * still syncing reports a zero balance and produces transactions the node
 * rejects, so every command waits here first.
 */
export const waitForSync = async (
  wallet: OperatorWallet,
  onProgress?: (state: WalletState) => void,
): Promise<WalletState> =>
  firstValueFrom(
    wallet.state().pipe(
      tap((state) => onProgress?.(state)),
      filter((state) => state.syncProgress?.synced === true),
      take(1),
      timeout({
        each: 15 * 60_000,
        with: () => throwError(() => new Error('wallet did not finish syncing within 15 minutes')),
      }),
    ),
  );

export const walletProviders = (
  wallet: OperatorWallet,
  coinPublicKey: string,
  encryptionPublicKey: string,
): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } => ({
  walletProvider: {
    getCoinPublicKey: () => coinPublicKey as never,
    getEncryptionPublicKey: () => encryptionPublicKey as never,
    balanceTx: async (tx, ttl) => {
      // `ttl` is honoured by the ledger-side balancing; the wallet SDK derives its own.
      void ttl;
      const recipe = await wallet.balanceTransaction(tx as never, []);
      const proven = await wallet.proveTransaction(recipe);
      return proven as never;
    },
  },
  midnightProvider: {
    submitTx: (tx) => wallet.submitTransaction(tx as never) as never,
  },
});

/** Emits a heartbeat while a long operation runs, so the CLI never looks hung. */
export const heartbeat = (label: string, everyMs = 10_000) =>
  concat(of(0), interval(everyMs)).pipe(map((tick) => `${label}${'.'.repeat((tick % 3) + 1)}`));
