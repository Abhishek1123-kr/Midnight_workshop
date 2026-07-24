// =============================================================================
// CLI DEPLOYMENT SCRIPT
// =============================================================================
// This script allows deploying the Journal contract to the Preprod network
// via CLI using a seed phrase (e.g. from the MIDNIGHT_SEED environment variable).
// =============================================================================

import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

import { PreprodRemoteConfig } from '../demo/bboard-cli/src/config.js';
import { MidnightWalletProvider } from '../demo/bboard-cli/src/midnight-wallet-provider.js';
import { syncWallet, waitForUnshieldedFunds } from '../demo/bboard-cli/src/wallet-utils.js';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  CompiledJournalContractContract,
  JOURNAL_PRIVATE_STATE_KEY,
  createJournalPrivateState
} from '../src/integration/journal-client.js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as pino from 'pino';
import * as path from 'path';
import crypto from 'crypto';

const logger = pino.pino({ level: 'debug' });

const run = async () => {
  logger.info("Initializing deploy to Preprod...");

  // 1. Setup preprod config
  const config = new PreprodRemoteConfig();
  const zkConfigPath = path.resolve('managed', 'journal');
  
  const env = config.getEnvironment(logger);
  const envConfig = {
    walletNetworkId: 'preprod',
    networkId: 'preprod' as any,
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    nodeWS: 'wss://rpc.preprod.midnight.network',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    proofServer: 'http://127.0.0.1:6300',
  };
  
  // 2. Load or generate seed
  let seed = process.env.MIDNIGHT_SEED;
  if (!seed) {
    logger.warn("MIDNIGHT_SEED environment variable not found. Generating a temporary seed...");
    seed = crypto.randomBytes(32).toString('hex');
    logger.info(`Generated temporary seed: ${seed}`);
  }

  // 3. Initialize wallet provider
  logger.info("Building wallet provider...");
  const walletProvider = await MidnightWalletProvider.build(logger, envConfig, seed);
  await walletProvider.start();
  
  const address = walletProvider.getCoinPublicKey();
  logger.info(`Wallet shielded public key: ${address}`);
  
  // Wait for sync
  await syncWallet(logger, walletProvider.wallet);
  
  // Check if we need to fund
  logger.info("Checking for funds. Please ensure the wallet is funded via the Preprod faucet if it is not.");
  await waitForUnshieldedFunds(logger, walletProvider.wallet, envConfig, unshieldedToken(), true);

  // 4. Initialize contract providers
  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: 'journal-private-state-cli'
  });
  
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const proofProvider = httpClientProofProvider(envConfig.proofServer, zkConfigProvider);
  const publicDataProvider = indexerPublicDataProvider(envConfig.indexer, envConfig.indexerWS);

  const providers = {
    privateStateProvider,
    zkConfigProvider,
    proofProvider,
    publicDataProvider,
    walletProvider
  };

  // 5. Deploy contract
  logger.info("Deploying Journal contract to Preprod...");
  const randomKey = new Uint8Array(crypto.randomBytes(32));

  const deployedContract = await deployContract(providers, {
    compiledContract: CompiledJournalContractContract,
    privateStateId: JOURNAL_PRIVATE_STATE_KEY,
    initialPrivateState: createJournalPrivateState(randomKey),
  });

  const contractAddress = deployedContract.deployTxData.public.contractAddress;
  logger.info(`\n==================================================`);
  logger.info(`JOURNAL CONTRACT DEPLOYED SUCCESSFULLY!`);
  logger.info(`Contract Address: ${contractAddress}`);
  logger.info(`==================================================\n`);

  await walletProvider.stop();
  process.exit(0);
};

run().catch((err) => {
  logger.error(err, "Deploy failed");
  process.exit(1);
});
