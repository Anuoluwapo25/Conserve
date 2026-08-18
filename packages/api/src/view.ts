/**
 * The read-only projection of a Conserve contract.
 *
 * Deliberately free of Node-only dependencies so the browser dashboard and the
 * CLI render the public state through exactly the same code.
 */

import { CycleStatus, type Ledger } from '@conserve/contract';

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

export const hex = (bytes: Uint8Array): string =>
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
