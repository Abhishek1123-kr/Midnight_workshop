import React, { useState, useEffect } from 'react';
import {
  JournalAPI,
  JOURNAL_PRIVATE_STATE_KEY,
  JournalDerivedState,
  JournalProviders,
  JournalPrivateState,
  createJournalPrivateState,
  connectToWallet,
  hashJournalEntry,
  CONTRACT_ADDRESS
} from './integration/journal-client.js';
import { inMemoryPrivateStateProvider } from './integration/in-memory-private-state-provider.js';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
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
import * as pino from 'pino';

const logger = pino.pino({ level: 'info' });

interface LocalEntry {
  text: string;
  hash: string;
  timestamp: string;
}

const App: React.FC = () => {
  // Connection states
  const [walletConnected, setWalletConnected] = useState<boolean>(false);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [providers, setProviders] = useState<JournalProviders | null>(null);
  const [connectedWalletName, setConnectedWalletName] = useState<string>('Wallet');

  // Contract states
  const [contractAddress, setContractAddress] = useState<string>(CONTRACT_ADDRESS !== 'TBD' ? CONTRACT_ADDRESS : '');
  const [journalApi, setJournalApi] = useState<JournalAPI | null>(null);
  const [derivedState, setDerivedState] = useState<JournalDerivedState | null>(null);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [isInitializingOwner, setIsInitializingOwner] = useState<boolean>(false);

  // Journal Entry Form & History states
  const [newEntryText, setNewEntryText] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState<boolean>(false);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [joinAddressInput, setJoinAddressInput] = useState<string>('');

  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' | null }>({
    message: '',
    type: null,
  });

  // Load local entries from storage when contract address changes
  useEffect(() => {
    if (contractAddress && contractAddress !== 'TBD') {
      const saved = localStorage.getItem(`journal_entries_${contractAddress}`);
      if (saved) {
        setLocalEntries(JSON.parse(saved));
      } else {
        setLocalEntries([]);
      }
    }
  }, [contractAddress]);

  // Subscribe to contract state updates
  useEffect(() => {
    if (!journalApi) return;

    const sub = journalApi.state$.subscribe({
      next: (state: JournalDerivedState) => {
        setDerivedState(state);
      },
      error: (err: any) => {
        logger.error(err, 'Error in contract state subscription');
        showNotification('Failed to fetch contract ledger updates', 'error');
      },
    });

    return () => sub.unsubscribe();
  }, [journalApi]);

  const showNotification = (message: string, type: 'success' | 'error' | 'info') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification({ message: '', type: null });
    }, 6000);
  };

  // 1. Connect to Wallet and Setup Providers
  const handleConnectWallet = async () => {
    setIsConnecting(true);
    try {
      const networkId = (import.meta.env.VITE_NETWORK_ID || 'preprod') as NetworkId;
      const connectedAPI = await connectToWallet(logger, networkId);
      const coinPublicKey = await connectedAPI.getShieldedAddresses();
      setWalletAddress(coinPublicKey.shieldedCoinPublicKey);

      const zkConfigPath = window.location.origin;
      const keyMaterialProvider = new FetchZkConfigProvider<any>(zkConfigPath, fetch.bind(window));
      const config = await connectedAPI.getConfiguration();
      const inMemoryJournalPrivateStateProvider = inMemoryPrivateStateProvider<string, JournalPrivateState>();
      const shieldedAddresses = await connectedAPI.getShieldedAddresses();

      const createdProviders: JournalProviders = {
        privateStateProvider: inMemoryJournalPrivateStateProvider,
        zkConfigProvider: keyMaterialProvider,
        proofProvider: httpClientProofProvider(config.proverServerUri!, keyMaterialProvider),
        publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
        walletProvider: {
          getCoinPublicKey(): string {
            return shieldedAddresses.shieldedCoinPublicKey;
          },
          getEncryptionPublicKey(): string {
            return shieldedAddresses.shieldedEncryptionPublicKey;
          },
          balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
            const serializedTx = toHex(tx.serialize());
            const received = await connectedAPI.balanceUnsealedTransaction(serializedTx);
            return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
              'signature',
              'proof',
              'binding',
              fromHex(received.tx),
            );
          },
        },
        midnightProvider: {
          submitTx: async (tx: FinalizedTransaction): Promise<any> => {
            await connectedAPI.submitTransaction(toHex(tx.serialize()));
            const txIdentifiers = tx.identifiers();
            return txIdentifiers[0];
          },
        },
      };

      const walletName = connectedAPI.walletName || 'Wallet';
      setConnectedWalletName(walletName);
      setProviders(createdProviders);
      setWalletConnected(true);
      showNotification(`Successfully connected to Midnight ${walletName} Wallet!`, 'success');
    } catch (error: any) {
      logger.error(error, 'Connection failed');
      showNotification(error.message || 'Failed to connect to wallet', 'error');
    } finally {
      setIsConnecting(false);
    }
  };

  // 2. Deploy a new Journal contract
  const handleDeployJournal = async () => {
    if (!providers) return;
    setIsDeploying(true);
    try {
      const api = await JournalAPI.deploy(providers, logger);
      setJournalApi(api);
      setContractAddress(api.deployedContractAddress);
      showNotification('New Journal contract successfully deployed!', 'success');
    } catch (error: any) {
      logger.error(error, 'Deployment failed');
      showNotification(error.message || 'Deployment failed. Check if Proof Server is running.', 'error');
    } finally {
      setIsDeploying(false);
    }
  };

  // 3. Join an existing Journal contract
  const handleJoinJournal = async (addressToJoin: string) => {
    if (!providers || !addressToJoin) return;
    setIsJoining(true);
    try {
      const api = await JournalAPI.join(providers, addressToJoin, logger);
      setJournalApi(api);
      setContractAddress(addressToJoin);
      showNotification('Successfully joined existing Journal contract!', 'success');
    } catch (error: any) {
      logger.error(error, 'Join failed');
      showNotification(error.message || 'Failed to resolve contract address.', 'error');
    } finally {
      setIsJoining(false);
    }
  };

  // 4. Initialize Journal Owner
  const handleInitializeOwner = async () => {
    if (!journalApi) return;
    setIsInitializingOwner(true);
    try {
      await journalApi.initializeOwner();
      showNotification('Owner initialized on-chain!', 'success');
    } catch (error: any) {
      logger.error(error, 'Initialization failed');
      showNotification(error.message || 'Failed to initialize owner.', 'error');
    } finally {
      setIsInitializingOwner(false);
    }
  };

  // 5. Commit a private entry
  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!journalApi || !newEntryText.trim()) return;

    setIsCommitting(true);
    try {
      // Invoke contract ZK proof circuit
      const hashHex = await journalApi.addEntry(newEntryText);

      // Save locally
      const entry: LocalEntry = {
        text: newEntryText,
        hash: hashHex,
        timestamp: new Date().toLocaleString(),
      };
      const updatedEntries = [entry, ...localEntries];
      setLocalEntries(updatedEntries);
      localStorage.setItem(`journal_entries_${contractAddress}`, JSON.stringify(updatedEntries));

      setNewEntryText('');
      showNotification('Zero-Knowledge proof generated and entry committed on-chain!', 'success');
    } catch (error: any) {
      logger.error(error, 'Failed to add entry');
      showNotification(error.message || 'Failed to commit entry via ZK circuit.', 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  const isContractActive = contractAddress && contractAddress !== 'TBD';

  return (
    <div className="app-container">
      {/* Notifications */}
      {notification.message && (
        <div 
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '16px 24px',
            borderRadius: '8px',
            zIndex: 1000,
            background: notification.type === 'error' ? '#7f1d1d' : notification.type === 'success' ? '#064e3b' : '#1e3a8a',
            color: '#fff',
            border: `1px solid ${notification.type === 'error' ? '#ef4444' : notification.type === 'success' ? '#10b981' : '#3b82f6'}`,
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            fontWeight: 500,
            maxWidth: '400px'
          }}
        >
          {notification.message}
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon"><img src="public\download.png" alt="" /></div>
          <div className="logo-text">
            <h1>Private Journal</h1>
            <p>Midnight Network ZK-dApp</p>
          </div>
        </div>

        <div className="connection-badge">
          <span className={`status-dot ${walletConnected ? 'connected' : ''}`}></span>
          <span>{walletConnected ? 'Wallet Connected' : 'Wallet Disconnected'}</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="dashboard-grid">
        {/* Left Sidebar */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
          {/* Wallet and Connection Panel */}
          <div className="glass-card">
            <h2 className="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Wallet Connection
            </h2>
            {!walletConnected ? (
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
                  Connect your Midnight wallet (1AM or Lace) to interact with the ZK smart contracts.
                </p>
                <button className="btn-primary" onClick={handleConnectWallet} disabled={isConnecting}>
                  {isConnecting ? <div className="spinner"></div> : 'Connect Wallet'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="data-item">
                  <span className="data-item-label">Shielded Public Key</span>
                  <div className="mono-display">{walletAddress.slice(0, 16)}...{walletAddress.slice(-16)}</div>
                </div>
                <div style={{ color: '#10b981', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  Connected via {connectedWalletName} Wallet
                </div>
              </div>
            )}
          </div>

          {/* Contract Connection/Deploy Panel */}
          {walletConnected && (
            <div className="glass-card">
              <h2 className="card-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                </svg>
                Contract Registry
              </h2>
              {!isContractActive ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <button className="btn-primary" onClick={handleDeployJournal} disabled={isDeploying}>
                      {isDeploying ? <div className="spinner"></div> : 'Deploy New Journal'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.05)' }}></div>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>or</span>
                    <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.05)' }}></div>
                  </div>
                  <div className="input-group" style={{ marginBottom: 0 }}>
                    <label className="input-label">Contract Address</label>
                    <input 
                      type="text" 
                      className="text-input" 
                      placeholder="Enter contract address to join..."
                      value={joinAddressInput}
                      onChange={(e) => setJoinAddressInput(e.target.value)}
                    />
                  </div>
                  <button 
                    className="btn-secondary" 
                    onClick={() => handleJoinJournal(joinAddressInput)} 
                    disabled={isJoining || !joinAddressInput.trim()}
                  >
                    {isJoining ? 'Joining...' : 'Join Journal'}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="data-item">
                    <span className="data-item-label">Contract Address</span>
                    <div className="mono-display">{contractAddress}</div>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Connected to journal contract.
                  </div>
                  <button className="btn-secondary" onClick={() => { setContractAddress(''); setJournalApi(null); setDerivedState(null); }}>
                    Disconnect Contract
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Right Dashboard Area */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
          {isContractActive ? (
            <>
              {/* Ledger State Panel */}
              <div className="glass-card">
                <h2 className="card-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  On-Chain Public Ledger State
                </h2>
                
                {derivedState ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                    <div className="data-item" style={{ gridColumn: 'span 2' }}>
                      <span className="data-item-label">Journal Owner (Public Key)</span>
                      <div className="mono-display" style={{ color: 'var(--text-primary)' }}>
                        {derivedState.owner === '0000000000000000000000000000000000000000000000000000000000000000' 
                          ? 'UNINITIALIZED (No Owner Registered)' 
                          : derivedState.owner}
                      </div>
                    </div>
                    <div className="data-item">
                      <span className="data-item-label">Total Entry Count</span>
                      <div style={{ fontSize: '28px', fontWeight: '800', color: 'var(--accent-purple)', marginTop: '4px' }}>
                        {derivedState.entryCount.toString()}
                      </div>
                    </div>
                    <div className="data-item">
                      <span className="data-item-label">Last Committed Hash</span>
                      <div className="mono-display" style={{ marginTop: '8px' }}>
                        {derivedState.lastEntryHash === '0000000000000000000000000000000000000000000000000000000000000000'
                          ? 'None'
                          : `${derivedState.lastEntryHash.slice(0, 16)}...`}
                      </div>
                    </div>

                    {/* Uninitialized State Banner */}
                    {derivedState.owner === '0000000000000000000000000000000000000000000000000000000000000000' && (
                      <div style={{ gridColumn: 'span 2', padding: '16px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                        <span style={{ fontSize: '13px', color: '#fbbf24', fontWeight: 500 }}>
                          This contract requires initialization to register your wallet as the authorized owner.
                        </span>
                        <button className="btn-primary" style={{ alignSelf: 'flex-start', width: 'auto', padding: '10px 20px' }} onClick={handleInitializeOwner} disabled={isInitializingOwner}>
                          {isInitializingOwner ? <div className="spinner"></div> : 'Register as Owner'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                    <div className="spinner"></div>
                  </div>
                )}
              </div>

              {/* Write and Feed Columns */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '30px' }}>
                {/* Write Entry */}
                {derivedState && derivedState.owner !== '0000000000000000000000000000000000000000000000000000000000000000' && (
                  <div className="glass-card">
                    <h2 className="card-title">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9"></path>
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                      </svg>
                      Write Private Entry
                    </h2>
                    
                    {derivedState.isOwner ? (
                      <form onSubmit={handleAddEntry}>
                        <div className="input-group">
                          <label className="input-label">Entry Content</label>
                          <textarea 
                            className="textarea-input" 
                            placeholder="Write your private thoughts here..."
                            value={newEntryText}
                            onChange={(e) => setNewEntryText(e.target.value)}
                            required
                          />
                        </div>
                        <button type="submit" className="btn-primary" disabled={isCommitting || !newEntryText.trim()}>
                          {isCommitting ? <div className="spinner"></div> : 'Generate ZK Proof & Commit'}
                        </button>
                      </form>
                    ) : (
                      <div style={{ color: '#ef4444', fontSize: '14px', background: 'rgba(239,68,68,0.1)', padding: '12px 16px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
                        You are not the registered owner of this journal. You cannot write entries.
                      </div>
                    )}
                  </div>
                )}

                {/* Journal Entries List */}
                <div className="glass-card">
                  <h2 className="card-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                    </svg>
                    Journal Feed (Stored Privately)
                  </h2>

                  {localEntries.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">📝</div>
                      <p>Your journal is currently empty. Write your first entry above!</p>
                    </div>
                  ) : (
                    <div>
                      {localEntries.map((entry, index) => {
                        const isLatestOnChain = derivedState && derivedState.lastEntryHash === entry.hash;
                        return (
                          <div key={index} className="entry-card">
                            <div className="entry-meta">
                              <span className="entry-date">{entry.timestamp}</span>
                              <span className={`verification-tag ${isLatestOnChain ? 'verified' : 'unverified'}`}>
                                {isLatestOnChain ? 'Verified On-Chain' : 'Saved Privately'}
                              </span>
                            </div>
                            <p className="entry-text">{entry.text}</p>
                            <div className="entry-hash-container">
                              <div>Cryptographic Entry Hash (SHA-256)</div>
                              <div className="entry-hash">{entry.hash}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', textAlign: 'center', gap: '16px' }}>
              <div style={{ fontSize: '48px' }}>🔒</div>
              <h3 style={{ fontSize: '20px', fontWeight: 600 }}>Secure Private Journal</h3>
              <p style={{ color: 'var(--text-secondary)', maxWidth: '400px', fontSize: '14px' }}>
                Connect your Midnight Wallet and deploy a new contract or join an existing contract address to unlock your private space.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default App;
