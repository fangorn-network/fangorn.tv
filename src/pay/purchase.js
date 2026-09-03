// One-call "watch this episode": pay once (if needed), then decrypt. Wraps the
// x402f register→settle→access flow (src/pay/buy.js) around the facilitator, with a
// pay-once short-circuit — if the buyer's stealth address is already settled for
// this resource we skip straight to decrypt, no second payment.

import { bytesToHex, toHex } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { deriveBuyer, stealthFor, hasPaid, signTransferAuth, buildSettleProof, downloadAndDecrypt } from "./buy.js";
import { mimeFor } from "../catalog/browse.js";
import { openStream } from "./stream.js";

// Every one of these MUST be written out as a literal `import.meta.env.VITE_…`.
// Vite inlines that exact text at build time and nothing else: alias the env
// object (`const env = import.meta.env`) and a production bundle gets the runtime
// object, which carries MODE/DEV/PROD/BASE_URL and no VITE_* at all. That failed
// as `address: undefined` → an eth_call with no `to` → "invalid opcode: DATASIZE",
// and only ever in built bundles, never in dev.
export const CFG = {
    // default is the vite dev-server proxy path (see vite.config.js) — the
    // facilitator itself sends no CORS headers, so don't hit it cross-origin.
    facilitator: (import.meta.env.VITE_FACILITATOR_URL ?? "/facilitator").replace(/\/$/, ""),
    settlementRegistry: import.meta.env.VITE_SETTLEMENT_REGISTRY_ADDR,
    usdc: import.meta.env.VITE_USDC_CONTRACT_ADDR,
    usdcName: import.meta.env.VITE_USDC_DOMAIN_NAME ?? "USD Coin",
    namespace: import.meta.env.VITE_NAMESPACE ?? "sond3r",
};

// Fail loudly at the top of a purchase rather than deep inside viem. A missing
// address here means the image was built without the VITE_* pair — a rebuild,
// not a restart (see DEPLOY.md, "build-time vs runtime").
function assertConfigured() {
    const missing = Object.entries({
        VITE_SETTLEMENT_REGISTRY_ADDR: CFG.settlementRegistry,
        VITE_USDC_CONTRACT_ADDR: CFG.usdc,
    }).filter(([, v]) => !/^0x[0-9a-fA-F]{40}$/.test(v ?? "")).map(([k]) => k);
    if (missing.length) throw new Error(`this build is missing ${missing.join(", ")} — rebuild the bundle with those set`);
}

