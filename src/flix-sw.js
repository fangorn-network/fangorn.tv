// Streaming decryptor (service worker). The <video> element points at
// /flix/<resourceId> and this worker answers: it fetches ciphertext chunks from
// the access worker, decrypts them, and streams plaintext back with Range
// support. Playback starts as soon as chunk 0 lands (~2s at 33MB/s) instead of
// after the whole 1.8GB file, and native seeking works because the player can
// issue a normal Range request.
//
// The mp4s are published faststart (moov up front), which is what makes plain
// progressive playback viable — no MSE, no fMP4, no re-encode.
//
// Registered as a MODULE worker so vite bundles it: chunk unpacking is imported
// from buy.js rather than duplicated, and the byte math lives in stream.js where
// a node self-check can reach it.
//
// The DEK lives in memory only, and only after the page proved settlement at the
// worker's /access gate. Without a descriptor this worker serves nothing.

// Imports stream.js ONLY. buy.js pulls @semaphore-protocol/proof, which touches
// URL.createObjectURL at module scope and can't be evaluated in a worker.
import { unpack, sliceStream, parseRange } from "./pay/stream.js";

const NONCE_LEN = 12;
const CACHE = "flix-plain-v1";

/** resourceId → { dek, workerUrl, chunkKeys, chunkSize, size } */
const streams = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
    const { type, descriptor } = e.data ?? {};
    if (type === "flix:open") {
        streams.set(descriptor.resourceId, descriptor);
        e.source?.postMessage({ type: "flix:ready", resourceId: descriptor.resourceId });
    } else if (type === "flix:close") {
        streams.delete(descriptor.resourceId); // drop the DEK
    }
});

/** AES-GCM additional data: the chunk index, big-endian uint32. MUST match
 *  aadFor() in server/settle.js and src/pay/buy.js. */
const aadFor = (i) => new Uint8Array([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);

/** Decrypted bytes for chunk `i`, from cache when we've seen it before. Caching
 *  plaintext is what makes a re-watch free: no refetch, no re-decrypt. The buyer
 *  already paid and it's their own disk — same exposure as a downloaded file. */
async function chunkPlain(d, key, i) {
    const cache = typeof caches !== "undefined" ? await caches.open(CACHE).catch(() => null) : null;
    const cacheKey = `/flix-chunk/${d.resourceId}/${i}`;
    if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    }

    const res = await fetch(`${d.workerUrl}/ct/${d.chunkKeys[i]}`);
    if (!res.ok) throw new Error(`/ct chunk ${i} failed: ${res.status}`);
    const ct = new Uint8Array(await res.arrayBuffer());
    const plain = await unpack(new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ct.subarray(0, NONCE_LEN), additionalData: aadFor(i) },
        key, ct.subarray(NONCE_LEN),
    )));

    // Best-effort: a full disk (or a 1.8GB film against the origin quota) must
    // never break playback, so a failed cache write is ignored.
    if (cache) await cache.put(cacheKey, new Response(plain)).catch(() => {});
    return plain;
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith("/flix/")) return;

    const resourceId = url.pathname.slice("/flix/".length);
    const d = streams.get(resourceId);
    // Not open (e.g. the page reloaded and the DEK is gone) — 404 beats hanging.
    if (!d) return event.respondWith(new Response("no open stream", { status: 404 }));

    event.respondWith((async () => {
        const key = await crypto.subtle.importKey("raw", d.dek, "AES-GCM", false, ["decrypt"]);
        const { start, end, partial, unsatisfiable } = parseRange(event.request.headers.get("range"), d.size);
        if (unsatisfiable) {
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${d.size}` } });
        }

        const headers = {
            "Content-Type": d.mime ?? "video/mp4",
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "Content-Length": String(end - start + 1),
            // openStream()'s proof that this URL reached the worker and not the
            // server's SPA fallback. Cheap enough to send on every response.
            "X-Flix": "1",
        };
        if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${d.size}`;
        // HEAD is the probe: same headers, no body, so it never fetches or
        // decrypts a chunk.
        if (event.request.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers });
        const body = sliceStream((i) => chunkPlain(d, key, i), d, start, end);
        return new Response(body, { status: partial ? 206 : 200, headers });
    })());
});
