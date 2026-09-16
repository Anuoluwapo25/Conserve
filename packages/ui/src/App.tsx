import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEPLOYED_CONTRACT, type NetworkProfile } from '@conserve/api/config';
import { type CycleView, readCycle, readLedger } from './cycle.js';
import { WalletPanel } from './WalletPanel.js';
import {
  type Line,
  MAX_LINES,
  budgetCommitment,
  emptyLine,
  randomSalt,
  total,
  validate,
} from './payroll.js';
import {
  type PublicCycleView,
  type ReceiptVerdict,
  summarise,
  verifyReceipt,
} from '@conserve/api/view';
import {
  type ReceiptInput,
  checkReceipt,
  emptyReceipt,
  receiptIssues,
  toReceipt,
} from './receipt.js';

const NETWORKS: NetworkProfile[] = ['preprod', 'undeployed'];

/**
 * A receipt from the demo contract's first cycle, so the recipient side can be
 * tried without having been paid. Its amount is not a secret: it comes from
 * `examples/payroll.example.json`, which is public in the repository, settled
 * against a throwaway testnet organizer key. A real recipient's receipt is
 * never published anywhere — that is the whole point — so this is the one
 * receipt it is safe to ship.
 */
const DEMO_RECEIPT: ReceiptInput = {
  cycleId: '1',
  recipient:
    'mn_shield-addr_preprod14vltmwdyrc45vc3rvx332kqqj093vjz6mxvvwaa7uhdulss3wnqua5mk3y7fqxuxz7uh38zlj5wh5uuue0jenmwh0hnd8pfgq9ycmeq8p8e60',
  amount: '3000',
  nonce: 'cb82a2c7cfab05619eb3cfadb5554db635e9b79b3b94d20d49f6664877479d89',
};

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="field">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

/** Headcount of the payroll behind the demo contract — public in the repository. */
const DEMO_HEADCOUNT = 3;

type Moment = {
  readonly view: PublicCycleView;
  readonly honest: ReceiptVerdict;
  readonly inflated: ReceiptVerdict;
};

/**
 * The whole idea on one screen: the same contract, read once, from two seats.
 * The public sees commitments and counts; a recipient holding their receipt can
 * prove their exact amount — and cannot prove a different one.
 */
