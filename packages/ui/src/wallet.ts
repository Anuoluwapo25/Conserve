/**
 * Browser wallet connection through the Midnight DApp connector (Lace and any
 * other wallet that injects `window.midnight`).
 *
 * The wallet holds the keys, pays the fees and proves. This module turns what
 * the connector exposes into the providers midnight-js needs, so the dashboard
 * runs the same deploy, mint, open and settle workflows the CLI does — without a
 * seed in a file.
 */

import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { CostModel, Transaction, type FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import { dappConnectorProofProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { ConserveProviders, DemoDollarProviders } from '@conserve/api';

declare global {
  interface Window {
    midnight?: Record<string, InitialAPI>;
  }
}

/**
 * An injected wallet, kept as the object the extension put on `window.midnight`.
 *
 * Never copy or re-wrap it: these are class instances with private fields, and a
 * copy loses its identity, so the first call fails with "attempted to get
 * private field on non-instance". The id travels beside the API instead.
 */
export type AvailableWallet = {
  readonly id: string;
  readonly api: InitialAPI;
  /** Whether it speaks the connector version this dashboard is built against. */
  readonly supported: boolean;
};

/** Connector API major version this dashboard is built against. */
const SUPPORTED_API_MAJOR = '4.';

/** Wallets that have injected a connector this dashboard can talk to. */
export const availableWallets = (): AvailableWallet[] =>
  Object.entries(window.midnight ?? {})
    .filter(([, api]) => typeof api?.connect === 'function')
    .map(([id, api]) => ({
      id,
      api,
      supported: String(api.apiVersion ?? '').startsWith(SUPPORTED_API_MAJOR),
    }));

export type WalletSession = {
  readonly wallet: AvailableWallet;
  readonly api: ConnectedAPI;
  readonly networkId: string;
  readonly indexerUri: string;
  readonly indexerWsUri: string;
  readonly shieldedAddress: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
};

export const connectWallet = async (
  wallet: AvailableWallet,
  networkId: string,
): Promise<WalletSession> => {
  // Call through the injected object so `this` stays the wallet's own instance.
  const api = await wallet.api.connect(networkId);
  const [config, addresses] = await Promise.all([
    api.getConfiguration(),
    api.getShieldedAddresses(),
  ]);
  if (config.networkId !== networkId) {
    throw new Error(
      `${wallet.api.name} is on ${config.networkId}; switch it to ${networkId} and connect again.`,
    );
  }
  setNetworkId(config.networkId);
  return {
    wallet,
    api,
    networkId: config.networkId,
    indexerUri: config.indexerUri,
    indexerWsUri: config.indexerWsUri,
    shieldedAddress: addresses.shieldedAddress,
    coinPublicKey: addresses.shieldedCoinPublicKey,
    encryptionPublicKey: addresses.shieldedEncryptionPublicKey,
  };
};

/**
 * Whether an error means the wallet's messaging channel is gone.
 *
 * A connector API object is a live channel into the extension, not a handle
 * that keeps working. Dismissing the popup, or the extension's background
 * worker sleeping between steps, tears it down — and every later call fails
 * with "Remote API with channel '…' was shutdown: object can no longer be
 * used". Reconnecting is the only cure, so recognise it and do that.
 */
export const isChannelClosed = (cause: unknown): boolean =>
  /was shutdown|no longer be used|disconnect|not connected/i.test(
    String(cause instanceof Error ? cause.message : cause),
  );

/**
 * Returns a session whose channel is known to be live, reconnecting if the
 * wallet has closed the old one. Long-running steps should call this first:
 * a proof takes minutes, and the channel may not survive it.
 */
export const ensureConnected = async (session: WalletSession): Promise<WalletSession> => {
  try {
    const status = await session.api.getConnectionStatus();
    if (status.status === 'connected' && status.networkId === session.networkId) {
      return session;
    }
  } catch (cause) {
    if (!isChannelClosed(cause)) throw cause;
  }
  return connectWallet(session.wallet, session.networkId);
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));

/** The wallet balances and seals; the wallet submits. */
const walletSide = (
  session: WalletSession,
): {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
} => ({
  walletProvider: {
    getCoinPublicKey: () => session.coinPublicKey,
    getEncryptionPublicKey: () => session.encryptionPublicKey,
    balanceTx: async (tx) => {
      const { tx: sealed } = await session.api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        fromHex(sealed),
      ) as FinalizedTransaction;
    },
  },
  midnightProvider: {
    submitTx: async (tx) => {
      await session.api.submitTransaction(toHex(tx.serialize()));
      const [id] = tx.identifiers();
      if (id === undefined) throw new Error('submitted transaction has no identifier');
      return id;
    },
  },
});

/**
 * Where the browser fetches a contract's proving keys and ZK IR: this site's
 * `zk/<contract>/`, a copy of what the Compact compiler wrote to `managed/`.
 */
export const zkBaseUrl = (contract: 'conserve' | 'demo-dollar'): string =>
  new URL(`zk/${contract}/`, document.baseURI).toString();

type ProviderKinds = {
  conserve: ConserveProviders;
  'demo-dollar': DemoDollarProviders;
};

/**
 * Providers for one contract, backed by the connected wallet.
 *
 * The private state — for Conserve, the roster — is encrypted with `password`
 * and kept in this browser's IndexedDB. It never leaves the machine.
 */
export const browserProviders = async <K extends keyof ProviderKinds>(
  session: WalletSession,
  contract: K,
  password: string,
): Promise<ProviderKinds[K]> => {
  const zkConfigProvider = new FetchZkConfigProvider<string>(zkBaseUrl(contract));
  const proofProvider = await dappConnectorProofProvider(
    session.api,
    zkConfigProvider,
    CostModel.initialCostModel(),
  );
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `conserve-browser-${contract}`,
      accountId: session.coinPublicKey,
      privateStoragePasswordProvider: () => password,
    }),
    publicDataProvider: indexerPublicDataProvider(session.indexerUri, session.indexerWsUri),
    zkConfigProvider,
    proofProvider,
    ...walletSide(session),
  } as unknown as ProviderKinds[K];
};
