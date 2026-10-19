import React, { useState } from 'react';
import { Address } from '@stellar/stellar-sdk';
import { buildDataLedgerKey, formatKeyLabel } from '../services/stellarService.js';

/**
 * AddContractModal — Form for adding a new contract to monitor.
 * Supports adding multiple data keys with their storage types.
 * Keys can be plain symbols, `#[contracttype]` enum variants (with an
 * optional argument), or raw base64 ScVal XDR.
 */

const KEY_NAME_PLACEHOLDERS = {
    symbol: 'Key symbol name',
    enum: 'Variant name, e.g. Balance',
    xdr: 'Base64 ScVal XDR',
};

export default function AddContractModal({ isOpen, onClose, onAdd }) {
    const [contractId, setContractId] = useState('');
    const [keys, setKeys] = useState([]);
    const [error, setError] = useState('');

    if (!isOpen) return null;

    function handleAddKey() {
        setKeys((prev) => [...prev, { name: '', type: 'persistent', kind: 'symbol', arg: '', argType: 'address' }]);
    }

    function handleRemoveKey(idx) {
        setKeys((prev) => prev.filter((_, i) => i !== idx));
    }

    function handleKeyChange(idx, field, value) {
        setKeys((prev) => {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], [field]: value };
            return updated;
        });
    }

    function handleSubmit(e) {
        e.preventDefault();
        setError('');

        const trimmedId = contractId.trim();
        if (!trimmedId) {
            setError('Please enter a Contract ID');
            return;
        }

        // Basic Stellar address validation (C... format, 56 chars)
        if (trimmedId.length !== 56 || !trimmedId.startsWith('C')) {
            setError('Invalid Contract ID. Must be a 56-character string starting with "C".');
            return;
        }

        // Validate address checksum using the SDK
        try {
            new Address(trimmedId);
        } catch {
            setError('Invalid Contract ID. The address checksum is incorrect — please double-check the address.');
            return;
        }

        // Filter out empty key names; only enum keys keep their argument fields
        const validKeys = keys
            .filter((k) => k.name.trim() !== '')
            .map((k) => (k.kind === 'enum'
                ? { ...k, name: k.name.trim(), arg: k.arg.trim() }
                : { name: k.name.trim(), type: k.type, kind: k.kind }));

        // Make sure every key can be encoded before saving it
        for (const key of validKeys) {
            try {
                buildDataLedgerKey(trimmedId, key);
            } catch (err) {
                setError(`Invalid key "${formatKeyLabel(key)}": ${err.message}`);
                return;
            }
        }

        onAdd({
            contractId: trimmedId,
            keys: validKeys,
        });

        // Reset form
        setContractId('');
        setKeys([]);
        setError('');
        onClose();
    }

    function handleOverlayClick(e) {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }

    return (
        <div className="modal-overlay" onClick={handleOverlayClick}>
            <div className="modal-content">
                <div className="modal-header">
                    <h2 className="modal-title">Add Contract to Monitor</h2>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="contract-id-input">Contract ID</label>
                        <input
                            id="contract-id-input"
                            className="form-input"
                            type="text"
                            placeholder="CABC123...XYZ"
                            value={contractId}
                            onChange={(e) => setContractId(e.target.value)}
                            autoFocus
                        />
                        <div className="form-hint">
                            The C-encoded Soroban contract address (56 characters)
                        </div>
                    </div>

                    <div className="keys-section">
                        <div className="keys-section-header">
                            <span className="keys-section-title">Data Keys (Optional)</span>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={handleAddKey}
                            >
                                + Add Key
                            </button>
                        </div>

                        {keys.map((key, idx) => (
                            <div className="key-block" key={idx}>
                                <div className="key-row">
                                    <select
                                        className="form-select key-kind-select"
                                        value={key.kind}
                                        onChange={(e) => handleKeyChange(idx, 'kind', e.target.value)}
                                        title="Key encoding"
                                    >
                                        <option value="symbol">Symbol</option>
                                        <option value="enum">Enum</option>
                                        <option value="xdr">Raw XDR</option>
                                    </select>
                                    <input
                                        className="form-input"
                                        type="text"
                                        placeholder={KEY_NAME_PLACEHOLDERS[key.kind]}
                                        value={key.name}
                                        onChange={(e) => handleKeyChange(idx, 'name', e.target.value)}
                                    />
                                    <select
                                        className="form-select"
                                        value={key.type}
                                        onChange={(e) => handleKeyChange(idx, 'type', e.target.value)}
                                    >
                                        <option value="persistent">Persistent</option>
                                        <option value="temporary">Temporary</option>
                                    </select>
                                    <button
                                        type="button"
                                        className="key-remove-btn"
                                        onClick={() => handleRemoveKey(idx)}
                                        title="Remove key"
                                    >
                                        ✕
                                    </button>
                                </div>
                                {key.kind === 'enum' && (
                                    <div className="key-row key-arg-row">
                                        <select
                                            className="form-select key-kind-select"
                                            value={key.argType}
                                            onChange={(e) => handleKeyChange(idx, 'argType', e.target.value)}
                                            title="Argument type"
                                        >
                                            <option value="address">Address</option>
                                            <option value="symbol">Symbol</option>
                                            <option value="string">String</option>
                                            <option value="u32">u32</option>
                                            <option value="u64">u64</option>
                                            <option value="i128">i128</option>
                                        </select>
                                        <input
                                            className="form-input"
                                            type="text"
                                            placeholder="Argument (optional), e.g. G... address"
                                            value={key.arg}
                                            onChange={(e) => handleKeyChange(idx, 'arg', e.target.value)}
                                        />
                                    </div>
                                )}
                            </div>
                        ))}

                        {keys.length === 0 && (
                            <div className="form-hint" style={{ textAlign: 'center', padding: '8px 0' }}>
                                The contract instance entry will always be monitored.
                                Add data keys here to also track specific storage entries.
                            </div>
                        )}
                    </div>

                    {error && (
                        <div className="error-banner" style={{ marginTop: '16px' }}>
                            ⚠ {error}
                        </div>
                    )}

                    <div className="form-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary">
                            Start Monitoring
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
