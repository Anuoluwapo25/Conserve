/**
 * Compares the NIGHT address the CLI prints (the one pasted into the faucet)
 * against the public key the unshielded wallet actually watches.
 */

import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { PublicKey, createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { networkConfig } from '@conserve/api/config';
import { deriveAddresses, deriveKeys, seedFromHex } from '../packages/cli/dist/keys.js';

const config = networkConfig('preprod');
const keys = deriveKeys(seedFromHex(process.env.CONSERVE_SEED));

console.log('--- what the CLI prints (funded) ---');
console.log(deriveAddresses(keys, config.networkId).night);

console.log('\n--- raw material ---');
console.log('String(nightVerifyingKey) =', String(keys.nightVerifyingKey));

console.log('\n--- what the wallet watches ---');
const keystore = createKeystore(keys.nightSecret, config.networkId);
const publicKey = PublicKey.fromKeyStore(keystore);
console.log('PublicKey object      =', publicKey);
for (const key of ['bytes', 'data', 'raw', 'value', 'toString']) {
  try {
    const v = typeof publicKey[key] === 'function' ? publicKey[key]() : publicKey[key];
    if (v !== undefined) console.log(`publicKey.${key} =`, Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v));
  } catch {
    /* ignore */
  }
}

try {
  const fromKeystore = new UnshieldedAddress(Buffer.from(keystore.getPublicKey().bytes ?? []));
  console.log('address from keystore =', MidnightBech32m.encode(config.networkId, fromKeystore).toString());
} catch (e) {
  console.log('keystore address encode failed:', e?.message ?? e);
}
