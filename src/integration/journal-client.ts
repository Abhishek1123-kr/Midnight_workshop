// =============================================================================
// MIDNIGHT JOURNAL CLIENT INTEGRATION
// =============================================================================
// This file connects the React frontend to the deployed Journal contract on Preprod.
// It manages the providers, private state, wallet connection, and contract interactions.
// =============================================================================

import {
  type ContractAddress,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import {
  Binding,
  FinalizedTransaction,
  Proof,
  SignatureEnabled,
  Transaction,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import { type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { combineLatest, map, tap, from, Observable } from 'rxjs';
import { type Logger } from 'pino';

// Import compiled contract interfaces
import * as CompiledJournalContract from '../../managed/journal/contract/index.js';
import { Ledger } from '../../managed/journal/contract/index.js';

// =============================================================================
// CONFIGURATION AND PLACEHOLDERS
// =============================================================================
// Step 7/8: This placeholder will be updated with the Preprod contract address after deployment.
export const CONTRACT_ADDRESS: string = "TBD";

// Storage key for the private state
export const JOURNAL_PRIVATE_STATE_KEY = "journal_private_state";

// =============================================================================
// PRIVATE STATE & WITNESSES
// =============================================================================
export type JournalPrivateState = {
  readonly secretKey: Uint8Array;
  readonly entryHashToCommit: Uint8Array;
};

export const createJournalPrivateState = (secretKey: Uint8Array): JournalPrivateState => ({
  secretKey,
  entryHashToCommit: new Uint8Array(32),
});

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, JournalPrivateState>): [JournalPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
  getPrivateEntryHash: ({
    privateState,
  }: WitnessContext<Ledger, JournalPrivateState>): [JournalPrivateState, Uint8Array] => [
    privateState,
    privateState.entryHashToCommit,
  ],
};

// =============================================================================
// COMPILED CONTRACT LOADING
// =============================================================================
export const CompiledJournalContractContract = CompiledContract.make<
  CompiledJournalContract.Contract<JournalPrivateState>
>("Journal", CompiledJournalContract.Contract<JournalPrivateState>).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets("./managed/journal"),
);

// Types representing the providers needed by Midnight.js
export type JournalProviders = {
  readonly privateStateProvider: any;
  readonly zkConfigProvider: any;
  readonly proofProvider: any;
  readonly publicDataProvider: any;
  readonly walletProvider: any;
  readonly midnightProvider: any;
};

export interface JournalDerivedState {
  readonly owner: string;
  readonly entryCount: bigint;
  readonly lastEntryHash: string;
  readonly isOwner: boolean;
}

// Utility to hash journal entry text privately
export const hashJournalEntry = async (text: string): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
};

// =============================================================================
// JOURNAL API CLIENT
// =============================================================================
export class JournalAPI {
  private constructor(
    public readonly deployedContract: any,
    private readonly providers: JournalProviders,
    private readonly logger?: Logger,
  ) {
    this.deployedContractAddress = deployedContract.deployTxData.public.contractAddress;
    providers.privateStateProvider.setContractAddress(this.deployedContractAddress);
    
    // Set up state streams
    this.state$ = combineLatest(
      providers.publicDataProvider.contractStateObservable(this.deployedContractAddress, { type: 'latest' }).pipe(
        map((contractState: any) => CompiledJournalContract.ledger(contractState.data)),
      ),
      from(providers.privateStateProvider.get(JOURNAL_PRIVATE_STATE_KEY) as Promise<JournalPrivateState | null>),
    ).pipe(
      map(([ledgerState, privateState]: readonly [any, any]) => {
        if (!privateState) {
          return {
            owner: toHex(ledgerState.owner),
            entryCount: ledgerState.entryCount,
            lastEntryHash: toHex(ledgerState.lastEntryHash),
            isOwner: false,
          };
        }

        // Calculate derived owner public key off-chain to check ownership
        const ownerPubKey = CompiledJournalContract.pureCircuits.publicKey(
          privateState.secretKey,
        );

        return {
          owner: toHex(ledgerState.owner),
          entryCount: ledgerState.entryCount,
          lastEntryHash: toHex(ledgerState.lastEntryHash),
          isOwner: toHex(ledgerState.owner) === toHex(ownerPubKey),
        };
      })
    );
  }

