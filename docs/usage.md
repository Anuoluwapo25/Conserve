# Usage

Every command takes `--network preprod` (default) or `--network undeployed`, and
`--json` for machine-readable output.

## The payroll file

```json
{
  "budget": "10000",
  "payouts": [
    { "label": "core-dev", "recipient": "mn_shield-addr_preprod13lvxh…", "amount": "4500" },
    { "label": "designer", "recipient": "mn_shield-addr_preprod14vltm…", "amount": "3000" },
    { "label": "ops", "recipient": "mn_shield-addr_preprod16a8zv…", "amount": "2500" }
  ]
}
```

`recipient` is the recipient's shielded address for the network you are paying
on (`mn_shield-addr_preprod1…`). It carries both keys a payout needs: the one
the coin is sent to, and the one it is encrypted to so their wallet finds it.
`label` is for you: it is stripped before anything reaches a circuit and never
leaves the machine. `budget` is optional — omit it and the payouts' sum is used —
but stating it is worth the keystroke, because a mismatch is caught immediately
with a readable message instead of surfacing as a proof failure.

At most 16 payouts per cycle. Amounts must be positive whole numbers.

## Dry run

```bash
node packages/cli/dist/main.js simulate --payroll examples/payroll.example.json
```

Runs the real circuits in-process. Nothing touches the network. The output ends
with the public state a block explorer would show — a commitment and three
counts, and no amount or recipient anywhere:

```
simulated cycle 1 with 3 recipients — circuits accepted the split
public state a block explorer would show:
  status:            settled
  budget commitment: ae59d100f081b9d6f5b7563676e2958aef308462ae77911103966ac48b3b8ca8
  roster slots:      16
  receipts anchored: 16
no amount and no recipient appears anywhere above.
```

Try breaking it. Change one amount so the payouts no longer match the budget, or
paste the same recipient twice — both are rejected before any proving work.

## Addresses and balances

```bash
source .env.local
conserve address --offline    # derive locally, no sync
conserve address              # sync and show NIGHT and DUST balances
```

## Deploy

```bash
conserve deploy
```

Prints the contract address. Record it — every later command needs it. If
`CONSERVE_ORGANIZER_KEY` is unset, a key is generated and printed once; save it
before you lose the terminal.

## Run a cycle

```bash
conserve open   --contract <addr> --payroll payroll.json
conserve settle --contract <addr> --payroll payroll.json --receipts ./receipts
```

`open` publishes the commitment to the budget. `settle` proves the split and,
with `--receipts`, writes one file per recipient:

```json
{
  "cycleId": "1",
  "recipient": "9f1c0e…6e23",
  "amount": "4500",
  "nonce": "91cd7a…08f1"
}
```

Hand each recipient their own file and nothing else. It contains only their own
figures — the file for one recipient says nothing about any other.

The payroll file is passed to both commands and must be identical between them —
`open` reads only its total, `settle` reads the lines.

## Check a receipt

Anyone holding a receipt can confirm it against the chain:

```bash
conserve verify --contract <addr> --receipt receipts/cycle-1-core-dev.json
```

```
receipt is anchored on chain
commitment: 7f3ac1…
proof path: 12 levels

The organizer included exactly this amount in a settlement the network
accepted. Verifying it revealed the amount to nobody but you.
```

The command recomputes the commitment locally and looks for it in the contract's
Merkle tree. It exits non-zero if the receipt is not there — so a recipient can
detect an employer who quietly changed a figure after the fact. Like `status`, it
needs only an indexer: no seed, no wallet, no proof server.

The same check is available in the dashboard for recipients who would rather not
install anything.

## Audit a contract

```bash
conserve status --contract <addr>
```

Needs no wallet, no seed and no proof server, only an indexer. This is the
command to hand someone who wants to check your claims:

```
cycle:              1
status:             settled
budget commitment:  ae59d1…
cycles settled:     1
roster slots:       16 (constant, whatever the headcount)
nullifiers:         16
receipts anchored:  16
```

## Dashboard

```bash
npm run dev -w @conserve/ui
```

The dashboard opens on the deployed Preprod contract, read once and shown from
two seats side by side: what the public sees (commitments and counts, no
amounts, no names, sixteen slots whatever the headcount) and what a recipient
can prove (their exact amount, matched against a commitment on chain). _Try
claiming 500 more_ shows the same check rejecting an overstated payment.

Below that are the hands-on tools: a receipt checker for your own receipt, a
payroll draft that never leaves the tab and shows the one commitment it would
publish, and a reader for any contract's public state on either network.
