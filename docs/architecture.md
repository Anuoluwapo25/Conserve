# Architecture

Conserve splits a payroll cycle into two transactions, and puts everything that
matters in between them into a proof.

```
  organizer's machine                          Midnight ledger
  ───────────────────                          ───────────────
  payroll.json  ──┐
                  │  openCycle
  budget total ───┼──▶ commit(total, salt) ───▶ budgetCommitment
                  │                             status = open
                  │                             cycleId++
                  │
  roster (16) ────┤  settle
  amounts     ────┼──▶ ZK proof of:          ─▶ 16 nullifiers
  nonces      ────┘     sum == total            16 receipt commitments
                        all recipients          status = settled
                          distinct              settledCycles++
                        commitment opens
```

## Why two transactions

If the organizer published the budget and the split at the same moment, the
"proof" would be vacuous: they could pick whatever total makes their chosen
payouts add up. Committing to the total first, in its own transaction, fixes the
number before any payout is decided. The settlement proof then has to open that
existing commitment, which is what makes conservation meaningful rather than
circular.

## The circuits

`packages/contract/src/conserve.compact` exports four pure helpers and two
transacting circuits.

**`openCycle(commitment)`** — checks no cycle is currently open, checks the
caller holds the organizer secret whose hash is on the ledger, bumps `cycleId`
and stores the commitment.

**`settle()`** — the privacy-critical core. It reads four witnesses (the roster,
the budget total, the budget salt and a per-cycle salt) and proves:

1. **The commitment opens.** `budgetCommitmentOf(total, salt)` must equal the
   `budgetCommitment` already on the ledger.
2. **Conservation.** The sixteen amounts, summed in the field to avoid
   intermediate overflow, equal that total exactly. Sixteen 64-bit values sum to
   at most 2^68, far below the field modulus, so the equality is exact rather
   than modular.
3. **Uniqueness.** All 256 ordered pairs of roster slots are compared, and any
   two distinct slots holding the same recipient fail the proof. Nobody can be
   paid twice in one cycle and no slot can be quietly reused.
4. **Receipts.** Each slot contributes one salted nullifier and one receipt
   commitment to public state.

## The padding, and why it is not a detail

The roster is a fixed sixteen slots. Real payouts fill the first _n_; the client
pads the rest with a random recipient and a zero amount.

The first version of this contract did the obvious thing instead — it looped
over the roster and only wrote a nullifier when `amount > 0`. The Compact
compiler rejected it:

```
potential witness-value disclosure must be declared but is not:
  nature of the disclosure:
    performing this ledger operation might disclose the boolean value of the
    result of a comparison involving the witness value
```

It was right. The number of ledger writes would have been the headcount, in
public, on every settlement — and headcount plus a known total is most of the
way to individual salaries for a small team. Padding removes the branch
entirely: the circuit has no notion of an active slot, so there is nothing to
leak. A settlement writes exactly sixteen nullifiers and sixteen receipts
whether you paid two people or twelve.

The cost is a fixed sixteen-recipient ceiling per cycle and a constant proving
cost. Both are the right trade.

## Public state

| Field              | What it reveals                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `organizer`        | A hash of the organizer's key. Identifies the payer across cycles by design.                              |
| `cycleId`          | How many cycles have been opened.                                                                         |
| `status`           | `dormant` / `open` / `settled`.                                                                           |
| `budgetCommitment` | A commitment. Reveals the total only to someone already holding the salt.                                 |
| `nullifiers`       | 16 salted commitments per cycle. Fresh salt per cycle, so the same recipient is unlinkable across cycles. |
| `receipts`         | A depth-12 Merkle tree of receipt commitments.                                                            |
| `settledCycles`    | How many cycles completed.                                                                                |
| `MAX_RECIPIENTS`   | The constant 16. A protocol parameter, not a secret.                                                      |

No amount, no recipient, and no headcount appears anywhere in that table. Two
tests in `packages/contract/src/conserve.test.ts` assert this directly, and CI
fails the build if a 3-recipient and a 12-recipient cycle ever differ in their
public footprint.

## Packages

| Package              | Role                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@conserve/contract` | The Compact source, the generated bindings, witness implementations, roster construction and the in-process simulator. |
| `@conserve/api`      | Provider wiring and the deploy / open / settle workflows. `./view` is the browser-safe read-only projection.           |
| `@conserve/cli`      | The operator: key derivation, wallet, and the commands.                                                                |
| `@conserve/ui`       | The dashboard.                                                                                                         |

## What Level 4 does not do

The contract proves the split is correct and complete. It does not yet _move_
the tokens — shielded transfers land in Level 5, alongside recurring cycles and
recipient-side threshold proofs. The receipt tree is already in place because
those threshold proofs are membership proofs against it.

This is a real limitation and worth stating plainly: today Conserve proves a
payroll was computed honestly, not that it was paid. See [roadmap.md](roadmap.md).
