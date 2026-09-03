// Publishing, from the browser. The relay never sees a plaintext byte.
//
// This is the browser twin of server/settle.js's encryptAndUpload, and the two
// exist for the same reason src/pay/buy.js and the SDK's buyer half both exist: the
// bytes belong to whoever owns them, and the shortest path from a publisher's
// disk to their OWN Cloudflare R2 does not go through anyone's server. A hosted
// relay that staged files would need disk sized to its publishers, RAM sized to
// their largest video, and would be holding unreleased work it has no business
// holding.
//
// It is not a second implementation of the envelope. Every constant that has to
// match the buyer comes from src/pay/envelope.js, which server/settle.js imports too.
//
// ponytail: chunks go up one at a time, no parallelism. Cloudflare's 100MB body
// cap is what sets CHUNK_SIZE, and a publisher's uplink is the bottleneck long
// before request concurrency is. Upgrade path if that stops being true: the
// chunk loop is index-addressed, so a bounded pool is a change to this function
// and nothing else.
import { sha256 } from "@noble/hashes/sha2.js";
// The deep path, not the package root: @fangorn-network/sdk's index pulls in fs
// and LMDB (see vite.config.js). This module is pure noble + viem and bundles
// clean for the browser.
import { seal } from "@fangorn-network/sdk/lib/crypto/encryption.js";
import { bytesToHex, keccak256, stringToBytes } from "viem";
import { CHUNK_SIZE, NONCE_LEN, aadFor, chunkKey, getWorkerPubkey, pack, putChunk } from "./envelope.js";

/**
 * Envelope-encrypt a File and upload it chunk by chunk to the publisher's own
 * access worker. Only ever holds one chunk in memory, so the ceiling is
 * CHUNK_SIZE and not the size of the video.
 *
 * @returns { plaintextHash, chunks, size, chunkSize } — the same shape
 *          server/settle.js returns, because the relay's commit path consumes it
 *          identically whichever side produced it.
 */
export async function encryptAndUpload({ file, resourceId, workerUrl, uploadToken, chunkSize = CHUNK_SIZE, onProgress }) {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
    const sealedDek = bytesToHex(seal(dek, await getWorkerPubkey(workerUrl), resourceId));

    const size = file.size;
    const chunks = Math.max(1, Math.ceil(size / chunkSize));
    // WebCrypto's digest() is one-shot, so hashing a 3GB file with it means
    // holding 3GB. noble's is incremental and takes the same slices the upload
    // loop already reads.
    const hash = sha256.create();

    for (let i = 0; i < chunks; i++) {
        const plain = new Uint8Array(await file.slice(i * chunkSize, (i + 1) * chunkSize).arrayBuffer());
        hash.update(plain);

        const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
        const aesCt = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aadFor(i) }, aesKey, await pack(plain)),
        );
        const body = new Uint8Array(NONCE_LEN + aesCt.length);
        body.set(nonce, 0);
        body.set(aesCt, NONCE_LEN);

        await putChunk({ workerUrl, uploadToken, key: chunkKey(resourceId, i), body, sealedDek });
        onProgress?.(i + 1, chunks);
    }
    return { plaintextHash: bytesToHex(hash.digest()), chunks, size, chunkSize };
}

// ── the publisher's manifest, in the publisher's own bucket ───────────────────
//
// uid↔path, prices, descriptions and published pointers. It is the one piece of
// per-publisher state that has to survive, because the uid is what keeps a file's
// PAID identity stable across a rename — lose it and re-publishing mints a new
// resourceId, and everyone who already bought the file loses access to it.
//
// It lives in the publisher's R2, not on the relay, so that a hosted relay is
// genuinely stateless and a publisher's library follows them to another machine.
// Stored with no sealed DEK, so the worker's /access gate has nothing to release
// even to someone who somehow paid for this key: see handleUpload in the worker.

/** R2 key for `owner`'s manifest. A bytes32, because that is the only key shape
 *  the worker accepts — see isObjectKey. */
export const manifestKey = (owner) => keccak256(stringToBytes(`sond3r:manifest:${owner.toLowerCase()}`));

const EMPTY = { files: {} };

/** Read `owner`'s manifest back. A worker that has never seen one answers 404,
 *  which is the ordinary first-publish state, not an error. */
export async function readManifest({ workerUrl, uploadToken, owner }) {
    const res = await fetch(`${workerUrl}/upload/${manifestKey(owner)}`, {
        headers: uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {},
    });
    if (res.status === 404) return { ...EMPTY };
    if (!res.ok) throw new Error(`could not read your library manifest from ${workerUrl}: ${res.status} ${await res.text()}`);
    try {
        return JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
    } catch {
        // Better to say so than to hand back an empty manifest, which would look
        // like an empty library and re-mint every uid on the next publish.
        throw new Error(`your library manifest at ${workerUrl} is corrupt — it did not parse as JSON`);
    }
}

