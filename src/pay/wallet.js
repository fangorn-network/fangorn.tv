// Browser wallet via viem. The server never holds a key; this wallet signs
// everything — the publisher's createResource/commit txs AND the buyer's
// payment/settlement.
//
// Two ways in, ONE output shape. Both an injected extension (window.ethereum)
// and a Privy embedded/email wallet hand over an EIP-1193 provider, so
// walletFromProvider() is the whole integration: everything downstream only ever
// sees { address, walletClient } and cannot tell the two apart.
//
// Buyers never need gas — src/pay/buy.js only signMessage()s a stealth identity and
// signTypedData()s an EIP-3009 authorization, and the facilitator submits. So a
// freshly minted embedded wallet with 0 ETH can buy and watch end to end.
// Publishers still send real txs (createResource, commitStateRoot) and still
// need a funded account.

import { createWalletClient, createPublicClient, custom, fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { api } from "../catalog/api.js";

const PUBLIC_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const RPC_URL = import.meta.env.VITE_CHAIN_RPC_URL ?? PUBLIC_RPC;

/**
 * Configured RPC first, the public Arbitrum endpoint behind it — because no single
 * provider serves both halves of this app.
 *
 * Metered providers cap historical range: Alchemy's free tier refuses eth_getLogs
 * over more than 10 blocks ("JSON is not a valid request object"), and buy.js
 * rebuilds a resource's Semaphore group with a `fromBlock: 0n` scan on EVERY
 * purchase — hasPaid and buildSettleProof both route through loadGroup. The scan
 * is now filtered to one resource's members, but the BLOCK RANGE is what those
 * providers object to, and that is still all of history. So a metered key alone
 * means no one can buy anything. The public endpoint answers wide scans but gets
 * flaky under load, which is why it isn't the primary.
 *
 * viem's fallback moves to the next transport on any non-user-rejection error, so
 * the range refusal is what demotes the scan — ordinary calls never leave the
 * configured provider.
 */
const RPCS = [...new Set([RPC_URL, PUBLIC_RPC])];

export const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: RPCS.length > 1 ? fallback(RPCS.map((u) => http(u))) : http(RPCS[0]),
});

/**
 * Send a tx with our own fee estimate instead of the wallet's. MetaMask quotes
 * the base fee of the block it saw; Arbitrum's moves between quote and inclusion
 * and the tx bounces with "max fee per gas less than block base fee".
 * ponytail: flat 2x headroom on maxFeePerGas — you only ever pay base + tip, so
 * overshooting costs nothing. Move to a percentile estimate if that stops holding.
 */
export async function sendTx(walletClient, tx) {
    const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
    return walletClient.sendTransaction({ ...tx, maxFeePerGas: maxFeePerGas * 2n, maxPriorityFeePerGas });
}

/**
 * EIP-1193 provider → { address, walletClient } on Arbitrum Sepolia.
 *
 * Shared by both sign-in paths. `address` is passed in when the caller already
 * knows it (Privy names the wallet it handed us); otherwise we ask the provider,
 * which is what prompts an extension for accounts.
 */
export async function walletFromProvider(eth, address = null) {
    if (!eth) throw new Error("No wallet provider.");
    if (!address) [address] = await eth.request({ method: "eth_requestAccounts" });
    const chainIdHex = `0x${arbitrumSepolia.id.toString(16)}`;
    try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (e) {
        if (e?.code === 4902) {
            await eth.request({
                method: "wallet_addEthereumChain",
                params: [{
                    chainId: chainIdHex,
                    chainName: "Arbitrum Sepolia",
                    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                    rpcUrls: [RPC_URL],
                    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
                }],
            });
        } else if (e?.code !== 4001) {
            throw e;
        }
    }
    const walletClient = createWalletClient({ account: address, chain: arbitrumSepolia, transport: custom(eth) });
    return { address, walletClient };
}

/** Prompt the injected extension (MetaMask etc.). */
export function connectWallet() {
    if (!window.ethereum) throw new Error("No injected wallet found — install MetaMask, or sign in with email.");
    return walletFromProvider(window.ethereum);
}

/**
 * Sign in to the relay: fetch a server-authored SIWE message, sign it, trade the
 * signature for a session token. Staging is scoped to the address that signs
 * here, so this is what stops one publisher seeing another's unreleased library.
 *
 * Costs one signature, no gas. Kept separate from connectWallet() so the Watch
 * tab still works with a bare connection — buyers never touch the relay's
 * authenticated routes.
 */
export async function signIn(walletClient, address) {
    const { nonce, message } = await api.sessionNonce(address);
    const signature = await walletClient.signMessage({ account: address, message });
    const { token } = await api.session(nonce, signature);
    api.setToken(token);
    return token;
}
