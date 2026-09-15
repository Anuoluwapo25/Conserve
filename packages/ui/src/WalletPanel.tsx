import { useCallback, useEffect, useMemo, useState } from 'react';
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
  connectWallet,
} from './wallet.js';

const NETWORK_ID = 'preprod';
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
 * Connects a Midnight wallet and runs a payroll from it: the recipient's view of
 * what they were paid, and the organizer's whole cycle — funding, deployment,
 * opening and settling — with the wallet holding every key.
 */
export function WalletPanel() {
  const [wallets, setWallets] = useState<AvailableWallet[]>([]);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [password, setPassword] = useState('');
  const [balances, setBalances] = useState<{ demo: bigint; dust: bigint } | null>(null);
  const [contract, setContract] = useState<string | null>(null);
  const [tokenContract, setTokenContract] = useState<string | null>(null);
  const [payrollText, setPayrollText] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const [shielded, dust] = await Promise.all([
      session.api.getShieldedBalances(),
      session.api.getDustBalance(),
    ]);
    setBalances({ demo: token === null ? 0n : (shielded[token] ?? 0n), dust: dust.balance });
  }, [session, token]);

  useEffect(() => {
    void refreshBalances().catch(() => undefined);
  }, [refreshBalances]);

  const connect = async (wallet: AvailableWallet) => {
    setError(null);
    setBusy(`Waiting for ${wallet.name}…`);
    try {
      const next = await connectWallet(wallet, NETWORK_ID);
      setSession(next);
      setContract(recall(storageKey(next, 'contract')));
      setTokenContract(DEMO_DOLLAR_CONTRACT.preprod ?? recall(storageKey(next, 'token')));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** Runs one step, surfacing progress and errors in the panel. */
  const step = async (label: string, work: () => Promise<string>) => {
    setError(null);
    setMessage(null);
    setBusy(label);
    try {
      setMessage(await work());
      await refreshBalances().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
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

  const conserveProviders = async () => {
    if (session === null) throw new Error('Connect a wallet first.');
    return browserProviders(session, 'conserve', password);
  };

  const privateStateFor = async (address: string): Promise<ConservePrivateState> => {
    const providers = await conserveProviders();
    providers.privateStateProvider.setContractAddress(address);
    const stored = await providers.privateStateProvider.get(CONSERVE_PRIVATE_STATE_ID);
    if (stored === null || stored === undefined) {
      throw new Error(
        'This browser holds no organizer key for that contract. Open and settle it from the browser that deployed it.',
      );
    }
    return stored;
  };

  const getDollars = () =>
    step('Minting Demo Dollars — approve in your wallet, then it proves…', async () => {
      if (session === null) throw new Error('Connect a wallet first.');
      const providers = await browserProviders(session, 'demo-dollar', password);
      let address = tokenContract;
      if (address === null) {
        address = await deployDemoDollar(providers);
        remember(storageKey(session, 'token'), address);
        setTokenContract(address);
      }
      const result = await mintDemoDollars(providers, address, MINT_AMOUNT);
      return `Minted ${MINT_AMOUNT.toLocaleString()} Demo Dollars to your wallet (block ${result.blockHeight}).`;
    });

  const deployContract = () =>
    step('Deploying your payroll contract…', async () => {
      if (session === null || token === null) throw new Error('Get Demo Dollars first.');
      const providers = await conserveProviders();
      const deployed = await deploy(providers, emptyPrivateState(randomBytes32()), token);
      const address = contractAddressOf(deployed);
      remember(storageKey(session, 'contract'), address);
      setContract(address);
      return `Payroll contract deployed: ${short(address)}. Its organizer key is encrypted in this browser.`;
    });

  const parsed = useMemo(() => parsePayouts(payrollText), [payrollText]);
  const budget = parsed.payouts.reduce((sum, payout) => sum + payout.amount, 0n);

  const joined = async (): Promise<{
    deployment: ConserveDeployment;
    state: ConservePrivateState;
  }> => {
    if (contract === null) throw new Error('Deploy a payroll contract first.');
    const providers = await conserveProviders();
    const state = await privateStateFor(contract);
    return { deployment: await join(providers, contract, state), state };
  };

  const open = () =>
    step('Opening the cycle — committing to the budget…', async () => {
      if (parsed.error !== undefined) throw new Error(parsed.error);
      const { deployment, state } = await joined();
      const result = await openCycle(await conserveProviders(), deployment, state, budget);
      return `Cycle ${result.cycleId} open. The budget is committed; the amount stays in this browser.`;
    });

  const pay = () =>
    step(
      'Settling — your wallet is proving 16 shielded payouts. This takes a few minutes…',
      async () => {
        if (parsed.error !== undefined) throw new Error(parsed.error);
        const { deployment, state } = await joined();
        const result = await settle(await conserveProviders(), deployment, state, parsed.payouts);
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
                {wallet.icon && <img src={wallet.icon} alt="" className="wallet-icon" />}
                Connect {wallet.name}
              </button>
            ))}
          </div>
        )}
        {busy !== null && <p className="loading">{busy}</p>}
        {error !== null && <p className="error">{error}</p>}
      </section>
    );
  }

  const ready = passwordIssue === null && busy === null;

  return (
    <section className="panel wallet">
      <header>
        <h2>{session.wallet.name} connected</h2>
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

      <h3>Run a payroll</h3>
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
      {error !== null && <p className="error">{error}</p>}

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
