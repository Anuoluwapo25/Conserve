#!/usr/bin/env node
/**
 * Conserve operator CLI.
 *
 * Commands that touch the chain need a funded wallet seed and a proof server;
 * `status` needs neither wallet nor proof server, and `simulate` needs no
 * network at all. See `docs/usage.md`.
 */

import { randomBytes } from 'node:crypto';
import {
  type ConserveDeployment,
  type NetworkProfile,
  buildProviders,
  contractAddressOf,
  deploy,
  isNetworkProfile,
  join,
  networkConfig,
  openCycle,
  publicState,
  settle,
  summarise,
} from '@conserve/api';
import { emptyPrivateState, prepareCycle, pureCircuits } from '@conserve/contract';
import { ConserveSimulator } from '@conserve/contract/simulator';
import { CONSERVE_PRIVATE_STATE_ID } from '@conserve/api';
import { readPayroll } from './roster.js';
import { buildWallet, formatDust, waitForSync, walletProviders } from './wallet.js';

const USAGE = `conserve — privacy-preserving payroll on Midnight

Usage:
  conserve address                          Show the operator wallet address and balance
  conserve deploy                           Deploy a payroll contract
  conserve open --contract <addr> --payroll <file>
                                            Publish the budget commitment for a new cycle
  conserve settle --contract <addr> --payroll <file>
                                            Prove and submit the split
  conserve status --contract <addr>         Show the public state anyone can see
  conserve simulate --payroll <file>        Run the circuits locally, no network

Options:
  --network <preprod|undeployed>            Default: preprod
  --json                                    Machine-readable output

Environment:
  CONSERVE_SEED       Hex wallet seed (required for address/deploy/open/settle)
  CONSERVE_PASSWORD   Password encrypting the local private-state store
  CONSERVE_ACCOUNT    Account label scoping that store (default: "default")
  CONSERVE_ORGANIZER_KEY
                      Hex organizer secret key; generated and printed if unset
`;

type Args = {
  readonly command: string;
  readonly flags: Record<string, string | true>;
};

const parseArgs = (argv: readonly string[]): Args => {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
};

const required = (flags: Args['flags'], name: string): string => {
  const value = flags[name];
  if (typeof value !== 'string') {
    throw new Error(`missing required option --${name}`);
  }
  return value;
};

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`environment variable ${name} is not set`);
  }
  return value;
};

const hexToBytes = (value: string): Uint8Array => {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('expected a 32-byte hex string');
  }
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const organizerKey = (): Uint8Array => {
  const configured = process.env.CONSERVE_ORGANIZER_KEY;
  if (configured) return hexToBytes(configured);
  const generated = new Uint8Array(randomBytes(32));
  console.error(
    'No CONSERVE_ORGANIZER_KEY set; generated a fresh organizer key.\n' +
      'Save it — without it you cannot open or settle another cycle on this contract:\n' +
      `  export CONSERVE_ORGANIZER_KEY=${bytesToHex(generated)}\n`,
  );
  return generated;
};

const profileOf = (flags: Args['flags']): NetworkProfile => {
  const value = flags.network;
  if (value === undefined || value === true) return 'preprod';
  if (!isNetworkProfile(value)) {
    throw new Error(`unknown network "${value}" (expected preprod or undeployed)`);
  }
  return value;
};

