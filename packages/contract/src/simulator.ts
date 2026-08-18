/**
 * In-process harness that runs the Conserve circuits against a real Compact
 * ledger without a node, a proof server, or a wallet. Used by the test suite
 * and by the CLI's `simulate` command.
 */

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  type ConservePrivateState,
  type Ledger,
  ledger,
  pureCircuits,
  witnesses,
} from './index.js';

/** Stand-in Zswap coin public key; settlement does not move coins at Level 4. */
const TEST_COIN_PUBLIC_KEY = '0'.repeat(64);

export class ConserveSimulator {
  readonly contract: Contract<ConservePrivateState>;
  readonly address = sampleContractAddress();
  private context: CircuitContext<ConservePrivateState>;

  constructor(privateState: ConservePrivateState) {
    this.contract = new Contract<ConservePrivateState>(witnesses);
    const organizerPk = pureCircuits.organizerPublicKey(privateState.organizerSecretKey);
    const initial = this.contract.initialState(
      createConstructorContext(privateState, TEST_COIN_PUBLIC_KEY),
      organizerPk,
    );
    this.context = createCircuitContext(
      this.address,
      TEST_COIN_PUBLIC_KEY,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  }

  /** The public state, exactly as a block explorer would see it. */
  get ledger(): Ledger {
    return ledger(this.context.currentQueryContext.state);
  }

  get privateState(): ConservePrivateState {
    return this.context.currentPrivateState;
  }

  /** Swaps in a new private state, e.g. a fresh roster for the next cycle. */
  setPrivateState(privateState: ConservePrivateState): void {
    this.context = { ...this.context, currentPrivateState: privateState };
  }

  openCycle(commitment: Uint8Array): bigint {
    const { result, context } = this.contract.impureCircuits.openCycle(this.context, commitment);
    this.context = context;
    return result;
  }

  settle(): void {
    const { context } = this.contract.impureCircuits.settle(this.context);
    this.context = context;
  }
}
