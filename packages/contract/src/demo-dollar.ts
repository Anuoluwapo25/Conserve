/**
 * Bindings for Demo Dollar, the shielded test token Conserve pays in on networks
 * that have no shielded token an organizer can get from a faucet.
 */

import { Contract as DemoDollarContract } from '../managed/demo-dollar/contract/index.js';

export { DemoDollarContract };

/** The token has no private state and no witnesses. */
export type DemoDollarPrivateState = Record<string, never>;

export const demoDollarWitnesses = {};

/**
 * The domain separator Demo Dollar mints under: the compiled form of
 * `pad(32, "conserve:demo-dollar:v1")`, UTF-8 bytes right-padded with zeros.
 * Together with the token contract's address it determines the token type.
 */
export const DEMO_DOLLAR_DOMAIN: Uint8Array = (() => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('conserve:demo-dollar:v1'));
  return bytes;
})();
