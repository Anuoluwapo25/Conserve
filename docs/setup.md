# Setup

## Prerequisites

| Tool              | Version         | Why                                              |
| ----------------- | --------------- | ------------------------------------------------ |
| Node.js           | 20+ (22 tested) | Runtime for every package                        |
| Compact toolchain | compiler 0.31.1 | Compiles the circuits and generates proving keys |
| Docker            | any recent      | Runs the proof server                            |

Install the Compact toolchain:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update 0.31.1
compact --version
```

The installer puts `compact` in `~/.local/bin`; add that to your `PATH` if it
is not there already.

## Build

```bash
git clone https://github.com/<owner>/conserve.git
cd conserve
npm install
npm run build
```

The first build compiles the circuits and generates proving keys, which takes a
few minutes. Later builds skip it unless `conserve.compact` changed; force a
rebuild with `COMPACT_FORCE=1 npm run compact`.

## Verify without a network

```bash
npm test
node packages/cli/dist/main.js simulate --payroll examples/payroll.example.json
```

`simulate` runs the real circuits in-process against a real Compact ledger. No
node, no wallet, no proof server, no funds. If this works, the privacy-critical
core works.

## Proof server

Every on-chain command needs one. Run it locally — it sees your entire payroll
in the clear, so a hosted one would defeat the point:

```bash
docker run -d --rm -p 6300:6300 --name conserve-proof-server \
  midnightnetwork/proof-server:latest -- \
  'midnight-proof-server --network preprod --verbose'
```

## Operator secrets

Create `.env.local` (gitignored):

```bash
CONSERVE_SEED=<64 hex chars>            # wallet seed
CONSERVE_PASSWORD=<16+ chars>           # encrypts the local private-state store
CONSERVE_ACCOUNT=default                # scopes that store
CONSERVE_ORGANIZER_KEY=<64 hex chars>   # authorises openCycle and settle
```

Generate the two keys:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The password must be at least 16 characters with three of {upper, lower, digit,
symbol}, no runs of four sequential characters, and no more than three identical
in a row — the SDK enforces this.

`CONSERVE_ORGANIZER_KEY` is the one to back up. Lose it and you cannot open or
settle another cycle on that contract, ever; there is no recovery path because
the ledger only holds its hash.

## Funding

```bash
source .env.local
node packages/cli/dist/main.js address --offline
```

Paste the `night:` address into <https://faucet.preprod.midnight.network>. Fees
are paid in DUST, which accrues against registered NIGHT, so after funding you
also need to register those UTXOs for DUST generation.

Syncing a fresh wallet scans the chain from genesis and needs more than Node's
default heap:

```bash
export NODE_OPTIONS=--max-old-space-size=12288
```

## Local network

To develop without Preprod, run a local node and indexer and pass
`--network undeployed`. Endpoints are overridable:

```bash
CONSERVE_INDEXER_URL=...  CONSERVE_INDEXER_WS_URL=...
CONSERVE_NODE_URL=...     CONSERVE_PROOF_SERVER_URL=...
```
