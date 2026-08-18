# Security

Conserve handles payroll. A bug here does not corrupt a balance — it publishes
somebody's salary.

## Reporting

Report privately via GitHub's [security advisories](https://github.com/Anuoluwapo25/conserve/security/advisories/new).
Please do not open a public issue for anything that would leak private data.

## What counts as a vulnerability

Anything that lets an observer learn, from public state or transaction
metadata, one of the things Conserve claims to hide:

- an individual payout amount,
- a recipient identifier,
- the number of real recipients in a cycle,
- the budget total, without the salt.

Also in scope: a settlement the network accepts where the amounts do not sum to
the committed total, or where a recipient appears twice.

The properties themselves and the trust assumptions behind them are written out
in [docs/privacy-model.md](docs/privacy-model.md). That document also lists the
weaknesses we already know about — those are not vulnerabilities, they are the
roadmap.

## Not vulnerabilities

- Learning that a payroll happened, or when. Cycle ids and settled flags are
  public by design.
- Correlating the organizer across cycles of one contract. `organizer` is a
  stable hash on purpose.
- Anything requiring the operator's machine, seed, or private-state password.
  The roster lives there; that is the trust boundary.
- A remote proof server seeing your payroll. Proving needs the witness data in
  the clear. Run it locally.

## Operational note

`CONSERVE_ORGANIZER_KEY` has no recovery path. The ledger stores only its hash,
so losing it permanently ends your ability to open or settle cycles on that
contract.
