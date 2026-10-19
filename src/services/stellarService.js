import { rpc, xdr, Address, Contract, nativeToScVal } from '@stellar/stellar-sdk';

/**
 * Stellar Sentry — Core Service Layer
 * Handles all Soroban RPC interactions, TTL calculations, and ledger queries.
 */

const RPC_URL = 'https://soroban-testnet.stellar.org:443';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

// Fallback maximum TTL values in ledgers, used until the network's
// state archival config has been fetched (see getMaxEntryTTL).
// Ledger closes roughly every ~5 seconds on Testnet
const MAX_TTL = {
    persistent: 3_110_400,  // ~180 days — network maxEntryTtl
    temporary: 518_400,     // ~30 days (display heuristic)
    instance: 3_110_400,    // Same as persistent (tied to contract instance)
};

let networkMaxEntryTtl = null;

// Health thresholds (percentage-based)
const HEALTH_THRESHOLDS = {
    critical: 10,   // Red zone
    warning: 30,    // Yellow zone
    healthy: 100,   // Green zone
};

let serverInstance = null;

/**
 * Get or create the Soroban RPC server instance (singleton).
 * @returns {rpc.Server}
 */
function getServer() {
    if (!serverInstance) {
        serverInstance = new rpc.Server(RPC_URL, { allowHttp: false });
    }
    return serverInstance;
}

/**
 * Fetch the latest ledger info from the Soroban RPC.
 * @returns {Promise<{sequence: number, timestamp: number}>}
 */
export async function getLatestLedger() {
    const server = getServer();
    const result = await server.getLatestLedger();
    return {
        sequence: result.sequence,
    };
}

/**
 * Fetch the network's maximum entry TTL (in ledgers) from the state archival
 * config setting. Cached after the first successful fetch; falls back to
 * MAX_TTL.persistent if the RPC call fails.
 * @returns {Promise<number>}
 */
export async function getMaxEntryTTL() {
    if (networkMaxEntryTtl) return networkMaxEntryTtl;
    try {
        const server = getServer();
        const key = xdr.LedgerKey.configSetting(
            new xdr.LedgerKeyConfigSetting({
                configSettingId: xdr.ConfigSettingId.configSettingStateArchival(),
            })
        );
        const response = await server.getLedgerEntries(key);
        const settings = response.entries[0].val.configSetting().stateArchivalSettings();
        networkMaxEntryTtl = settings.maxEntryTtl();
        return networkMaxEntryTtl;
    } catch {
        return MAX_TTL.persistent;
    }
}

/**
 * Checks network connectivity by pinging the Soroban RPC.
 * @returns {Promise<{connected: boolean, latestLedger: number|null, error: string|null}>}
 */
export async function checkNetworkStatus() {
    try {
        const ledger = await getLatestLedger();
        return {
            connected: true,
            latestLedger: ledger.sequence,
            error: null,
        };
    } catch (err) {
        return {
            connected: false,
            latestLedger: null,
            error: err.message || 'Unable to connect to Soroban RPC',
        };
    }
}

/**
 * Build a LedgerKey for a contract's instance storage.
 * Instance storage contains the contract instance and its WASM reference.
 * @param {string} contractId — C-encoded Stellar contract address
 * @returns {xdr.LedgerKey}
 */
export function buildInstanceLedgerKey(contractId) {
    const contractAddress = new Address(contractId);
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contractAddress.toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
        })
    );
}

/**
 * Build a LedgerKey for a specific contract data entry.
 * @param {string} contractId
 * @param {string} keySymbol — The symbol name of the key (e.g., "counter", "balance")
 * @param {'persistent'|'temporary'} storageType
 * @returns {xdr.LedgerKey}
 */
export function buildDataLedgerKey(contractId, keySymbol, storageType) {
    const contractAddress = new Address(contractId);
    const durability = storageType === 'temporary'
        ? xdr.ContractDataDurability.temporary()
        : xdr.ContractDataDurability.persistent();

    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contractAddress.toScAddress(),
            key: nativeToScVal(keySymbol, { type: 'symbol' }),
            durability,
        })
    );
}

/**
 * Calculate TTL health metrics for a ledger entry.
 * @param {number} liveUntilLedgerSeq — The ledger at which the entry expires
 * @param {number} currentLedger — The current ledger sequence
 * @param {'persistent'|'temporary'|'instance'} storageType
 * @returns {{remainingLedgers: number, healthPercentage: number, healthStatus: string, estimatedTimeLeft: string, isExpired: boolean}}
 */
