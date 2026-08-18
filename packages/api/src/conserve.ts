/**
 * Cycle workflows: deploy a payroll contract, open a cycle against a budget
 * commitment, and settle it with a private roster.
 *
 * Every function here keeps the roster and the amounts on the caller's machine.
 * What crosses the wire is a proof plus the cycle's public trace.
 */

import {
  type DeployedContract,
  type FoundContract,
  deployContract,
  findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  type ConservePrivateState,
  type Ledger,
  type Payout,
  type ReceiptRecord,
  CycleStatus,
  assertRosterValid,
  ledger,
  padRoster,
  pureCircuits,
  randomBytes32,
  receiptsFor,
} from '@conserve/contract';
import { CONSERVE_PRIVATE_STATE_ID } from './config.js';
import { type ConserveContract, conserveCompiledContract } from './contract.js';
import type { ConserveProviders } from './providers.js';

export type ConserveDeployment =
  | DeployedContract<ConserveContract>
  | FoundContract<ConserveContract>;

/** Deploys a fresh payroll contract bound to the organizer's key. */
export const deploy = async (
  providers: ConserveProviders,
  privateState: ConservePrivateState,
): Promise<DeployedContract<ConserveContract>> => {
  const organizerPk = pureCircuits.organizerPublicKey(privateState.organizerSecretKey);
  return deployContract(providers, {
    compiledContract: conserveCompiledContract,
    privateStateId: CONSERVE_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
    args: [organizerPk],
  });
};

/** Reconnects to a contract that is already on chain. */
export const join = async (
  providers: ConserveProviders,
  contractAddress: ContractAddress,
  privateState: ConservePrivateState,
): Promise<FoundContract<ConserveContract>> =>
  findDeployedContract(providers, {
    compiledContract: conserveCompiledContract,
    contractAddress,
    privateStateId: CONSERVE_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  });

export type OpenCycleResult = {
  readonly cycleId: bigint;
  readonly txId: string;
  readonly blockHeight: number;
  /** The private state to keep for the settlement; holds the budget salt. */
  readonly privateState: ConservePrivateState;
};

/**
 * Publishes the budget commitment for a new cycle.
 *
 * The commitment is what makes the later settlement proof binding: the total is
 * fixed on chain before any individual amount is chosen, so the organizer
 * cannot fit the budget to the payouts after the fact.
 */
export const openCycle = async (
  providers: ConserveProviders,
  deployment: ConserveDeployment,
  privateState: ConservePrivateState,
  budgetTotal: bigint,
): Promise<OpenCycleResult> => {
  if (budgetTotal <= 0n) {
    throw new Error('conserve: the cycle budget must be positive');
  }
  const budgetSalt = randomBytes32();
  const next: ConservePrivateState = { ...privateState, budgetTotal, budgetSalt };
  await providers.privateStateProvider.set(CONSERVE_PRIVATE_STATE_ID, next);

  const commitment = pureCircuits.budgetCommitmentOf(budgetTotal, budgetSalt);
  const finalized = await deployment.callTx.openCycle(commitment);

  return {
    cycleId: finalized.private.result,
    txId: finalized.public.txId,
    blockHeight: finalized.public.blockHeight,
    privateState: next,
  };
};

export type SettleResult = {
  readonly txId: string;
  readonly blockHeight: number;
  /** One receipt per real payout, to hand to the recipient. */
  readonly receipts: readonly ReceiptRecord[];
  readonly privateState: ConservePrivateState;
};

/**
 * Proves and submits the split.
 *
 * The roster is validated locally against the same rules the circuit enforces,
 * so a payroll that does not add up fails in milliseconds rather than after a
 * proof has been generated.
 */
export const settle = async (
  providers: ConserveProviders,
  deployment: ConserveDeployment,
  privateState: ConservePrivateState,
  payouts: readonly Payout[],
): Promise<SettleResult> => {
  const roster = padRoster(payouts);
  assertRosterValid(roster, privateState.budgetTotal);

  const next: ConservePrivateState = { ...privateState, roster, cycleSalt: randomBytes32() };
  await providers.privateStateProvider.set(CONSERVE_PRIVATE_STATE_ID, next);

  const finalized = await deployment.callTx.settle();
  const { cycleId } = await publicState(providers, contractAddressOf(deployment));

  return {
    txId: finalized.public.txId,
    blockHeight: finalized.public.blockHeight,
    receipts: receiptsFor(next, cycleId),
    privateState: next,
  };
};

export const contractAddressOf = (deployment: ConserveDeployment): ContractAddress =>
  deployment.deployTxData.public.contractAddress;

/** Reads the contract's public state — the same view a block explorer has. */
export const publicState = async (
  providers: ConserveProviders,
  contractAddress: ContractAddress,
): Promise<Ledger> => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (state === null) {
    throw new Error(`conserve: no contract found at ${contractAddress}`);
  }
  return ledger(state.data);
};

/** Everything an outside observer can learn about a cycle. */
export type PublicCycleView = {
  readonly cycleId: bigint;
  readonly status: string;
  readonly budgetCommitment: string;
  readonly settledCycles: bigint;
  readonly nullifierCount: bigint;
  readonly receiptsAnchored: bigint;
  readonly rosterWidth: bigint;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const summarise = (state: Ledger): PublicCycleView => ({
  cycleId: state.cycleId,
  status: CycleStatus[state.status] ?? String(state.status),
  budgetCommitment: hex(state.budgetCommitment),
  settledCycles: state.settledCycles,
  nullifierCount: state.nullifiers.size(),
  receiptsAnchored: state.receipts.firstFree(),
  rosterWidth: state.MAX_RECIPIENTS,
});
