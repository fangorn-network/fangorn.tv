// Browser buyer flow: pay once per file, decrypt forever. Composes viem + Semaphore
// exactly like x402f/examples/node (paid.ts + settle.ts download half), but runs
// in the browser with the connected wallet and imports NO Fangorn SDK — the only
// SDK primitive the download needs is a SHA-256 hash, inlined here via WebCrypto.
//
//   register (facilitator /verify): EIP-3009 authorization + identity commitment
//   claim    (facilitator /settle):  Semaphore membership proof (scope=resourceId)
//   access   (worker /access):       stealth-signed request → worker releases DEK

import {
    bytesToHex, hexToBytes, encodePacked, keccak256, numberToHex, parseSignature, toBytes, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { unpack } from "./stream.js";

const NONCE_LEN = 12;

// Chunk addressing + AAD — MUST match server/settle.js byte for byte.
const chunkKey = (resourceId, i) =>
    i === 0 ? resourceId : keccak256(encodePacked(["bytes32", "uint32"], [resourceId, i]));
const aadFor = (i) => hexToBytes(numberToHex(i, { size: 4 }));

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return bytesToHex(new Uint8Array(digest));
}

const MEMBER_REGISTERED_EVENT = {
    name: "MemberRegistered",
    type: "event",
    inputs: [
        { name: "resourceId", type: "bytes32", indexed: true },
        { name: "identityCommitment", type: "uint256", indexed: false },
    ],
};

/**
 * The stealth key this identity settles `resourceId` with — the address the
 * settlement and the worker's /access gate are keyed on, so the buyer's main
 * wallet never appears in the settlement.
 *
 * The resourceId is mixed in, so a buyer gets a DIFFERENT address per resource.
 * It used to be derived from the secret scalar alone, which gave one buyer one
 * address forever: `settle` calldata is public, so anyone could enumerate the
 * chain and rebuild that buyer's whole purchase history under a stable
 * pseudonym. Payer↔reader was unlinkable; reader↔reader was not, and
 * co-purchase graphs re-identify. The anonymity set is now what §12 of
 * architecture.md always claimed — the buyers of one resource — and it no
 * longer leaks sideways into every other resource the same buyer touched.
 */
export function stealthFor(identity, resourceId) {
    const stealthKey = keccak256(
        encodePacked(
            ["string", "bytes32", "bytes32"],
            ["fangorn:stealth:", toHex(identity.secretScalar, { size: 32 }), resourceId],
        ),
    );
    return { stealthKey, stealthAddress: privateKeyToAccount(stealthKey).address };
}

/**
 * ONE buyer identity per wallet, from a single deterministic signature — a new
 * browser (or the agent, or a second machine) re-derives everything the wallet
 * already owns with no state to carry.
 *
 * The identity is wallet-wide; the ENTITLEMENT is per file. The registry used to
 * keep one Semaphore group for everything, so joining it once — for one file,
 * from one publisher — entitled the buyer to every file in the registry
 * forever. Each resource now has its own group, and this same commitment joins
 * each of them separately, once per purchase.
 */
export async function deriveBuyer(walletClient) {
    const account = walletClient.account;
    const signature = await walletClient.signMessage({ account, message: "fangorn:identity:v1" });
    return { identity: new Identity(keccak256(toBytes(signature))) };
}

/** Sign an EIP-3009 transferWithAuthorization for `amount` USDC, paying `to`. */
export async function signTransferAuth(walletClient, { to, amount, usdcAddress, usdcDomainName, usdcDomainVersion }) {
    const account = walletClient.account;
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));

    const signature = await walletClient.signTypedData({
        account,
        domain: { name: usdcDomainName, version: usdcDomainVersion, chainId: arbitrumSepolia.id, verifyingContract: usdcAddress },
        types: {
            TransferWithAuthorization: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore", type: "uint256" },
                { name: "nonce", type: "bytes32" },
            ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: account.address, to, value: amount, validAfter, validBefore, nonce },
    });

    const sig = parseSignature(signature);
    const v = Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0)));
    return { from: account.address, to, amount: amount.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce, v, r: sig.r, s: sig.s };
}