function TwoViews() {
  const address = DEPLOYED_CONTRACT.preprod;
  const [moment, setMoment] = useState<Moment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimInflated, setClaimInflated] = useState(false);

  useEffect(() => {
    if (address === undefined) return;
    let cancelled = false;
    readLedger('preprod', address)
      .then((state) => {
        if (cancelled) return;
        const inflatedAmount = String(BigInt(DEMO_RECEIPT.amount) + 500n);
        setMoment({
          view: summarise(state),
          honest: verifyReceipt(state, toReceipt(DEMO_RECEIPT)),
          inflated: verifyReceipt(state, toReceipt({ ...DEMO_RECEIPT, amount: inflatedAmount })),
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const claimed = claimInflated ? BigInt(DEMO_RECEIPT.amount) + 500n : BigInt(DEMO_RECEIPT.amount);
  const verdict = moment === null ? null : claimInflated ? moment.inflated : moment.honest;

  return (
    <section
      className="two-views"
      aria-label="The same contract, seen by the public and by a recipient"
    >
      <div className="seat public">
        <p className="seat-label">What everyone sees</p>
        <h2>The public</h2>
        {error !== null && <p className="error">{error}</p>}
        {moment === null && error === null && <p className="loading">Reading Midnight Preprod…</p>}
        {moment !== null && (
          <>
            <dl>
              <Field label="Cycle" value={String(moment.view.cycleId)} />
              <Field label="Status" value={moment.view.status} />
              <Field label="Payout slots" value={String(moment.view.rosterWidth)} />
              <Field label="Receipts on chain" value={String(moment.view.receiptsAnchored)} />
              <Field label="Shielded payouts" value={String(moment.view.rosterWidth)} />
              <Field label="Amounts on chain" value="none" />
              <Field label="Names on chain" value="none" />
            </dl>
            <div className="commitment">
              <span>Budget commitment</span>
              <code>{moment.view.budgetCommitment}</code>
            </div>
            <p className="note">
              {DEMO_HEADCOUNT} people were paid. The chain shows {String(moment.view.rosterWidth)}{' '}
              of everything, so not even the headcount leaks.
            </p>
          </>
        )}
      </div>

      <div className="seat recipient">
        <p className="seat-label">What only they can prove</p>
        <h2>A recipient</h2>
        {moment === null && error === null && <p className="loading">Checking their receipt…</p>}
        {moment !== null && verdict !== null && (
          <>
            <p className={verdict.anchored ? 'verdict ok' : 'verdict bad'}>
              <span className="amount">{claimed.toLocaleString()}</span>
              {verdict.anchored ? 'Proven on chain' : 'Rejected — no such payment'}
            </p>
            <p className="note">
              {verdict.anchored
                ? `The designer holds a private receipt for cycle ${DEMO_RECEIPT.cycleId}. It matches a commitment the network accepted, and the payment itself landed in their wallet as a shielded coin — so they know they were paid exactly this, and nobody watching learns the figure.`
                : 'Claim a different amount and the commitment no longer matches anything on chain. A receipt proves one exact payment, so nobody can overstate what they were paid.'}
            </p>
            <div className="commitment">
              <span>{verdict.anchored ? 'Matching commitment' : 'Commitment for this claim'}</span>
              <code>{verdict.commitment}</code>
            </div>
            <button className="ghost add" onClick={() => setClaimInflated((current) => !current)}>
              {claimInflated ? 'Back to the real receipt' : 'Try claiming 500 more'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ChainPanel() {
  const [network, setNetwork] = useState<NetworkProfile>('preprod');
  const [address, setAddress] = useState(DEPLOYED_CONTRACT.preprod ?? '');
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

  // Switching networks should carry the address that network is actually
  // running, rather than leaving the previous network's address behind to fail
  // its lookup. Clear it when a network has no known deployment.
  const known = DEPLOYED_CONTRACT[network];
  useEffect(() => {
    setAddress(known ?? '');
    setView(null);
    setError(null);
  }, [network, known]);

  return (
    <section className="panel">
      <header>
        <h2>Inspect any contract</h2>
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
        <h2>Draft a payroll</h2>
        <p>
          This table never leaves the tab. In a real cycle it becomes private input to the proof;
          only the commitment below is ever published.
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
              placeholder="Shielded address (mn_shield-addr_…)"
              spellCheck={false}
              aria-label={`Shielded address for recipient ${index + 1}`}
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

function ReceiptPanel() {
  const [network, setNetwork] = useState<NetworkProfile>('preprod');
  const [address, setAddress] = useState(DEPLOYED_CONTRACT.preprod ?? '');
  const [input, setInput] = useState<ReceiptInput>(emptyReceipt);
  const [verdict, setVerdict] = useState<ReceiptVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const issues = useMemo(() => receiptIssues(input), [input]);
  const set = (patch: Partial<ReceiptInput>) => setInput((current) => ({ ...current, ...patch }));

  const run = useCallback(async () => {
    setChecking(true);
    setError(null);
    setVerdict(null);
    try {
      setVerdict(await checkReceipt(network, address.trim(), input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }, [network, address, input]);

  return (
    <section className="panel">
      <header>
        <h2>Check your receipt</h2>
        <p>
          Paste what your employer gave you and confirm it is anchored on chain. Nothing is sent
          anywhere — the check runs against public state, in this tab.
        </p>
      </header>

      <div className="row">
        <select
          value={network}
          onChange={(event) => setNetwork(event.target.value as NetworkProfile)}
          aria-label="Network for receipt check"
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
          aria-label="Contract address for receipt check"
        />
      </div>

      <div className="lines receipt">
        <input
          value={input.cycleId}
          onChange={(event) => set({ cycleId: event.target.value })}
          placeholder="Cycle"
          inputMode="numeric"
          aria-label="Cycle"
        />
        <input
          value={input.amount}
          onChange={(event) => set({ amount: event.target.value })}
          placeholder="Amount"
          inputMode="numeric"
          aria-label="Amount"
        />
        <input
          value={input.recipient}
          onChange={(event) => set({ recipient: event.target.value })}
          placeholder="Your shielded address (mn_shield-addr_…)"
          spellCheck={false}
          aria-label="Your shielded address"
        />
        <input
          value={input.nonce}
          onChange={(event) => set({ nonce: event.target.value })}
          placeholder="Nonce from your receipt"
          spellCheck={false}
          aria-label="Nonce"
        />
      </div>

      <div className="row">
        <button
          className="add"
          onClick={run}
          disabled={checking || issues.length > 0 || address.trim() === ''}
        >
          {checking ? 'Checking…' : 'Check'}
        </button>
        <button className="ghost" onClick={() => setInput(DEMO_RECEIPT)} disabled={checking}>
          Use the example receipt
        </button>
      </div>

      {issues.length > 0 && Object.values(input).some((value) => value.trim() !== '') && (
        <p className="error">{issues[0]}</p>
      )}
      {error !== null && <p className="error">{error}</p>}

      {verdict !== null && (
        <div className="commitment">
          <span>{verdict.anchored ? 'Anchored on chain' : 'Not found'}</span>
          <code>{verdict.commitment}</code>
          <p className="note">
            {verdict.anchored
              ? 'Your employer settled exactly this amount in a transaction the network accepted. Checking it revealed the amount to nobody.'
              : verdict.reason}
          </p>
        </div>
      )}
    </section>
  );
}

export default function App() {
  return (
    <main>
      <header className="masthead">
        <p className="eyebrow">Live on Midnight Preprod</p>
        <h1>Private payroll on a public blockchain.</h1>
        <p>
          Anyone can verify the team was paid correctly. Nobody can see who earns what. Below is a
          real payroll, settled on chain — read once, from two seats.
        </p>
      </header>

      <TwoViews />

      <h2 className="section-title">Try it yourself</h2>
      <div className="panels">
        <WalletPanel />
        <ReceiptPanel />
        <PayrollPanel />
        <ChainPanel />
      </div>

      <footer>
        <p>
          Organizers run cycles with <code>conserve open</code> and <code>conserve settle</code>.
          The proof is built against a proof server they control, because the payroll is the one
          thing that must never leave their machine.{' '}
          <a href="https://github.com/Anuoluwapo25/Conserve">Source and docs on GitHub</a>.
        </p>
      </footer>
    </main>
  );
}
