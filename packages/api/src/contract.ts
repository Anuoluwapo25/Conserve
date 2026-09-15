/**
 * Binds the compiled Compact output to its witness implementations and ZK assets.
 */

import { pipe } from 'effect';
import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { Contract, type ConservePrivateState, witnesses } from '@conserve/contract';
import {
  DemoDollarContract,
  type DemoDollarPrivateState,
  demoDollarWitnesses,
} from '@conserve/contract/demo-dollar';

export type ConserveContract = Contract<ConservePrivateState>;

/** Circuit ids that produce proofs, i.e. everything that needs a proving key. */
export type ConserveCircuitId = 'openCycle' | 'settle';

/**
 * The compiled contract handle passed to `deployContract` / `findDeployedContract`.
 *
 * `withCompiledFileAssets('conserve')` is resolved relative to the base path
 * given to the ZK config provider, which points at the contract package's
 * `managed/conserve/` directory.
 */
export const conserveCompiledContract = pipe(
  CompiledContract.make<ConserveContract, ConservePrivateState>('conserve', Contract),
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets('conserve'),
);

export type DemoDollar = DemoDollarContract<DemoDollarPrivateState>;

export type DemoDollarCircuitId = 'mint';

/** The compiled Demo Dollar token, resolved against `managed/demo-dollar/`. */
export const demoDollarCompiledContract = pipe(
  CompiledContract.make<DemoDollar, DemoDollarPrivateState>('demo-dollar', DemoDollarContract),
  CompiledContract.withWitnesses(demoDollarWitnesses as never),
  CompiledContract.withCompiledFileAssets('demo-dollar'),
);