const SETTLEMENT_ABI = [
    { type: "function", name: "isSettled", stateMutability: "view", inputs: [{ name: "stealth", type: "address" }, { name: "resource_id", type: "bytes32" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "getPrice", stateMutability: "view", inputs: [{ name: "resource_id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "getOwner", stateMutability: "view", inputs: [{ name: "resource_id", type: "bytes32" }], outputs: [{ type: "address" }] },
    { type: "function", name: "isDisabled", stateMutability: "view", inputs: [{ name: "resource_id", type: "bytes32" }], outputs: [{ type: "bool" }] },
];

// POST the facilitator's x402 wire shape; Fangorn fields ride in `extra`.
async function postExtra(baseUrl, path, extra) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
            { paymentPayload: { x402Version: 2 }, paymentRequirements: { scheme: "exact", network: `eip155:${arbitrumSepolia.id}`, extra } },
            (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
    });
    // NOT res.json(). When this origin doesn't proxy /facilitator (vite preview,
    // a static host, a relay with no FACILITATOR_URL) the SPA fallback answers
    // with index.html and a bare .json() dies as `Unexpected token '<'`, naming
    // nothing. Say which URL answered with what instead.
    const text = await res.text();
    try { return JSON.parse(text); } catch {
        throw new Error(`${baseUrl}${path} answered ${res.status} with ${res.headers.get("content-type") ?? "no content-type"}, not JSON — this origin isn't proxying the facilitator`);
    }
}

/**
 * Poll `isSettled` — the exact read the access gate makes before releasing a DEK.
 *
 * ponytail: 4 tries over ~4.5s. The facilitator already waited for the receipt,
 * so this is only covering a public RPC that hasn't caught up, not a pending tx.
 */
async function confirmSettled({ publicClient, stealthAddress, resourceId }) {
    for (let i = 0; i < 4; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        const ok = await publicClient.readContract({
            address: CFG.settlementRegistry, abi: SETTLEMENT_ABI, functionName: "isSettled", args: [stealthAddress, resourceId],
        }).catch(() => false);
        if (ok) return true;
    }
    return false;
}

/**
 * @param episode { resourceId, workerUrl, price, plaintextHash, chunks, size?, chunkSize? }
 * @param onStage optional (label) => void progress callback
 * @returns { url, streaming } — `url` goes straight into <video src>. Streaming
 *          URLs are served by the service worker and must be released with
 *          closeStream(); blob: URLs with URL.revokeObjectURL().
 */
// The payment recipient is NOT a parameter: it is read from the registry.
export async function watchEpisode({ walletClient, publicClient, episode, onStage }) {
    assertConfigured();
    const { resourceId, workerUrl, price, plaintextHash, chunks } = episode;
    const say = (s) => onStage?.(s);
    const read = (functionName, args) =>
        publicClient.readContract({ address: CFG.settlementRegistry, abi: SETTLEMENT_ABI, functionName, args });

    // Price first: it decides whether any of the payment machinery runs at all.
    const [onChainPrice, disabled] = await Promise.all([
        read("getPrice", [resourceId]),
        read("isDisabled", [resourceId]),
    ]);

    // Taken down. The worker refuses the DEK for a disabled resource even to
    // someone who already paid, so there is nothing to buy and nothing to play —
    // say so before asking anyone to sign anything.
    if (disabled) throw new Error("this file has been taken down by its publisher");

    const nfKey = `${CFG.namespace}:nf:${resourceId}`;
    const randomU256 = () => BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))).toString();

    // Free means free. The worker's access gate short-circuits on `price == 0`
    // (see verify() in webworker/fangorn-access-worker) and hands the DEK to any valid
    // signature, settled or not — so there is nothing to register, nothing to
    // settle, and no wallet to connect: an ephemeral key signs /access and is
    // thrown away. The price comes from the registry, never the catalog, so a
    // poisoned index can't turn a paid file into a free one.
    const free = onChainPrice === 0n;
    let stealthKey = free ? toHex(crypto.getRandomValues(new Uint8Array(32))) : null;
    let nullifier = free ? randomU256() : localStorage.getItem(nfKey);
    let settled = free;
    let identity, stealthAddress;

    if (!free) {
        say("deriving buyer identity…");
        ({ identity } = await deriveBuyer(walletClient));
        // Per resource, not per buyer: see stealthFor() in buy.js.
        ({ stealthKey, stealthAddress } = stealthFor(identity, resourceId));
        settled = await read("isSettled", [stealthAddress, resourceId]);
    }

    if (!free && !settled) {
        // register() joins THIS resource's group, once per (file, wallet) — a
        // repeat reverts as AlreadyRegistered. So a buyer pays once per file, and
        // a file already paid for skips straight to settle.
        if (!(await hasPaid({ publicClient, registry: CFG.settlementRegistry, identity, resourceId }))) {
            // NEVER sign for a price OR a payee the catalog handed us. The
            // shard/graph is a convenience index (and with cross-publisher
            // aggregation, one we didn't build), so both come from the contract:
            // a poisoned index can neither overcharge nor redirect a payment.
            // The registry pays `resource_owners[resourceId]` regardless of what
            // we sign, so signing to anyone else just fails the transfer.
            const onChainOwner = await read("getOwner", [resourceId]);
            if (price != null && BigInt(price) !== onChainPrice) {
                onStage?.(`price is ${Number(onChainPrice) / 1e6} USDC on-chain (listed ${Number(price) / 1e6})`);
            }
            say("signing payment…");
            const payment = await signTransferAuth(walletClient, {
                to: onChainOwner, amount: onChainPrice, usdcAddress: CFG.usdc, usdcDomainName: CFG.usdcName, usdcDomainVersion: "2",
            });
            say("registering (paying owner)…");
            const verify = await postExtra(CFG.facilitator, "/verify", { resourceId, identityCommitment: identity.commitment.toString(), payment });
            if (!verify.isValid) throw new Error(`register failed: ${verify.invalidReason ?? "unknown"}`);
        }

        say("proving membership (settle)…");
        const proof = await buildSettleProof({ publicClient, registry: CFG.settlementRegistry, identity, resourceId, stealthAddress });
        const settle = await postExtra(CFG.facilitator, "/settle", proof);
        if (!settle.success) throw new Error(`settle failed: ${settle.errorReason ?? "unknown"}`);

        // Trust the chain, not the receipt. A facilitator that waits for a receipt
        // without checking `status` reports a REVERTED settle as a success — viem
        // resolves on a revert rather than throwing — and the only symptom is the
        // access gate answering "not settled" two steps later, naming nothing.
        // This is also the RPC-lag guard: the gate reads state, so we must too.
        if (!(await confirmSettled({ publicClient, stealthAddress, resourceId }))) {
            throw new Error(
                `settle didn't take: the facilitator reported success but ${resourceId.slice(0, 10)}… is still unsettled on-chain` +
                `${settle.transaction && settle.transaction !== "0x" ? ` — check tx ${settle.transaction}` : ""}.`,
            );
        }
        nullifier = settle.extensions.nullifier;
        localStorage.setItem(nfKey, nullifier);
    }

    // Already settled with no cached nullifier (e.g. a wiped cache): the /access
    // gate keys on the stealth address, so any U256 nullifier works.
    if (!nullifier) nullifier = randomU256();

    // Stream when the pointer carries the byte geometry: the service worker
    // decrypts chunk-on-demand, so playback starts in seconds instead of after the
    // whole file. Anything older falls back to decrypt-it-all.
    // Resolve the Content-Type ONCE, here, and hand the same answer to both paths.
    // A blob typed application/octet-stream doesn't play no matter which element
    // points at it, and neither does a stream the worker labels that way — so a
    // pointer whose mime shrugged (or predates the mime table) is unplayable
    // unless the extension gets a say. Media picks its element the same way.
    const mime = mimeFor(episode) || "video/mp4";

    const nullifierHex = toHex(BigInt(nullifier));
    const owned = free ? "free — " : settled ? "already owned — " : "";
    say(`${owned}streaming…`);
    try {
        const url = await openStream({ episode: { ...episode, mime }, stealthKey, nullifier: nullifierHex });
        if (url) return { url, streaming: true };
    } catch (err) {
        // A broken service worker must not cost someone a video they paid for —
        // but falling back silently reads as "streaming is just slow", so say it
        // in the UI, not only the console.
        console.warn("NO STREAMING — falling back to full download:", err.message);
        say(`no streaming (${err.message}) — decrypting whole file…`);
    }

    say(`${owned}decrypting…`);
    const blob = await downloadAndDecrypt({ resourceId, workerUrl, stealthKey, nullifier: nullifierHex, expectedPlaintextHash: plaintextHash, chunks, mime, onStage });
    return { url: URL.createObjectURL(blob), streaming: false };
}
