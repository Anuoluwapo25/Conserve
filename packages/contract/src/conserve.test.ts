import { describe, expect, it } from 'vitest';
import {
  CycleStatus,
  MAX_RECIPIENTS,
  type Payout,
  RosterError,
  assertRosterValid,
  emptyPrivateState,
  padRoster,
  prepareCycle,
  pureCircuits,
  randomBytes32,
  receiptsFor,
} from './index.js';
import { ConserveSimulator } from './simulator.js';

const ORGANIZER_SK = randomBytes32();

const payouts = (...amounts: bigint[]): Payout[] =>
  amounts.map((amount) => ({ recipient: randomBytes32(), amount }));

const sum = (values: bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/** Opens a cycle for `total` and settles it with `roster`, all in-process. */
const runCycle = (sim: ConserveSimulator, state: ReturnType<typeof prepareCycle>): bigint => {
  sim.setPrivateState(state);
  const cycleId = sim.openCycle(
    pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt),
  );
  sim.settle();
  return cycleId;
};

describe('deployment', () => {
  it('starts dormant with the organizer bound and no cycle open', () => {
    const sim = new ConserveSimulator(emptyPrivateState(ORGANIZER_SK));
    const { status, cycleId, organizer, settledCycles, MAX_RECIPIENTS: width } = sim.ledger;

    expect(status).toBe(CycleStatus.dormant);
    expect(cycleId).toBe(0n);
    expect(settledCycles).toBe(0n);
    expect(width).toBe(BigInt(MAX_RECIPIENTS));
    expect(organizer).toEqual(pureCircuits.organizerPublicKey(ORGANIZER_SK));
  });
});

describe('settle', () => {
  it('settles a conservative split and marks the cycle settled', () => {
    const amounts = [4_000n, 3_500n, 2_500n];
    const state = prepareCycle(ORGANIZER_SK, payouts(...amounts), sum(amounts));
    const sim = new ConserveSimulator(state);

    const cycleId = runCycle(sim, state);

    expect(cycleId).toBe(1n);
    expect(sim.ledger.status).toBe(CycleStatus.settled);
    expect(sim.ledger.settledCycles).toBe(1n);
  });

  it('rejects a roster that does not sum to the committed budget', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(4_000n, 3_500n, 2_500n), 10_000n);
    const sim = new ConserveSimulator(state);
    // Commit to 10_000 but hand the circuit a roster worth 9_999.
    const tampered = {
      ...state,
      roster: state.roster.map((entry, i) =>
        i === 0 ? { ...entry, amount: entry.amount - 1n } : entry,
      ),
    };

    sim.setPrivateState(state);
    sim.openCycle(pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt));
    sim.setPrivateState(tampered);

    expect(() => sim.settle()).toThrow(/do not sum to the committed budget/);
  });

  it('rejects a roster that pays the same recipient twice', () => {
    const recipient = randomBytes32();
    const state = prepareCycle(
      ORGANIZER_SK,
      [
        { recipient, amount: 6_000n },
        { recipient: randomBytes32(), amount: 4_000n },
      ],
      10_000n,
    );
    const sim = new ConserveSimulator(state);
    const duplicated = {
      ...state,
      roster: state.roster.map((entry, i) => (i === 1 ? { ...entry, recipient } : entry)),
    };

    sim.setPrivateState(state);
    sim.openCycle(pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt));
    sim.setPrivateState(duplicated);

    expect(() => sim.settle()).toThrow(/appears more than once/);
  });

  it('rejects a settlement opened against a different budget commitment', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(5_000n, 5_000n), 10_000n);
    const sim = new ConserveSimulator(state);

    sim.setPrivateState(state);
    // Commit to a budget of 12_000 while holding a roster worth 10_000.
    sim.openCycle(pureCircuits.budgetCommitmentOf(12_000n, state.budgetSalt));

    expect(() => sim.settle()).toThrow(/does not match the committed budget/);
  });

  it('rejects settlement by anyone other than the organizer', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(5_000n, 5_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    sim.setPrivateState(state);
    sim.openCycle(pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt));

    sim.setPrivateState({ ...state, organizerSecretKey: randomBytes32() });

    expect(() => sim.settle()).toThrow(/not the organizer/);
  });

  it('refuses to settle before a cycle is opened', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(5_000n, 5_000n), 10_000n);
    const sim = new ConserveSimulator(state);

    expect(() => sim.settle()).toThrow(/no cycle is open/);
  });

  it('refuses to open a second cycle while one is still open', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(5_000n, 5_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    sim.setPrivateState(state);
    const commitment = pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt);
    sim.openCycle(commitment);

    expect(() => sim.openCycle(commitment)).toThrow(/already open/);
  });
});

