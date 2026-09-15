# Roadmap

## Level 4 — Waxing Gibbous (this release)

- [x] Sum-conservation circuit with per-recipient privacy
- [x] Duplicate-recipient rejection inside the proof
- [x] Constant-size public footprint regardless of headcount
- [x] Receipt commitments anchored in a Merkle tree
- [x] Operator CLI: deploy, open, settle, status, simulate
- [x] Minimal dashboard reading live public state
- [x] CI compiling circuits, running tests, and failing on a footprint leak
- [x] Deployed to Preprod, with a cycle opened and settled on chain ([what it took](deployment.md))

## Level 5 — Full Moon

- [x] **Shielded transfers.** `settle` now pays: the organizer's wallet funds one
      shielded coin worth the committed total, and the circuit sends each
      recipient their share in the same transaction, so the sum that is proved is
      the sum that moves. The budget is funded at settlement rather than escrowed
      at `openCycle`, which keeps the total private (see
      [privacy-model.md](privacy-model.md)).
- [x] **Demo Dollar.** A shielded test token, so payrolls can move real shielded
      value on Preprod, which has no shielded faucet.

**Recurring cycles.** The `cycleId` counter and the per-cycle salt are already
in place. What is missing is a payroll schedule and the state to carry a roster
between cycles without retyping it.

**Recipient threshold proofs.** The receipt tree exists for this. A recipient
holding `(cycleId, amount, nonce)` for the last three cycles proves membership
of three leaves and that the amounts sum above a threshold — enough to satisfy a
lender or a landlord without revealing the figure or the employer's payroll.

## Level 6 — Supermoon

**Auditor selective disclosure.** A designated auditor receives the budget salt
and the per-cycle salt out of band, re-derives the nullifiers, and confirms
uniqueness and the total independently — without any of it becoming public.

- [x] **DApp connector.** The dashboard connects Lace (or any wallet implementing
      the Midnight DApp connector) and runs a whole cycle — fund, deploy, open,
      settle — with the wallet holding the keys and proving. The CLI remains for
      scripted use.

**Polished frontend.** Cycle history, receipt distribution, and the recipient's
own view of what they can prove.
