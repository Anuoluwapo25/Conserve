import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONSERVE_PRIVATE_STATE_ID, DEMO_DOLLAR_CONTRACT } from '@conserve/api/config';
import {
  type ConserveDeployment,
  contractAddressOf,
  deploy,
  join,
  openCycle,
  settle,
} from '@conserve/api/conserve';
import { demoDollarToken, deployDemoDollar, mintDemoDollars } from '@conserve/api/demo-dollar';
import {
  type ConservePrivateState,
  type Payout,
  emptyPrivateState,
  randomBytes32,
} from '@conserve/contract';
import { parseRecipient } from './recipient.js';
import {
  type AvailableWallet,
  type WalletSession,
  availableWallets,
  browserProviders,
  checkZkAssets,
  connectWallet,
  ensureConnected,
  isChannelClosed,
  isWalletLocked,
} from './wallet.js';

const NETWORK_ID = 'preprod';
const DEFAULT_PROOF_SERVER = 'http://localhost:6300';
const MINT_AMOUNT = 1_000_000n;

const short = (value: string, keep = 10): string =>
  value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;

const storageKey = (session: WalletSession, name: string): string =>
  `conserve:${session.networkId}:${session.coinPublicKey}:${name}`;

const remember = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the session still works.
  }
};

const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Parses "address amount" lines, one payout per line. */
const parsePayouts = (text: string): { payouts: Payout[]; error?: string } => {
  const payouts: Payout[] = [];
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const [index, line] of lines.entries()) {
    const [address = '', amount = ''] = line.split(/[\s,]+/);
    const parsed = parseRecipient(address);
    if (!parsed.ok || parsed.encryptionKey === undefined) {
      return { payouts, error: `Line ${index + 1}: enter a full shielded address.` };
    }
    if (parsed.network !== NETWORK_ID) {
      return { payouts, error: `Line ${index + 1}: that address is for ${parsed.network}.` };
    }
    if (amount === '') {
      return {
        payouts,
        error: `Line ${index + 1}: add the amount after the address, e.g. "mn_shield-addr_preprod1… 3000".`,
      };
    }
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      return { payouts, error: `Line ${index + 1}: the amount must be a positive whole number.` };
    }
    payouts.push({
      recipient: parsed.coinPublicKey,
      encryptionKey: parsed.encryptionKey,
      amount: BigInt(amount),
    });
  }
  if (payouts.length === 0) return { payouts, error: 'Add at least one payout.' };
  if (payouts.length > 16) return { payouts, error: 'A cycle pays at most 16 people.' };
  return { payouts };
};