describe('public footprint', () => {
  it('leaks nothing about headcount: 2 and 11 recipients look identical on-chain', () => {
    const small = prepareCycle(ORGANIZER_SK, payouts(9_000n, 1_000n), 10_000n);
    const large = prepareCycle(
      ORGANIZER_SK,
      payouts(1_000n, 900n, 800n, 700n, 600n, 500n, 400n, 300n, 200n, 100n, 4_500n),
      10_000n,
    );

    const smallSim = new ConserveSimulator(small);
    runCycle(smallSim, small);
    const largeSim = new ConserveSimulator(large);
    runCycle(largeSim, large);

    expect(smallSim.ledger.nullifiers.size()).toBe(BigInt(MAX_RECIPIENTS));
    expect(largeSim.ledger.nullifiers.size()).toBe(smallSim.ledger.nullifiers.size());
    expect(largeSim.ledger.receipts.firstFree()).toBe(smallSim.ledger.receipts.firstFree());
  });

  it('never writes an amount or a recipient to the ledger', () => {
    const recipients = [randomBytes32(), randomBytes32()];
    const state = prepareCycle(
      ORGANIZER_SK,
      [
        { recipient: recipients[0]!, amount: 7_777n },
        { recipient: recipients[1]!, amount: 2_223n },
      ],
      10_000n,
    );
    const sim = new ConserveSimulator(state);
    runCycle(sim, state);

    const publicState = sim.ledger;
    const publicBytes = [
      publicState.organizer,
      publicState.budgetCommitment,
      ...Array.from(publicState.nullifiers),
    ].map(String);

    // No recipient identifier appears anywhere in public state.
    for (const recipient of recipients) {
      expect(publicBytes).not.toContain(String(recipient));
    }
    // The only numbers on-chain are the cycle id, the settled count and the
    // roster width — never a payout amount or the budget total.
    expect(publicState.cycleId).toBe(1n);
    expect(publicState.settledCycles).toBe(1n);
    expect(Object.values(publicState)).not.toContain(10_000n);
    expect(Object.values(publicState)).not.toContain(7_777n);
  });
});

describe('receipts', () => {
  it('anchors a receipt per real payout that the recipient can locate in the tree', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(6_000n, 3_000n, 1_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    const cycleId = runCycle(sim, state);

    const receipts = receiptsFor(state, cycleId);
    expect(receipts).toHaveLength(3);

    for (const receipt of receipts) {
      const recomputed = pureCircuits.receiptCommitment(
        receipt.cycleId,
        receipt.recipient,
        receipt.amount,
        receipt.nonce,
      );
      expect(recomputed).toEqual(receipt.commitment);
      expect(sim.ledger.receipts.findPathForLeaf(receipt.commitment)).toBeDefined();
    }
  });

  it('does not admit a receipt for an amount the recipient was not paid', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(6_000n, 4_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    const cycleId = runCycle(sim, state);
    const real = receiptsFor(state, cycleId)[0]!;

    const inflated = pureCircuits.receiptCommitment(
      cycleId,
      real.recipient,
      real.amount * 2n,
      real.nonce,
    );
    expect(sim.ledger.receipts.findPathForLeaf(inflated)).toBeUndefined();
  });

  it('records the organizer nullifier set so an auditor holding the salt can recheck uniqueness', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(6_000n, 4_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    runCycle(sim, state);

    for (const entry of state.roster) {
      const nullifier = pureCircuits.recipientNullifier(entry.recipient, state.cycleSalt);
      expect(sim.ledger.nullifiers.member(nullifier)).toBe(true);
    }
  });
});

describe('roster validation', () => {
  it('pads short rosters to the circuit width with zero-value slots', () => {
    const roster = padRoster(payouts(1n, 2n));
    expect(roster).toHaveLength(MAX_RECIPIENTS);
    expect(roster.filter((entry) => entry.amount === 0n)).toHaveLength(MAX_RECIPIENTS - 2);
  });

  it('rejects more payouts than the circuit can prove', () => {
    expect(() => padRoster(payouts(...Array<bigint>(MAX_RECIPIENTS + 1).fill(1n)))).toThrow(
      RosterError,
    );
  });

  it('rejects non-positive amounts and malformed recipients', () => {
    expect(() => padRoster([{ recipient: randomBytes32(), amount: 0n }])).toThrow(RosterError);
    expect(() => padRoster([{ recipient: new Uint8Array(16), amount: 1n }])).toThrow(RosterError);
  });

  it('catches a mismatched total locally, before any proving work', () => {
    expect(() => assertRosterValid(padRoster(payouts(1n, 2n)), 4n)).toThrow(/sum to 3/);
  });
});
