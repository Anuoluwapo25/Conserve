# Usage

Every command takes `--network preprod` (default) or `--network undeployed`, and
`--json` for machine-readable output.

## The payroll file

```json
{
  "budget": "10000",
  "payouts": [
    { "label": "core-dev", "recipient": "9f1c0e…6e23", "amount": "4500" },
    { "label": "designer", "recipient": "3a7d5e…7a0d", "amount": "3000" },
    { "label": "ops", "recipient": "c48b1f…e9b5", "amount": "2500" }
  ]
}
```

`recipient` is a 32-byte hex identifier. `label` is for you: it is stripped
before anything reaches a circuit and never leaves the machine. `budget` is
optional — omit it and the payouts' sum is used — but stating it is worth the
keystroke, because a mismatch is caught immediately with a readable message
instead of surfacing as a proof failure.

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
conserve settle --contract <addr> --payroll payroll.json
```

`open` publishes the commitment to the budget. `settle` proves the split and
prints one receipt line per recipient:

```
core-dev: commitment 7f3a… nonce 91cd…
```

Hand each recipient their own line and nothing else. Those two values plus their
own identifier and amount are what they will need to prove their earnings in
Level 5.

The payroll file is passed to both commands and must be identical between them —
`open` reads only its total, `settle` reads the lines.

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

Two panels: a payroll composer that never leaves the tab, and a live read of any
contract's public state. The contrast between them is the point.
