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

- Product updates on X: **`<!-- TODO: create the product X profile and link it here -->`**
- Documentation: [architecture](docs/architecture.md) · [privacy model](docs/privacy-model.md) · [setup](docs/setup.md) · [usage](docs/usage.md) · [roadmap](docs/roadmap.md)

## Deployment

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
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
conserve settle --contract <addr> --payroll p.json
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

Three steps remain before a Preprod address can go in the table above, and each
needs a human:

1. **Fund the wallet.** The faucet at <https://faucet.preprod.midnight.network>
   is a web form. Run `conserve address --offline` and paste the `night:`
   address, then register the NIGHT UTXOs for DUST generation so fees can be
   paid.
2. **Start a proof server.** `docker run … midnightnetwork/proof-server` — see
   [docs/setup.md](docs/setup.md).
3. **First wallet sync.** A fresh wallet replays every shielded event since
   genesis, which on Preprod takes a long while and needs
   `NODE_OPTIONS=--max-old-space-size=8192`. It only happens once — the synced
   state is cached in `.conserve-state`.

Then `conserve deploy` prints the contract address.

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