/**
 * Rebuild manifest entries from a publisher's own on-chain library tree.
 *
 * The manifest is a CACHE of something already public — the commit graph carries
 * every published file's path, price, description and purchase pointer — so an
 * empty bucket is recoverable rather than fatal. That matters for a publisher
 * who published before the manifest moved into R2, and for anyone opening the
 * portal in a browser that has never seen this wallet.
 *
 * Two things it deliberately does not recover:
 *
 *  - `uid`. resourceId is keccak(owner ++ keccak("sond3r:"+uid)), which is
 *    one-way. It does not matter: identity is carried by `published.resourceId`,
 *    and every path that could re-derive an id prefers the recorded one. So a
 *    fresh uid on a recovered entry never changes what a buyer already paid for.
 *  - Unpublished files. They were never on-chain.
 *
 * @param files  flatten()ed nodes from GET /api/remote
 */
export function manifestFromTree(files, { defaultPrice = "1000", newUid } = {}) {
    const out = {};
    for (const n of files ?? []) {
        if (!n?.path) continue;
        out[n.path] = {
            uid: newUid ? newUid() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            ...(n.mime ? { mime: n.mime } : {}),
            ...(n.desc ? { desc: n.desc } : {}),
            price: String(n.price ?? defaultPrice),
            // No resourceId in the payload means a free catalog entry — that
            // absence is the signal everywhere downstream, so it round-trips as
            // `forSale: false` rather than as a price with nothing to buy.
            ...(n.resourceId
                ? {
                    published: {
                        resourceId: n.resourceId, workerUrl: n.workerUrl, plaintextHash: n.plaintextHash,
                        chunks: n.chunks ?? 1, size: n.size, chunkSize: n.chunkSize, mime: n.mime,
                    },
                }
                : { forSale: false }),
        };
    }
    return out;
}

