import { rpc, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';

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
 * Data key config as stored for a monitored contract.
 * `kind` is missing on keys saved by older versions and defaults to 'symbol'.
 * @typedef {Object} KeyConfig
 * @property {string} name — symbol name, enum variant name, or base64 ScVal XDR (kind 'xdr')
 * @property {'persistent'|'temporary'} type — storage durability
 * @property {'symbol'|'enum'|'xdr'} [kind]
 * @property {string} [arg] — optional enum variant argument (kind 'enum')
 * @property {'address'|'symbol'|'string'|'u32'|'u64'|'i128'} [argType]
 */

/**
 * Convert a user-entered enum argument into an ScVal.
 * @param {string} value
 * @param {KeyConfig['argType']} argType
 * @returns {xdr.ScVal}
 */
function buildArgScVal(value, argType) {
    switch (argType) {
        case 'address':
            return new Address(value).toScVal();
        case 'u32': {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
                throw new Error(`"${value}" is not a valid u32`);
            }
            return nativeToScVal(n, { type: 'u32' });
        }
        case 'u64':
        case 'i128':
            return nativeToScVal(BigInt(value), { type: argType });
        case 'string':
            return nativeToScVal(value, { type: 'string' });
        case 'symbol':
        default:
            return nativeToScVal(value, { type: 'symbol' });
    }
}

/**
 * Build the ScVal a contract uses as the storage key.
 *
 * Soroban `#[contracttype]` enums are encoded as a Vec whose first element is
 * the variant name as a Symbol, followed by the variant's fields — so
 * `DataKey::Admin` is `Vec[Symbol("Admin")]` and `DataKey::Balance(addr)` is
 * `Vec[Symbol("Balance"), Address]`.
 *
 * @param {KeyConfig} key
 * @returns {xdr.ScVal}
 */
export function buildKeyScVal(key) {
    const kind = key.kind || 'symbol';
    if (kind === 'xdr') {
        return xdr.ScVal.fromXDR(key.name.trim(), 'base64');
    }
    if (kind === 'enum') {
        const parts = [nativeToScVal(key.name, { type: 'symbol' })];
        if (key.arg && key.arg.trim() !== '') {
            parts.push(buildArgScVal(key.arg.trim(), key.argType));
        }
        return xdr.ScVal.scvVec(parts);
    }
    return nativeToScVal(key.name, { type: 'symbol' });
}

/**
 * Human-readable label for a data key, e.g. "counter" or "Balance(GABC…WXYZ)".
 * @param {KeyConfig} key
 * @returns {string}
 */
export function formatKeyLabel(key) {
    const kind = key.kind || 'symbol';
    if (kind === 'xdr') {
        return `XDR ${key.name.trim().substring(0, 12)}…`;
    }
    if (kind === 'enum') {
        const arg = key.arg?.trim();
        if (!arg) return key.name;
        const shortArg = arg.length > 12 ? `${arg.substring(0, 4)}…${arg.substring(arg.length - 4)}` : arg;
        return `${key.name}(${shortArg})`;
    }
    return key.name;
}

/**
 * Build a LedgerKey for a specific contract data entry.
 * @param {string} contractId
 * @param {KeyConfig} key
 * @returns {xdr.LedgerKey}
 */
export function buildDataLedgerKey(contractId, key) {
    const contractAddress = new Address(contractId);
    const durability = key.type === 'temporary'
        ? xdr.ContractDataDurability.temporary()
        : xdr.ContractDataDurability.persistent();

    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contractAddress.toScAddress(),
            key: buildKeyScVal(key),
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

// --- Last-seen tracking ---
// Remembers the last known liveUntilLedgerSeq of every entry we have seen,
// so an entry that later disappears from the RPC can be reported as
// expired/archived rather than "not found".
const LAST_SEEN_STORAGE_KEY = 'stellar-sentry-last-seen';
let lastSeen = null;

function loadLastSeen() {
    if (lastSeen) return lastSeen;
    try {
        const saved = JSON.parse(localStorage.getItem(LAST_SEEN_STORAGE_KEY));
        lastSeen = saved && typeof saved === 'object' ? saved : {};
    } catch {
        lastSeen = {};
    }
    return lastSeen;
}

function rememberLastSeen(ledgerKeyXdr, liveUntilLedgerSeq) {
    const seen = loadLastSeen();
    if (seen[ledgerKeyXdr] === liveUntilLedgerSeq) return;
    seen[ledgerKeyXdr] = liveUntilLedgerSeq;
    try {
        localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(seen));
    } catch {
        // Storage unavailable — tracking only lasts for this session
    }
}

