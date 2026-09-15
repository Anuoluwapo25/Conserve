/**
 * The payroll composer's local model.
 *
 * Nothing in this module leaves the browser tab. It exists so an operator can
 * see the split they are about to prove, and see the single value — the budget
 * commitment — that will actually be published.
 */

import { MAX_RECIPIENTS } from '@conserve/contract';
import { pureCircuits } from '@conserve/contract';
import { parseRecipient } from './recipient.js';

export type Line = {
  readonly id: string;
  readonly label: string;
  readonly recipient: string;
  readonly amount: string;
};

export const emptyLine = (): Line => ({
  id: crypto.randomUUID(),
  label: '',
  recipient: '',
  amount: '',
});

export const MAX_LINES = MAX_RECIPIENTS;

export type PayrollIssue = { readonly line?: string; readonly message: string };

export const validate = (lines: readonly Line[]): PayrollIssue[] => {
  const issues: PayrollIssue[] = [];
  const seen = new Map<string, string>();

  for (const line of lines) {
    if (line.recipient.trim() === '' && line.amount.trim() === '') continue;
    const parsed = parseRecipient(line.recipient);
    if (!parsed.ok) {
      issues.push({ line: line.id, message: parsed.reason });
    } else {
      const key = toHex(parsed.coinPublicKey);
      if (seen.has(key)) {
        issues.push({
          line: line.id,
          message: 'This recipient already appears above — the circuit rejects duplicates.',
        });
      }
      seen.set(key, line.id);
    }
    if (!/^\d+$/.test(line.amount.trim()) || BigInt(line.amount.trim() || '0') <= 0n) {
      issues.push({ line: line.id, message: 'Amount must be a positive whole number.' });
    }
  }

  if (seen.size === 0) {
    issues.push({ message: 'Add at least one recipient.' });
  }
  if (lines.length > MAX_LINES) {
    issues.push({ message: `A cycle proves at most ${MAX_LINES} recipients.` });
  }
  return issues;
};

export const total = (lines: readonly Line[]): bigint =>
  lines.reduce(
    (sum, line) => sum + (/^\d+$/.test(line.amount.trim()) ? BigInt(line.amount) : 0n),
    0n,
  );

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The one value this payroll would publish. Everything else — who, how much,
 * how many — stays in this tab.
 */
export const budgetCommitment = (lines: readonly Line[], salt: Uint8Array): string =>
  toHex(pureCircuits.budgetCommitmentOf(total(lines), salt));

export const randomSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export const receiptPreview = (line: Line, cycleId: bigint, nonce: Uint8Array): string => {
  const parsed = parseRecipient(line.recipient);
  if (!parsed.ok) throw new Error(parsed.reason);
  return toHex(
    pureCircuits.receiptCommitment(cycleId, parsed.coinPublicKey, BigInt(line.amount), nonce),
  );
};
