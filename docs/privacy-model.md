# Privacy model

What Conserve hides, what it does not, and who has to be trusted.

## Hidden

**Individual amounts.** Never leave the operator's machine. They enter the
circuit as witness data and appear on chain only inside a hash.

**Recipient identities.** Same. The nullifiers published per cycle are
`persistentCommit(recipient, cycleSalt)` with a fresh secret salt per cycle, so
an observer who knows a recipient's identifier still cannot test for their
presence, and cannot link the same person across two cycles.

**Headcount.** Every settlement writes exactly `MAX_RECIPIENTS` nullifiers and
receipts regardless of how many payouts are real. See
[architecture.md](architecture.md) for why this is padding rather than a branch.

**The budget total.** Only a commitment to it is published. Opening that
commitment requires the salt, which the organizer holds and can disclose
selectively — to an auditor, for instance.

## Not hidden

**That a payroll happened, and when.** `cycleId`, `status` and `settledCycles`
are public, as are the block heights of the two transactions. Conserve is about
keeping amounts private, not about hiding that an organization pays people.

**The organizer.** `organizer` is a stable hash of the organizer's key across
all cycles of a contract. This is deliberate — it is what makes the contract's
history attributable — but it means the payer is pseudonymous, not anonymous.

**The ceiling.** `MAX_RECIPIENTS = 16` is public, so an observer learns the
payroll has at most sixteen people in it. Deploying a contract with a larger
roster width would widen that bound at the cost of proving time.

**Transaction graph metadata.** Fees are paid from the operator's wallet, and
that wallet's activity is visible like any other.

## Trust

**The operator's machine.** The roster lives there, and the local private-state
store holds it between the two transactions. That store is encrypted at rest
with a password you supply; the strength policy is enforced by the SDK.

**The proof server.** Proving requires the witness data in the clear, so the
proof server sees the entire payroll. This is why Conserve defaults to
`http://127.0.0.1:6300` and why the docs never suggest a hosted one. Pointing
`CONSERVE_PROOF_SERVER_URL` at a remote proof server hands that operator your
complete payroll.

**No trust required for verification.** Anyone with the contract address can
check the public state and confirm that a cycle was opened against a commitment
and settled against a proof. They learn nothing else, and they do not have to
take the organizer's word for the split being conservative — the network
rejected the transaction otherwise.

## Known weaknesses

**Zero-amount slots are indistinguishable from real ones — including to the
circuit.** A roster of sixteen entries summing to the committed total is
accepted whatever the split. That is the intended semantics, but it means the
circuit does not enforce "everyone on the roster got something"; a payout of
zero is a valid line. The client rejects zero amounts in `padRoster`, so this is
a policy the operator's tooling enforces, not the chain.

**Salt reuse would break unlinkability.** `cycleSalt` is regenerated per
settlement. An operator who pinned it across cycles would make recipients
linkable. Nothing on chain enforces freshness.

**The organizer can refuse to settle.** Opening a cycle commits to a budget but
nothing forces a settlement. Recipients have no on-chain recourse at Level 4.

**No proof of payment.** As stated in [architecture.md](architecture.md), Level 4
proves the split, not the transfer.
