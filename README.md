# Conserve

[![CI](https://github.com/Anuoluwapo25/Conserve/actions/workflows/ci.yml/badge.svg)](https://github.com/Anuoluwapo25/Conserve/actions/workflows/ci.yml)

**Payroll and revenue splits where the total is verifiable and nobody's
individual amount is public.**

Pay a team on chain today and you publish everyone's rate. Competitors read it,
teammates read each other's, and a block explorer keeps it forever. Move payroll
off chain and the privacy comes back, but so does "trust us, it added up."

Conserve uses Midnight's split of private and public state to keep both. The
organization publishes a commitment to the cycle's total budget. A Compact
circuit then takes the recipient list and the per-recipient amounts as private
witness data and proves that the payouts sum to exactly that committed total,
and that every recipient appears exactly once — disclosing neither the amounts
nor the recipients nor even how many people were paid.

Anyone can verify the cycle. Nobody can read the payroll.

- Product updates on X: [@conserveui](https://x.com/conserveui)
- Demo video: _pending — TODO: record and link the MVP walkthrough_
- Documentation: [architecture](docs/architecture.md) · [privacy model](docs/privacy-model.md) · [setup](docs/setup.md) · [usage](docs/usage.md) · [roadmap](docs/roadmap.md)

## Deployment

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| Live dashboard   | _pending — TODO: link the deployed Vercel URL_            |
| Network          | Midnight **Preprod**                                      |
| Contract address | _pending — see [Deployment status](#deployment-status)_   |
| Indexer          | `https://indexer.preprod.midnight.network/api/v3/graphql` |
| Compact compiler | 0.31.1                                                    |

## See it work in one command

No wallet, no funds, no proof server, no network:

```bash
npm install && npm run build
node packages/cli/dist/main.js simulate --payroll examples/payroll.example.json
```

This runs the real circuits in-process against a real Compact ledger and prints
the public state a block explorer would see:

```
simulated cycle 1 with 3 recipients — circuits accepted the split
public state a block explorer would show:
  status:            settled
  budget commitment: ae59d100f081b9d6f5b7563676e2958aef308462ae77911103966ac48b3b8ca8
  roster slots:      16
  receipts anchored: 16
no amount and no recipient appears anywhere above.
```

Now run it against `examples/payroll.large.json` — twelve recipients, a
different total. The public state is byte-identical in every field except the
commitment. That is the property the whole product rests on, and CI fails the
build if it ever stops holding.

## How it works

Two transactions per cycle:

**`openCycle`** publishes `commit(total, salt)`. The total itself stays local.
This has to happen first — if the budget and the split were published together,
the organizer could pick whatever total makes their chosen payouts add up, and
"conservation" would mean nothing.

**`settle`** proves, in zero knowledge, that:

1. the roster's amounts sum to exactly the total committed when the cycle opened,
2. every recipient in the roster is distinct, so nobody is paid twice,
3. each recipient has a receipt commitment anchored in a Merkle tree.

The ledger ends up holding a commitment, a cycle id, a settled flag, sixteen
salted nullifiers and sixteen receipt commitments. No amount. No recipient. No
headcount.

Recipients get the other half. Each one receives `(cycleId, recipient, amount,
nonce)` and can recompute their own commitment and find it in the on-chain tree —
proving their employer settled exactly that amount, in a transaction the network
accepted, without revealing the amount to anyone and without learning anything
about the rest of the payroll. `conserve verify` does this, and so does the
dashboard.

### The headcount is not a footnote

The first version of `settle` looped over the roster and wrote a nullifier only
when `amount > 0`. The Compact compiler refused to build it:

```
potential witness-value disclosure must be declared but is not:
  nature of the disclosure:
    performing this ledger operation might disclose the boolean value of the
    result of a comparison involving the witness value
```

It was right, and the leak was a real one — headcount plus a known total is most
of the way to individual salaries on a small team. The fix was to delete the
notion of an active slot entirely: the roster is always sixteen entries, padded
client-side with a random recipient and a zero amount, and the circuit treats
all sixteen identically. There is no branch left to leak.

## Repository

| Package                                  | What it is                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- |
| [`packages/contract`](packages/contract) | The Compact circuits, witness bindings, and the in-process simulator |
| [`packages/api`](packages/api)           | Provider wiring and the deploy / open / settle workflows             |
| [`packages/cli`](packages/cli)           | The operator CLI                                                     |
| [`packages/ui`](packages/ui)             | Minimal dashboard                                                    |

Start with [`packages/contract/src/conserve.compact`](packages/contract/src/conserve.compact).
It is about 200 lines and it is the whole idea.

## Quick reference

```bash
npm test                                          # 21 circuit tests, no network
conserve address --offline                        # derive a fundable address
conserve deploy                                   # deploy to Preprod
conserve open   --contract <addr> --payroll p.json
conserve settle --contract <addr> --payroll p.json --receipts ./receipts
conserve verify --contract <addr> --receipt receipts/cycle-1-core-dev.json
conserve status --contract <addr>                 # audit; needs only an indexer
```

Full walkthrough in [docs/usage.md](docs/usage.md); prerequisites and funding in
[docs/setup.md](docs/setup.md).

## Deployment status

The circuits, the CLI and the dashboard are complete, and everything that can be
checked without funds is checked: 21 circuit tests, a clean build, and a CI step
that fails if the public footprint ever depends on headcount.

A Preprod address is pending a faucet grant, which is rate limited to one
request per address per 24 hours. Getting to that point took two real bugs out
of this codebase, both fixed here:

**The address `conserve address` printed was not the one the wallet watches.**
`deriveAddresses` built the unshielded address by bech32m-encoding the raw
verifying key. That produces a well-formed address string — the faucet accepts
it, the transaction confirms, and the funds land on chain under an owner the
wallet has no reason to look at. Every symptom pointed at the sync: a wallet
that reported itself fully synced with a zero balance, while a GraphQL query
against the indexer showed the tNIGHT sitting in the transaction's
`unshieldedCreatedOutputs`. An unshielded address is derived from the verifying
key rather than being it, so the fix is to read the address off the same
keystore `openWallet` starts the unshielded wallet with — what the CLI prints
is then, by construction, what the wallet observes.

**Sync progress was discarded on every interruption.** `openWallet` persisted
state only after `waitForSyncedState()` resolved. A first sync replays millions
of shielded and dust events, the indexer subscriptions do not reliably survive
that long, and the SDK stops re-establishing them after enough reconnects —
leaving a process that is alive with no network sockets, CPU at zero, and a
synced state that can never arrive. Because nothing had been written, the next
run started from genesis, so progress was permanently non-cumulative. That is
what "17 hours without converging" actually was. Checkpointing every 30 seconds
(atomically, via rename) makes progress survive a restart, and
[`scripts/deploy-supervised.sh`](scripts/deploy-supervised.sh) restarts the
deploy whenever the checkpoint stops growing. With those two changes the wallet
reaches a strictly synced state in about two hours of unattended retrying.

The remaining steps each need a human: fund the address `conserve address`
prints, register the NIGHT UTXOs for DUST generation, and run a local proof
server (`docker run … midnightntwrk/proof-server`, see
[docs/setup.md](docs/setup.md)). Fees are paid in DUST, which only accrues
against registered NIGHT — an unregistered wallet cannot pay for its own
deployment no matter how well it syncs.

Once a funded, registered wallet exists, `conserve deploy` prints the contract
address.

## Honest limitations

Conserve proves that a payroll was _computed_ honestly. It does not yet move the
tokens — shielded transfers arrive in Level 5, along with recurring cycles and
recipient-side threshold proofs. The receipt tree is already in the contract
because those threshold proofs are membership proofs against it.

Proving requires the witness data in the clear, so the proof server sees your
entire payroll. Run it locally. The default is `127.0.0.1:6300` for exactly this
reason.

More in [docs/privacy-model.md](docs/privacy-model.md), including the weaknesses.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
