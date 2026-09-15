/**
 * Witness bindings and private-state helpers for the Conserve contract.
 *
 * Everything in {@link ConservePrivateState} stays on the payer's machine. The
 * proof server reads it to build the settlement proof; the ledger never sees it.
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
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

/** Fixed-width roster handed to the circuit: padding followed by real payouts. */
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
  /** Nonce of the shielded coin the organizer's wallet funds the settlement with. */
  readonly fundingNonce: Uint8Array;
  /**
   * Hex coin public key → hex encryption public key for every roster slot. Each
   * payout is encrypted to its recipient's key so their wallet can find it;
   * padding slots carry throwaway keys, so their payouts are encrypted too and
   * look no different.
   */
  readonly encryptionKeys: readonly (readonly [string, string])[];
};

export const emptyPrivateState = (organizerSecretKey: Uint8Array): ConservePrivateState => ({
  organizerSecretKey,
  budgetTotal: 0n,
  budgetSalt: new Uint8Array(32),
  cycleSalt: new Uint8Array(32),
  roster: [],
  fundingNonce: new Uint8Array(32),
  encryptionKeys: [],
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
  fundingNonce: ({
    privateState,
  }: WitnessContext<Ledger, ConservePrivateState>): [ConservePrivateState, Uint8Array] => [
    privateState,
    privateState.fundingNonce,
  ],
};

/**
 * A payout line as a human writes it, before padding and nonce assignment. The
 * recipient is identified by the two keys in a shielded address: the coin public
 * key the payout is sent to, and the encryption public key that lets their
 * wallet detect it.
 */
export type Payout = {
  readonly recipient: Uint8Array;
  readonly encryptionKey: string;
  readonly amount: bigint;
};

export class RosterError extends Error {}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));

/**
 * A recipient nobody controls: a fresh shielded key pair whose secret is
 * dropped. Padding slots are paid zero to one of these, so every slot produces
 * an encrypted shielded payout and a real one cannot be told from padding.
 */
export const throwawayRecipient = (): Pick<Payout, 'recipient' | 'encryptionKey'> => {
  const keys = ZswapSecretKeys.fromSeed(randomBytes32());
  const recipient = {
    recipient: fromHex(keys.coinPublicKey),
    encryptionKey: keys.encryptionPublicKey,
  };
  keys.clear();
  return recipient;
};

/** A padded roster together with the encryption key for each of its slots. */
export type PaddedRoster = {
  readonly roster: Roster;
  readonly encryptionKeys: readonly (readonly [string, string])[];
};

/**
 * Pads a payout list out to the fixed roster width.
 *
 * Padding slots carry a throwaway recipient and a zero amount, so they are
 * indistinguishable on-chain from real ones: a settlement always writes exactly
 * MAX_RECIPIENTS nullifiers and receipts and makes exactly MAX_RECIPIENTS
 * shielded payouts, whatever the real headcount.
 *
 * Padding goes first. Settlement pays the slots in order from one coin, and the
 * change coin is skipped only when change reaches zero; with every real payout
 * last, that happens at the final slot and nowhere else, so the transaction has
 * the same shape for a team of one as for a team of sixteen.
 */
export const padRoster = (payouts: readonly Payout[]): PaddedRoster => {
  if (payouts.length > MAX_RECIPIENTS) {
    throw new RosterError(
      `roster holds ${payouts.length} payouts but the circuit proves ${MAX_RECIPIENTS} slots`,
    );
  }
  const real = payouts.map((payout) => {
    if (payout.recipient.length !== 32) {
      throw new RosterError('recipient coin public keys must be 32 bytes');
    }
    if (!/^[0-9a-fA-F]+$/.test(payout.encryptionKey)) {
      throw new RosterError('recipient encryption keys must be hex');
    }
    if (payout.amount <= 0n) {
      throw new RosterError('payout amounts must be positive');
    }
    return payout;
  });
  const padding = Array.from({ length: MAX_RECIPIENTS - real.length }, () => ({
    ...throwawayRecipient(),
    amount: 0n,
  }));
  const slots = [...padding, ...real];
  return {
    roster: slots.map(({ recipient, amount }) => ({
      recipient: { bytes: recipient },
      amount,
      nonce: randomBytes32(),
    })),
    encryptionKeys: slots.map(({ recipient, encryptionKey }) => [toHex(recipient), encryptionKey]),
  };
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
    const key = toHex(entry.recipient.bytes);
    if (seen.has(key)) {
      throw new RosterError(`recipient ${key.slice(0, 16)}… appears more than once`);
    }
    seen.add(key);
    sum += entry.amount;
  }
  if (sum !== total) {
    throw new RosterError(`payouts sum to ${sum} but the committed budget is ${total}`);
  }
  if (roster[MAX_RECIPIENTS - 1]!.amount === 0n) {
    throw new RosterError('the last roster slot must be a real payout; padding goes first');
  }
};

/** Builds the private state for a cycle from a payout list and a budget total. */
export const prepareCycle = (
  organizerSecretKey: Uint8Array,
  payouts: readonly Payout[],
  budgetTotal: bigint,
): ConservePrivateState => {
  const { roster, encryptionKeys } = padRoster(payouts);
  assertRosterValid(roster, budgetTotal);
  return {
    organizerSecretKey,
    budgetTotal,
    budgetSalt: randomBytes32(),
    cycleSalt: randomBytes32(),
    roster,
    fundingNonce: randomBytes32(),
    encryptionKeys,
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
      recipient: entry.recipient.bytes,
      amount: entry.amount,
      nonce: entry.nonce,
      commitment: pureCircuits.receiptCommitment(
        cycleId,
        entry.recipient.bytes,
        entry.amount,
        entry.nonce,
      ),
    }));
