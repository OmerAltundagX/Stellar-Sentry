/**
 * Stellar Sentry — Freighter Wallet Integration Service
 *
 * Provides wallet connectivity and TTL extension capabilities
 * via the Freighter browser extension.
 *
 * Prerequisites:
 *  - User must have Freighter wallet extension installed
 *  - @stellar/freighter-api must be installed
 */

import {
    isConnected,
    isAllowed,
    requestAccess,
    getAddress,
    signTransaction,
} from '@stellar/freighter-api';

import {
    TransactionBuilder,
    SorobanDataBuilder,
    Operation,
    rpc,
    xdr,
} from '@stellar/stellar-sdk';

import {
    RPC_URL,
    NETWORK_PASSPHRASE,
    getMaxEntryTTL,
    buildInstanceLedgerKey,
    buildDataLedgerKey,
} from './stellarService.js';

/**
 * Check if the Freighter extension is installed and available.
 * @returns {Promise<boolean>}
 */
export async function isFreighterInstalled() {
    try {
        const { isConnected: connected } = await isConnected();
        return !!connected;
    } catch {
        return false;
    }
}

/**
 * Connect to Freighter and retrieve the user's public key.
 * @returns {Promise<{publicKey: string|null, error: string|null}>}
 */
export async function connectWallet() {
    try {
        const installed = await isFreighterInstalled();
        if (!installed) {
            return {
                publicKey: null,
                error: 'Freighter wallet extension is not installed. Please install it from freighter.app',
            };
        }

        // Check if the app is already allowed; requestAccess prompts the user
        // and returns the address once access is granted
        const { isAllowed: allowed } = await isAllowed();
        const access = allowed ? await getAddress() : await requestAccess();

        if (access.error) {
            throw new Error(access.error.message || 'Access to Freighter was denied');
        }
        if (!access.address) {
            throw new Error('Freighter did not return an address — is the wallet unlocked?');
        }

        return { publicKey: access.address, error: null };
    } catch (err) {
        return {
            publicKey: null,
            error: err.message || 'Failed to connect to Freighter wallet',
        };
    }
}

// How long to wait for a submitted transaction to be confirmed
const TX_POLL_INTERVAL_MS = 2000;
const TX_POLL_TIMEOUT_MS = 60_000;

/**
 * Build the ledger keys whose TTL should be extended.
 *
 * For the contract instance this includes the contract's WASM code entry as
 * well — if the code expires the contract is unusable even when the instance
 * is still live. Stellar Asset Contracts have no code entry.
 *
 * @param {rpc.Server} server
 * @param {string} contractId
 * @param {import('./stellarService.js').KeyConfig|null} dataKey — null for the instance
 * @returns {Promise<xdr.LedgerKey[]>}
 */
async function buildFootprintKeys(server, contractId, dataKey) {
    if (dataKey) {
        return [buildDataLedgerKey(contractId, dataKey)];
    }

    const instanceKey = buildInstanceLedgerKey(contractId);
    const response = await server.getLedgerEntries(instanceKey);
    if (!response.entries || response.entries.length === 0) {
        throw new Error('Contract instance not found (it may be archived)');
    }

    const executable = response.entries[0].val.contractData().val().instance().executable();
    if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
        return [instanceKey];
    }

    const codeKey = xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: executable.wasmHash() })
    );
    return [instanceKey, codeKey];
}

/**
 * Build and sign a transaction to extend the TTL of a contract instance
 * (plus its WASM code) or of a single contract data entry.
 *
 * This function:
 * 1. Builds a transaction with Operation.extendFootprintTtl
 * 2. Simulates it via the Soroban RPC to calculate resource fees
 * 3. Sends it to Freighter for the user to sign
 * 4. Submits the signed transaction to the network and waits for it
 *
 * @param {string} contractId — The contract whose TTL to extend
 * @param {number} extendToLedgers — Ledgers past the current ledger to extend to
 *   (clamped to the network's maximum entry TTL)
 * @param {string} signerPublicKey — The user's public key (from Freighter)
 * @param {import('./stellarService.js').KeyConfig|null} [dataKey] — data entry to extend; omit for the instance
 * @returns {Promise<{success: boolean, txHash: string|null, error: string|null}>}
 */
export async function extendContractTTL(contractId, extendToLedgers, signerPublicKey, dataKey = null) {
    try {
        const server = new rpc.Server(RPC_URL, { allowHttp: false });
        const account = await server.getAccount(signerPublicKey);

        // Entries can't live past maxEntryTtl - 1 ledgers; asking for more
        // only inflates the simulated resource fee
        const maxEntryTtl = await getMaxEntryTTL();
        const extendTo = Math.min(Math.floor(extendToLedgers), maxEntryTtl - 1);

        const footprintKeys = await buildFootprintKeys(server, contractId, dataKey);

        // Build the soroban data with footprint using SorobanDataBuilder
        const sorobanData = new SorobanDataBuilder()
            .setFootprint(footprintKeys, [])
            .build();

        // Build the transaction
        const tx = new TransactionBuilder(account, {
            fee: '100000', // 0.01 XLM base fee — simulation will adjust
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(Operation.extendFootprintTtl({ extendTo }))
            .setSorobanData(sorobanData)
            .setTimeout(300)
            .build();

        // Simulate to get the proper resource fees
        const simulated = await server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(simulated)) {
            throw new Error(`Simulation failed: ${simulated.error}`);
        }

        // Assemble the transaction with proper fees from simulation
        const preparedTx = rpc.assembleTransaction(tx, simulated).build();

        // Send to Freighter for signing
        const signed = await signTransaction(preparedTx.toXDR(), {
            networkPassphrase: NETWORK_PASSPHRASE,
            address: signerPublicKey,
        });
        if (signed.error) {
            throw new Error(signed.error.message || 'Transaction signing was rejected');
        }

        // Submit the signed transaction
        const signedTx = TransactionBuilder.fromXDR(signed.signedTxXdr, NETWORK_PASSPHRASE);
        const sendResponse = await server.sendTransaction(signedTx);

        // PENDING and DUPLICATE mean the network has the transaction;
        // ERROR and TRY_AGAIN_LATER mean it was not accepted.
        if (sendResponse.status === 'ERROR') {
            throw new Error(`Transaction submission failed: ${sendResponse.errorResult?.result().switch().name || 'unknown error'}`);
        }
        if (sendResponse.status === 'TRY_AGAIN_LATER') {
            throw new Error('Network is busy — transaction was not accepted, please try again');
        }

        // Poll for completion
        // After sendTransaction, we poll getTransaction which returns:
        //   'NOT_FOUND' — still processing
        //   'SUCCESS'   — completed successfully
        //   'FAILED'    — transaction failed
        const deadline = Date.now() + TX_POLL_TIMEOUT_MS;
        let result = await server.getTransaction(sendResponse.hash);
        while (result.status === 'NOT_FOUND') {
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for transaction ${sendResponse.hash.substring(0, 12)}... — check it on a block explorer`);
            }
            await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL_MS));
            result = await server.getTransaction(sendResponse.hash);
        }

        if (result.status === 'SUCCESS') {
            return { success: true, txHash: sendResponse.hash, error: null };
        } else {
            throw new Error(`Transaction failed with status: ${result.status}`);
        }
    } catch (err) {
        return {
            success: false,
            txHash: null,
            error: err.message || 'Failed to extend contract TTL',
        };
    }
}
