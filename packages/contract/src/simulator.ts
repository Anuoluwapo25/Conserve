/**
 * In-process harness that runs the Conserve circuits against a real Compact
 * ledger without a node, a proof server, or a wallet. Used by the test suite
 * and by the CLI's `simulate` command.
 */

import {
  type CircuitContext,
  type ZswapLocalState,
  createCircuitContext,
  decodeZswapLocalState,
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

/** Stand-in coin public key for the organizer's side of the simulated transactions. */
const TEST_COIN_PUBLIC_KEY = '0'.repeat(64);

export class ConserveSimulator {
  readonly contract: Contract<ConservePrivateState>;
  readonly address = sampleContractAddress();
  private context: CircuitContext<ConservePrivateState>;

  /**
   * @param payoutToken The token type payouts are made in. Any 32 bytes will do
   *   in-process: nothing here checks that the funding coin exists.
   */
  constructor(
    privateState: ConservePrivateState,
    readonly payoutToken = randomToken(),
  ) {
    this.contract = new Contract<ConservePrivateState>(witnesses);
    const organizerPk = pureCircuits.organizerPublicKey(privateState.organizerSecretKey);
    const initial = this.contract.initialState(
      createConstructorContext(privateState, TEST_COIN_PUBLIC_KEY),
      organizerPk,
      payoutToken,
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

  /**
   * The shielded coins the last circuit call spent and created. A settlement's
   * payouts are here, and so is the evidence that its shape does not depend on
   * how many of them are real.
   */
  get zswap(): ZswapLocalState {
    return decodeZswapLocalState(this.context.currentZswapLocalState);
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

function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
