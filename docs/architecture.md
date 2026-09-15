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
  amounts     ────┤──▶ ZK proof of:          ─▶ 16 nullifiers
  nonces      ────┤     sum == total            16 receipt commitments
                  │     all recipients          status = settled
  wallet funds ───┘       distinct              settledCycles++
  one coin = total      commitment opens
                        and pays:            ─▶ 16 shielded payouts,
                          coin ─▶ 16 sends        encrypted to recipients
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
transacting circuits. The contract is bound at deployment to an organizer key
and a `payoutToken`, the shielded token every payout is made in.

**`openCycle(commitment)`** — checks no cycle is currently open, checks the
caller holds the organizer secret whose hash is on the ledger, bumps `cycleId`
and stores the commitment.

**`settle()`** — the privacy-critical core. It reads five witnesses (the roster,
the budget total, the budget salt, a per-cycle salt and the funding coin's
nonce) and proves, then pays:

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
5. **Payment.** The organizer's wallet supplies one shielded coin worth exactly
   the committed total. The contract receives it — which discloses only its
   commitment — and then, slot by slot, spends the running coin, sends the
   slot's amount to the slot's recipient and carries the change forward, all
   inside the same transaction. The final change must be zero. Because no
   intermediate balance is ever written to the ledger, no salary can be read
   off as the difference between two balances.

Each payout is encrypted to its recipient's encryption key, supplied off-chain
by the organizer's tooling from the recipient's shielded address, so the
recipient's wallet finds the coin without being told about it.

## The padding, and why it is not a detail

The roster is a fixed sixteen slots. The client fills the first 16 − _n_ with
padding — a throwaway recipient key and a zero amount — and puts the _n_ real
payouts last.

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

Payment adds a second reason for the ordering. The standard library's
`sendImmediateShielded` creates a change coin unless the change is exactly zero.
If that happened mid-roster, the number of change coins would vary with the
split. With padding first, change reaches zero only at the final slot, so every
settlement makes sixteen payouts and fifteen change coins. Padding pays zero to
a key whose secret was discarded, and that zero-value coin is encrypted like any
real payout.

The cost is a fixed sixteen-recipient ceiling per cycle and a constant proving
cost. Both are the right trade.

## Circuit size

`settle` compiles to 511,434 rows, under the 2^19 limit, with a 154 MB proving
key. An earlier draft nested a second hash inside each receipt commitment;
sixteen of those pushed it to 577,473 rows, past 2^19, which doubled the proving
key to 305 MB and roughly doubled the memory a proof server needs. The receipt
commitment is now one flat hash over the same values. `zkir mock-compile` on
`managed/conserve/zkir/settle.bzkir` prints the row count, and is worth running
before any change to the circuit.

## Public state

| Field              | What it reveals                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `organizer`        | A hash of the organizer's key. Identifies the payer across cycles by design.                              |
| `payoutToken`      | The shielded token payouts are made in. Not how much of it moves.                                         |
| `cycleId`          | How many cycles have been opened.                                                                         |
| `status`           | `dormant` / `open` / `settled`.                                                                           |
| `budgetCommitment` | A commitment. Reveals the total only to someone already holding the salt.                                 |
| `nullifiers`       | 16 salted commitments per cycle. Fresh salt per cycle, so the same recipient is unlinkable across cycles. |
| `receipts`         | A depth-12 Merkle tree of receipt commitments.                                                            |
| `settledCycles`    | How many cycles completed.                                                                                |
| `MAX_RECIPIENTS`   | The constant 16. A protocol parameter, not a secret.                                                      |

No amount, no recipient, and no headcount appears anywhere in that table, and
none can be read from the shielded payouts either. Tests in
`packages/contract/src/conserve.test.ts` assert this directly: CI fails the
build if a 2-recipient and an 11-recipient cycle ever differ in their public
footprint or in the shape of their shielded coin activity.

## Packages

| Package              | Role                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@conserve/contract` | The Compact sources (Conserve and the Demo Dollar test token), generated bindings, witnesses, roster construction and the in-process simulator. |
| `@conserve/api`      | Provider wiring and the deploy / mint / open / settle workflows. `./view`, `./conserve` and `./demo-dollar` are browser-safe.                   |
| `@conserve/cli`      | The organizer's command line: key derivation, headless wallet, and the commands.                                                                |
| `@conserve/ui`       | The dashboard, including the DApp-connector wallet flow that runs a cycle from Lace.                                                            |

## What it does not do yet

Opening a cycle commits to a budget but does not escrow it, so recipients cannot
force a settlement; see [privacy-model.md](privacy-model.md) for why. Cycles are
run one at a time by hand, and recipients cannot yet prove anything about their
pay beyond a single receipt. Recurring cycles and threshold proofs over the
receipt tree are next; see [roadmap.md](roadmap.md).