type Receipt = {
  readonly cycleId: string;
  readonly recipient: string;
  readonly amount: string;
  readonly nonce: string;
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The whole error, not just its outermost sentence.
 *
 * The SDK wraps failures in its own errors and keeps the reason as a `cause`:
 * "Failed to read verifier key for conserve#openCycle" says nothing about the
 * 404, the timeout or the rejected name underneath it. Walk the chain so the
 * panel shows what actually went wrong.
 */
const describe = (cause: unknown, depth = 0): string => {
  if (depth > 4 || cause === null || cause === undefined) return '';
  const error = cause as { message?: unknown; cause?: unknown; errors?: unknown[] };
  const message = typeof error.message === 'string' ? error.message : String(cause);
  const nested = Array.isArray(error.errors)
    ? error.errors.map((e) => describe(e, depth + 1)).filter(Boolean)
    : [describe(error.cause, depth + 1)].filter(Boolean);
  const unique = nested.filter((text) => !message.includes(text));
  return unique.length === 0 ? message : `${message} — ${unique.join('; ')}`;
};

/**
 * Connects a Midnight wallet and runs a payroll from it: the recipient's view of
 * what they were paid, and the organizer's whole cycle — funding, deployment,
 * opening and settling — with the wallet holding every key.
 */
export function WalletPanel() {
  const [wallets, setWallets] = useState<AvailableWallet[]>([]);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [password, setPassword] = useState('');
  const [balances, setBalances] = useState<{
    demo: bigint;
    dust: bigint;
    night: bigint;
    nightAddress: string;
  } | null>(null);
  const [contract, setContract] = useState<string | null>(null);
  const [tokenContract, setTokenContract] = useState<string | null>(null);
  const [payrollText, setPayrollText] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly string[] | null>(null);
  const [proofServer, setProofServer] = useState(
    () => recall('conserve:proof-server') ?? DEFAULT_PROOF_SERVER,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stepLabel = useRef<string | null>(null);

  // Wallet extensions inject window.midnight shortly after page load.
  useEffect(() => {
    const found = () => setWallets(availableWallets());
    found();
    const timer = window.setTimeout(found, 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  const token = tokenContract === null ? null : demoDollarToken(tokenContract);

  const refreshBalances = useCallback(async () => {
    if (session === null) return;
    const [shielded, dust, unshielded, nightAddress] = await Promise.all([
      session.api.getShieldedBalances(),
      session.api.getDustBalance(),
      session.api.getUnshieldedBalances(),
      session.api.getUnshieldedAddress(),
    ]);
    setBalances({
      demo: token === null ? 0n : (shielded[token] ?? 0n),
      dust: dust.balance,
      night: Object.values(unshielded).reduce((total, value) => total + value, 0n),
      nightAddress: nightAddress.unshieldedAddress,
    });
  }, [session, token]);

  useEffect(() => {
    void refreshBalances().catch(() => undefined);
  }, [refreshBalances]);

  const connect = async (wallet: AvailableWallet) => {
    setError(null);
    setBusy(`Waiting for ${wallet.api.name}…`);
    try {
      const next = await connectWallet(wallet, NETWORK_ID);
      setSession(next);
      setContract(recall(storageKey(next, 'contract')));
      setTokenContract(DEMO_DOLLAR_CONTRACT.preprod ?? recall(storageKey(next, 'token')));
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error('conserve: connect failed', cause);
      setError(describe(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Runs one step against a live wallet channel, surfacing progress and errors.
   *
   * The channel is re-checked before each step rather than trusted. A connector
   * API is a live channel into the extension: it closes when the wallet's popup
   * goes away or its background worker sleeps, which is easy to do in the gaps
   * between these steps.
   */
  const step = async (label: string, work: (live: WalletSession) => Promise<string>) => {
    if (session === null) return;
    setError(null);
    setMessage(null);
    setBusy(label);
    stepLabel.current = label;
    try {
      const live = await ensureConnected(session);
      if (live !== session) setSession(live);
      setMessage(await work(live));
      await refreshBalances().catch(() => undefined);
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error('conserve: step failed', cause);
      setError(
        isChannelClosed(cause)
          ? `${session.wallet.api.name} closed its connection. Approve its prompt, or press Connect again, then retry.`
          : isWalletLocked(cause)
            ? `${session.wallet.api.name} stayed locked. Unlock it, then retry.`
            : describe(cause),
      );
    } finally {
      stepLabel.current = null;
      setBusy(null);
    }
  };

  const passwordIssue = useMemo(() => {
    if (password.length < 16) return 'Use at least 16 characters.';
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password));
    return classes.length < 3
      ? 'Mix at least three of: lower case, upper case, digits, symbols.'
      : null;
  }, [password]);

  /** Swaps the progress line for an unlock request while the wallet is locked. */
  const onLocked = (locked: boolean) =>
    setBusy(
      locked
        ? `${session?.wallet.api.name ?? 'Your wallet'} locked itself while this was proving. Unlock it — the proof is kept and the step carries on.`
        : stepLabel.current,
    );

  const conserveProviders = async (live: WalletSession) =>
    browserProviders(live, 'conserve', password, proofServer.trim(), onLocked);

  /**
   * One scoped provider set for a whole step, with the contract joined.
   *
   * The private-state store is scoped per contract and refuses to read or write
   * until it is told which one. Building providers more than once in a step
   * left the later call writing through an unscoped store, which failed with
   * "Contract address not set" after the work was already done.
   */
  const conserveFor = async (
    live: WalletSession,
  ): Promise<{
    providers: Awaited<ReturnType<typeof conserveProviders>>;
    deployment: ConserveDeployment;
    state: ConservePrivateState;
  }> => {
    if (contract === null) throw new Error('Deploy a payroll contract first.');
    const providers = await conserveProviders(live);
    providers.privateStateProvider.setContractAddress(contract);
    const state = await providers.privateStateProvider.get(CONSERVE_PRIVATE_STATE_ID);
    if (state === null || state === undefined) {
      throw new Error(
        'This browser holds no organizer key for that contract. Open and settle it from the browser that deployed it.',
      );
    }
    return { providers, deployment: await join(providers, contract, state), state };
  };

  const getDollars = () =>
    step('Minting Demo Dollars — approve in your wallet, then it proves…', async (live) => {
      const providers = await browserProviders(live, 'demo-dollar', password, proofServer.trim(), onLocked);
      let address = tokenContract;
      if (address === null) {
        address = await deployDemoDollar(providers);
        remember(storageKey(live, 'token'), address);
        setTokenContract(address);
      }
      const result = await mintDemoDollars(providers, address, MINT_AMOUNT);
      return `Minted ${MINT_AMOUNT.toLocaleString()} Demo Dollars to your wallet (block ${result.blockHeight}).`;
    });

  const deployContract = () =>
    step('Deploying your payroll contract…', async (live) => {
      if (token === null) throw new Error('Get Demo Dollars first.');
      const providers = await conserveProviders(live);
      const deployed = await deploy(providers, emptyPrivateState(randomBytes32()), token);
      const address = contractAddressOf(deployed);
      remember(storageKey(live, 'contract'), address);
      setContract(address);
      return `Payroll contract deployed: ${short(address)}. Its organizer key is encrypted in this browser.`;
    });

  const parsed = useMemo(() => parsePayouts(payrollText), [payrollText]);
  const budget = parsed.payouts.reduce((sum, payout) => sum + payout.amount, 0n);

  const open = () =>
    step('Opening the cycle — committing to the budget…', async (live) => {
      if (parsed.error !== undefined) throw new Error(parsed.error);
      const { providers, deployment, state } = await conserveFor(live);
      const result = await openCycle(providers, deployment, state, budget);
      return `Cycle ${result.cycleId} open. The budget is committed; the amount stays in this browser.`;
    });

  const pay = () =>
    step(
      'Settling — your wallet is proving 16 shielded payouts. This takes a few minutes; leave the wallet open…',
      async (live) => {
        if (parsed.error !== undefined) throw new Error(parsed.error);
        const { providers, deployment, state } = await conserveFor(live);
        const result = await settle(providers, deployment, state, parsed.payouts);
        setReceipts(
          result.receipts.map((receipt) => ({
            cycleId: String(receipt.cycleId),
            recipient: toHex(receipt.recipient),
            amount: String(receipt.amount),
            nonce: toHex(receipt.nonce),
          })),
        );
        return `Paid ${parsed.payouts.length} people ${budget.toLocaleString()} Demo Dollars in one shielded transaction (block ${result.blockHeight}).`;
      },
    );

  if (session === null) {
    return (
      <section className="panel wallet">
        <header>
          <h2>Run payroll from your wallet</h2>
          <p>
            Connect a Midnight wallet to see what you have been paid, or to fund, open and settle a
            payroll yourself. Your wallet holds the keys and approves every transaction.
          </p>
        </header>
        {wallets.some((wallet) => !wallet.supported) && (
          <p className="note">
            {wallets
              .filter((wallet) => !wallet.supported)
              .map((wallet) => `${wallet.api.name} speaks connector ${wallet.api.apiVersion}`)
              .join('; ')}
            , and this dashboard is built for 4.x. Connecting may fail.
          </p>
        )}
        {wallets.length === 0 ? (
          <p className="note">
            No Midnight wallet detected. Install{' '}
            <a href="https://www.lace.io" target="_blank" rel="noreferrer">
              Lace
            </a>{' '}
            with Midnight enabled, switch it to Preprod, and reload this page.
          </p>
        ) : (
          <div className="row">
            {wallets.map((wallet) => (
              <button key={wallet.id} onClick={() => void connect(wallet)} disabled={busy !== null}>
                {wallet.api.icon && <img src={wallet.api.icon} alt="" className="wallet-icon" />}
                Connect {wallet.api.name}
              </button>
            ))}
          </div>
        )}
        {busy !== null && <p className="loading">{busy}</p>}
        {error !== null && <p className="error">{error}</p>}
      </section>
    );
  }

  // Every step pays a fee in DUST, and DUST only accrues against NIGHT that has
  // been registered for it. Without any, each button would fail on submission
  // for a reason the error would not explain.
  const fundable = balances !== null && balances.dust > 0n;
  const ready =
    passwordIssue === null && busy === null && fundable && proofServer.trim().length > 0;

  return (
    <section className="panel wallet">
      <header>
        <h2>{session.wallet.api.name} connected</h2>
        <p>
          <code title={session.shieldedAddress}>{short(session.shieldedAddress, 18)}</code>{' '}
          <button
            className="ghost inline"
            onClick={() => void navigator.clipboard.writeText(session.shieldedAddress)}
          >
            Copy address
          </button>
        </p>
      </header>

      <dl>
        <div className="field">
          <dt>Demo Dollars in this wallet</dt>
          <dd>{balances === null ? '…' : balances.demo.toLocaleString()}</dd>
        </div>
        <div className="field">
          <dt>DUST for fees</dt>
          <dd>{balances === null ? '…' : balances.dust > 0n ? 'available' : 'none'}</dd>
        </div>
      </dl>
      <p className="note">
        Paid by a Conserve payroll? Your payout arrives here as shielded Demo Dollars — visible to
        you, and to nobody else.
      </p>

      {balances !== null && !fundable && (
        <div className="commitment">
          <span>This wallet cannot pay fees yet</span>
          <p className="note">
            Fees are paid in DUST, which accrues against NIGHT you have registered for it. To run a
            payroll from this wallet:
          </p>
          <ol className="steps">
            <li>
              {balances.night > 0n ? (
                'It already holds NIGHT.'
              ) : (
                <>
                  Fund its NIGHT address at{' '}
                  <a
                    href="https://faucet.preprod.midnight.network"
                    target="_blank"
                    rel="noreferrer"
                  >
                    the Preprod faucet
                  </a>
                  : <code title={balances.nightAddress}>{short(balances.nightAddress, 12)}</code>{' '}
                  <button
                    className="ghost inline"
                    onClick={() => void navigator.clipboard.writeText(balances.nightAddress)}
                  >
                    Copy
                  </button>
                </>
              )}
            </li>
            <li>
              Register that NIGHT for DUST generation in the wallet, and wait for DUST to appear.
            </li>
            <li>
              <button
                className="ghost"
                onClick={() => void refreshBalances()}
                disabled={busy !== null}
              >
                Check again
              </button>
            </li>
          </ol>
          <p className="note">Reading the payroll above needs none of this — only paying does.</p>
        </div>
      )}

      <h3>Run a payroll</h3>
      <label className="stack">
        <span>Proof server — one you run; it sees the payroll in the clear</span>
        <input
          value={proofServer}
          onChange={(event) => {
            setProofServer(event.target.value);
            remember('conserve:proof-server', event.target.value);
          }}
          spellCheck={false}
          placeholder={DEFAULT_PROOF_SERVER}
        />
      </label>
      <p className="note">
        Start one with{' '}
        <code>
          docker run -d --rm -p 6300:6300 -v midnight-zk-params:/.cache/midnight/zk-params
          midnightntwrk/proof-server:8.1.0 -- &apos;midnight-proof-server --port 6300&apos;
        </code>
        . On this page, served over HTTPS, a <code>http://localhost</code> prover is blocked as
        mixed content — expose yours over HTTPS (a tunnel will do) and paste that URL, or open this
        dashboard from <code>http://localhost</code> instead.
      </p>

      <label className="stack">
        <span>Passphrase protecting your payroll on this device</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
      </label>
      {password !== '' && passwordIssue !== null && <p className="error">{passwordIssue}</p>}

      <ol className="steps">
        <li>
          <button onClick={() => void getDollars()} disabled={!ready}>
            Get {MINT_AMOUNT.toLocaleString()} Demo Dollars
          </button>
        </li>
        <li>
          {contract === null ? (
            <button onClick={() => void deployContract()} disabled={!ready || token === null}>
              Deploy your payroll contract
            </button>
          ) : (
            <span className="note">
              Your contract: <code>{short(contract)}</code>
            </span>
          )}
        </li>
        <li>
          <label className="stack">
            <span>Payouts — one per line: shielded address, then amount</span>
            <textarea
              value={payrollText}
              onChange={(event) => setPayrollText(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="mn_shield-addr_preprod1… 3000"
            />
          </label>
          {payrollText !== '' && parsed.error !== undefined && (
            <p className="error">{parsed.error}</p>
          )}
          {parsed.error === undefined && (
            <p className="note">
              {parsed.payouts.length} {parsed.payouts.length === 1 ? 'person' : 'people'}, budget{' '}
              {budget.toLocaleString()}. The chain will see 16 payouts and no amounts.
            </p>
          )}
        </li>
        <li>
          <div className="row">
            <button
              onClick={() => void open()}
              disabled={!ready || contract === null || parsed.error !== undefined}
            >
              Open cycle
            </button>
            <button
              onClick={() => void pay()}
              disabled={!ready || contract === null || parsed.error !== undefined}
            >
              Settle and pay
            </button>
          </div>
        </li>
      </ol>

      {busy !== null && <p className="loading">{busy}</p>}
      {message !== null && <p className="verdict ok small">{message}</p>}
      {error !== null && (
        <>
          <p className="error">{error}</p>
          <button
            className="ghost"
            onClick={() =>
              void Promise.all([checkZkAssets('conserve'), checkZkAssets('demo-dollar')]).then(
                ([a, b]) => setDiagnostics([...a, ...b]),
              )
            }
          >
            Check this site&apos;s proving keys
          </button>
        </>
      )}
      {diagnostics !== null && (
        <div className="commitment">
          <span>Proving key check</span>
          {diagnostics.map((line) => (
            <code key={line} className="receipt-line">
              {line}
            </code>
          ))}
        </div>
      )}

      {receipts.length > 0 && (
        <div className="commitment">
          <span>Receipts — send each recipient only their own</span>
          {receipts.map((receipt) => (
            <code key={receipt.nonce} className="receipt-line">
              {JSON.stringify(receipt)}
            </code>
          ))}
        </div>
      )}
    </section>
  );
}
