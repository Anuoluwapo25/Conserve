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

**Try it on the live network:** open the [dashboard](https://conserve-uio.vercel.app).
It reads the deployed contract straight from the public indexer — no wallet, no
address to paste — and shows a settled payroll with nothing in it you could
reconstruct a salary from. Then press _Use the example receipt_ and verify, as
one of that payroll's recipients, that you were paid exactly what you were owed.

- Product updates on X: [@conserveui](https://x.com/conserveui)
- Demo video: [MVP walkthrough](https://www.loom.com/share/f0f353e23a3446129703bec52aca38db)
- Documentation: [architecture](docs/architecture.md) · [privacy model](docs/privacy-model.md) · [setup](docs/setup.md) · [usage](docs/usage.md) · [roadmap](docs/roadmap.md)

## Deployment

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Live dashboard   | <https://conserve-uio.vercel.app>                                  |
| Network          | Midnight **Preprod**                                               |
| Contract address | `7940f5eeb2e87e5ab8629e1b8ce7167ef37f73e976261886edf90ffed1114e5d` |
| State            | cycle 1 **settled** — 16 nullifiers, 16 receipts, no amounts       |
| Indexer          | `https://indexer.preprod.midnight.network/api/v3/graphql`          |
| Compact compiler | 0.31.1                                                             |

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
| [`packages/ui`](packages/ui)             | Dashboard: live chain view, receipt checker, budget commitment tool  |

Start with [`packages/contract/src/conserve.compact`](packages/contract/src/conserve.compact).
It is about 200 lines and it is the whole idea.

## Quick reference

```bash
npm test                                          # 21 circuit tests, no network
conserve address --offline                        # derive a fundable address
conserve register                                 # register NIGHT for DUST (fees)
conserve deploy                                   # deploy to Preprod
conserve open   --contract <addr> --payroll p.json
conserve settle --contract <addr> --payroll p.json --receipts ./receipts
conserve verify --contract <addr> --receipt receipts/cycle-1-designer.json
conserve status --contract <addr>                 # audit; needs only an indexer
```

On-chain commands need a local proof server matching the client's ledger
version — `midnightntwrk/proof-server:8.1.0`. Full walkthrough in
[docs/usage.md](docs/usage.md); prerequisites and funding in
[docs/setup.md](docs/setup.md).

## Deployment status

Live on Midnight Preprod, with one full payroll cycle run from
[`examples/payroll.example.json`](examples/payroll.example.json):

| Step        | Transaction hash                                                   | Block   |
| ----------- | ------------------------------------------------------------------ | ------- |
| `deploy`    | `82a634a3898d81547d73c83e30ebb81c8566a0f330e23d72103ef15f8eb3f4e3` | 2509842 |
| `openCycle` | `95e4c2d621aa7e443b002196bd5d323410c6ba4a1497d7d8aed7a867ad66c5df` | 2510226 |
| `settle`    | `557fbaee0d4171e68f4e43396ff49739d3b5b4a10fa90df159274e8442d8d213` | 2510264 |

Verify it yourself against nothing but a public indexer:

```bash
conserve status --contract 7940f5eeb2e87e5ab8629e1b8ce7167ef37f73e976261886edf90ffed1114e5d
```

```
cycle:              1
status:             settled
budget commitment:  196afdd1526c7ebfd0acdb6839cd245a393d1faab75f655910cc0252283cee81
cycles settled:     1
roster slots:       16 (constant, whatever the headcount)
nullifiers:         16
receipts anchored:  16
```

That payroll had **three** recipients. The chain shows sixteen of everything and
no amount at all — the property the whole design exists for, on a public
network rather than in a simulator. The
[dashboard](https://conserve-uio.vercel.app) reads exactly this state on load,
and its receipt checker ships one verifiable receipt from this cycle so the
recipient side can be tried without having been paid:

```bash
conserve verify --contract 7940f5eeb2e87e5ab8629e1b8ce7167ef37f73e976261886edf90ffed1114e5d \
  --receipt receipts/cycle-1-designer.json
```

```
The organizer included exactly this amount in a settlement the network
accepted. Verifying it revealed the amount to nobody but you.
```

That example payroll is public in this repository and was settled with a
throwaway testnet organizer key, which is the only reason its receipt can be
published. A real recipient's receipt never leaves their hands.

Getting here took six real bugs out of this codebase, all fixed:

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
deploy whenever the checkpoint stops growing.

**The ZK config provider was pointed one directory short of the compiled
keys.** `zkAssetsDirectory` in `providers.ts` resolved to the contract
package's `managed/` directory; the Compact compiler writes prover and
verifier keys one level deeper, to `managed/conserve/`. Every deploy failed
with `ZKConfigurationReadError` before this — `npm test` never exercises the
path, since it only runs the in-process simulator.

**The wallet's node relay was given the RPC URL where the SDK wants a
websocket.** `relayURL` was built directly from the configured `nodeUrl`
(`https://` on Preprod, `http://` locally); this SDK version accepts only
`ws://` or `wss://` there.

**Two copies of the on-chain runtime in one process.** `compact-runtime`
accepts `^3.0.0` of `@midnight-ntwrk/onchain-runtime-v3` and resolved to 3.1.0;
`midnight-js-protocol` pins 3.0.0 exactly and got its own nested copy. Both
define a `StateValue` class, and a value built by one fails `instanceof` in the
other, so every `open` and `settle` died on `expected instance of StateValue`
while `deploy` — which never crosses that boundary — kept working. The root
`package.json` now pins the runtime the same way it already pins the ledger.
The pin only takes effect once `package-lock.json` is regenerated: npm honours
a new override when it resolves the tree, not when it is replaying an existing
lockfile, and until then it reinstalls the duplicate and reports it as
`invalid`.

**The proof server was a major version behind the client, and said nothing.**
The client is built against `@midnight-ntwrk/ledger-v8` (pinned to 8.1.0);
`midnightnetwork/proof-server:latest` is built against ledger 7.0.0-rc.1,
because that organisation stopped publishing after ledger 7 — the current
images are under `midnightntwrk`. Pairing the two does not fail cleanly. The
server accepts the `/prove` request, returns no error, and spins on a single
core indefinitely; the wallet blocks on the HTTP response with its own CPU at
zero. It is indistinguishable from a slow proof, and a DUST fee proof is
plausibly slow, so it cost an hour before the version skew was suspected at
all. Against `midnightntwrk/proof-server:8.1.0` the same proof returns in
**0.88 seconds**.

Funding the wallet also needs one step the docs used to hand-wave: fees are
paid in DUST, which only accrues against _registered_ NIGHT, so a freshly
funded wallet holds a balance it cannot spend. `conserve register` submits that
registration and waits for a DUST coin to become spendable — not merely for the
balance to read non-zero, which happens earlier and still fails a submission
with "insufficient DUST".

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
