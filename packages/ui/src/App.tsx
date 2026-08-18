import { useCallback, useMemo, useState } from 'react';
import type { NetworkProfile } from '@conserve/api/config';
import { type CycleView, readCycle } from './cycle.js';
import {
  type Line,
  MAX_LINES,
  budgetCommitment,
  emptyLine,
  randomSalt,
  total,
  validate,
} from './payroll.js';

const NETWORKS: NetworkProfile[] = ['preprod', 'undeployed'];

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="field">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

function ChainPanel() {
  const [network, setNetwork] = useState<NetworkProfile>('preprod');
  const [address, setAddress] = useState('');
  const [view, setView] = useState<CycleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await readCycle(network, address.trim()));
    } catch (cause) {
      setView(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [network, address]);

  return (
    <section className="panel">
      <header>
        <h2>What the chain shows</h2>
        <p>Read live from the public indexer — the same view a block explorer has.</p>
      </header>

      <div className="row">
        <select
          value={network}
          onChange={(event) => setNetwork(event.target.value as NetworkProfile)}
          aria-label="Network"
        >
          {NETWORKS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Contract address"
          spellCheck={false}
          aria-label="Contract address"
        />
        <button onClick={load} disabled={loading || address.trim() === ''}>
          {loading ? 'Reading…' : 'Read state'}
        </button>
      </div>

      {error !== null && <p className="error">{error}</p>}

      {view !== null && (
        <>
          <dl>
            <Field label="Cycle" value={String(view.cycleId)} />
            <Field label="Status" value={view.status} />
            <Field label="Cycles settled" value={String(view.settledCycles)} />
            <Field label="Roster slots" value={`${view.rosterWidth} (fixed)`} />
            <Field label="Nullifiers" value={String(view.nullifierCount)} />
            <Field label="Receipts anchored" value={String(view.receiptsAnchored)} />
          </dl>
          <div className="commitment">
            <span>Budget commitment</span>
            <code>{view.budgetCommitment}</code>
          </div>
          <p className="note">
            Everything above is a count or a commitment. The budget total, the recipients and every
            individual amount are absent — and the slot count is fixed at {String(view.rosterWidth)}
            , so it does not reveal how many people were actually paid.
          </p>
        </>
      )}
    </section>
  );
}

function PayrollPanel() {
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [salt] = useState(randomSalt);

  const issues = useMemo(() => validate(lines), [lines]);
  const sum = useMemo(() => total(lines), [lines]);
  const commitment = useMemo(
    () => (issues.length === 0 ? budgetCommitment(lines, salt) : null),
    [issues, lines, salt],
  );

  const update = (id: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));

  const issueFor = (id: string) => issues.find((issue) => issue.line === id)?.message;

  return (
    <section className="panel">
      <header>
        <h2>What stays private</h2>
        <p>
          This table never leaves the tab. It becomes witness data for the proof; only the
          commitment below is published.
        </p>
      </header>

      <div className="lines">
        {lines.map((line, index) => (
          <div key={line.id} className="line">
            <input
              value={line.label}
              onChange={(event) => update(line.id, { label: event.target.value })}
              placeholder={`Recipient ${index + 1}`}
              aria-label={`Label for recipient ${index + 1}`}
            />
            <input
              value={line.recipient}
              onChange={(event) => update(line.id, { recipient: event.target.value })}
              placeholder="32-byte hex identifier"
              spellCheck={false}
              aria-label={`Identifier for recipient ${index + 1}`}
            />
            <input
              value={line.amount}
              onChange={(event) => update(line.id, { amount: event.target.value })}
              placeholder="Amount"
              inputMode="numeric"
              aria-label={`Amount for recipient ${index + 1}`}
            />
            <button
              className="ghost"
              onClick={() => setLines((current) => current.filter((l) => l.id !== line.id))}
              disabled={lines.length === 1}
              aria-label={`Remove recipient ${index + 1}`}
            >
              ×
            </button>
            {issueFor(line.id) !== undefined && <p className="error">{issueFor(line.id)}</p>}
          </div>
        ))}
      </div>

      <button
        className="ghost add"
        onClick={() => setLines((current) => [...current, emptyLine()])}
        disabled={lines.length >= MAX_LINES}
      >
        Add recipient {lines.length >= MAX_LINES && `(limit ${MAX_LINES})`}
      </button>

      <dl>
        <Field label="Budget total" value={String(sum)} />
        <Field label="Recipients" value={`${lines.filter((l) => l.recipient !== '').length}`} />
      </dl>

      {issues.some((issue) => issue.line === undefined) && (
        <p className="error">{issues.find((issue) => issue.line === undefined)!.message}</p>
      )}

      {commitment !== null && (
        <div className="commitment">
          <span>Budget commitment — the only value published</span>
          <code>{commitment}</code>
        </div>
      )}
    </section>
  );
}

export default function App() {
  return (
    <main>
      <header className="masthead">
        <h1>Conserve</h1>
        <p>
          Payroll and revenue splits where the total is verifiable and the individual amounts are
          not public.
        </p>
      </header>

      <div className="panels">
        <PayrollPanel />
        <ChainPanel />
      </div>

      <footer>
        <p>
          Settlement runs from the CLI: <code>conserve open</code> then <code>conserve settle</code>
          . The proof is built locally against a proof server you control, because the roster is the
          one thing that must never leave your machine.
        </p>
      </footer>
    </main>
  );
}
