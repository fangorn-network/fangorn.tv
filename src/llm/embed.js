// In-browser query embedder. Lifted from embeddings/examples/src/lib/embed.ts —
// the query vector MUST come out of the same model and post-processing as the
// document vectors in the shard, or cosine is meaningless.
//
// Document side (quickbeam/embeddings.py): fastembed nomic-embed-text-v1.5 on
//   "search_document: " + text, then matryoshka(vec, 256).
// Query side (here): same model on "search_query: " + text (nomic is asymmetric),
//   then the identical matryoshka.
//
// If the embedding pipeline switches model or dim, change MODEL/DIM here to match.
// transformers.js is dynamically imported so its ~MB runtime stays out of the main
// bundle and a load failure degrades to lexical search instead of breaking the app.

const MODEL = "nomic-ai/nomic-embed-text-v1.5";
const DIM = 256;

// Stamped onto every vector a publisher commits. Vectors from different models
// (or dims) are not comparable — cosine between them is noise, and silently so.
// The shard bake drops any vector whose stamp doesn't match rather than blending
// corpora, which is the one thing that can quietly ruin a shared index.
export const EMBED_MODEL = MODEL;
export const EMBED_DIM = DIM;

let _extractor = null;
const extractor = () => (_extractor ??= (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    return pipeline("feature-extraction", MODEL, { dtype: "q8" });
})());

/** Standardize over the full vector, slice to `dim`, L2-normalize the slice. */
function matryoshka(vec, dim = DIM) {
    const n = vec.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += vec[i];
    mean /= n;
    let varsum = 0;
    for (let i = 0; i < n; i++) varsum += (vec[i] - mean) ** 2;
    const std = Math.sqrt(varsum / n + 1e-5);

    const out = new Array(Math.min(dim, n));
    for (let i = 0; i < out.length; i++) out[i] = (vec[i] - mean) / std;

    let norm = 0;
    for (const x of out) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm) for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

/** Free text → 256-d L2-normalized vector. Throws if the model can't load —
 *  callers fall back to lexical. First call downloads the model (slow). */
export async function embedQueryDirect(text) {
    const ex = await extractor();
    const output = await ex(`search_query: ${text}`, { pooling: "mean", normalize: false });
    return matryoshka(output.data);
}

/** One document, in-process. The batch loop stays with the caller — see embedDocuments. */
export async function embedDocumentDirect(text) {
    const ex = await extractor();
    const output = await ex(`search_document: ${text}`, { pooling: "mean", normalize: false });
    return matryoshka(output.data);
}

/** Load the model in-process, and settle when it is actually ready. */
export const warmDirect = () => extractor().then(() => {});

// ── off the main thread ──────────────────────────────────────────────────────
//
// The public API below is unchanged, so no caller knows where the work happens.
// In a browser it happens in embed.worker.js; in Node (the publish script, the
// self-checks) and inside the worker itself there is no Worker to spawn, so it
// runs in-process. `window`, not `Worker`: a worker context HAS Worker and would
// otherwise spawn a worker per query, forever.
const offThread = () => typeof window !== "undefined" && typeof Worker !== "undefined";

let _w = null, _seq = 0;
const _pending = new Map();

function hub() {
    if (_w) return _w;
    _w = new Worker(new URL("./embed.worker.js", import.meta.url), { type: "module" });
    _w.onmessage = ({ data }) => {
        const job = _pending.get(data.id);
        if (!job) return;
        _pending.delete(data.id);
        data.error ? job.reject(new Error(data.error)) : job.resolve(data.vec);
    };
    // A worker that fails to BOOT never answers a message, so every caller would
    // hang. Fail them all and drop the worker, so the next call retries.
    _w.onerror = (e) => {
        for (const job of _pending.values()) job.reject(new Error(`embed worker: ${e?.message ?? "failed to start"}`));
        _pending.clear();
        _w = null;
    };
    return _w;
}

const ask = (kind, text) => new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject });
    hub().postMessage({ id, kind, text });
});

/** Free text → 256-d L2-normalized vector. Throws if the model can't load —
 *  callers fall back to lexical. First call downloads the model (slow). */
export const embedQuery = (text) => (offThread() ? ask("query", text) : embedQueryDirect(text));

/**
 * Document side. Same model, the OTHER nomic prefix — it's an asymmetric model,
 * so documents embedded with "search_query: " would rank against real queries
 * about as well as random.
 *
 * Runs one at a time on purpose: this executes in a publisher's browser during
 * publish, and a batch large enough to matter is a batch large enough to lock
 * the tab. `onProgress(done, total)` drives the publish progress bar.
 */
export async function embedDocuments(texts, onProgress) {
    const one = offThread() ? (t) => ask("document", t) : embedDocumentDirect;
    const out = [];
    for (const text of texts) {
        out.push(await one(text));
        onProgress?.(out.length, texts.length);
    }
    return out;
}

// ── wire format ───────────────────────────────────────────────────────────────
// Vectors are L2-normalized, so every component is in [-1, 1] and int8 costs one
// byte instead of ~9 for a JSON float. 256 floats: ~2.3 KB as JSON, 344 chars as
// base64 int8. That matters twice over — the vectors ride in the on-chain graph
// payload (which /api/catalog walks on every cold hit) AND in the shard every
// buyer downloads.
//
// ponytail: flat int8, no per-vector scale. Components of a unit vector in 256
// dims are ~0.06 RMS, so 1/127 steps cost far less recall than the retrieval
// noise floor. Add a scale factor only if a measured recall drop says to.

