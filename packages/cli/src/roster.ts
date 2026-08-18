/**
 * Reads a payroll file from disk.
 *
 * The file is the sensitive artefact in this whole system: it holds who gets
 * paid and how much. It is read locally, turned into witness data, and never
 * transmitted. Labels in particular exist only for the operator's own benefit
 * and are not part of the circuit at all.
 */

import { readFile } from 'node:fs/promises';
import { MAX_RECIPIENTS, type Payout } from '@conserve/api';

export type PayrollFile = {
  readonly budget: bigint;
  readonly payouts: readonly LabelledPayout[];
};

export type LabelledPayout = Payout & {
  /** Local-only nickname; never enters a circuit or a transaction. */
  readonly label?: string;
};

const HEX = /^(0x)?[0-9a-fA-F]{64}$/;

const parseRecipient = (value: unknown, index: number): Uint8Array => {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new Error(
      `payout ${index}: "recipient" must be a 32-byte hex string, got ${JSON.stringify(value)}`,
    );
  }
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
};

const parseAmount = (value: unknown, where: string): bigint => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(
      `${where}: expected a number or a decimal string, got ${JSON.stringify(value)}`,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${where}: ${JSON.stringify(value)} is not a whole number`);
  }
};

export const parsePayroll = (raw: string): PayrollFile => {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    throw new Error('payroll file must be a JSON object');
  }
  const { budget, payouts } = data as Record<string, unknown>;
  if (!Array.isArray(payouts) || payouts.length === 0) {
    throw new Error('payroll file must list at least one payout');
  }
  if (payouts.length > MAX_RECIPIENTS) {
    throw new Error(
      `payroll lists ${payouts.length} payouts; the circuit proves at most ${MAX_RECIPIENTS} per cycle`,
    );
  }

  const parsed = payouts.map((payout, index) => {
    const entry = payout as Record<string, unknown>;
    return {
      recipient: parseRecipient(entry.recipient, index),
      amount: parseAmount(entry.amount, `payout ${index} ("amount")`),
      label: typeof entry.label === 'string' ? entry.label : undefined,
    };
  });

  const total = parsed.reduce((sum, payout) => sum + payout.amount, 0n);
  const declared = budget === undefined ? total : parseAmount(budget, '"budget"');
  if (declared !== total) {
    throw new Error(
      `payroll declares a budget of ${declared} but the payouts sum to ${total}. ` +
        'The circuit will reject any settlement where these differ.',
    );
  }

  return { budget: declared, payouts: parsed };
};

export const readPayroll = async (path: string): Promise<PayrollFile> =>
  parsePayroll(await readFile(path, 'utf8'));
