/**
 * Demo Dollar workflows: deploy the test token and mint a working balance.
 *
 * Conserve pays in the shielded token its deployment names. On a network with
 * no shielded token to hand, this is where an organizer gets one.
 */

import { rawTokenType } from '@midnight-ntwrk/ledger-v8';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { DEMO_DOLLAR_DOMAIN } from '@conserve/contract/demo-dollar';
import { randomBytes32 } from '@conserve/contract';
import { demoDollarCompiledContract } from './contract.js';
import type { DemoDollarProviders } from './providers.js';

/** Deploys a Demo Dollar token contract and returns its address. */
export const deployDemoDollar = async (providers: DemoDollarProviders): Promise<string> => {
  const deployed = await deployContract(providers, {
    compiledContract: demoDollarCompiledContract,
  } as never);
  return (deployed as { deployTxData: { public: { contractAddress: string } } }).deployTxData.public
    .contractAddress;
};

/** The token type a Demo Dollar contract at `address` mints: what Conserve is deployed to pay in. */
export const demoDollarToken = (address: string): string =>
  rawTokenType(DEMO_DOLLAR_DOMAIN, address);

export type MintResult = { readonly txId: string; readonly blockHeight: number };

/**
 * Mints `amount` Demo Dollars to the calling wallet's shielded address.
 *
 * The amount is public. Mint a round working balance, not one cycle's exact
 * budget, or the mint reveals the total the budget commitment keeps private.
 */
export const mintDemoDollars = async (
  providers: DemoDollarProviders,
  address: string,
  amount: bigint,
): Promise<MintResult> => {
  if (amount <= 0n) {
    throw new Error('conserve: mint a positive amount');
  }
  const result = await submitCallTx(providers, {
    compiledContract: demoDollarCompiledContract,
    circuitId: 'mint',
    contractAddress: address,
    args: [amount, randomBytes32()],
  } as never);
  const { txId, blockHeight } = (result as { public: MintResult }).public;
  return { txId, blockHeight };
};