/** Float vector → base64 int8. */
export function packVec(vec) {
    const q = new Uint8Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        const v = Math.round(Math.max(-1, Math.min(1, vec[i])) * 127);
        q[i] = v < 0 ? v + 256 : v; // two's complement in a byte
    }
    let s = "";
    for (const b of q) s += String.fromCharCode(b);
    return btoa(s);
}

/** base64 int8 → Float32Array. Returns null on anything malformed — a bad vector
 *  must degrade that row to lexical, never throw mid-search. */
export function unpackVec(b64) {
    try {
        const s = atob(b64);
        const out = new Float32Array(s.length);
        for (let i = 0; i < s.length; i++) {
            const b = s.charCodeAt(i);
            out[i] = (b > 127 ? b - 256 : b) / 127;
        }
        return out.length ? out : null;
    } catch { return null; }
}

/**
 * A unit vector as SIGN BITS — one bit per dimension, eight to a byte, base64.
 *
 * For LINKS, not for ranking storage: 256 dims land in 32 bytes (43 chars)
 * instead of int8's 256 bytes (344 chars), which is the difference between a
 * channel link you can paste in a message and one that wraps four times.
 *
 * The sign vector is a worse query than the float one, but not by much, and the
 * cost is measurable rather than a guess: over 7k real catalog vectors, the
 * top-80 pool it selects sits at mean cosine 0.808 to the true query where the
 * float query's own pool sits at 0.824 — a ~2% dilution of the neighbourhood for
 * an 8x shorter link. Both sides of a shared channel walk the SAME sign vector
 * (see tuned()), so there is no drift between them either way.
 *
 * ponytail: 1 bit. If the neighbourhood ever reads as visibly loose, 4 bits with
 * a per-vector scale measured 0.822 — indistinguishable from float — at 172 chars.
 */
export function packBits(vec) {
    const q = new Uint8Array(Math.ceil(vec.length / 8));
    for (let i = 0; i < vec.length; i++) if (vec[i] >= 0) q[i >> 3] |= 128 >> (i & 7);
    let s = "";
    for (const b of q) s += String.fromCharCode(b);
    return btoa(s);
}

/** base64 sign bits → Float32Array of ±1. Null on anything malformed, same
 *  contract as unpackVec: a pasted link is untrusted input. */
export function unpackBits(b64) {
    try {
        // atob is strict about length: a stripped "=" is normal in a URL.
        const s = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
        const out = new Float32Array(s.length * 8);
        for (let i = 0; i < out.length; i++) out[i] = (s.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1 ? 1 : -1;
        return out.length ? out : null;
    } catch { return null; }
}

/**
 * Start loading the model. Never rejects, and safe to call on every keystroke or
 * focus — the pipeline is a memoized singleton on whichever thread owns it.
 *
 * Call this on INTENT (the search box taking focus), never on page load: it is a
 * 131MB download, and until someone types there is nothing for it to embed. The
 * whole first-paint path — browse, shelves, channels, the field, the compass —
 * runs on the document vectors already in the shard.
 */
export const warmEmbedder = () => {
    if (offThread()) ask("warm").catch(() => {});
    else warmDirect().catch(() => {});
};

// ── self-check: `node src/llm/embed.js` — quantization only, no model download ────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const v = matryoshka(Array.from({ length: 768 }, (_, i) => Math.sin(i)));
    let norm = 0;
    for (const x of v) norm += x * x;
    if (Math.abs(Math.sqrt(norm) - 1) > 1e-6) throw new Error("matryoshka must L2-normalize");
    if (v.length !== DIM) throw new Error(`matryoshka must truncate to ${DIM}`);

    const round = unpackVec(packVec(v));
    if (round.length !== v.length) throw new Error("pack/unpack changed the dimension");
    // Round-trip must stay near-parallel, or cosine ranking shifts under quantization.
    let dot = 0, n2 = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i] * round[i]; n2 += round[i] * round[i]; }
    const cos = dot / Math.sqrt(n2);
    if (cos < 0.999) throw new Error(`int8 round-trip cosine ${cos} — too lossy to rank with`);

    // Negatives are the easy thing to get wrong in a byte round-trip.
    const neg = unpackVec(packVec([-1, -0.5, 0, 0.5, 1]));
    if (neg[0] > -0.99 || neg[1] > -0.49 || neg[1] < -0.51) throw new Error(`negative components corrupted: ${[...neg]}`);

    if (unpackVec("!!!not base64!!!") !== null) throw new Error("malformed vector must return null, not throw");

    // Sign bits: the link encoding. Idempotent (packing a sign vector again
    // changes nothing), which is what lets tuned() walk the shared vector.
    const bits = packBits(v);
    if (bits.length > 48) throw new Error(`sign bits must stay link-sized, got ${bits.length} chars`);
    const back = unpackBits(bits);
    if (back.length !== v.length) throw new Error("sign round-trip changed the dimension");
    for (let i = 0; i < v.length; i++) {
        if (Math.sign(back[i]) !== (v[i] < 0 ? -1 : 1)) throw new Error(`sign flipped at ${i}`);
    }
    if (packBits(back) !== bits) throw new Error("sign packing must be idempotent");
    if (unpackBits("!!!not base64!!!") !== null) throw new Error("malformed bits must return null, not throw");

    console.log("embed.js self-check ok — matryoshka norm, int8 round-trip, negatives, malformed input, sign bits");
}