const emit = (flags: Args['flags'], human: string, data: Record<string, unknown>): void => {
  if (flags.json) {
    console.log(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    console.log(human);
  }
};

/** Brings up wallet + providers for the commands that write to the chain. */
const connect = async (flags: Args['flags']) => {
  const config = networkConfig(profileOf(flags));
  const wallet = await buildWallet(config, env('CONSERVE_SEED'));
  process.stderr.write('syncing wallet…');
  const state = await waitForSync(wallet);
  process.stderr.write(' done\n');

  const providers = buildProviders({
    config,
    wallet: walletProviders(wallet, state.coinPublicKey, state.encryptionPublicKey),
    accountId: process.env.CONSERVE_ACCOUNT ?? 'default',
    password: () => env('CONSERVE_PASSWORD'),
  });
  return { config, wallet, state, providers };
};

const loadPrivateState = async (
  providers: Awaited<ReturnType<typeof connect>>['providers'],
  fallbackKey: Uint8Array,
) => {
  const stored = await providers.privateStateProvider.get(CONSERVE_PRIVATE_STATE_ID);
  return stored ?? emptyPrivateState(fallbackKey);
};

const commands: Record<string, (flags: Args['flags']) => Promise<void>> = {
  async address(flags) {
    const { wallet, state, config } = await connect(flags);
    const balance = state.balances[Object.keys(state.balances)[0] ?? ''] ?? 0n;
    emit(
      flags,
      `network:  ${config.networkId}\naddress:  ${state.address}\nbalance:  ${formatDust(balance)} tDUST`,
      { network: config.networkId, address: state.address, balance },
    );
    await wallet.close();
  },

  async deploy(flags) {
    const { wallet, providers, config } = await connect(flags);
    const secretKey = organizerKey();
    const deployed = await deploy(providers, emptyPrivateState(secretKey));
    const address = contractAddressOf(deployed);
    emit(
      flags,
      `deployed to ${config.networkId}\ncontract: ${address}\norganizer: ${bytesToHex(
        pureCircuits.organizerPublicKey(secretKey),
      )}`,
      {
        network: config.networkId,
        contractAddress: address,
        organizerPublicKey: bytesToHex(pureCircuits.organizerPublicKey(secretKey)),
      },
    );
    await wallet.close();
  },

  async open(flags) {
    const payroll = await readPayroll(required(flags, 'payroll'));
    const { wallet, providers } = await connect(flags);
    const contractAddress = required(flags, 'contract');
    const privateState = await loadPrivateState(providers, organizerKey());
    const deployment: ConserveDeployment = await join(providers, contractAddress, privateState);

    const result = await openCycle(providers, deployment, privateState, payroll.budget);
    emit(
      flags,
      `cycle ${result.cycleId} open\n` +
        `budget committed (the amount itself stays local)\n` +
        `tx: ${result.txId} @ block ${result.blockHeight}`,
      { cycleId: result.cycleId, txId: result.txId, blockHeight: result.blockHeight },
    );
    await wallet.close();
  },

  async settle(flags) {
    const payroll = await readPayroll(required(flags, 'payroll'));
    const { wallet, providers } = await connect(flags);
    const contractAddress = required(flags, 'contract');
    const privateState = await loadPrivateState(providers, organizerKey());
    const deployment: ConserveDeployment = await join(providers, contractAddress, privateState);

    const result = await settle(providers, deployment, privateState, payroll.payouts);
    const receipts = result.receipts.map((receipt, index) => ({
      label: payroll.payouts[index]?.label ?? `recipient ${index + 1}`,
      recipient: bytesToHex(receipt.recipient),
      amount: receipt.amount,
      nonce: bytesToHex(receipt.nonce),
      commitment: bytesToHex(receipt.commitment),
    }));
    emit(
      flags,
      `settled\ntx: ${result.txId} @ block ${result.blockHeight}\n` +
        `${receipts.length} receipts anchored — hand each recipient their own line:\n` +
        receipts.map((r) => `  ${r.label}: commitment ${r.commitment} nonce ${r.nonce}`).join('\n'),
      { txId: result.txId, blockHeight: result.blockHeight, receipts },
    );
    await wallet.close();
  },

  async status(flags) {
    const config = networkConfig(profileOf(flags));
    const { indexerPublicDataProvider } =
      await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(config.networkId);
    const providers = {
      publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
    } as Parameters<typeof publicState>[0];

    const view = summarise(await publicState(providers, required(flags, 'contract')));
    emit(
      flags,
      `cycle:              ${view.cycleId}\n` +
        `status:             ${view.status}\n` +
        `budget commitment:  ${view.budgetCommitment}\n` +
        `cycles settled:     ${view.settledCycles}\n` +
        `roster slots:       ${view.rosterWidth} (constant, whatever the headcount)\n` +
        `nullifiers:         ${view.nullifierCount}\n` +
        `receipts anchored:  ${view.receiptsAnchored}`,
      view,
    );
    process.exit(0);
  },

  async simulate(flags) {
    const payroll = await readPayroll(required(flags, 'payroll'));
    const secretKey = organizerKey();
    const state = prepareCycle(secretKey, payroll.payouts, payroll.budget);
    const sim = new ConserveSimulator(state);
    sim.setPrivateState(state);
    const cycleId = sim.openCycle(
      pureCircuits.budgetCommitmentOf(state.budgetTotal, state.budgetSalt),
    );
    sim.settle();
    const view = summarise(sim.ledger);
    emit(
      flags,
      `simulated cycle ${cycleId} with ${payroll.payouts.length} recipients — circuits accepted the split\n` +
        `public state a block explorer would show:\n` +
        `  status:            ${view.status}\n` +
        `  budget commitment: ${view.budgetCommitment}\n` +
        `  roster slots:      ${view.rosterWidth}\n` +
        `  receipts anchored: ${view.receiptsAnchored}\n` +
        `no amount and no recipient appears anywhere above.`,
      { cycleId, recipients: payroll.payouts.length, publicState: view },
    );
  },

  async help() {
    console.log(USAGE);
  },
};

const main = async (): Promise<void> => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const handler = commands[command];
  if (!handler) {
    console.error(`unknown command "${command}"\n`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  await handler(flags);
};

main().catch((error: unknown) => {
  console.error(`conserve: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
