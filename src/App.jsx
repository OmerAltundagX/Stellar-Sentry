import React, { useState, useEffect, useCallback, useRef } from 'react';
import Dashboard from './components/Dashboard.jsx';
import ContractCard from './components/ContractCard.jsx';
import AddContractModal from './components/AddContractModal.jsx';
import {
    checkNetworkStatus,
    fetchAllContractEntries,
    getMaxEntryTTL,
    MAX_TTL,
} from './services/stellarService.js';
import {
    isFreighterInstalled,
    connectWallet,
    extendContractTTL,
} from './services/freighterService.js';

/**
 * App — Root component for Stellar Sentry.
 * Manages contract monitoring state, auto-refresh, and wallet integration.
 */

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds
const LEDGERS_PER_DAY = 17_280; // ~24h at 5s per ledger

export default function App() {
    // --- Network state ---
    const [networkStatus, setNetworkStatus] = useState({
        connected: false,
        latestLedger: null,
        error: null,
    });

    // --- Contracts state ---
    // Each contract config: { contractId: string, keys: [{name, type}] }
    const [contracts, setContracts] = useState(() => {
        try {
            const saved = localStorage.getItem('stellar-sentry-contracts');
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });

    // contractData: Map<contractId, { entries: [], error: string|null }>
    const [contractData, setContractData] = useState({});
    const [isLoading, setIsLoading] = useState(false);

    // --- Modal state ---
    const [isModalOpen, setIsModalOpen] = useState(false);

    // --- Extend modal state ---
    // entry: the TTL entry being extended ({ keyName, storageType, remainingLedgers, ... })
    const [extendModal, setExtendModal] = useState({
        open: false,
        contractId: null,
        entry: null,
        days: 30,
    });

    // Network maximum entry TTL in ledgers — caps how far an entry can be extended
    const [maxEntryTtl, setMaxEntryTtl] = useState(MAX_TTL.persistent);

    // --- Wallet state ---
    const [walletState, setWalletState] = useState({
        installed: false,
        publicKey: null,
        connecting: false,
    });

    // --- Toasts ---
    const [toasts, setToasts] = useState([]);
    const toastIdRef = useRef(0);

    // Save contracts to localStorage whenever they change
    useEffect(() => {
        localStorage.setItem('stellar-sentry-contracts', JSON.stringify(contracts));
    }, [contracts]);

    // --- Toast helpers ---
    const showToast = useCallback((message, type = 'success') => {
        const id = toastIdRef.current++;
        setToasts((prev) => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 4000);
    }, []);

    // --- Network polling ---
    const refreshNetworkStatus = useCallback(async () => {
        const status = await checkNetworkStatus();
        setNetworkStatus(status);
        return status;
    }, []);

    // --- Fetch all contract data ---
    const refreshContractData = useCallback(async () => {
        if (contracts.length === 0) return;

        setIsLoading(true);
        try {
            const results = {};
            // Fetch all contracts in parallel
            const promises = contracts.map((config) => fetchAllContractEntries(config));
            const responses = await Promise.allSettled(promises);

            responses.forEach((result, idx) => {
                const config = contracts[idx];
                if (result.status === 'fulfilled') {
                    results[config.contractId] = result.value;
                } else {
                    results[config.contractId] = {
                        contractId: config.contractId,
                        entries: [],
                        error: result.reason?.message || 'Unknown error',
                    };
                }
            });

            setContractData(results);
        } catch (err) {
            showToast(`Refresh failed: ${err.message}`, 'error');
        } finally {
            setIsLoading(false);
        }
    }, [contracts, showToast]);

    // --- Initial load & auto-refresh ---
    useEffect(() => {
        refreshNetworkStatus();
        refreshContractData();

        const interval = setInterval(() => {
            refreshNetworkStatus();
            refreshContractData();
        }, REFRESH_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [refreshNetworkStatus, refreshContractData]);

    // --- Check Freighter on mount ---
    useEffect(() => {
        async function checkWallet() {
            const installed = await isFreighterInstalled();
            setWalletState((prev) => ({ ...prev, installed }));
        }
        checkWallet();
    }, []);

    // --- Fetch network max TTL on mount ---
    useEffect(() => {
        getMaxEntryTTL().then(setMaxEntryTtl);
    }, []);

    const maxExtendDays = Math.floor((maxEntryTtl - 1) / LEDGERS_PER_DAY);

    // --- Handlers ---
    function handleAddContract(config) {
        // Prevent duplicates
        if (contracts.some((c) => c.contractId === config.contractId)) {
            showToast('This contract is already being monitored', 'error');
            return;
        }
        setContracts((prev) => [...prev, config]);
        showToast(`Contract ${config.contractId.substring(0, 8)}... added`);
    }

    function handleRemoveContract(contractId) {
        setContracts((prev) => prev.filter((c) => c.contractId !== contractId));
        setContractData((prev) => {
            const next = { ...prev };
            delete next[contractId];
            return next;
        });
        showToast(`Contract ${contractId.substring(0, 8)}... removed`);
    }

    async function handleConnectWallet() {
        setWalletState((prev) => ({ ...prev, connecting: true }));
        const result = await connectWallet();

        if (result.error) {
            showToast(result.error, 'error');
            setWalletState((prev) => ({ ...prev, connecting: false }));
        } else {
            setWalletState({
                installed: true,
                publicKey: result.publicKey,
                connecting: false,
            });
            showToast(`Wallet connected: ${result.publicKey.substring(0, 8)}...`);
        }
    }

    function handleExtendTTL(contractId, entry) {
        if (!walletState.publicKey) {
            showToast('Please connect your wallet first', 'error');
            return;
        }
        setExtendModal({ open: true, contractId, entry, days: Math.min(30, maxExtendDays) });
    }

    async function handleExtendSubmit() {
        const { contractId, entry, days } = extendModal;
        setExtendModal((prev) => ({ ...prev, open: false }));

        const currentRemaining = entry?.remainingLedgers || 0;
        const extendToLedgers = currentRemaining + (days * LEDGERS_PER_DAY);

        // The instance extension also extends the contract's WASM code;
        // data entries are extended individually.
        const dataKey = entry && entry.storageType !== 'instance'
            ? { name: entry.keyName, type: entry.storageType }
            : null;

        showToast(`Extending ${entry?.keyName || 'TTL'} by ${days} days...`, 'success');
        const result = await extendContractTTL(
            contractId,
            extendToLedgers,
            walletState.publicKey,
            dataKey
        );

        if (result.success) {
            showToast(`TTL extended by ${days} days! TX: ${result.txHash?.substring(0, 12)}...`);
            setTimeout(() => refreshContractData(), 3000);
        } else {
            showToast(`Extension failed: ${result.error}`, 'error');
        }
    }

    return (
        <div className="app-container">
            {/* Header */}
            <header className="app-header">
                <div className="brand">
                    <div className="brand-icon">🛡</div>
                    <div className="brand-text">
                        <h1>Stellar Sentry</h1>
                        <span>Soroban TTL Monitor</span>
                    </div>
                </div>
                <div className="header-actions">
                    {walletState.publicKey ? (
                        <div className="wallet-status">
                            <span className="wallet-address">
                                {walletState.publicKey.substring(0, 6)}...{walletState.publicKey.substring(walletState.publicKey.length - 4)}
                            </span>
                        </div>
                    ) : (
                        <button
                            className="btn btn-wallet"
                            onClick={handleConnectWallet}
                            disabled={walletState.connecting}
                        >
                            {walletState.connecting ? (
                                <>
                                    <span className="spinner spinner-sm" />
                                    Connecting...
                                </>
                            ) : (
                                '🔗 Connect Wallet'
                            )}
                        </button>
                    )}
                    <button
                        className="btn-icon"
                        onClick={() => {
                            refreshNetworkStatus();
                            refreshContractData();
                        }}
                        title="Refresh all data"
                    >
                        {isLoading ? <span className="spinner spinner-sm" /> : '↻'}
                    </button>
                </div>
            </header>

            {/* Dashboard Stats */}
            <Dashboard
                connected={networkStatus.connected}
                latestLedger={networkStatus.latestLedger}
                contractCount={contracts.length}
                networkError={networkStatus.error}
            />

            {/* Contract Section */}
            <div className="section-header">
                <h2 className="section-title">Monitored Contracts</h2>
                <button className="btn btn-primary btn-sm" onClick={() => setIsModalOpen(true)}>
                    + Add Contract
                </button>
            </div>

            {contracts.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state-icon">🔭</div>
                    <div className="empty-state-title">No Contracts Monitored</div>
                    <p className="empty-state-text">
                        Add a Soroban smart contract address to start monitoring its TTL health.
                        The dashboard will track instance and data entry expirations in real-time.
                    </p>
                    <button className="btn btn-primary" onClick={() => setIsModalOpen(true)}>
                        + Add Your First Contract
                    </button>
                </div>
            ) : (
                <div className="contracts-grid">
                    {contracts.map((config) => {
                        const data = contractData[config.contractId];
                        return (
                            <ContractCard
                                key={config.contractId}
                                contractId={config.contractId}
                                entries={data?.entries || []}
                                error={data?.error}
                                onRemove={handleRemoveContract}
                                onExtendTTL={handleExtendTTL}
                                walletConnected={!!walletState.publicKey}
                            />
                        );
                    })}
                </div>
            )}

            {/* Add Contract Modal */}
            <AddContractModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onAdd={handleAddContract}
            />

            {/* Extend TTL Modal */}
            {extendModal.open && (
                <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setExtendModal((p) => ({ ...p, open: false }))}>
                    <div className="modal-content extend-modal">
                        <div className="modal-header">
                            <h2 className="modal-title">⏱ Extend TTL</h2>
                            <button className="modal-close" onClick={() => setExtendModal((p) => ({ ...p, open: false }))}>✕</button>
                        </div>

                        <div className="extend-contract-info">
                            <span className="extend-label">Contract</span>
                            <span className="extend-value mono">
                                {extendModal.contractId?.substring(0, 8)}...{extendModal.contractId?.substring(extendModal.contractId.length - 8)}
                            </span>
                        </div>

                        {extendModal.entry && (
                            <div className="extend-contract-info">
                                <span className="extend-label">Entry</span>
                                <span className="extend-value">
                                    {extendModal.entry.keyName} ({extendModal.entry.storageType})
                                    {extendModal.entry.storageType === 'instance' && ' + WASM code'}
                                </span>
                            </div>
                        )}

                        {extendModal.entry && !extendModal.entry.error && (
                            <div className="extend-contract-info">
                                <span className="extend-label">Current Remaining</span>
                                <span className="extend-value">{extendModal.entry.estimatedTimeLeft} ({extendModal.entry.remainingLedgers?.toLocaleString()} ledgers)</span>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label" htmlFor="extend-days-input">Days to Add</label>
                            <input
                                id="extend-days-input"
                                className="form-input"
                                type="number"
                                min="1"
                                max={maxExtendDays}
                                value={extendModal.days}
                                onChange={(e) => setExtendModal((p) => ({ ...p, days: Math.min(maxExtendDays, Math.max(1, parseInt(e.target.value) || 1)) }))}
                                autoFocus
                            />
                            <div className="extend-presets">
                                {[7, 30, 90, 180].filter((d) => d <= maxExtendDays).map((d) => (
                                    <button
                                        key={d}
                                        type="button"
                                        className={`extend-preset-btn ${extendModal.days === d ? 'active' : ''}`}
                                        onClick={() => setExtendModal((p) => ({ ...p, days: d }))}
                                    >
                                        {d}d
                                    </button>
                                ))}
                            </div>
                            <div className="form-hint">
                                ≈ {(extendModal.days * LEDGERS_PER_DAY).toLocaleString()} ledgers will be added
                            </div>
                            {(extendModal.entry?.remainingLedgers || 0) + extendModal.days * LEDGERS_PER_DAY > maxEntryTtl - 1 && (
                                <div className="form-hint">
                                    Capped at the network maximum of {(maxEntryTtl - 1).toLocaleString()} ledgers (~{maxExtendDays} days)
                                </div>
                            )}
                        </div>

                        <div className="form-actions">
                            <button className="btn btn-secondary" onClick={() => setExtendModal((p) => ({ ...p, open: false }))}>
                                Cancel
                            </button>
                            <button className="btn btn-primary" onClick={handleExtendSubmit}>
                                Extend by {extendModal.days} Days
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notifications */}
            {toasts.length > 0 && (
                <div className="toast-container">
                    {toasts.map((toast) => (
                        <div className={`toast ${toast.type}`} key={toast.id}>
                            {toast.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