/**
 * Rebuild THIS resource's Semaphore group — every registration for it, in
 * emission order, or the merkle root won't match the one the contract verifies
 * against. `args` filters on the indexed resourceId topic; replaying other
 * resources' members would build a tree the registry has never seen.
 */
export async function loadGroup(publicClient, registry, resourceId) {
    const logs = await publicClient.getLogs({
        address: registry, event: MEMBER_REGISTERED_EVENT, args: { resourceId }, fromBlock: 0n,
    });
    const group = new Group();
    for (const log of logs) group.addMember(log.args.identityCommitment);
    return group;
}

/**
 * Has this wallet paid for THIS file? Membership in the resource's own group is
 * the entitlement, and it is per resource — one payment buys one file.
 *
 * It used to be a wallet-wide question, because there was a single group for the
 * whole registry: paying one publisher $0.10 entitled you to everything anyone
 * had ever published. Every publisher but the first was giving their work away.
 */
export async function hasPaid({ publicClient, registry, identity, resourceId }) {
    const group = await loadGroup(publicClient, registry, resourceId);
    return group.members.map(String).includes(identity.commitment.toString());
}

/**
 * Rebuild this resource's Semaphore group from on-chain events and prove
 * membership. Must run AFTER register.
 */
export async function buildSettleProof({ publicClient, registry, identity, resourceId, stealthAddress }) {
    const group = await loadGroup(publicClient, registry, resourceId);
    if (!group.members.map(String).includes(identity.commitment.toString())) {
        throw new Error("identity commitment not in group — was /verify (register) settled first?");
    }
    const proof = await generateProof(identity, group, BigInt(stealthAddress), BigInt(resourceId));
    return {
        resourceId, stealthAddress,
        merkleTreeDepth: proof.merkleTreeDepth.toString(),
        merkleTreeRoot: proof.merkleTreeRoot.toString(),
        nullifier: proof.nullifier.toString(),
        message: proof.message.toString(),
        points: proof.points.map(String),
        hookData: "0x",
    };
}

// The message the worker recovers the settling address from — must match the
// worker's buildMessageHash byte-for-byte:
//   keccak256(abi.encodePacked(uint256 nullifier, bytes32 resourceId, uint64 timestamp))
function accessMessageHash(nullifier, resourceId, timestamp) {
    return keccak256(encodePacked(["uint256", "bytes32", "uint64"], [BigInt(nullifier), resourceId, BigInt(timestamp)]));
}

/** The settlement-gated DEK. Signs an /access request with the stealth key (the
 *  address the worker checks settlement for) and gets the unsealed DEK back. */
export async function fetchDek({ resourceId, workerUrl, stealthKey, nullifier }) {
    const signer = privateKeyToAccount(stealthKey);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signer.signMessage({ message: { raw: accessMessageHash(nullifier, resourceId, timestamp) } });

    const res = await fetch(`${workerUrl}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nullifier, resourceId, timestamp, signature }),
    });
    if (!res.ok) throw new Error(`/access failed: ${res.status} ${await res.text()}`);
    return hexToBytes((await res.json()).dek);
}

/** The R2 keys for every chunk, in order — precomputed here because the service
 *  worker has no bundler and therefore no keccak. */
export const chunkKeysFor = (resourceId, chunks) =>
    Array.from({ length: chunks }, (_, i) => chunkKey(resourceId, i));

/**
 * Settlement-gated download + decrypt. Signs an /access request with the stealth
 * key (the address the worker checks settlement for), gets the unsealed DEK once,
 * then pulls the video's `chunks` ciphertext objects and decrypts each locally.
 *
 * @returns Blob — each chunk is handed to a Blob as soon as it decrypts, so the
 *          browser can spill it to disk and a multi-GB video never sits whole in
 *          the JS heap.
 */
export async function downloadAndDecrypt({ resourceId, workerUrl, stealthKey, nullifier, expectedPlaintextHash, chunks = 1, mime = "video/mp4", onStage }) {
    const signer = privateKeyToAccount(stealthKey);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signer.signMessage({ message: { raw: accessMessageHash(nullifier, resourceId, timestamp) } });

    const accessRes = await fetch(`${workerUrl}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nullifier, resourceId, timestamp, signature }),
    });
    if (!accessRes.ok) throw new Error(`/access failed: ${accessRes.status} ${await accessRes.text()}`);
    const { dek } = await accessRes.json();

    const aesKey = await crypto.subtle.importKey("raw", hexToBytes(dek), "AES-GCM", false, ["decrypt"]);

    const parts = [];
    for (let i = 0; i < chunks; i++) {
        if (chunks > 1) onStage?.(`decrypting… chunk ${i + 1}/${chunks}`);
        const ctRes = await fetch(`${workerUrl}/ct/${chunkKey(resourceId, i)}`);
        if (!ctRes.ok) throw new Error(`/ct chunk ${i + 1}/${chunks} failed: ${ctRes.status}`);
        const ciphertext = new Uint8Array(await ctRes.arrayBuffer());

        // GCM's tag authenticates the bytes and the AAD authenticates the index,
        // so a swapped, dropped or duplicated chunk throws here rather than
        // silently producing a scrambled video.
        const plaintext = await unpack(new Uint8Array(await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: ciphertext.subarray(0, NONCE_LEN), additionalData: aadFor(i) },
            aesKey,
            ciphertext.subarray(NONCE_LEN),
        )));

        // ponytail: whole-file hash only for single-chunk videos — verifying a
        // chunked one means holding it all in memory, which is what chunking
        // exists to avoid. Per-chunk GCM + the on-chain chunk count cover
        // tampering; add per-chunk hashes to the vertex payload if you want the
        // publisher's own hash re-checked end to end.
        if (chunks === 1 && expectedPlaintextHash && (await sha256Hex(plaintext)) !== expectedPlaintextHash) {
            throw new Error("plaintext hash mismatch — got the wrong data back");
        }
        parts.push(new Blob([plaintext]));
    }
    return new Blob(parts, { type: mime });
}

