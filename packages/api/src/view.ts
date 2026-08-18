/**
 * The read-only projection of a Conserve contract.
 *
 * Deliberately free of Node-only dependencies so the browser dashboard and the
 * CLI render the public state through exactly the same code.
 */

import { CycleStatus, type Ledger, pureCircuits } from '@conserve/contract';

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

/** A receipt as handed to a recipient after a settlement. */
export type Receipt = {
  readonly cycleId: bigint;
  readonly recipient: Uint8Array;
  readonly amount: bigint;
  readonly nonce: Uint8Array;
};

export type ReceiptVerdict =
  | { readonly anchored: true; readonly commitment: string; readonly pathLength: number }
  | { readonly anchored: false; readonly commitment: string; readonly reason: string };

/**
 * Checks a receipt against a contract's public state.
 *
 * The recipient recomputes their own commitment from the four values they were
 * given and looks for it in the on-chain tree. A commitment that is present
 * proves the organizer really did include that exact amount in a settlement the
 * network accepted — and it does so without the recipient revealing the amount
 * to anyone, and without learning anything about the rest of the payroll.
 */
export const verifyReceipt = (state: Ledger, receipt: Receipt): ReceiptVerdict => {
  const commitment = pureCircuits.receiptCommitment(
    receipt.cycleId,
    receipt.recipient,
    receipt.amount,
    receipt.nonce,
  );
  const path = state.receipts.findPathForLeaf(commitment);
  if (path === undefined) {
    return {
      anchored: false,
      commitment: hex(commitment),
      reason:
        'no such commitment in the receipt tree — the amount, nonce, cycle or recipient does not match what was settled',
    };
  }
  return { anchored: true, commitment: hex(commitment), pathLength: path.path.length };
};
