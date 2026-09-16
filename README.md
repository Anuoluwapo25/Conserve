# Conserve

[![CI](https://github.com/Anuoluwapo25/Conserve/actions/workflows/ci.yml/badge.svg)](https://github.com/Anuoluwapo25/Conserve/actions/workflows/ci.yml)

**Private payroll on a public blockchain. Anyone can verify the team was paid
correctly. Nobody can see who earns what.**

Pay a team on chain today and you publish everyone's salary. Competitors read
it, teammates read each other's, and a block explorer keeps it forever. Move
payroll off chain and the privacy comes back — but so does "trust us, it added
up."

Conserve keeps both. Built on [Midnight](https://midnight.network), it pays a
team in one transaction that proves, in zero knowledge, that the payouts came to
exactly the committed budget and that nobody was paid twice — without revealing a
single amount, a single recipient, or even how many people were paid. The sum
that is proved is the sum that moves.

## Try it — live on Midnight Preprod

**[conserve-uio.vercel.app](https://conserve-uio.vercel.app)** — no wallet, no
sign-up, nothing to paste.

1. **See what the public sees.** The dashboard reads a real settled payroll
   straight from the public indexer: a commitment and some counts. Nothing you
   could reconstruct a salary from.
2. **See what a recipient sees.** Press _Use the example receipt_ and verify, as
   one of that payroll's recipients, that you were paid exactly what you were
   owed — a proof only you can check.
3. **Run one yourself.** Connect a Midnight wallet, mint some Demo Dollars, and
   pay a payroll of your own from the browser. Your wallet holds the keys, pays
   the fees, and builds the proof.

|             |                                                                                 |
| ----------- | ------------------------------------------------------------------------------- |
| Contract    | `ecc85abce5e6b1c286eba4f559012ff5ff0cf7bb766dbb35e4cf068b98855a9b`              |
| State       | cycle 1 **settled and paid** — 3 people paid, 16 shielded payouts sent          |
| `settle` tx | `236eda1869945e61d04f516bd55f0c6c1aa6e548fc63c8838bdab65ebd80c23a`              |
| Pays in     | Demo Dollar, `b9fa505af02fa88fcb511c730996675a670308db91f74c66e42fba638f48372f` |

### Check it yourself

Everything above is public state. Read it with nothing but an indexer — no
wallet, no key:

```bash
conserve status --contract ecc85abce5e6b1c286eba4f559012ff5ff0cf7bb766dbb35e4cf068b98855a9b
```

```
cycle:              1
status:             settled
cycles settled:     1
roster slots:       16 (constant, whatever the headcount)
nullifiers:         16
receipts anchored:  16
```

That payroll paid **three** people. The chain shows sixteen of everything and no
amount at all, and the settlement created thirty-three shielded coins — sixteen
payouts, fifteen change coins, the funding coin and the organizer's change — the
same shape for a team of one as for a team of sixteen.

## The whole idea in 30 seconds

No wallet, no funds, no network:

```bash
npm install && npm run build
node packages/cli/dist/main.js simulate --payroll examples/payroll.example.json
node packages/cli/dist/main.js simulate --payroll examples/payroll.large.json
```

The first payroll pays 3 people; the second pays 12, with a different total.
The public state each one leaves behind is **byte-identical except for one
commitment**. That is the property the product rests on, and CI fails the build
if it ever stops holding.

## Who it's for

- **DAOs and remote crypto-native teams** paying contributors across borders,
  who need to show the treasury was spent as approved without doxxing every
  salary.
- **Grant programs** proving a round paid out its full budget to distinct
  grantees.
- **Creators and collectives** splitting revenue where the split is nobody
  else's business.

## How it works

Each payroll cycle is two transactions.

**1. Open** — the organizer publishes a commitment to the cycle's budget. The
number itself stays private. Committing first matters: if the budget and the
split were published together, the organizer could pick whatever total makes
their payouts add up.

**2. Settle** — one transaction that proves and pays. The organizer's wallet
funds a single shielded coin worth the committed budget, and the circuit proves
that:

- the amounts sum to exactly that budget,
- no recipient appears twice,
- every recipient gets a receipt anchored on chain,

then splits the coin into one shielded payout per recipient. Each payout is
encrypted to its recipient, so it lands in their wallet and nobody else can read
it.

The chain ends up holding a commitment, sixteen nullifiers, sixteen receipt
commitments and sixteen shielded coins. No amounts. No recipients. No headcount.

**Recipients** are paid in their own wallet, and each gets a private receipt.
With it they can prove their employer settled exactly their amount, in a
transaction the network accepted — without revealing the amount to anyone.

### Why headcount stays hidden

An early version skipped empty payroll slots. The Compact compiler refused to
build it, flagging that the circuit would disclose which slots held real
payouts — and headcount plus a known total is most of the way to individual
salaries on a small team. So every cycle is exactly sixteen slots, padded with
random recipients and zero amounts, all processed identically. There is no
branch left to leak — and the payment works the same way: sixteen payouts every
time, with padding slots paying zero to a throwaway key, so even the shape of
the transaction is identical whether you pay one person or sixteen. More in
[docs/architecture.md](docs/architecture.md).

## Quick reference

```bash
npm test                                          # 24 circuit tests, no network
conserve address --offline                        # derive a fundable address
conserve register                                 # register NIGHT for DUST (fees)
conserve demo-dollar deploy                       # a shielded test token to pay in
conserve demo-dollar mint --token-contract <addr> --amount 1000000
conserve deploy --token <type>                    # deploy to Preprod
conserve open   --contract <addr> --payroll p.json
conserve settle --contract <addr> --payroll p.json --receipts ./receipts
conserve verify --contract <addr> --receipt receipts/cycle-1-designer.json
conserve status --contract <addr>                 # audit; needs only an indexer
```

On-chain commands need a local proof server matching the client's ledger
version (`midnightntwrk/proof-server:8.1.0`). Setup and funding:
[docs/setup.md](docs/setup.md). Full walkthrough: [docs/usage.md](docs/usage.md).

## Repository

| Package                                  | What it is                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- |
| [`packages/contract`](packages/contract) | The Compact circuits, witness bindings, and the in-process simulator |
| [`packages/api`](packages/api)           | Provider wiring and the deploy / open / settle workflows             |
| [`packages/cli`](packages/cli)           | The operator CLI                                                     |
| [`packages/ui`](packages/ui)             | Dashboard: live chain view, receipt checker, budget commitment tool  |

Start with [`packages/contract/src/conserve.compact`](packages/contract/src/conserve.compact)
— about 200 lines, and it is the whole idea.

## Limitations

Opening a cycle commits to a budget but does not escrow it, so nothing forces an
organizer to settle; escrowing would put the total in public state, which is the
one thing the design keeps private. Cycles are run one at a time, and a
recipient can prove a single receipt but not yet a total across cycles.

Proving needs the payroll in the clear, so whoever proves sees it — the local
proof server from the CLI, or your wallet's prover from the dashboard. The full
privacy analysis, including known weaknesses, is in
[docs/privacy-model.md](docs/privacy-model.md).

Getting this live took eleven real bugs out of this codebase and its
dependencies, none of them reachable from `npm test`: they needed a funded
wallet, a real proof server or a real ledger. They are written up in
[docs/deployment.md](docs/deployment.md).

## Documentation

[Architecture](docs/architecture.md) · [Privacy model](docs/privacy-model.md) ·
[Setup](docs/setup.md) · [Usage](docs/usage.md) ·
[Deploying to Preprod](docs/deployment.md) · [Roadmap](docs/roadmap.md)

Demo video: [MVP walkthrough](https://www.loom.com/share/f0f353e23a3446129703bec52aca38db)
(recorded before the Preprod deployment) · Updates on X:
[@conserveui](https://x.com/conserveui)

## Licence

Apache-2.0. See [LICENSE](LICENSE).
