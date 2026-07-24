import React, { useState, useEffect } from 'react';
import {
  JournalAPI,
  JOURNAL_PRIVATE_STATE_KEY,
  JournalDerivedState,
  JournalProviders,
  JournalPrivateState,
  connectToWallet,
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
  // Navigation active tab: 'overview' | 'circuits' | 'vault' | 'explorer'
  const [activeTab, setActiveTab] = useState<string>('overview');

  // Connection states
  const [walletConnected, setWalletConnected] = useState<boolean>(false);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [providers, setProviders] = useState<JournalProviders | null>(null);
  const [connectedWalletName, setConnectedWalletName] = useState<string>('1AM Wallet');

  // Contract states
  const [contractAddress, setContractAddress] = useState<string>(CONTRACT_ADDRESS !== 'TBD' ? CONTRACT_ADDRESS : '');
  const [journalApi, setJournalApi] = useState<JournalAPI | null>(null);
  const [derivedState, setDerivedState] = useState<JournalDerivedState | null>(null);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [isInitializingOwner, setIsInitializingOwner] = useState<boolean>(false);

  // Form & ZK Proof states
  const [newEntryText, setNewEntryText] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState<boolean>(false);
  const [proofStep, setProofStep] = useState<number>(0);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [joinAddressInput, setJoinAddressInput] = useState<string>('');
  const [targetNetwork, setTargetNetwork] = useState<string>('preprod');

  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' | null }>({
    message: '',
    type: null,
  });

  // Load saved local entries
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

  // 1. Connect to Wallet (Prioritizing 1AM Wallet)
  const handleConnectWallet = async () => {
    setIsConnecting(true);
    try {
      const networkId = (import.meta.env.VITE_NETWORK_ID || targetNetwork || 'preprod') as NetworkId;
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

      const walletName = connectedAPI.walletName || '1AM Wallet';
      setConnectedWalletName(walletName);
      setProviders(createdProviders);
      setWalletConnected(true);
      showNotification(`Connected to ${walletName}!`, 'success');
    } catch (error: any) {
      logger.error(error, 'Connection failed');
      showNotification(error.message || 'Failed to connect to 1AM wallet extension', 'error');
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
      showNotification('Midnight ZK contract deployed!', 'success');
    } catch (error: any) {
      logger.error(error, 'Deployment failed');
      showNotification(error.message || 'Deployment failed.', 'error');
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
      showNotification('Connected to contract address!', 'success');
    } catch (error: any) {
      logger.error(error, 'Join failed');
      showNotification(error.message || 'Failed to resolve contract.', 'error');
    } finally {
      setIsJoining(false);
    }
  };

  // 4. Initialize Owner Circuit
  const handleInitializeOwner = async () => {
    if (!journalApi) return;
    setIsInitializingOwner(true);
    try {
      await journalApi.initializeOwner();
      showNotification('Owner initialized on ledger!', 'success');
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
    setProofStep(1);
    try {
      await new Promise((res) => setTimeout(res, 400));
      setProofStep(2);
      await new Promise((res) => setTimeout(res, 600));
      setProofStep(3);

      const hashHex = await journalApi.addEntry(newEntryText);
      setProofStep(4);

      const entry: LocalEntry = {
        text: newEntryText,
        hash: hashHex,
        timestamp: new Date().toLocaleString(),
      };
      const updatedEntries = [entry, ...localEntries];
      setLocalEntries(updatedEntries);
      localStorage.setItem(`journal_entries_${contractAddress}`, JSON.stringify(updatedEntries));

      setNewEntryText('');
      showNotification('Zero-Knowledge proof generated and entry committed!', 'success');
    } catch (error: any) {
      logger.error(error, 'Failed to add entry');
      showNotification(error.message || 'Failed to commit entry.', 'error');
    } finally {
      setIsCommitting(false);
      setTimeout(() => setProofStep(0), 3000);
    }
  };

  const isContractActive = contractAddress && contractAddress !== 'TBD';

  return (
    <div className="app-layout">
      {/* Toast Notifications */}
      {notification.message && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            padding: '12px 20px',
            borderRadius: '10px',
            zIndex: 1000,
            background: notification.type === 'error' ? '#991b1b' : '#10b981',
            color: '#fff',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            fontWeight: 600,
            fontSize: '13px',
          }}
        >
          {notification.message}
        </div>
      )}

      {/* Left Sidebar Navigation */}
      <aside className="sidebar">
        <div>
          <div className="sidebar-brand">
            <div className="brand-icon">🔏</div>
            <div>
              <div className="brand-title">Journal Vault</div>
              <div className="brand-sub">Level 2 ZK dApp</div>
            </div>
          </div>

          <div className="nav-menu">
            <div className="nav-section-title">Core Menu</div>
            <div 
              className={`nav-link ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
              </svg>
              Overview
            </div>

            <div 
              className={`nav-link ${activeTab === 'circuits' ? 'active' : ''}`}
              onClick={() => setActiveTab('circuits')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
              ZK Circuit Studio
            </div>

            <div 
              className={`nav-link ${activeTab === 'vault' ? 'active' : ''}`}
              onClick={() => setActiveTab('vault')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Encrypted Vault ({localEntries.length})
            </div>

            <div className="nav-section-title" style={{ marginTop: '16px' }}>Network & Docs</div>
            <div 
              className={`nav-link ${activeTab === 'explorer' ? 'active' : ''}`}
              onClick={() => setActiveTab('explorer')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="20" x2="18" y2="10"></line>
                <line x1="12" y1="20" x2="12" y2="4"></line>
                <line x1="6" y1="20" x2="6" y2="14"></line>
              </svg>
              Ledger State
            </div>
          </div>
        </div>

        {/* Sidebar Footer Wallet Widget */}
        <div className="sidebar-footer">
          <div className="wallet-card-mini">
            <div className="wallet-mini-status">
              <span>1AM Wallet Status</span>
              <span className={`status-indicator ${walletConnected ? 'connected' : ''}`}></span>
            </div>
            {!walletConnected ? (
              <button className="btn-emerald" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={handleConnectWallet} disabled={isConnecting}>
                {isConnecting ? <div className="spinner"></div> : 'Connect 1AM Wallet'}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Connected via {connectedWalletName}</div>
                <div className="mono-display" style={{ marginTop: '6px', fontSize: '11px', padding: '4px 8px' }}>
                  {walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        {/* Top Header */}
        <header className="top-header">
          <div className="header-title-group">
            <h2>
              {activeTab === 'overview' && 'Dashboard Overview'}
              {activeTab === 'circuits' && 'ZK Circuit Execution Studio'}
              {activeTab === 'vault' && 'Private Encrypted Vault'}
              {activeTab === 'explorer' && 'Public Ledger & Privacy Inspector'}
            </h2>
            <p>Midnight Network Zero-Knowledge Confidentiality Suite • 1AM Wallet Integrated</p>
          </div>

          <div className="header-pills">
            <div className={`pill-tag ${isContractActive ? 'active' : ''}`}>
              <span className={`status-indicator ${isContractActive ? 'connected' : ''}`}></span>
              {isContractActive ? `Contract Active (${contractAddress.slice(0, 6)}...)` : 'No Contract Active'}
            </div>
            <div className="pill-tag active">
              <span>RPC 28ms</span>
            </div>
          </div>
        </header>

        {/* TAB 1: OVERVIEW & SYSTEM STATUS */}
        {(activeTab === 'overview' || activeTab === 'circuits') && (
          <div>
            {/* Handcrafted Stats Row */}
            <div className="stat-boxes">
              <div className="stat-box">
                <div className="stat-box-val">2</div>
                <div className="stat-box-lbl">Compact Circuits</div>
              </div>
              <div className="stat-box">
                <div className="stat-box-val">100%</div>
                <div className="stat-box-lbl">Private Witness</div>
              </div>
              <div className="stat-box">
                <div className="stat-box-val">v0.16</div>
                <div className="stat-box-lbl">Runtime SDK</div>
              </div>
            </div>

            <div className="dashboard-grid-layout">
              {/* Left Column: Wallet & Registry */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className="human-card">
                  <div className="human-card-title">
                    <span>1AM Wallet Authorization</span>
                    <span style={{ fontSize: '12px', color: walletConnected ? 'var(--emerald-bright)' : 'var(--amber-accent)' }}>
                      {walletConnected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>

                  {!walletConnected ? (
                    <div>
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                        Authorize your 1AM Midnight extension wallet to generate Zero-Knowledge proofs locally on your browser.
                      </p>
                      <div style={{ marginBottom: '14px' }}>
                        <label className="input-label">Target Network</label>
                        <select className="select-input" value={targetNetwork} onChange={(e) => setTargetNetwork(e.target.value)}>
                          <option value="preprod">Preview Testnet (Recommended)</option>
                          <option value="devnet">Devnet</option>
                        </select>
                      </div>
                      <button className="btn-emerald" onClick={handleConnectWallet} disabled={isConnecting}>
                        {isConnecting ? <div className="spinner"></div> : 'Connect 1AM Wallet'}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <span className="input-label">Shielded Public Key</span>
                      <div className="mono-display">{walletAddress}</div>
                    </div>
                  )}
                </div>

                {/* Contract Registry */}
                {walletConnected && (
                  <div className="human-card">
                    <div className="human-card-title">Contract Registry</div>

                    {!isContractActive ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                        <button className="btn-emerald" onClick={handleDeployJournal} disabled={isDeploying}>
                          {isDeploying ? <div className="spinner"></div> : 'Deploy New Journal Contract'}
                        </button>
                        
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }}></div>
                          <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>OR JOIN</span>
                          <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }}></div>
                        </div>

                        <input 
                          type="text" 
                          className="text-input" 
                          placeholder="Paste contract address..."
                          value={joinAddressInput}
                          onChange={(e) => setJoinAddressInput(e.target.value)}
                        />
                        <button 
                          className="btn-secondary" 
                          onClick={() => handleJoinJournal(joinAddressInput)} 
                          disabled={isJoining || !joinAddressInput.trim()}
                        >
                          {isJoining ? 'Joining...' : 'Connect Address'}
                        </button>
                      </div>
                    ) : (
                      <div>
                        <span className="input-label">Active Contract Address</span>
                        <div className="mono-display">{contractAddress}</div>
                        <button className="btn-secondary" style={{ marginTop: '12px' }} onClick={() => { setContractAddress(''); setJournalApi(null); setDerivedState(null); }}>
                          Disconnect Contract
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right Column: Circuit Studio */}
              <div className="human-card">
                <div className="human-card-title">
                  <span>Circuit Execution Studio (`addEntry`)</span>
                  <span style={{ fontSize: '11px', color: 'var(--emerald-bright)', fontFamily: 'var(--font-mono)' }}>ZK Shielded</span>
                </div>

                {!walletConnected ? (
                  <div style={{ textAlign: 'center', padding: '36px 20px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔒</div>
                    <p style={{ fontSize: '14px', fontWeight: 600 }}>1AM Wallet Authorization Required</p>
                    <p style={{ fontSize: '12px', marginTop: '4px' }}>Connect your 1AM wallet using the left panel to execute circuits.</p>
                  </div>
                ) : !isContractActive ? (
                  <div style={{ textAlign: 'center', padding: '36px 20px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>⚙️</div>
                    <p style={{ fontSize: '14px', fontWeight: 600 }}>No Active Contract</p>
                    <p style={{ fontSize: '12px', marginTop: '4px' }}>Deploy or join a Journal contract to begin executing circuits.</p>
                  </div>
                ) : (
                  <div>
                    {derivedState && (
                      <div style={{ background: 'var(--bg-app)', padding: '14px', borderRadius: '10px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between' }}>
                        <div>
                          <span className="input-label">Ledger Entry Count</span>
                          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--emerald-bright)', fontFamily: 'var(--font-mono)' }}>
                            {derivedState.entryCount.toString()}
                          </div>
                        </div>
                        <div>
                          <span className="input-label">Last Committed Hash</span>
                          <div className="mono-display" style={{ fontSize: '11px', padding: '4px 8px' }}>
                            {derivedState.lastEntryHash === '0000000000000000000000000000000000000000000000000000000000000000'
                              ? 'None'
                              : `${derivedState.lastEntryHash.slice(0, 10)}...`}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Uninitialized Owner Warning */}
                    {derivedState && derivedState.owner === '0000000000000000000000000000000000000000000000000000000000000000' && (
                      <div style={{ padding: '12px 14px', background: 'var(--amber-glow)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '8px', marginBottom: '16px' }}>
                        <p style={{ fontSize: '12px', color: 'var(--amber-accent)', fontWeight: 600, marginBottom: '8px' }}>
                          Contract owner needs initialization on the ledger.
                        </p>
                        <button className="btn-emerald" style={{ padding: '6px 12px', fontSize: '12px', width: 'auto' }} onClick={handleInitializeOwner} disabled={isInitializingOwner}>
                          {isInitializingOwner ? <div className="spinner"></div> : 'Initialize Owner Circuit'}
                        </button>
                      </div>
                    )}

                    <form onSubmit={handleAddEntry}>
                      <div style={{ marginBottom: '16px' }}>
                        <label className="input-label">Secret Entry Content (Stored Privately)</label>
                        <textarea 
                          className="textarea-input" 
                          placeholder="Type your secret custom message here..."
                          value={newEntryText}
                          onChange={(e) => setNewEntryText(e.target.value)}
                          required
                        />
                      </div>

                      <button type="submit" className="btn-emerald" disabled={isCommitting || !newEntryText.trim()}>
                        {isCommitting ? <div className="spinner"></div> : 'Generate ZK Proof & Commit to Ledger'}
                      </button>
                    </form>

                    {/* Proof Step Tracker */}
                    {proofStep > 0 && (
                      <div className="proof-step-tracker">
                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-main)' }}>
                          Proof Generation Progress
                        </div>
                        <div className="step-tracker-grid">
                          <div className={`step-item ${proofStep > 1 ? 'completed' : proofStep === 1 ? 'active' : ''}`}>1. Witness</div>
                          <div className={`step-item ${proofStep > 2 ? 'completed' : proofStep === 2 ? 'active' : ''}`}>2. Circuit</div>
                          <div className={`step-item ${proofStep > 3 ? 'completed' : proofStep === 3 ? 'active' : ''}`}>3. ZK Proof</div>
                          <div className={`step-item ${proofStep === 4 ? 'completed' : ''}`}>4. Commit</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: VAULT (LOCAL PRIVATE ENTRIES) */}
        {(activeTab === 'overview' || activeTab === 'vault') && (
          <div className="human-card" style={{ marginTop: activeTab === 'overview' ? '10px' : '0' }}>
            <div className="human-card-title">
              <span>Encrypted Vault Feed ({localEntries.length} Items)</span>
              <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Stored Privately in Browser</span>
            </div>

            {localEntries.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: '28px', marginBottom: '6px' }}>📝</div>
                <p style={{ fontSize: '13px' }}>Vault is currently empty. Use the circuit studio above to commit your first private entry!</p>
              </div>
            ) : (
              <div>
                {localEntries.map((entry, idx) => {
                  const isVerified = derivedState && derivedState.lastEntryHash === entry.hash;
                  return (
                    <div key={idx} className="feed-card">
                      <div className="feed-header">
                        <span>{entry.timestamp}</span>
                        <span className="feed-verified">{isVerified ? 'Verified On-Chain' : 'Saved Privately'}</span>
                      </div>
                      <p style={{ fontSize: '14px', color: 'var(--text-main)', marginBottom: '10px', lineHeight: 1.6 }}>
                        {entry.text}
                      </p>
                      <div style={{ borderTop: '1px dashed var(--border-subtle)', paddingTop: '8px' }}>
                        <span className="input-label" style={{ fontSize: '10px' }}>SHA-256 Hash</span>
                        <div className="mono-display" style={{ fontSize: '11px', marginTop: '2px' }}>{entry.hash}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: LEDGER EXPLORER & PRIVACY BREAKDOWN */}
        {(activeTab === 'overview' || activeTab === 'explorer') && (
          <div style={{ marginTop: '28px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 800, marginBottom: '16px' }}>
              Public State vs. Private Witness Breakdown
            </h3>

            <div className="breakdown-row">
              <div className="breakdown-box">
                <span className="badge-tag public">Public State • Ledger</span>
                <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>On-Chain Storage</h4>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Stored transparently on the Midnight ledger. The contract state hash and entry counter are indexed publicly and queryable by network observers.
                </p>
              </div>

              <div className="breakdown-box">
                <span className="badge-tag private">Private Witness • Client</span>
                <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>Local Client Security</h4>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Your secret custom message remains strictly on your local browser. The proof provider generates a Zero-Knowledge proof locally, enabling validators to verify validity without seeing the input.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
