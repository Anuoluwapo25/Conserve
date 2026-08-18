/**
 * Receipt verification: what a recipient can prove to themselves, and what an
 * organizer cannot fake.
 */

import { describe, expect, it } from 'vitest';
import { type Payout, prepareCycle, pureCircuits, randomBytes32, receiptsFor } from './index.js';
import { ConserveSimulator } from './simulator.js';

const ORGANIZER_SK = randomBytes32();

const settledCycle = (payouts: readonly Payout[], total: bigint) => {
  const state = prepareCycle(ORGANIZER_SK, payouts, total);
  const sim = new ConserveSimulator(state);
  sim.setPrivateState(state);
  const cycleId = sim.openCycle(
    pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt),
  );
  sim.settle();
  return { sim, state, cycleId, receipts: receiptsFor(state, cycleId) };
};

const anchored = (sim: ConserveSimulator, commitment: Uint8Array): boolean =>
  sim.ledger.receipts.findPathForLeaf(commitment) !== undefined;

describe('receipt verification', () => {
  const alice = randomBytes32();
  const bob = randomBytes32();
  const payouts: Payout[] = [
    { recipient: alice, amount: 6_000n },
    { recipient: bob, amount: 4_000n },
  ];

  it('accepts a recipient checking their own receipt', () => {
    const { sim, receipts } = settledCycle(payouts, 10_000n);
    const mine = receipts.find((receipt) => receipt.recipient === alice)!;

    expect(
      anchored(
        sim,
        pureCircuits.receiptCommitment(mine.cycleId, mine.recipient, mine.amount, mine.nonce),
      ),
    ).toBe(true);
  });

  it('rejects a receipt with any single field altered', () => {
    const { sim, receipts, cycleId } = settledCycle(payouts, 10_000n);
    const real = receipts[0]!;

    const tampered = [
      ['amount', pureCircuits.receiptCommitment(cycleId, real.recipient, 9_999n, real.nonce)],
      [
        'nonce',
        pureCircuits.receiptCommitment(cycleId, real.recipient, real.amount, randomBytes32()),
      ],
      [
        'recipient',
        pureCircuits.receiptCommitment(cycleId, randomBytes32(), real.amount, real.nonce),
      ],
      [
        'cycle',
        pureCircuits.receiptCommitment(cycleId + 1n, real.recipient, real.amount, real.nonce),
      ],
    ] as const;

    for (const [field, commitment] of tampered) {
      expect(anchored(sim, commitment), `${field} should not verify`).toBe(false);
    }
  });

  it('does not let a recipient learn anything about the rest of the payroll', () => {
    const { sim, receipts } = settledCycle(payouts, 10_000n);
    const mine = receipts.find((receipt) => receipt.recipient === alice)!;

    // Alice knows her own amount and can guess Bob is on the roster. She still
    // cannot confirm what he was paid without also guessing his nonce, which is
    // 256 bits of randomness she never sees.
    for (const guess of [1_000n, 2_000n, 3_000n, 4_000n, 5_000n]) {
      expect(
        anchored(sim, pureCircuits.receiptCommitment(mine.cycleId, bob, guess, mine.nonce)),
      ).toBe(false);
    }
  });

  it('anchors receipts for every real payout and nothing identifiable for the padding', () => {
    const { sim, receipts } = settledCycle(payouts, 10_000n);

    expect(receipts).toHaveLength(2);
    // Sixteen leaves are written; only two of them are receipts anyone holds.
    expect(sim.ledger.receipts.firstFree()).toBe(16n);
  });
});