/**
 * Explain why an entry was not returned by the RPC.
 * @param {{storageType: string, keyName: string}} target
 * @param {number|undefined} lastLiveUntil — last known liveUntilLedgerSeq, if ever seen
 * @returns {{message: string, healthStatus: string}}
 */
function describeMissingEntry(target, lastLiveUntil) {
    const what = target.storageType === 'instance'
        ? 'Contract instance'
        : `Data entry "${target.keyName}"`;

    if (target.storageType === 'temporary') {
        return lastLiveUntil
            ? { healthStatus: 'archived', message: `${what} expired at ledger ${lastLiveUntil.toLocaleString()} and was deleted — temporary entries cannot be restored` }
            : { healthStatus: 'error', message: `${what} not found — check the key, or it has already expired (temporary entries are deleted on expiry)` };
    }

    return lastLiveUntil
        ? { healthStatus: 'archived', message: `${what} expired at ledger ${lastLiveUntil.toLocaleString()} and was archived — restore it with a RestoreFootprint transaction` }
        : { healthStatus: 'error', message: `${what} not found — it may not exist, or it has already expired and been archived` };
}

/**
 * Fetch all monitored entries for a contract configuration.
 * Returns instance data + any additional key entries, using a single
 * getLedgerEntries call for the whole contract.
 * @param {{contractId: string, keys: KeyConfig[]}} config
 * @returns {Promise<{contractId: string, entries: Array, error: string|null}>}
 */
export async function fetchAllContractEntries(config) {
    const { contractId, keys = [] } = config;

    try {
        // Make sure health percentages use the real network max TTL
        await getMaxEntryTTL();

        // One slot per displayed entry, in display order. Keys that can't be
        // encoded keep their slot with an error instead of a ledger key.
        const slots = [
            { keyName: 'Contract Instance', storageType: 'instance', keyConfig: null, ledgerKey: buildInstanceLedgerKey(contractId) },
            ...keys.map((key) => {
                const slot = { keyName: formatKeyLabel(key), storageType: key.type, keyConfig: key };
                try {
                    slot.ledgerKey = buildDataLedgerKey(contractId, key);
                } catch (err) {
                    slot.error = `Invalid key: ${err.message}`;
                }
                return slot;
            }),
        ];

        const ledgerKeys = slots.filter((s) => s.ledgerKey).map((s) => s.ledgerKey);
        const response = await getServer().getLedgerEntries(...ledgerKeys);
        const currentLedger = response.latestLedger;

        const found = new Map(
            (response.entries || []).map((entry) => [entry.key.toXDR('base64'), entry])
        );

        const entries = slots.map((slot) => {
            const base = {
                contractId,
                keyName: slot.keyName,
                storageType: slot.storageType,
                keyConfig: slot.keyConfig,
            };
            if (slot.error) {
                return { ...base, error: slot.error, healthStatus: 'error' };
            }

            const ledgerKeyXdr = slot.ledgerKey.toXDR('base64');
            const entry = found.get(ledgerKeyXdr);

            if (!entry || entry.liveUntilLedgerSeq === undefined || entry.liveUntilLedgerSeq === null) {
                const { message, healthStatus } = describeMissingEntry(slot, loadLastSeen()[ledgerKeyXdr]);
                return { ...base, error: message, healthStatus };
            }

            rememberLastSeen(ledgerKeyXdr, entry.liveUntilLedgerSeq);

            return {
                ...base,
                currentLedger,
                liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
                lastModifiedLedger: entry.lastModifiedLedgerSeq,
                ...calculateTTL(entry.liveUntilLedgerSeq, currentLedger, slot.storageType),
            };
        });

        // Without a live instance the contract is unusable — report it at card level
        if (entries[0].error) {
            return { contractId, entries: [], error: entries[0].error };
        }

        return { contractId, entries, error: null };
    } catch (err) {
        return { contractId, entries: [], error: err.message };
    }
}

export { RPC_URL, NETWORK_PASSPHRASE, MAX_TTL, HEALTH_THRESHOLDS };
