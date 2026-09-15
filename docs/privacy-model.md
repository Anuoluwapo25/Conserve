# Privacy model

What Conserve hides, what it does not, and who has to be trusted.

## Hidden

**Individual amounts.** They never leave the organizer's machine in the clear.
They enter the circuit as witness data and reach the chain only inside hashes:
a receipt commitment, and the commitment of a shielded coin. Each coin is
encrypted to its recipient, so only that recipient's wallet can read its value.

**Recipient identities.** A payout is sent to the recipient's coin public key,
which appears on chain only inside the coin's commitment. The nullifiers
published per cycle are `persistentCommit(recipient, cycleSalt)` with a fresh
secret salt per cycle, so an observer who knows a recipient's address still
cannot test for their presence, and cannot link the same person across two
cycles.

**Headcount.** Every settlement writes exactly `MAX_RECIPIENTS` nullifiers and
receipts and makes exactly `MAX_RECIPIENTS` shielded payouts, whatever the real
headcount. Padding slots pay zero to a throwaway key, and their payouts are
encrypted like any other. The shielded transaction has the same shape too —
sixteen payouts and fifteen change coins — because padding goes first and only
the final slot ever exhausts the funding coin. A test asserts that a
2-recipient and an 11-recipient settlement produce identical coin activity. See
[architecture.md](architecture.md).

**The budget total.** Only a commitment to it is published at `openCycle`. At
`settle` the organizer's wallet funds one shielded coin worth the total; the
contract receives it as a commitment and spends it in the same transaction, so
its value is never written to the ledger. Opening the budget commitment requires
the salt, which the organizer holds and can disclose selectively — to an
auditor, for instance.

## Not hidden

**That a payroll happened, and when.** `cycleId`, `status` and `settledCycles`
are public, as are the block heights of the two transactions. Conserve keeps
amounts private; it does not hide that an organization pays people.

**The organizer.** `organizer` is a stable hash of the organizer's key across
all cycles of a contract. This is deliberate — it makes the contract's history
attributable — but it means the payer is pseudonymous, not anonymous.

**The payout token.** `payoutToken` is public: anyone can see which token a
contract pays in, though not how much of it moves.

**The ceiling.** `MAX_RECIPIENTS = 16` is public, so an observer learns a
payroll has at most sixteen people in it.

**Transaction graph metadata.** Fees are paid in DUST from the organizer's
wallet, and that wallet's activity is visible like any other.

**Demo Dollar mints.** On test networks, the organizer funds payrolls with Demo
Dollars, and mint amounts are public. Minting exactly one cycle's budget right
before settling would reveal the total. Mint round working balances.

## Trust

**The organizer's machine.** The roster lives there, and the local private-state
store holds it between the two transactions. That store is encrypted at rest
with a password you supply; the strength policy is enforced by the SDK.

**Whoever proves.** Proving requires the witness data in the clear, so the
prover sees the entire payroll. From the CLI that is the proof server at
`CONSERVE_PROOF_SERVER_URL`, which defaults to `http://127.0.0.1:6300` for
exactly this reason. From the dashboard it is whatever prover the connected
wallet is configured to use. Point either at a hosted prover and you hand that
operator your complete payroll.

**No trust required for verification.** Anyone with the contract address can
check the public state and confirm that a cycle was opened against a commitment
and settled against a proof. They learn nothing else, and they do not have to
take the organizer's word for the split: the network rejects a settlement that
does not add up, and the same transaction is the one that pays.

## Known weaknesses

**Zero-amount slots are indistinguishable from real ones — including to the
circuit.** A roster of sixteen entries summing to the committed total is
accepted whatever the split, so the circuit does not enforce "everyone on the
roster got something"; a payout of zero is a valid line. The client rejects zero
amounts in `padRoster`, so this is a policy the organizer's tooling enforces,
not the chain. The circuit does require the final slot to be non-zero, because
the payout chain would otherwise try to spend a coin that no longer exists.

**Salt reuse would break unlinkability.** `cycleSalt` is regenerated per
settlement. An organizer who pinned it across cycles would make recipients
linkable. Nothing on chain enforces freshness.

**The organizer can refuse to settle.** Opening a cycle commits to a budget but
does not escrow it, so nothing forces a settlement. Escrowing at `openCycle`
would give recipients that guarantee, but a contract holding the budget in its
public ledger state reveals the total — Conserve keeps the total private instead.
