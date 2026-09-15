/**
 * Recipient addresses, parsed in the browser.
 *
 * A shielded address is bech32m over the recipient's 32-byte coin public key
 * followed by their 32-byte encryption public key. The receipt tree commits to
 * the coin public key, so that is the half a receipt check needs. Decoding here
 * rather than through the wallet SDK's address package keeps Node's Buffer out
 * of the bundle.
 */

import { bech32m } from '@scure/base';

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

export type ParsedRecipient =
  | {
      readonly ok: true;
      readonly coinPublicKey: Uint8Array;
      /** Hex encryption public key; absent when a bare coin key was given. */
      readonly encryptionKey?: string;
      readonly network?: string;
    }
  | { readonly ok: false; readonly reason: string };

/** Accepts a shielded address (mn_shield-addr_…) or a raw 32-byte hex coin public key. */
export const parseRecipient = (value: string): ParsedRecipient => {
  const input = value.trim();
  if (HEX32.test(input)) {
    const hex = input.replace(/^0x/, '');
    return { ok: true, coinPublicKey: Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)) };
  }
  if (!input.startsWith('mn_shield-addr_')) {
    return { ok: false, reason: 'Enter a shielded address (mn_shield-addr_…).' };
  }
  try {
    const { prefix, words } = bech32m.decode(input as `${string}1${string}`, false);
    const bytes = bech32m.fromWords(words);
    if (bytes.length !== 64) {
      return { ok: false, reason: 'That shielded address has the wrong length.' };
    }
    return {
      ok: true,
      coinPublicKey: bytes.slice(0, 32),
      encryptionKey: Array.from(bytes.slice(32), (b) => b.toString(16).padStart(2, '0')).join(''),
      network: prefix.slice('mn_shield-addr_'.length),
    };
  } catch {
    return { ok: false, reason: 'That is not a valid shielded address.' };
  }
};
