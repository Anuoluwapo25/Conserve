# Deploying to Preprod: what it took

Getting Conserve from a passing test suite to a settled payroll on a public
network took six real bugs out of this codebase. None of them was reachable from
`npm test`, which only exercises the in-process simulator — each one needed a
funded wallet, a real proof server or a real ledger to surface.

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
[`scripts/deploy-supervised.sh`](../scripts/deploy-supervised.sh) restarts the
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

## Paying: what it took

Making `settle` move shielded coins surfaced a second set. Most of them failed
silently — a process that looks busy and is not — which is why the fixes lean
toward failing loudly.

**The proof client gave up before the proof finished.** midnight-js's HTTP proof
provider defaults to a five-minute timeout per proof, and the paying `settle`
proof takes a little longer than that. The request was aborted, the error was
swallowed along the way, and the CLI sat waiting for a transaction that had
never been submitted. The timeout is now 45 minutes and set through
`CONSERVE_PROOF_TIMEOUT_MS`.

**The first version of the circuit was twice the size it needed to be.** Nesting
a second hash inside each receipt commitment put `settle` at 577,473 rows —
just past 2^19 — so the proving key doubled to 305 MB and a proof server with
two workers ran out of Docker's memory and was killed. One flat hash over the
same values brings it to 511,434 rows and 154 MB. `zkir mock-compile` reports
the row count in a second, long before a failed proof would.

**A proof server with a fresh container has nothing cached.** The server
downloads public parameters on demand, including a 100 MB set the first
settlement needs. When that download failed partway through a proof, the client
saw `400 Bad Request` and nothing more; when one failed at startup, the container
exited. The documented `docker run` now mounts a volume for them.

**A wallet cache from before a network upgrade can never sync again.** After
Preprod moved to node 1.0.2, a cache that had worked for weeks resumed a few
positions out of step with the indexer, and the SDK rejected every update —
`values inserted non-linearly into … commitment tree` — logging it without
failing. Sync simply never completed. Commands now give up after ten minutes
without progress and name the cache file to move aside; the cure is a fresh sync.
Caches are also keyed per wallet now, where they used to be keyed per network,
which silently handed one seed another seed's state.

**On an idle local chain, the DUST wallet cannot pay a fee of one.** Fee prices
fall as blocks go empty. After a few hours the local chain priced a contract call
at a single unit of DUST, and the wallet SDK's coin selection then picks no coins,
re-estimates, picks none again, and loops synchronously forever — with plenty of
DUST available. Both the CLI and the dashboard path hang there. Preprod, with real
traffic and real fees, does not reach that price; locally, restarting the chain
resets it.

**The browser bundle needed two Node built-ins back.** The private-state store
extends `EventEmitter` and the SDK's address codec calls `assert`; Vite replaces
both with empty modules in a browser build, and the page failed to load at all.
The `events` and `assert` packages supply browser versions.

For the steps themselves, see [setup.md](setup.md) and [usage.md](usage.md).
