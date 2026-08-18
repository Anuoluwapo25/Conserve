#!/usr/bin/env node
/**
 * Conserve operator CLI.
 *
 * Commands that touch the chain need a funded wallet seed and a proof server;
 * `status` needs neither wallet nor proof server, and `simulate` needs no
 * network at all. See `docs/usage.md`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
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
  verifyReceipt,
} from '@conserve/api';
import { emptyPrivateState, prepareCycle, pureCircuits } from '@conserve/contract';
import { ConserveSimulator } from '@conserve/contract/simulator';
import { CONSERVE_PRIVATE_STATE_ID } from '@conserve/api';
import { readPayroll } from './roster.js';
import { deriveAddresses, deriveKeys, seedFromHex } from './keys.js';
import { formatUnits, openWallet, summariseWallet, walletProviders } from './wallet.js';

const USAGE = `conserve — privacy-preserving payroll on Midnight

Usage:
  conserve address                          Show the operator addresses and balances
  conserve deploy                           Deploy a payroll contract
  conserve open --contract <addr> --payroll <file>
                                            Publish the budget commitment for a new cycle
  conserve settle --contract <addr> --payroll <file> [--receipts <dir>]
                                            Prove and submit the split
  conserve status --contract <addr>         Show the public state anyone can see
  conserve verify --contract <addr> --receipt <file>
                                            Check a receipt against the on-chain tree
  conserve simulate --payroll <file>        Run the circuits locally, no network

Options:
  --network <preprod|undeployed>            Default: preprod
  --json                                    Machine-readable output
  --offline                                 (address) derive addresses without syncing

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

/** Filenames only; labels are local and must not end up anywhere else. */
const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'recipient';

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
  const keys = deriveKeys(seedFromHex(env('CONSERVE_SEED')));
  process.stderr.write('syncing wallet…');
  const wallet = await openWallet(config, keys);
  await wallet.facade.waitForSyncedState();
  process.stderr.write(' done\n');

  const providers = buildProviders({
    config,
    wallet: walletProviders(wallet),
    accountId: process.env.CONSERVE_ACCOUNT ?? 'default',
    password: () => env('CONSERVE_PASSWORD'),
  });
  return { config, keys, wallet, providers };
};

const loadPrivateState = async (
  providers: Awaited<ReturnType<typeof connect>>['providers'],
  fallbackKey: Uint8Array,
) => {
  const stored = await providers.privateStateProvider.get(CONSERVE_PRIVATE_STATE_ID);
  return stored ?? emptyPrivateState(fallbackKey);
};

/**
 * The indexer alone, for the commands that only read. Deliberately needs no
 * seed, no wallet and no proof server: auditing a Conserve contract must not
 * require credentials of any kind.
 */
const readOnlyProviders = async (flags: Args['flags']) => {
  const config = networkConfig(profileOf(flags));
  const { indexerPublicDataProvider } =
    await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(config.networkId);
  return {
    publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
  } as Parameters<typeof publicState>[0];
};

const commands: Record<string, (flags: Args['flags']) => Promise<void>> = {
  async address(flags) {
    // Addresses derive locally, so this works before the wallet has ever seen
    // the chain — which is the point: you need one to visit the faucet.
    const config = networkConfig(profileOf(flags));
    const keys = deriveKeys(seedFromHex(env('CONSERVE_SEED')));
    const addresses = deriveAddresses(keys, config.networkId);

    if (flags.offline) {
      emit(
        flags,
        `network:   ${config.networkId}\nnight:     ${addresses.night}\n` +
          `shielded:  ${addresses.shielded}\ndust:      ${addresses.dust}`,
        { network: config.networkId, ...addresses },
      );
      return;
    }

    const wallet = await openWallet(config, keys);
    const balances = await summariseWallet(wallet);
    emit(
      flags,
      `network:   ${config.networkId}\nnight:     ${addresses.night}\n` +
        `shielded:  ${addresses.shielded}\ndust:      ${addresses.dust}\n` +
        `\nNIGHT:     ${formatUnits(balances.night)}\nDUST:      ${formatUnits(balances.dust)}` +
        (balances.night === 0n
          ? '\n\nFund the NIGHT address above at https://faucet.preprod.midnight.network,' +
            '\nthen register it for DUST generation so fees can be paid.'
          : ''),
      { network: config.networkId, ...addresses, ...balances },
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
    const receiptDir = typeof flags.receipts === 'string' ? flags.receipts : undefined;
    if (receiptDir !== undefined) {
      await mkdir(receiptDir, { recursive: true });
      await Promise.all(
        result.receipts.map((receipt, index) =>
          writeFile(
            joinPath(receiptDir, `cycle-${receipt.cycleId}-${slug(receipts[index]!.label)}.json`),
            `${JSON.stringify(
              {
                cycleId: String(receipt.cycleId),
                recipient: bytesToHex(receipt.recipient),
                amount: String(receipt.amount),
                nonce: bytesToHex(receipt.nonce),
              },
              null,
              2,
            )}\n`,
            { mode: 0o600 },
          ),
        ),
      );
    }

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

  async verify(flags) {
    const raw: unknown = JSON.parse(await readFile(required(flags, 'receipt'), 'utf8'));
    const receipt = raw as Record<string, unknown>;
    const providers = await readOnlyProviders(flags);
    const state = await publicState(providers, required(flags, 'contract'));

    const verdict = verifyReceipt(state, {
      cycleId: BigInt(String(receipt.cycleId)),
      recipient: hexToBytes(String(receipt.recipient)),
      amount: BigInt(String(receipt.amount)),
      nonce: hexToBytes(String(receipt.nonce)),
    });

    emit(
      flags,
      verdict.anchored
        ? `receipt is anchored on chain\n` +
            `commitment: ${verdict.commitment}\n` +
            `proof path: ${verdict.pathLength} levels\n\n` +
            'The organizer included exactly this amount in a settlement the network\n' +
            'accepted. Verifying it revealed the amount to nobody but you.'
        : `receipt is NOT anchored on chain\ncommitment: ${verdict.commitment}\n${verdict.reason}`,
      verdict,
    );
    process.exit(verdict.anchored ? 0 : 1);
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
