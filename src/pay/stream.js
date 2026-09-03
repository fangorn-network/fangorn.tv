// Hand an episode to the service worker and get back a URL the <video> element
// can stream from. Playback starts on chunk 0 instead of waiting for the whole
// file, and the worker caches decrypted chunks so a re-watch costs nothing.
//
// Falls back to the whole-blob path when streaming isn't possible: no service
// worker (unsupported / not localhost or https), or an episode published before
// the pointer carried `size`/`chunkSize` — the byte offsets are unknowable
// without them, so there's nothing to seek against.

// NO top-level import of buy.js: it pulls @semaphore-protocol/proof, which calls
// URL.createObjectURL at module scope — absent in a service worker, so evaluating
// it kills the worker. flix-sw.js imports this file, so this file's static graph
// must stay dep-free. openStream() imports buy.js dynamically; the worker never
// calls it, so the worker never evaluates it.

/** Undo server/settle.js pack(): decrypted bytes are `flag(1) || data`, flag 1 = gzip.
 *  Lives here rather than buy.js so the service worker can reach it without the
 *  wallet/proof stack. */
export async function unpack(bytes) {
    if (bytes[0] === 0) return bytes.subarray(1);
    // Not 0/1 means these bytes aren't packed at all — almost always ciphertext
    // uploaded before the compression format landed. The publisher re-publishes
    // (server stamps `enc` in the manifest); there's nothing the buyer can do.
    if (bytes[0] !== 1) throw new Error(`unknown chunk encoding ${bytes[0]} — this video needs re-publishing`);
    return new Uint8Array(await new Response(
        new Response(bytes.subarray(1)).body.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer());
}

/**
 * Stream plaintext bytes [start, end] INCLUSIVE, pulling one chunk at a time.
 * This is the whole reason playback can start early: the player gets bytes as
 * each chunk decrypts instead of after the last one.
 *
 * Kept here (pure, injected `chunkPlain`) so the byte math is testable without a
 * browser — an off-by-one here is a corrupt video, not a visible error.
 *
 * @param chunkPlain (i) => Promise<Uint8Array> — decrypted bytes of chunk i
 */
export function sliceStream(chunkPlain, { chunkSize }, start, end) {
    let pos = start;
    return new ReadableStream({
        async pull(controller) {
            if (pos > end) return controller.close();
            try {
                const i = Math.floor(pos / chunkSize);
                const plain = await chunkPlain(i);
                const offsetInChunk = pos - i * chunkSize;
                const take = Math.min(plain.length - offsetInChunk, end - pos + 1);
                // A short/ragged chunk that can't advance would spin forever.
                if (take <= 0) return controller.close();
                controller.enqueue(plain.subarray(offsetInChunk, offsetInChunk + take));
                pos += take;
            } catch (err) {
                controller.error(err);
            }
        },
    });
}

/** Parse a `Range: bytes=START-[END]` header against a known size. */
export function parseRange(header, size) {
    const m = /bytes=(\d+)-(\d*)/.exec(header ?? "");
    if (!m) return { start: 0, end: size - 1, partial: false };
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return { start, end, partial: true, unsatisfiable: start >= size };
}

let _sw = null;
function register() {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
    // Two different URLs on purpose. Dev: vite transforms /src/flix-sw.js on
    // request (scope "/" needs the Service-Worker-Allowed header vite.config sets).
    // Build: the worker is its own rollup entry at /flix-sw.js. Do NOT go back to
    // `new URL("../flix-sw.js", import.meta.url)` — that form makes vite COPY the
    // file into assets/ untransformed, its `import "./stream.js"` resolves to
    // nothing, and the worker dies with "ServiceWorker cannot be started".
    // Memoize SUCCESS only: caching a rejected promise means one bad registration
    // (dev server without Service-Worker-Allowed, worker mid-restart) disables
    // streaming for the whole tab, and every later play silently downloads 1.8GB.
    return (_sw ??= navigator.serviceWorker
        .register(import.meta.env?.DEV ? "/src/flix-sw.js" : "/flix-sw.js", { type: "module", scope: "/" })
        .then(() => navigator.serviceWorker.ready)
        .catch((err) => {
            _sw = null; // let the next play try again
            throw new Error(`service worker registration failed: ${err.message}`);
        }));
}

/** An active worker is NOT a controlled page: `ready` resolves as soon as one is
 *  active, but until `controller` is set every fetch — including <video src> —
 *  bypasses the worker entirely and the server answers /flix/<id> with index.html.
 *  A media element handed HTML says "no supported format"; an <img> just breaks.
 *  clients.claim() lands a beat after activation, so wait for it rather than
 *  racing it. */
function controlled(ms = 3000) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (v) => { navigator.serviceWorker.removeEventListener("controllerchange", onChange); clearTimeout(t); resolve(v); };
        const onChange = () => done(true);
        const t = setTimeout(() => done(false), ms);
        navigator.serviceWorker.addEventListener("controllerchange", onChange);
    });
}

