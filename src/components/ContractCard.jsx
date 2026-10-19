import React from 'react';
import TTLBar from './TTLBar.jsx';

/**
 * ContractCard — Displays a single contract's TTL entries
 * with health indicators, storage type badges, and an Extend TTL button.
 */

export default function ContractCard({ contractId, entries, error, onRemove, onExtendTTL, walletConnected }) {
    // Truncate contract ID for display
    const shortId = contractId
        ? `${contractId.substring(0, 8)}...${contractId.substring(contractId.length - 8)}`
        : 'Unknown';

    if (error && (!entries || entries.length === 0)) {
        return (
            <div className="contract-card">
                <div className="contract-card-header">
                    <div className="contract-id" title={contractId}>{shortId}</div>
                    <button
                        className="contract-remove-btn"
                        onClick={() => onRemove(contractId)}
                        title="Remove contract"
                    >
                        ✕
                    </button>
                </div>
                <div className="entry-error">⚠ {error}</div>
            </div>
        );
    }

    return (
        <div className="contract-card">
            <div className="contract-card-header">
                <div className="contract-id" title={contractId}>{shortId}</div>
                <button
                    className="contract-remove-btn"
                    onClick={() => onRemove(contractId)}
                    title="Remove contract"
                >
                    ✕
                </button>
            </div>

            <div className="entry-list">
                {entries.map((entry, idx) => (
                    <div className="entry-item" key={`${entry.keyName}-${idx}`}>
                        <div className="entry-item-header">
                            <div>
                                <span className="entry-key-name">{entry.keyName}</span>
                                <span className={`storage-badge ${entry.storageType}`}>
                                    {entry.storageType}
                                </span>
                            </div>
                            {onExtendTTL && !entry.error && (
                                <button
                                    className="btn btn-extend btn-sm"
                                    onClick={() => onExtendTTL(contractId, entry)}
                                    disabled={!walletConnected}
                                    title={walletConnected ? 'Extend TTL via Freighter' : 'Connect wallet first'}
                                >
                                    ⏱ Extend
                                </button>
                            )}
                        </div>

                        {entry.error ? (
                            <div className="entry-error">⚠ {entry.error}</div>
                        ) : (
                            <>
                                <TTLBar
                                    healthPercentage={entry.healthPercentage}
                                    healthStatus={entry.healthStatus}
                                    estimatedTimeLeft={entry.estimatedTimeLeft}
                                    remainingLedgers={entry.remainingLedgers}
                                />
                                <div className="entry-details">
                                    <div className="entry-detail-item">
                                        <span className="entry-detail-label">Live Until Ledger</span>
                                        <span className="entry-detail-value">
                                            {entry.liveUntilLedgerSeq?.toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="entry-detail-item">
                                        <span className="entry-detail-label">Current Ledger</span>
                                        <span className="entry-detail-value">
                                            {entry.currentLedger?.toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="entry-detail-item">
                                        <span className="entry-detail-label">Last Modified</span>
                                        <span className="entry-detail-value">
                                            {entry.lastModifiedLedger?.toLocaleString() || '—'}
                                        </span>
                                    </div>
                                    <div className="entry-detail-item">
                                        <span className="entry-detail-label">Remaining</span>
                                        <span className="entry-detail-value">
                                            {entry.remainingLedgers?.toLocaleString()} ledgers
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