export async function writeManifest({ workerUrl, uploadToken, owner, manifest }) {
    await putChunk({
        workerUrl, uploadToken, key: manifestKey(owner),
        body: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    return manifest;
}

// ── self-check: the browser publish path, round-tripped by the real buyer ─────
// `node src/pay/encrypt.js` — no network, no worker, no payment.
//
// The thing worth proving is that this module and server/settle.js are
// interchangeable. They share the envelope, but they read bytes differently
// (File.slice vs fs.read) and hash differently (noble streaming vs node's
// createHash), and either of those drifting produces a file that uploads fine
// and is undecryptable forever.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const { unseal } = await import("@fangorn-network/sdk/lib/crypto/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519");
    const { hexToBytes } = await import("viem");
    const { downloadAndDecrypt } = await import("./buy.js");
    const { encryptAndUpload: nodeEncrypt } = await import("../../server/settle.js");
    const { writeFileSync, rmSync } = await import("node:fs");

    const CHUNK = 1000;
    const bytes = crypto.getRandomValues(new Uint8Array(2500)); // 2.5 chunks → ragged tail
    const file = new Blob([bytes]);

    const workerSecret = crypto.getRandomValues(new Uint8Array(32));
    const workerPubkey = x25519.getPublicKey(workerSecret);
    const r2 = new Map();
    const sealedFor = new Map();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/pubkey")) return { ok: true, json: async () => ({ pubkey: bytesToHex(workerPubkey) }) };
        if (u.includes("/upload/")) {
            const key = u.split("/upload/")[1];
            if (init.method === "DELETE") return r2.delete(key), { ok: true };
            if (!init.method || init.method === "GET") {
                const b = r2.get(key);
                return b ? { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } : { ok: false, status: 404, text: async () => "" };
            }
            const sealed = init.headers?.["X-Sealed-Dek"];
            if (sealed) sealedFor.set(key, sealed); else sealedFor.delete(key);
            r2.set(key, new Uint8Array(init.body));
            return { ok: true };
        }
        if (u.endsWith("/access")) {
            const rid = JSON.parse(init.body).resourceId;
            return { ok: true, json: async () => ({ dek: bytesToHex(unseal(hexToBytes(sealedFor.get(rid)), workerSecret, rid)) }) };
        }
        const body = r2.get(u.split("/ct/")[1]);
        return body ? { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) } : { ok: false, status: 404 };
    };

    const check = (cond, msg) => { if (!cond) throw new Error(msg); };
    const rid = keccak256(new Uint8Array([1]));
    const owner = "0xAbCdEf0000000000000000000000000000000001";

    try {
        const out = await encryptAndUpload({ file, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        check(out.chunks === 3, `chunk count: got ${out.chunks}, want 3`);
        check(r2.has(rid), "chunk 0 must land on the resourceId — that's where /access looks");

        // The hash this module streams must equal the one the relay-side
        // implementation produces, or the same file publishes under two different
        // plaintextHashes depending on who uploaded it and the buyer's integrity
        // check rejects one of them.
        const tmp = `/tmp/encrypt-selfcheck-${process.pid}.bin`;
        writeFileSync(tmp, bytes);
        const viaNode = await nodeEncrypt({ file: tmp, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        rmSync(tmp, { force: true });
        check(out.plaintextHash === viaNode.plaintextHash, `browser hash ${out.plaintextHash} != node hash ${viaNode.plaintextHash}`);
        check(out.chunks === viaNode.chunks && out.size === viaNode.size, "browser and node disagree about chunk geometry");

        // Re-upload from this module so r2 holds THIS module's ciphertext, then
        // let the real buyer decrypt it.
        r2.clear(); sealedFor.clear();
        await encryptAndUpload({ file, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        const blob = await downloadAndDecrypt({
            resourceId: rid, workerUrl: "http://stub", stealthKey: keccak256(new Uint8Array([2])),
            nullifier: "0x1", expectedPlaintextHash: out.plaintextHash, chunks: 3,
        });
        const got = new Uint8Array(await blob.arrayBuffer());
        check(got.length === bytes.length && got.every((b, i) => b === bytes[i]), "round trip corrupted the file");

        // Manifest: absent reads empty (first publish), and survives a write/read
        // with no sealed DEK — the worker must store it, and /access must have
        // nothing to hand out for it.
        const before = await readManifest({ workerUrl: "http://stub", owner });
        check(Object.keys(before.files).length === 0, "a bucket with no manifest must read as an empty library");
        await writeManifest({ workerUrl: "http://stub", owner, manifest: { files: { "a/b.mp4": { uid: "u1", price: "1000" } } } });
        const after = await readManifest({ workerUrl: "http://stub", owner });
        check(after.files["a/b.mp4"]?.uid === "u1", "manifest did not round trip through the bucket");
        check(!sealedFor.has(manifestKey(owner)), "the manifest must be stored with NO sealed DEK — /access could otherwise release it");
        check(manifestKey(owner) === manifestKey(owner.toLowerCase()), "manifest key must not depend on address casing");

        // Recovery from the chain: the manifest is a cache of something public,
        // so an empty bucket must not read as an empty library. Shapes are the
        // real ones GET /api/remote returns (see treeFromGraph — payload spread
        // flat, `kind` renamed to `type`).
        const recovered = manifestFromTree([
            { path: "images/cat.jpg", mime: "image/jpeg", desc: "a cat", price: "50000", chunks: 1, size: 136065, chunkSize: 67108864,
              workerUrl: "https://w.workers.dev", resourceId: `0x${"d7".repeat(32)}`, plaintextHash: `0x${"af".repeat(32)}` },
            { path: "docs/paper.pdf", mime: "application/pdf", price: "0", chunks: 3, size: 900, chunkSize: 300,
              workerUrl: "https://w.workers.dev", resourceId: `0x${"c5".repeat(32)}`, plaintextHash: `0x${"11".repeat(32)}` },
            { path: "notes/abstract.txt", mime: "text/plain", desc: "on umwelt" }, // no resourceId → free catalog entry
            { name: "no-path" },                                                    // not a file vertex
        ], { newUid: () => "u" });

        check(Object.keys(recovered).length === 3, `recovered ${Object.keys(recovered).length} entries, want 3`);
        // The pointer is the whole point: losing resourceId or workerUrl would
        // orphan a file everyone already paid for.
        check(recovered["images/cat.jpg"].published.resourceId === `0x${"d7".repeat(32)}`, "recovery lost the resourceId");
        check(recovered["images/cat.jpg"].published.workerUrl === "https://w.workers.dev", "recovery lost the workerUrl — the bytes become unfindable");
        check(recovered["docs/paper.pdf"].published.chunks === 3, "recovery lost the chunk count — the buyer reassembles the wrong number of objects");
        check(recovered["docs/paper.pdf"].price === "0", "a price of 0 must survive, not fall back to the default");
        // A catalog entry is identified by having NO resourceId. Round-tripping it
        // as anything else would either mint a resource for a free file or price
        // something with nothing to buy.
        check(!recovered["notes/abstract.txt"].published, "a free catalog entry came back with a purchase pointer");
        check(recovered["notes/abstract.txt"].forSale === false, "a free catalog entry must come back as forSale:false");
        check(recovered["notes/abstract.txt"].desc === "on umwelt", "recovery dropped the description");

        // A recovered entry keeps its PAID identity even though the uid is new,
        // because resourceId is recorded and always preferred over re-derivation.
        const reDerived = keccak256(new Uint8Array([9]));
        check(recovered["images/cat.jpg"].published.resourceId !== reDerived, "sanity");
        check(recovered["images/cat.jpg"].uid === "u", "uid should be freshly minted, not recovered");

        console.log("encrypt.js self-check ok — browser==node hash + geometry, buyer round trip, manifest read/write with no DEK, chain recovery keeps pointers + free entries");
    } finally {
        globalThis.fetch = realFetch;
    }
}