  readonly deployedContractAddress: ContractAddress;
  readonly state$: Observable<JournalDerivedState>;

  // Initialize Owner
  async initializeOwner(): Promise<void> {
    this.logger?.info("Initializing Journal Owner...");
    await this.deployedContract.callTx.initialize();
  }

  // Add Private Journal Entry
  async addEntry(entryText: string): Promise<string> {
    this.logger?.info("Adding private entry to Journal...");
    
    // 1. Hash the entry text off-chain privately
    const hash = await hashJournalEntry(entryText);
    const hashHex = toHex(hash);

    // 2. Retrieve existing private state and update the entry hash to commit
    const privateState = await this.providers.privateStateProvider.get(JOURNAL_PRIVATE_STATE_KEY) as JournalPrivateState;
    const updatedPrivateState = {
      ...privateState,
      entryHashToCommit: hash,
    };
    await this.providers.privateStateProvider.set(JOURNAL_PRIVATE_STATE_KEY, updatedPrivateState);

    // 3. Invoke contract circuit which reads `entryHashToCommit` witness and updates the ledger
    const tx = await this.deployedContract.callTx.addEntry();
    this.logger?.info(`Entry committed successfully. Tx: ${tx.public.txHash}`);
    
    return hashHex;
  }

  // Deploy Contract
  static async deploy(providers: JournalProviders, logger?: Logger): Promise<JournalAPI> {
    logger?.info("Deploying new Journal contract...");
    
    // Generate random 32-byte secret key for the new journal
    const randomKey = new Uint8Array(32);
    window.crypto.getRandomValues(randomKey);

    const deployedContract = await deployContract(providers as any, {
      compiledContract: CompiledJournalContractContract,
      privateStateId: JOURNAL_PRIVATE_STATE_KEY,
      initialPrivateState: createJournalPrivateState(randomKey),
    });

    return new JournalAPI(deployedContract, providers, logger);
  }

  // Join existing Contract
  static async join(providers: JournalProviders, contractAddress: ContractAddress, logger?: Logger): Promise<JournalAPI> {
    logger?.info(`Joining existing Journal contract at ${contractAddress}`);

    const existingPrivateState = await providers.privateStateProvider.get(JOURNAL_PRIVATE_STATE_KEY);
    const privateState = existingPrivateState || createJournalPrivateState(new Uint8Array(32));

    const deployedContract = await findDeployedContract(providers as any, {
      contractAddress,
      compiledContract: CompiledJournalContractContract,
      privateStateId: JOURNAL_PRIVATE_STATE_KEY,
      initialPrivateState: privateState,
    });

    return new JournalAPI(deployedContract, providers, logger);
  }
}

// =============================================================================
// WALLET CONNECTION HELPERS (Supports 1AM and Lace)
// =============================================================================
export const connectToWallet = async (logger: Logger, networkId: NetworkId): Promise<any> => {
  const midnight = (window as any).midnight;
  if (!midnight) {
    throw new Error('No Midnight-compatible wallet extension detected.');
  }

  // Find 1AM wallet first (keys like '1AM' or 'oneAM'), then 'mnLace', or fallback to the first available wallet key
  const walletKey = Object.keys(midnight).find(
    (key) => key.toUpperCase() === '1AM' || key.toLowerCase() === 'oneam'
  ) || 'mnLace';

  const api = midnight[walletKey] || Object.values(midnight)[0];
  
  if (!api) {
    throw new Error('No Midnight wallet is installed.');
  }

  const walletName = api.name || (walletKey.toUpperCase() === '1AM' ? '1AM' : 'Lace');
  logger.info(`Detected wallet: ${walletName}`);

  logger.info(`Requesting connection to ${walletName} Wallet...`);
  const connected = await api.connect(networkId);
  connected.walletName = walletName;
  return connected;
};