// Self-check: `node src/pay/buy.js`. Covers identity derivation and the entitlement
// lookup — between them they decide whether a buyer is charged, charged twice, or
// blocked from buying at all. Both have been wrong once already.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) void (async () => {
    // A fake wallet: same signature every time, which is what makes identities
    // deterministic across browsers.
    const wallet = (sig) => ({ account: { address: `0x${"11".repeat(20)}` }, signMessage: async () => sig });
    const alice = wallet(`0x${"7f".repeat(65)}`), bob = wallet(`0x${"3c".repeat(65)}`);

    const a1 = await deriveBuyer(alice);
    const a2 = await deriveBuyer(alice);
    const b = await deriveBuyer(bob);

    if (a1.identity.commitment !== a2.identity.commitment) throw new Error("same wallet must re-derive the same identity, on any machine");
    const rid1 = keccak256(toBytes("resource-one"));
    const rid2 = keccak256(toBytes("resource-two"));
    if (stealthFor(a1.identity, rid1).stealthAddress !== stealthFor(a2.identity, rid1).stealthAddress)
        throw new Error("stealth address must be deterministic — it's what settlement is keyed on");
    if (stealthFor(a1.identity, rid1).stealthAddress === stealthFor(a1.identity, rid2).stealthAddress)
        throw new Error("stealth address must differ per resource — one address per buyer leaks their whole purchase history");
    if (a1.identity.commitment === b.identity.commitment) throw new Error("different wallets must get different identities");

    // The entitlement is per FILE: each resource has its own Semaphore group, so
    // paying for one file entitles the buyer to that file and nothing else. The
    // stub answers only for the resource actually asked about — a `hasPaid` that
    // ignored the filter would pass this test and charge nobody for file two.
    const BOUGHT = `0x${"aa".repeat(32)}`, OTHER = `0x${"bb".repeat(32)}`;
    const publicClient = {
        getLogs: async ({ args }) =>
            args?.resourceId === BOUGHT ? [{ args: { identityCommitment: a1.identity.commitment } }] : [],
    };
    const paid = (identity, resourceId) => hasPaid({ publicClient, registry: "0x0", identity, resourceId });

    if (!(await paid(a1.identity, BOUGHT))) throw new Error("a file already paid for must NOT be charged again");
    if (await paid(a1.identity, OTHER)) throw new Error("paying for one file must not unlock another — that was the v1 paywall bypass");
    if (await paid(b.identity, BOUGHT)) throw new Error("a wallet that never paid is not entitled");

    console.log("buy.js self-check ok — wallet-wide identity, per-file entitlement");
})();