export function calculateTTL(liveUntilLedgerSeq, currentLedger, storageType = 'persistent') {
    const remainingLedgers = Math.max(0, liveUntilLedgerSeq - currentLedger);
    const isExpired = remainingLedgers === 0;

    const maxTTL = storageType === 'temporary'
        ? MAX_TTL.temporary
        : (networkMaxEntryTtl || MAX_TTL.persistent);
    // Clamp to 100% — entry might have been extended beyond default max
    const healthPercentage = Math.min(100, (remainingLedgers / maxTTL) * 100);

    let healthStatus = 'healthy';
    if (isExpired) {
        healthStatus = 'expired';
    } else if (healthPercentage <= HEALTH_THRESHOLDS.critical) {
        healthStatus = 'critical';
    } else if (healthPercentage <= HEALTH_THRESHOLDS.warning) {
        healthStatus = 'warning';
    }

    // Estimate time left (1 ledger ≈ 5 seconds on testnet)
    const totalSeconds = remainingLedgers * 5;
    const estimatedTimeLeft = formatDuration(totalSeconds);

    return {
        remainingLedgers,
        healthPercentage,
        healthStatus,
        estimatedTimeLeft,
        isExpired,
    };
}

/**
 * Format seconds into a human-readable duration string.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return 'Expired';

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/**
 * Fetch TTL data for a contract's instance entry.
 * @param {string} contractId
 * @returns {Promise<Object>} The entry data with TTL metrics
 */
export async function fetchContractInstanceTTL(contractId) {
    const server = getServer();
    const ledgerKey = buildInstanceLedgerKey(contractId);

    const { sequence: currentLedger } = await getLatestLedger();
    const response = await server.getLedgerEntries(ledgerKey);

    if (!response.entries || response.entries.length === 0) {
        throw new Error(`Contract instance not found: ${contractId.substring(0, 10)}...`);
    }

    const entry = response.entries[0];
    const liveUntilLedgerSeq = entry.liveUntilLedgerSeq;

    if (liveUntilLedgerSeq === undefined || liveUntilLedgerSeq === null) {
        throw new Error('Entry does not have TTL information (liveUntilLedgerSeq is missing)');
    }

    const ttl = calculateTTL(liveUntilLedgerSeq, currentLedger, 'instance');

    return {
        contractId,
        keyName: 'Contract Instance',
        storageType: 'instance',
        currentLedger,
        liveUntilLedgerSeq,
        lastModifiedLedger: entry.lastModifiedLedgerSeq,
        ...ttl,
    };
}

/**
 * Fetch TTL data for a specific contract data key.
 * @param {string} contractId
 * @param {string} keySymbol
 * @param {'persistent'|'temporary'} storageType
 * @returns {Promise<Object>}
 */
export async function fetchContractDataTTL(contractId, keySymbol, storageType = 'persistent') {
    const server = getServer();
    const ledgerKey = buildDataLedgerKey(contractId, keySymbol, storageType);

    const { sequence: currentLedger } = await getLatestLedger();
    const response = await server.getLedgerEntries(ledgerKey);

    if (!response.entries || response.entries.length === 0) {
        throw new Error(`Data entry "${keySymbol}" not found for contract ${contractId.substring(0, 10)}...`);
    }

    const entry = response.entries[0];
    const liveUntilLedgerSeq = entry.liveUntilLedgerSeq;

    if (liveUntilLedgerSeq === undefined || liveUntilLedgerSeq === null) {
        throw new Error(`Entry "${keySymbol}" does not have TTL information`);
    }

    const ttl = calculateTTL(liveUntilLedgerSeq, currentLedger, storageType);

    return {
        contractId,
        keyName: keySymbol,
        storageType,
        currentLedger,
        liveUntilLedgerSeq,
        lastModifiedLedger: entry.lastModifiedLedgerSeq,
        ...ttl,
    };
}

/**
 * Fetch all monitored entries for a contract configuration.
 * Returns instance data + any additional key entries.
 * @param {{contractId: string, keys: Array<{name: string, type: string}>}} config
 * @returns {Promise<{contractId: string, entries: Array, error: string|null}>}
 */
export async function fetchAllContractEntries(config) {
    const { contractId, keys = [] } = config;
    const entries = [];
    let error = null;

    try {
        // Make sure health percentages use the real network max TTL
        await getMaxEntryTTL();

        // Always fetch the instance entry first
        const instanceEntry = await fetchContractInstanceTTL(contractId);
        entries.push(instanceEntry);

        // Fetch additional data keys
        for (const key of keys) {
            try {
                const dataEntry = await fetchContractDataTTL(contractId, key.name, key.type);
                entries.push(dataEntry);
            } catch (keyError) {
                entries.push({
                    contractId,
                    keyName: key.name,
                    storageType: key.type,
                    error: keyError.message,
                    healthStatus: 'error',
                });
            }
        }
    } catch (mainError) {
        error = mainError.message;
    }

    return { contractId, entries, error };
}

export { RPC_URL, NETWORK_PASSPHRASE, MAX_TTL, HEALTH_THRESHOLDS };
