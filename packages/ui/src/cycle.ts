/**
 * Reads a Conserve contract's public state straight from the Preprod indexer.
 *
 * This is deliberately the same path a block explorer would take: if the
 * dashboard can only show commitments and counts, so can everybody else.
 */

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { type NetworkProfile, networkConfig } from '@conserve/api/config';
import { summarise } from '@conserve/api/view';
import { type Ledger, ledger } from '@conserve/contract';

export type CycleView = ReturnType<typeof summarise>;

/**
 * Fetches a contract's ledger once, so several views of the same moment — what
 * the public sees and what a recipient can prove — are computed from one read
 * rather than from reads that could straddle a new settlement.
 */
export const readLedger = async (
  profile: NetworkProfile,
  contractAddress: string,
): Promise<Ledger> => {
  const config = networkConfig(profile);
  setNetworkId(config.networkId);
  const provider = indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl);
  const state = await provider.queryContractState(contractAddress);
  if (state === null) {
    throw new Error(`No contract found at ${contractAddress} on ${config.networkId}.`);
  }
  return ledger(state.data);
};

export const readCycle = async (
  profile: NetworkProfile,
  contractAddress: string,
): Promise<CycleView> => summarise(await readLedger(profile, contractAddress));
