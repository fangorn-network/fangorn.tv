// Publisher-side settlement crypto (envelope model). Lifted from
// x402f/examples/node/settle.ts, trimmed to the SELL half — the server encrypts
// each episode's mp4 and uploads {ciphertext, sealed DEK} to the access worker.
// The buyer half (download+decrypt) runs in the browser (src/pay/buy.js).
//
// Envelope: bytes are AES-256-GCM'd under a random 32-byte DEK. The big
// ciphertext goes to the worker's R2 (keyed by resourceId); the DEK is sealed to
// the worker's X25519 pubkey and stored alongside. The worker never sees
// plaintext and only unseals the DEK after an on-chain settlement check.
//
// Bulk layout in R2, per chunk:  nonce(12) || aes-256-gcm(ct||tag)
//
// Big videos are split into chunks: Cloudflare caps a Worker request body at
// 100MB (a 150MB POST gets a 413 from the edge), and one-shot WebCrypto over a
// whole file peaked at ~5x the file in RSS — a 3GB mp4 OOM-killed the server.
// Each chunk is encrypted separately under the SAME DEK, so one settlement still
// unlocks the whole video; the chunk index rides in the GCM AAD, so a reordered
// or dropped chunk fails to decrypt.

import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { seal } from "@fangorn-network/sdk";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
// The wire format lives in src/, not here, because the browser publishes too
// now (src/pay/encrypt.js) and a second copy of these constants is a file that goes
// dark for everyone who bought it. Re-exported so this module's existing
// importers don't care where they moved.
import { CHUNK_SIZE, NONCE_LEN, aadFor, chunkKey, deleteResource, getWorkerPubkey, pack, putChunk } from "../src/pay/envelope.js";

export { CHUNK_SIZE, aadFor, chunkKey, deleteResource, getWorkerPubkey };


/**
 * Envelope-encrypt the file at `file` chunk by chunk and upload each
 * {ciphertext, sealed DEK} to the access worker's R2. Reads one chunk at a time,
 * so peak memory is ~2x chunkSize no matter how big the video is.
 *
 * @returns { plaintextHash, chunks, size, chunkSize } — the hash to commit
 *          on-chain, the chunk count the buyer reassembles, and the plaintext
 *          byte geometry a streaming player needs to map a Range request onto a
 *          chunk (chunk i starts at i * chunkSize).
 */
export async function encryptAndUpload({ file, resourceId, workerUrl, uploadToken, chunkSize = CHUNK_SIZE, onProgress }) {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
    const sealedDek = bytesToHex(seal(dek, await getWorkerPubkey(workerUrl), resourceId));

    const fh = await open(file, "r");
    try {
        const { size } = await fh.stat();
        const chunks = Math.max(1, Math.ceil(size / chunkSize));
        const hash = createHash("sha256");
        const buf = Buffer.allocUnsafe(Math.min(size, chunkSize) || 1);

        for (let i = 0; i < chunks; i++) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, i * chunkSize);
            const plain = buf.subarray(0, bytesRead);
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
        return { plaintextHash: `0x${hash.digest("hex")}`, chunks, size, chunkSize };
    } finally {
        await fh.close();
    }
}

