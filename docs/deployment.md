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

For the steps themselves, see [setup.md](setup.md) and [usage.md](usage.md).
