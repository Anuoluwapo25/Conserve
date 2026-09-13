/**
 * Network endpoints for the environments Conserve runs against.
 *
 * Preprod is the public Midnight network the Level 4 MVP is deployed to; the
 * `undeployed` profile points at a local node stack for development.
 */

export type NetworkProfile = 'preprod' | 'undeployed';

export type NetworkConfig = {
  /** Value handed to `setNetworkId` so addresses serialise for the right chain. */
  readonly networkId: string;
  readonly indexerUrl: string;
  readonly indexerWsUrl: string;
  readonly nodeUrl: string;
  /** Proof servers are never remote: the roster is private and must not leave the operator's machine. */
  readonly proofServerUrl: string;
  readonly explorerUrl?: string;
};

const PREPROD: NetworkConfig = {
  networkId: 'preprod',
  indexerUrl: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  nodeUrl: 'https://rpc.preprod.midnight.network',
  proofServerUrl: 'http://127.0.0.1:6300',
  explorerUrl: 'https://explorer.preprod.midnight.network',
};

const UNDEPLOYED: NetworkConfig = {
  networkId: 'undeployed',
  indexerUrl: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWsUrl: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  nodeUrl: 'http://127.0.0.1:9944',
  proofServerUrl: 'http://127.0.0.1:6300',
};

const PROFILES: Record<NetworkProfile, NetworkConfig> = {
  preprod: PREPROD,
  undeployed: UNDEPLOYED,
};

export const isNetworkProfile = (value: string): value is NetworkProfile => value in PROFILES;

/**
 * Resolves a network profile, letting individual endpoints be overridden by
 * environment variables so a self-hosted node or proof server can be swapped in.
 */
export const networkConfig = (profile: NetworkProfile = 'preprod'): NetworkConfig => {
  const base = PROFILES[profile];
  return {
    ...base,
    indexerUrl: process.env.CONSERVE_INDEXER_URL ?? base.indexerUrl,
    indexerWsUrl: process.env.CONSERVE_INDEXER_WS_URL ?? base.indexerWsUrl,
    nodeUrl: process.env.CONSERVE_NODE_URL ?? base.nodeUrl,
    proofServerUrl: process.env.CONSERVE_PROOF_SERVER_URL ?? base.proofServerUrl,
  };
};

/**
 * The contract each network is actually running, so nothing has to be pasted in
 * to see live state. A visitor with no address in hand is the common case, and
 * the dashboard's whole claim is that the chain is publicly auditable — asking
 * for a 64-character hex string before showing anything argues the opposite.
 */
export const DEPLOYED_CONTRACT: Partial<Record<NetworkProfile, string>> = {
  preprod: '7940f5eeb2e87e5ab8629e1b8ce7167ef37f73e976261886edf90ffed1114e5d',
};

/** Key under which the payer's private state is stored locally. */
export const CONSERVE_PRIVATE_STATE_ID = 'conserve-private-state';
