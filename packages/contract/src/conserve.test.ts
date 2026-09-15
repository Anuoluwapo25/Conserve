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
  throwawayRecipient,
} from './index.js';
import { ConserveSimulator } from './simulator.js';

const ORGANIZER_SK = randomBytes32();

const payouts = (...amounts: bigint[]): Payout[] =>
  amounts.map((amount) => ({ ...throwawayRecipient(), amount }));

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

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
        i === MAX_RECIPIENTS - 1 ? { ...entry, amount: entry.amount - 1n } : entry,
      ),
    };

    sim.setPrivateState(state);
    sim.openCycle(pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt));
    sim.setPrivateState(tampered);

    expect(() => sim.settle()).toThrow(/do not sum to the committed budget/);
  });

  it('rejects a roster that pays the same recipient twice', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(6_000n, 4_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    // Point the first real payout at the second real payout's recipient.
    const last = state.roster[MAX_RECIPIENTS - 1]!;
    const duplicated = {
      ...state,
      roster: state.roster.map((entry, i) =>
        i === MAX_RECIPIENTS - 2 ? { ...entry, recipient: last.recipient } : entry,
      ),
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
    const lines = payouts(7_777n, 2_223n);
    const recipients = lines.map((line) => line.recipient);
    const state = prepareCycle(ORGANIZER_SK, lines, 10_000n);
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
      const nullifier = pureCircuits.recipientNullifier(entry.recipient.bytes, state.cycleSalt);
      expect(sim.ledger.nullifiers.member(nullifier)).toBe(true);
    }
  });
});

describe('payouts', () => {
  it('pays each real recipient exactly their amount, in the payout token', () => {
    const lines = payouts(6_000n, 3_000n, 1_000n);
    const state = prepareCycle(ORGANIZER_SK, lines, 10_000n);
    const sim = new ConserveSimulator(state);
    runCycle(sim, state);

    const toUsers = sim.zswap.outputs.filter((output) => output.recipient.is_left);
    for (const line of lines) {
      const paid = toUsers.filter((output) => output.recipient.left === hex(line.recipient));
      expect(paid).toHaveLength(1);
      expect(paid[0]!.coinInfo.value).toBe(line.amount);
      expect(paid[0]!.coinInfo.type).toBe(hex(sim.payoutToken));
    }
    const paidTotal = toUsers.reduce((total, output) => total + output.coinInfo.value, 0n);
    expect(paidTotal).toBe(10_000n);
  });

  it('makes the same shielded transaction for 2 recipients as for 11', () => {
    const shape = (state: ReturnType<typeof prepareCycle>) => {
      const sim = new ConserveSimulator(state);
      runCycle(sim, state);
      const { inputs, outputs } = sim.zswap;
      return {
        inputs: inputs.length,
        toUsers: outputs.filter((output) => output.recipient.is_left).length,
        toContract: outputs.filter((output) => !output.recipient.is_left).length,
      };
    };

    const small = shape(prepareCycle(ORGANIZER_SK, payouts(9_000n, 1_000n), 10_000n));
    const large = shape(
      prepareCycle(
        ORGANIZER_SK,
        payouts(1_000n, 900n, 800n, 700n, 600n, 500n, 400n, 300n, 200n, 100n, 4_500n),
        10_000n,
      ),
    );

    expect(small.toUsers).toBe(MAX_RECIPIENTS);
    expect(large).toEqual(small);
  });

  it('refuses a roster whose last slot is padding', () => {
    const state = prepareCycle(ORGANIZER_SK, payouts(6_000n, 4_000n), 10_000n);
    const sim = new ConserveSimulator(state);
    // Move a padding slot to the end, so the coin would run out before it.
    const reordered = { ...state, roster: [...state.roster.slice(1), state.roster[0]!] };

    expect(() => assertRosterValid(reordered.roster, 10_000n)).toThrow(/padding goes first/);

    sim.setPrivateState(state);
    sim.openCycle(pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt));
    sim.setPrivateState(reordered);
    expect(() => sim.settle()).toThrow(/last roster slot must be a real payout/);
  });
});

describe('roster validation', () => {
  it('pads short rosters to the circuit width, padding first', () => {
    const { roster, encryptionKeys } = padRoster(payouts(1n, 2n));
    expect(roster).toHaveLength(MAX_RECIPIENTS);
    expect(encryptionKeys).toHaveLength(MAX_RECIPIENTS);
    expect(roster.slice(0, MAX_RECIPIENTS - 2).every((entry) => entry.amount === 0n)).toBe(true);
    expect(roster.slice(-2).map((entry) => entry.amount)).toEqual([1n, 2n]);
  });

  it('rejects more payouts than the circuit can prove', () => {
    expect(() => padRoster(payouts(...Array<bigint>(MAX_RECIPIENTS + 1).fill(1n)))).toThrow(
      RosterError,
    );
  });

  it('rejects non-positive amounts and malformed recipients', () => {
    expect(() => padRoster([{ ...throwawayRecipient(), amount: 0n }])).toThrow(RosterError);
    expect(() =>
      padRoster([{ ...throwawayRecipient(), recipient: new Uint8Array(16), amount: 1n }]),
    ).toThrow(RosterError);
  });

  it('catches a mismatched total locally, before any proving work', () => {
    expect(() => assertRosterValid(padRoster(payouts(1n, 2n)).roster, 4n)).toThrow(/sum to 3/);
  });
});
