/**
 * Recipient-side receipt checking, entirely in the browser.
 *
 * The recipient pastes the four values their employer gave them. The check runs
 * against public state, so it needs no wallet and no credentials — and it tells
 * the employer nothing, because nothing is sent anywhere.
 */

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { type NetworkProfile, networkConfig } from '@conserve/api/config';
import { type ReceiptVerdict, verifyReceipt } from '@conserve/api/view';
import { ledger } from '@conserve/contract';

export type ReceiptInput = {
  readonly cycleId: string;
  readonly recipient: string;
  readonly amount: string;
  readonly nonce: string;
};

export const emptyReceipt = (): ReceiptInput => ({
  cycleId: '',
  recipient: '',
  amount: '',
  nonce: '',
});

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

const bytes = (value: string): Uint8Array => {
  const hex = value.trim().replace(/^0x/, '');
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
};

export const receiptIssues = (input: ReceiptInput): string[] => {
  const issues: string[] = [];
  if (!/^\d+$/.test(input.cycleId.trim())) issues.push('Cycle must be a whole number.');
  if (!HEX32.test(input.recipient)) issues.push('Recipient must be a 32-byte hex identifier.');
  if (!/^\d+$/.test(input.amount.trim())) issues.push('Amount must be a whole number.');
  if (!HEX32.test(input.nonce))
    issues.push('Nonce must be the 32-byte hex value from your receipt.');
  return issues;
};

export const checkReceipt = async (
  profile: NetworkProfile,
  contractAddress: string,
  input: ReceiptInput,
): Promise<ReceiptVerdict> => {
  const config = networkConfig(profile);
  setNetworkId(config.networkId);
  const provider = indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl);
  const state = await provider.queryContractState(contractAddress);
  if (state === null) {
    throw new Error(`No contract found at ${contractAddress} on ${config.networkId}.`);
  }
  return verifyReceipt(ledger(state.data), {
    cycleId: BigInt(input.cycleId.trim()),
    recipient: bytes(input.recipient),
    amount: BigInt(input.amount.trim()),
    nonce: bytes(input.nonce),
  });
};
