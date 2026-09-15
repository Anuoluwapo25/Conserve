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
import type { DemoDollarPrivateState } from '@conserve/contract/demo-dollar';
import { CONSERVE_PRIVATE_STATE_ID, type NetworkConfig } from './config.js';
import type { ConserveCircuitId, DemoDollarCircuitId } from './contract.js';

export type ConserveProviders = MidnightProviders<
  ConserveCircuitId,
  typeof CONSERVE_PRIVATE_STATE_ID,
  ConservePrivateState
>;

export type DemoDollarProviders = MidnightProviders<
  DemoDollarCircuitId,
  string,
  DemoDollarPrivateState
>;

/** Wallet-side providers, supplied by either the headless wallet or the browser connector. */
export type WalletProviders = Pick<ConserveProviders, 'walletProvider' | 'midnightProvider'>;

/**
 * Locates a contract's directory under the contract package's `managed/`, where
 * the Compact compiler wrote its prover keys, verifier keys and ZK IR.
 */
export const zkAssetsDirectory = (contract: 'conserve' | 'demo-dollar' = 'conserve'): string => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@conserve/contract');
  return resolve(dirname(entry), `../managed/${contract}`);
};

/**
 * How long to wait for one proof.
 *
 * The client's own default is five minutes, and a `settle` proof takes longer
 * than that: it proves the split and sixteen shielded payouts in one circuit,
 * which measured a little over five minutes on a developer machine. Exceeding
 * the limit aborts the request, and the failure surfaces as a transaction that
 * simply never arrives, so the default here is generous and the environment can
 * raise it further on slower hardware.
 */
const PROOF_TIMEOUT_MS = 45 * 60 * 1000;

const proofTimeout = (): number => {
  const configured = process.env.CONSERVE_PROOF_TIMEOUT_MS;
  const parsed = configured === undefined ? Number.NaN : Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PROOF_TIMEOUT_MS;
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
    proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider, {
      timeout: proofTimeout(),
    }),
    walletProvider: wallet.walletProvider,
    midnightProvider: wallet.midnightProvider,
  };
};

/**
 * Providers for the Demo Dollar token. It keeps no private state, but
 * midnight-js still expects a store, so it gets its own rather than sharing the
 * one that holds the payroll.
 */
export const buildDemoDollarProviders = ({
  config,
  wallet,
  accountId,
  password,
}: ProviderOptions): DemoDollarProviders => {
  setNetworkId(config.networkId);

  const zkConfigProvider = new NodeZkConfigProvider<DemoDollarCircuitId>(
    zkAssetsDirectory('demo-dollar'),
  );

  return {
    privateStateProvider: levelPrivateStateProvider<string, DemoDollarPrivateState>({
      privateStateStoreName: 'conserve-demo-dollar-state',
      accountId,
      privateStoragePasswordProvider: password,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider, {
      timeout: proofTimeout(),
    }),
    walletProvider: wallet.walletProvider,
    midnightProvider: wallet.midnightProvider,
  };
};
