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
import {
  type MidnightProvider,
  type ProverKey,
  type VerifierKey,
  type WalletProvider,
  type ZKIR,
  ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js-types';
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
  /**
   * The prover the wallet will use. It sees the payroll in the clear, so a
   * remote one is a disclosure — and a hosted prover will not take proving
   * material for an arbitrary contract anyway, failing with a bare 400.
   */
  readonly proverUri?: string;
};

/**
 * Network id spellings a wallet may use for the same chain. `connect` takes the
 * id as a hint and a wallet refuses outright when it disagrees ("Network ID
 * mismatch") without saying what it is set to — so ask for the one the contract
 * lives on first, then try the aliases before giving up.
 */
const NETWORK_ALIASES: Record<string, readonly string[]> = {
  preprod: ['preprod', 'Preprod', 'pre-prod', 'preprod-02', 'testnet-preprod'],
  undeployed: ['undeployed', 'Undeployed'],
};

const isNetworkMismatch = (cause: unknown): boolean =>
  /network\s*id\s*mismatch|unsupported network|wrong network/i.test(
    String(cause instanceof Error ? cause.message : cause),
  );

export const connectWallet = async (
  wallet: AvailableWallet,
  networkId: string,
): Promise<WalletSession> => {
  // Call through the injected object so `this` stays the wallet's own instance.
  let api: ConnectedAPI | undefined;
  let mismatch: unknown;
  for (const candidate of NETWORK_ALIASES[networkId] ?? [networkId]) {
    try {
      api = await wallet.api.connect(candidate);
      break;
    } catch (cause) {
      if (!isNetworkMismatch(cause)) throw cause;
      mismatch = cause;
    }
  }
  if (api === undefined) {
    throw new Error(
      `${wallet.api.name} refused to connect on ${networkId}: its own Midnight network is set to ` +
        `something else. Open the wallet, switch its network to ${networkId}, then connect again. ` +
        `(${mismatch instanceof Error ? mismatch.message : String(mismatch)})`,
    );
  }
  const [config, addresses] = await Promise.all([
    api.getConfiguration(),
    api.getShieldedAddresses(),
  ]);
  // The wallet accepted a hint but reports its own network: if that is not the
  // one the contract lives on, nothing here would work against it.
  if (config.networkId.toLowerCase() !== networkId.toLowerCase()) {
    throw new Error(
      `${wallet.api.name} is connected to ${config.networkId}, but this dashboard reads a contract on ` +
        `${networkId}. Switch the wallet's Midnight network to ${networkId} and connect again.`,
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
    proverUri: config.proverServerUri,
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

/**
 * Serves a contract's ZK artifacts from this site, by circuit name.
 *
 * Key locations arrive namespaced as `<contract>#<circuit>` from parts of the
 * stack, and the fetcher rejects a name containing `#` outright — which
 * surfaced only as "Failed to read verifier key", naming neither the URL nor
 * the reason. So take the circuit off the end, and say what was being fetched
 * from where when something does fail.
 */
class SiteZkConfigProvider extends ZKConfigProvider<string> {
  private readonly fetcher: FetchZkConfigProvider<string>;

  constructor(private readonly baseUrl: string) {
    super();
    this.fetcher = new FetchZkConfigProvider<string>(baseUrl);
  }

  private circuitOf(circuitId: string): string {
    const hash = circuitId.lastIndexOf('#');
    return hash === -1 ? circuitId : circuitId.slice(hash + 1);
  }

  private async load<T>(what: string, circuitId: string, get: (circuit: string) => Promise<T>) {
    const circuit = this.circuitOf(circuitId);
    try {
      return await get(circuit);
    } catch (cause) {
      throw new Error(
        `could not load the ${what} for "${circuit}" from ${this.baseUrl}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  getProverKey(circuitId: string): Promise<ProverKey> {
    return this.load('proving key', circuitId, (circuit) => this.fetcher.getProverKey(circuit));
  }

  getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return this.load('verifier key', circuitId, (circuit) => this.fetcher.getVerifierKey(circuit));
  }

  getZKIR(circuitId: string): Promise<ZKIR> {
    return this.load('circuit IR', circuitId, (circuit) => this.fetcher.getZKIR(circuit));
  }
}

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
  const zkConfigProvider = new SiteZkConfigProvider(zkBaseUrl(contract));
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