// ── self-check: full publisher→buyer round trip over a stubbed worker ─────────
// `node server/settle.js` — no network, no worker, no payment. Exercises the
// real encryptAndUpload AND the real downloadAndDecrypt, so the chunk addressing
// and AAD duplicated in src/pay/buy.js can't drift out of sync with this file.
if (import.meta.url === `file://${process.argv[1]}`) {
    const { writeFileSync, rmSync } = await import("node:fs");
    const { sha256Hex, unseal } = await import("@fangorn-network/sdk");
    const { x25519 } = await import("@noble/curves/ed25519");
    const { downloadAndDecrypt } = await import("../src/pay/buy.js");

    const CHUNK = 1000;
    const tmp = `/tmp/settle-selfcheck-${process.pid}.bin`;
    const bytes = crypto.getRandomValues(new Uint8Array(2500)); // 2.5 chunks → ragged tail
    writeFileSync(tmp, bytes);

    // Stub worker: an R2 bucket in a Map, plus the /access DEK gate with the
    // settlement check removed (settlement is untouched by chunking).
    const workerSecret = crypto.getRandomValues(new Uint8Array(32)); // any 32 bytes; x25519 clamps
    const workerPubkey = x25519.getPublicKey(workerSecret);
    const r2 = new Map();
    let sealedSeen = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/pubkey")) return { ok: true, json: async () => ({ pubkey: bytesToHex(workerPubkey) }) };
        if (u.includes("/upload/")) {
            const key = u.split("/upload/")[1];
            // The stub is a bucket, so DELETE has to actually remove the key —
            // otherwise the check below would pass against a no-op.
            if (init.method === "DELETE") return r2.delete(key), { ok: true };
            sealedSeen = init.headers["X-Sealed-Dek"];
            r2.set(key, new Uint8Array(init.body));
            return { ok: true };
        }
        if (u.endsWith("/access")) {
            const rid = JSON.parse(init.body).resourceId;
            return { ok: true, json: async () => ({ dek: bytesToHex(unseal(hexToBytes(sealedSeen), workerSecret, rid)) }) };
        }
        const body = r2.get(u.split("/ct/")[1]);
        return body ? { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) } : { ok: false, status: 404 };
    };

    const rid = keccak256(new Uint8Array([1]));
    const stealthKey = keccak256(new Uint8Array([2]));
    const buy = () => downloadAndDecrypt({ resourceId: rid, workerUrl: "http://stub", stealthKey, nullifier: "0x1", expectedPlaintextHash: sha256Hex(bytes), chunks: 3 });

    try {
        const { plaintextHash, chunks } = await encryptAndUpload({ file: tmp, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        if (chunks !== 3) throw new Error(`chunk count: got ${chunks}, want 3`);
        if (plaintextHash !== sha256Hex(bytes)) throw new Error("streamed hash != whole-file sha256");
        if (!r2.has(rid)) throw new Error("chunk 0 must land on the resourceId — that's where /access looks");
        if (r2.size !== 3) throw new Error(`chunk keys collide: ${r2.size} objects for 3 chunks`);
        // ragged tail: nonce(12) + flag(1) + ct(500) + tag(16). Random bytes don't
        // compress, so this also asserts pack() stored them raw rather than paying
        // gzip's overhead.
        const tail = r2.get(chunkKey(rid, 2));
        if (tail.length !== 12 + 1 + 500 + 16) throw new Error(`ragged last chunk: ${tail.length}`);
        if (Math.max(...[...r2.values()].map((b) => b.length)) > CHUNK + 12 + 1 + 16) throw new Error("a chunk exceeded chunkSize");

        const blob = await buy();
        const got = new Uint8Array(await blob.arrayBuffer());
        if (got.length !== bytes.length || !got.every((b, i) => b === bytes[i])) throw new Error("round trip corrupted the video");

        // AAD binds each chunk to its index: swapping two chunks must fail to
        // decrypt, not silently hand the viewer a scrambled mp4.
        const [a, b] = [chunkKey(rid, 0), chunkKey(rid, 1)];
        [r2.set(a, r2.get(b)), r2.set(b, r2.get(a))];
        let swallowed = false;
        try { await buy(); swallowed = true; } catch {}
        if (swallowed) throw new Error("swapped chunks decrypted — AAD index binding is broken");

        // Compressible payload: the other half of pack() — stored bytes must come
        // in well under the plaintext, and still round trip.
        r2.clear();
        const text = new Uint8Array(3000).fill(65); // 3 chunks of "AAAA…"
        writeFileSync(tmp, text);
        const packed = await encryptAndUpload({ file: tmp, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        const stored = [...r2.values()].reduce((n, b) => n + b.length, 0);
        if (stored > text.length / 2) throw new Error(`compressible payload barely shrank: ${stored} of ${text.length}`);
        const back = new Uint8Array(await (await downloadAndDecrypt({
            resourceId: rid, workerUrl: "http://stub", stealthKey, nullifier: "0x1",
            expectedPlaintextHash: packed.plaintextHash, chunks: packed.chunks,
        })).arrayBuffer());
        if (back.length !== text.length || !back.every((b) => b === 65)) throw new Error("gzip round trip corrupted the video");

        // Delete: every chunk goes, and a worker that refuses RAISES rather than
        // reporting freed space the operator is still being billed for.
        if (r2.size !== packed.chunks) throw new Error(`expected ${packed.chunks} chunks staged, got ${r2.size}`);
        if (await deleteResource({ workerUrl: "http://stub", uploadToken: "t", resourceId: rid, chunks: packed.chunks }) !== packed.chunks) throw new Error("deleteResource miscounted");
        if (r2.size !== 0) throw new Error(`delete left ${r2.size} chunk(s) behind`);

        const okFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
        let quiet = false;
        try { await deleteResource({ workerUrl: "http://stub", resourceId: rid, chunks: 2 }); quiet = true; } catch {}
        globalThis.fetch = okFetch;
        if (quiet) throw new Error("a refused delete was swallowed — the ledger would free bytes still in R2");

        console.log(`settle.js self-check ok — round trip, hash, ragged tail, reorder rejected, gzip ${stored}/${text.length} bytes, delete frees all chunks + raises on refusal`);
    } finally {
        globalThis.fetch = realFetch;
        rmSync(tmp, { force: true });
    }
}
