/**
 * Assembles the six providers midnight-js needs to build, prove, balance and
 * submit a Conserve transaction.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { ConservePrivateState } from '@conserve/contract';
import { CONSERVE_PRIVATE_STATE_ID, type NetworkConfig } from './config.js';
import type { ConserveCircuitId } from './contract.js';

export type ConserveProviders = MidnightProviders<
  ConserveCircuitId,
  typeof CONSERVE_PRIVATE_STATE_ID,
  ConservePrivateState
>;

/** Wallet-side providers, supplied by either the headless wallet or the browser connector. */
export type WalletProviders = Pick<ConserveProviders, 'walletProvider' | 'midnightProvider'>;

/**
 * Locates the contract package's `managed/conserve/` directory, where the
 * Compact compiler wrote the prover keys, verifier keys and ZK IR.
 */
export const zkAssetsDirectory = (): string => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@conserve/contract');
  return resolve(dirname(entry), '../managed/conserve');
};

export type ProviderOptions = {
  readonly config: NetworkConfig;
  readonly wallet: WalletProviders;
  /**
   * Scopes the local private-state store, so one machine can hold the rosters
   * of several organizations without mixing them.
   */
  readonly accountId: string;
  /**
   * Returns the password the private-state store is encrypted at rest with.
   * This protects the roster on disk: it is the one copy of the payroll that
   * exists anywhere, and it never leaves the operator's machine.
   */
  readonly password: () => string | Promise<string>;
  /** Name of the on-disk private state store. */
  readonly privateStateStore?: string;
};

export const buildProviders = ({
  config,
  wallet,
  accountId,
  password,
  privateStateStore = 'conserve-private-state',
}: ProviderOptions): ConserveProviders => {
  setNetworkId(config.networkId);

  const zkConfigProvider = new NodeZkConfigProvider<ConserveCircuitId>(zkAssetsDirectory());

  return {
    privateStateProvider: levelPrivateStateProvider<
      typeof CONSERVE_PRIVATE_STATE_ID,
      ConservePrivateState
    >({
      privateStateStoreName: privateStateStore,
      accountId,
      privateStoragePasswordProvider: password,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider),
    walletProvider: wallet.walletProvider,
    midnightProvider: wallet.midnightProvider,
  };
};