/** Why can't this episode stream? null when it can. Every caller used to get a
 *  bare false and fall back to a 1.8GB decrypt with no way to tell which gate
 *  failed — the reason is the whole point. */
export function streamBlocker(episode) {
    if (!episode?.size || !episode?.chunkSize) return "episode pointer has no size/chunkSize — publish predates streaming, re-publish it";
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        // The usual cause: the page is open on a LAN IP or plain http, which is
        // not a secure context, so navigator.serviceWorker doesn't exist at all.
        return `no navigator.serviceWorker — need localhost or https (page is ${globalThis.location?.origin})`;
    }
    return null;
}

/**
 * @returns a same-origin URL for <video src>, or null if streaming isn't available.
 *          The DEK is handed to the worker in memory only — it never touches disk.
 */
export async function openStream({ episode, stealthKey, nullifier }) {
    const blocked = streamBlocker(episode);
    if (blocked) throw new Error(blocked);
    const reg = await register();
    if (!reg?.active) throw new Error("service worker registered but not active yet");

    const { chunkKeysFor, fetchDek } = await import("./buy.js");
    const { resourceId, workerUrl, chunks = 1, size, chunkSize, mime } = episode;
    const dek = await fetchDek({ resourceId, workerUrl, stealthKey, nullifier });

    const descriptor = {
        resourceId, workerUrl, dek,
        chunkKeys: chunkKeysFor(resourceId, chunks),
        chunkSize: Number(chunkSize), size: Number(size),
        mime: mime ?? "video/mp4", // pointers published before mixed media are all mp4
    };

    // Wait for the worker to acknowledge before handing the URL to <video>: a
    // request that arrives before the descriptor is registered gets a 404, and the
    // player treats that as a fatal source error rather than retrying.
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("service worker did not acknowledge the stream")), 5000);
        const onMessage = (e) => {
            if (e.data?.type === "flix:ready" && e.data.resourceId === resourceId) {
                clearTimeout(timer);
                navigator.serviceWorker.removeEventListener("message", onMessage);
                resolve();
            }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        reg.active.postMessage({ type: "flix:open", descriptor });
    });

    if (!(await controlled())) throw new Error("service worker is active but not controlling this page yet");

    // Prove the URL is actually answered by the worker before handing it to a
    // media element. Anything else here (the server's SPA fallback, a browser that
    // registered the worker but won't route to it) is a silent "no supported
    // format" the buyer can't act on; throwing falls back to the whole-file
    // decrypt, which works everywhere. HEAD costs no chunk fetch — see flix-sw.js.
    const probe = await fetch(`/flix/${resourceId}`, { method: "HEAD" }).catch(() => null);
    if (probe?.headers.get("x-flix") !== "1") {
        throw new Error(`/flix/${resourceId.slice(0, 10)}… was not answered by the service worker (got ${probe?.status ?? "network error"} ${probe?.headers.get("content-type") ?? ""})`);
    }

    return `/flix/${resourceId}`;
}

