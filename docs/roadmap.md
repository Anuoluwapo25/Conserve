# Roadmap

## Level 4 — Waxing Gibbous (this release)

- [x] Sum-conservation circuit with per-recipient privacy
- [x] Duplicate-recipient rejection inside the proof
- [x] Constant-size public footprint regardless of headcount
- [x] Receipt commitments anchored in a Merkle tree
- [x] Operator CLI: deploy, open, settle, status, simulate
- [x] Minimal dashboard reading live public state
- [x] CI compiling circuits, running tests, and failing on a footprint leak
- [ ] Deployed to Preprod (see the README for the current status)

## Level 5 — Full Moon

**Shielded transfers.** Settlement currently proves the split; it should also
move the tokens. This means escrowing the cycle budget in the contract at
`openCycle` and sending each recipient their share inside `settle`, so the sum
that is proved is the sum that actually moves.

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

**DApp connector.** Replace the seed-based CLI wallet with the Midnight DApp
connector so an operator signs from Lace rather than from an environment
variable.

**Polished frontend.** Cycle history, receipt distribution, and the recipient's
own view of what they can prove.
