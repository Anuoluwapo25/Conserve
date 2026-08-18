/**
 * Key derivation for the operator wallet.
 *
 * One seed produces the three key families Midnight uses: Night (unshielded,
 * what the faucet funds), Zswap (shielded coins), and Dust (what pays fees).
 * Derivation is entirely local and needs no network, which is why
 * `conserve address` can print a fundable address before anything is deployed.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

export type OperatorKeys = {
  /** Raw BIP340 key bytes for the Night role; the unshielded keystore wants these. */
  readonly nightSecret: Uint8Array;
  readonly nightSigningKey: ledger.SigningKey;
  readonly nightVerifyingKey: ledger.SignatureVerifyingKey;
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
};

export type OperatorAddresses = {
  /** Bech32m unshielded address — the one to paste into the faucet. */
  readonly night: string;
  readonly shielded: string;
  readonly dust: string;
};

export const seedFromHex = (value: string): Uint8Array => {
  const hex = value.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CONSERVE_SEED must be a 32-byte hex string');
  }
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
};

export const deriveKeys = (seed: Uint8Array, account = 0, index = 0): OperatorKeys => {
  const wallet = HDWallet.fromSeed(seed);
  if (wallet.type !== 'seedOk') {
    throw new Error(`could not derive keys from the seed: ${String(wallet.error)}`);
  }
  const derived = wallet.hdWallet
    .selectAccount(account)
    .selectRoles([Roles.NightExternal, Roles.Zswap, Roles.Dust])
    .deriveKeysAt(index);
  if (derived.type !== 'keysDerived') {
    throw new Error('key derivation fell outside the valid range; try another account index');
  }
  wallet.hdWallet.clear();

  const nightSecret = derived.keys[Roles.NightExternal];
  const nightSigningKey = ledger.signingKeyFromBip340(nightSecret);
  return {
    nightSecret,
    nightSigningKey,
    nightVerifyingKey: ledger.signatureVerifyingKey(nightSigningKey),
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]),
  };
};

export const deriveAddresses = (keys: OperatorKeys, networkId: string): OperatorAddresses => {
  const shielded = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(keys.shieldedSecretKeys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(keys.shieldedSecretKeys.encryptionPublicKey),
  );
  const night = new UnshieldedAddress(Buffer.from(String(keys.nightVerifyingKey), 'hex'));

  return {
    night: MidnightBech32m.encode(networkId, night).toString(),
    shielded: MidnightBech32m.encode(networkId, shielded).toString(),
    dust: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
  };
};
