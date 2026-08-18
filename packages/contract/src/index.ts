/**
 * Witness bindings and private-state helpers for the Conserve contract.
 *
 * Everything in {@link ConservePrivateState} stays on the payer's machine. The
 * proof server reads it to build the settlement proof; the ledger never sees it.
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import {
  type Ledger,
  type PayoutEntry,
  CycleStatus,
  Contract,
  ledger,
  pureCircuits,
} from '../managed/conserve/contract/index.js';

export { Contract, ledger, pureCircuits, CycleStatus };
export type { Ledger, PayoutEntry };

/** Roster width baked into the circuit. Every cycle proves exactly this many slots. */
export const MAX_RECIPIENTS = 16;

/** Fixed-width roster handed to the circuit: real payouts followed by padding. */
export type Roster = PayoutEntry[];

export type ConservePrivateState = {
  /** Authorises `openCycle` and `settle`. Only its hash is on-chain. */
  readonly organizerSecretKey: Uint8Array;
  /** Total budget for the open cycle. Committed on-chain, never revealed. */
  readonly budgetTotal: bigint;
  /** Blinding factor for the budget commitment. */
  readonly budgetSalt: Uint8Array;
  /** Per-cycle blinding factor for recipient nullifiers. */
  readonly cycleSalt: Uint8Array;
  /** The padded roster proved by `settle`. */
  readonly roster: Roster;
};

export const emptyPrivateState = (organizerSecretKey: Uint8Array): ConservePrivateState => ({
  organizerSecretKey,
  budgetTotal: 0n,
  budgetSalt: new Uint8Array(32),
  cycleSalt: new Uint8Array(32),
  roster: padRoster([], new Uint8Array(32)),
});

export const witnesses = {
  organizerSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, Uint8Array] => [
    privateState,
    privateState.organizerSecretKey,
  ],
  payoutRoster: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, Roster] => [
    privateState,
    privateState.roster,
  ],
  budgetTotal: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, bigint] => [
    privateState,
    privateState.budgetTotal,
  ],
  budgetSalt: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, Uint8Array] => [
    privateState,
    privateState.budgetSalt,
  ],
  cycleSalt: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, Uint8Array] => [
    privateState,
    privateState.cycleSalt,
  ],
};

/** A payout line as a human writes it, before padding and nonce assignment. */
export type Payout = {
  readonly recipient: Uint8Array;
  readonly amount: bigint;
};

export class RosterError extends Error {}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/**
 * Pads a payout list out to the fixed roster width.
 *
 * Padding slots carry a random recipient and a zero amount, so they are
 * indistinguishable on-chain from real ones: a settlement always writes exactly
 * MAX_RECIPIENTS nullifiers and receipts, whatever the real headcount.
 */
export const padRoster = (payouts: readonly Payout[], _seed?: Uint8Array): Roster => {
  if (payouts.length > MAX_RECIPIENTS) {
    throw new RosterError(
      `roster holds ${payouts.length} payouts but the circuit proves ${MAX_RECIPIENTS} slots`,
    );
  }
  const entries: PayoutEntry[] = payouts.map(({ recipient, amount }) => {
    if (recipient.length !== 32) {
      throw new RosterError('recipient identifiers must be 32 bytes');
    }
    if (amount <= 0n) {
      throw new RosterError('payout amounts must be positive');
    }
    return { recipient, amount, nonce: randomBytes32() };
  });
  while (entries.length < MAX_RECIPIENTS) {
    entries.push({ recipient: randomBytes32(), amount: 0n, nonce: randomBytes32() });
  }
  return entries;
};

/**
 * Checks the roster against the same rules the circuit enforces, so a bad
 * payroll fails locally with a readable message instead of as a proof error.
 */
export const assertRosterValid = (roster: Roster, total: bigint): void => {
  if (roster.length !== MAX_RECIPIENTS) {
    throw new RosterError(`roster must hold exactly ${MAX_RECIPIENTS} slots`);
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const entry of roster) {
    const key = toHex(entry.recipient);
    if (seen.has(key)) {
      throw new RosterError(`recipient ${key.slice(0, 16)}… appears more than once`);
    }
    seen.add(key);
    sum += entry.amount;
  }
  if (sum !== total) {
    throw new RosterError(`payouts sum to ${sum} but the committed budget is ${total}`);
  }
};

/** Builds the private state for a cycle from a payout list and a budget total. */
export const prepareCycle = (
  organizerSecretKey: Uint8Array,
  payouts: readonly Payout[],
  budgetTotal: bigint,
): ConservePrivateState => {
  const roster = padRoster(payouts);
  assertRosterValid(roster, budgetTotal);
  return {
    organizerSecretKey,
    budgetTotal,
    budgetSalt: randomBytes32(),
    cycleSalt: randomBytes32(),
    roster,
  };
};

/** The receipt a recipient keeps so they can later prove what they were paid. */
export type ReceiptRecord = {
  readonly cycleId: bigint;
  readonly recipient: Uint8Array;
  readonly amount: bigint;
  readonly nonce: Uint8Array;
  readonly commitment: Uint8Array;
};

/** Derives the receipts for a settled cycle, one per real payout. */
export const receiptsFor = (state: ConservePrivateState, cycleId: bigint): ReceiptRecord[] =>
  state.roster
    .filter((entry) => entry.amount > 0n)
    .map((entry) => ({
      cycleId,
      recipient: entry.recipient,
      amount: entry.amount,
      nonce: entry.nonce,
      commitment: pureCircuits.receiptCommitment(
        cycleId,
        entry.recipient,
        entry.amount,
        entry.nonce,
      ),
    }));
