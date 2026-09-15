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
git clone https://github.com/Anuoluwapo25/Conserve.git
cd Conserve
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
  -v midnight-zk-params:/.cache/midnight/zk-params \
  midnightntwrk/proof-server:8.1.0 -- \
  'midnight-proof-server --port 6300 --num-workers 2 --job-timeout 3600'
```

The volume keeps the public proving parameters the server downloads from
`srs.midnight.network`. Without it every new container downloads them again,
including a 100 MB set the first settlement needs. If a download fails partway
through a proof, the client sees `400 Bad Request` with no further detail; if
one fails at startup, the container exits.

A settlement is proof-heavy: one proof for the payroll circuit, plus one for
each of the sixteen shielded payouts and the coins the wallet spends to fund
them — around fifty proofs, a few minutes each on a laptop. Two things follow.

**Give Docker memory.** Proofs run in parallel up to `--num-workers`, and each
one is hungry; settling peaked near 7 GB with two workers. Eight is a sensible
floor for Docker's memory limit (Docker Desktop → Settings → Resources). More
workers on a machine that cannot feed them makes settlement slower, not faster,
and the proof server is killed outright when it runs out — exit code 137, which
reaches the CLI as a connection refused partway through proving.

**Do not shorten the job timeout.** `--job-timeout 3600` keeps queued proofs
from being cancelled while a long one runs. The client has a matching deadline
per proof, 45 minutes by default; `CONSERVE_PROOF_TIMEOUT_MS` raises or lowers
it. Both exist because the payroll proof itself takes over five minutes, and an
aborted proof surfaces as a transaction that simply never arrives.

The image tag has to match the ledger version the client is built against —
`@midnight-ntwrk/ledger-v8`, pinned to 8.1.0 in the root `package.json`. Note
the organisation: `midnightntwrk` publishes the current images, while the
older `midnightnetwork/proof-server` stops at ledger 7 and its `latest` tag is
far behind. Pairing an 8.x client with a 7.x proof server does not fail
cleanly — the server accepts the `/prove` request and then spins on one core
indefinitely, which looks exactly like a slow proof.

## Payout token

Conserve pays in a shielded token, fixed at deployment. Preprod has no shielded
token a faucet will hand out, so the repository ships one — Demo Dollar — for
testing:

```bash
node packages/cli/dist/main.js demo-dollar deploy
node packages/cli/dist/main.js demo-dollar mint --token-contract <addr> --amount 1000000
node packages/cli/dist/main.js deploy --token <token type>
```

Mint a round working balance rather than one cycle's exact budget: mint amounts
are public, and minting the budget would reveal the total the commitment hides.

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

Paste the `night:` address into <https://faucet.preprod.midnight.network>. The
faucet is rate limited to one request per address per 24 hours.

Fees are paid in DUST, which only accrues against _registered_ NIGHT, so a
freshly funded wallet has a balance and no way to spend it. Register the new
UTXOs once the funding has synced:

```bash
node packages/cli/dist/main.js register
```

This submits one transaction covering every unregistered NIGHT UTXO, then waits
until a DUST coin is actually spendable — the DUST balance reads non-zero as
soon as the registration lands, but a transaction submitted before the chain has
accounted for the accrual still fails with "insufficient DUST". Re-running it
once everything is registered is a no-op.

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