/** Drop the DEK from the worker when the player closes. */
export function closeStream(resourceId) {
    _sw?.then((reg) => reg?.active?.postMessage({ type: "flix:close", descriptor: { resourceId } }));
}

// ── self-check: `node src/pay/stream.js` — range math over fake chunks ───────────
// The risky part isn't the crypto (WebCrypto authenticates every chunk), it's the
// offset arithmetic: an off-by-one here is a corrupt video, not an error.
// Wrapped in an async IIFE, NOT top-level await: a module with top-level await is
// an async module, and Chrome refuses to evaluate one as a service worker
// ("ServiceWorker cannot be started") — the guard below is runtime, the await isn't.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) void (async () => {
    const CHUNK = 100;
    const SIZE = 250; // 2 full chunks + a ragged 50-byte tail
    const whole = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);
    const chunkOf = async (i) => whole.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, SIZE));
    const collect = async (start, end) => {
        const out = [];
        const reader = sliceStream(chunkOf, { chunkSize: CHUNK }, start, end).getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(...value); }
        return Uint8Array.from(out);
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    if (!same(await collect(0, SIZE - 1), whole)) throw new Error("full range did not reassemble the file");
    // Mid-chunk start is what a seek produces — the common case for search hits.
    if (!same(await collect(150, 249), whole.subarray(150, 250))) throw new Error("seek into chunk 1 returned wrong bytes");
    // A range wholly inside one chunk must not over-read.
    if (!same(await collect(10, 19), whole.subarray(10, 20))) throw new Error("intra-chunk range wrong");
    // Crossing a boundary is where an off-by-one hides.
    if (!same(await collect(95, 105), whole.subarray(95, 106))) throw new Error("chunk-boundary range wrong");
    // The ragged tail must terminate rather than spin on a short chunk.
    if (!same(await collect(200, SIZE - 1), whole.subarray(200, SIZE))) throw new Error("ragged tail wrong");
    if ((await collect(SIZE - 1, SIZE - 1)).length !== 1) throw new Error("single-byte range wrong");

    // A failing chunk must surface as a stream error, not a silent truncation.
    let errored = false;
    try {
        const r = sliceStream(async () => { throw new Error("402"); }, { chunkSize: CHUNK }, 0, 10).getReader();
        await r.read();
    } catch { errored = true; }
    if (!errored) throw new Error("a chunk failure must error the stream");

    // Range header parsing, including what <video> actually sends.
    const openEnded = parseRange("bytes=0-", SIZE);
    if (openEnded.start !== 0 || openEnded.end !== SIZE - 1 || !openEnded.partial) throw new Error("open-ended range wrong");
    if (parseRange(null, SIZE).partial) throw new Error("absent Range must be a 200, not a 206");
    if (parseRange("bytes=100-199", SIZE).end !== 199) throw new Error("closed range wrong");
    if (parseRange("bytes=100-999", SIZE).end !== SIZE - 1) throw new Error("range past EOF must clamp");
    if (!parseRange(`bytes=${SIZE}-`, SIZE).unsatisfiable) throw new Error("range at/past EOF must be 416");

    // unpack(): both flags round-trip, and an unknown flag names the fix.
    const gz = new Uint8Array(await new Response(
        new Response(whole).body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    if (!same(await unpack(Uint8Array.from([0, ...whole])), whole)) throw new Error("unpack flag 0 wrong");
    if (!same(await unpack(Uint8Array.from([1, ...gz])), whole)) throw new Error("unpack flag 1 (gzip) wrong");
    await unpack(Uint8Array.from([7, 1, 2])).then(
        () => { throw new Error("unknown encoding flag must throw"); },
        (e) => { if (!/re-publishing/.test(e.message)) throw e; },
    );

    console.log("stream.js self-check ok — reassembly, seek, boundaries, ragged tail, errors, Range parsing, unpack");
})();
