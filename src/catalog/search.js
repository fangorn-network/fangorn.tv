// Search AND browse over a quickbeam VIEW's Semantic CDN shards, streamed from the
// registry worker. One catalog → one manifest per watched (owner, namespace) domain
// → N gzipped NDJSON shards, downloaded once, kept in memory, ranked client-side —
// no index server, no backend of ours, and no chain read on the viewer's path.
//
// The shards are the whole catalog: quickbeam's `video` rows carry every field the
// buy/stream path needs (resourceId, workerUrl, price, plaintextHash, chunks, size,
// chunkSize, mime) plus the row's 256-d vector, so browse, search, "more like this"
// and purchase all read the same download.
//
// WHICH view is a RUNTIME setting on the relay (`QUICKBEAM_URL` → `/api/config`),
// deliberately not a `VITE_` value baked into dist/: a view id embeds its requester
// and its name, so repointing a storefront at a new one must not need an image
// rebuild. `watchShard` holds the view's SSE stream open and drops the cache when a
// domain gains shards, so a publish shows up without a page reload.
//
// Two ranking modes, chosen per row:
//   semantic — cosine against the query vector (rows that carry one)
//   lexical  — word-boundary scoring (rows that don't, or if the embedder won't load)
// So search degrades rather than breaks.
//
// ponytail: brute-force cosine over every row. This corpus is ~16 rows and a big
// library is thousands — a linear scan of 2k × 256 floats is well under a frame.
// Reach for HNSW/quantization only past ~50k rows.

import { embedQuery, unpackVec } from "../llm/embed.js";
// Pure path→tree nesting, no node deps — the same function the relay nests
// /api/catalog with, so both paths sort and group identically.
import { nest } from "../../server/graph.js";
// One definition of catalog identity, shared with the browse/ranking side. A
// second copy that disagreed about free entries would key the kernel's vector
// map differently from its history and silently rank nothing.
import { byEpisode, nodeKey, seriesKey } from "./browse.js";

let _view = null;      // the relay's default view base, resolved lazily
let _active = null;     // the app the viewer navigated into, or null for the default
let _only = null;       // domain allowlist from /api/config; null = pull every domain
const _shards = new Map(); // view base → its rows
// Everyone waiting to paint a download that is already running. Honouring only
// the caller that STARTED it was a race nobody could win: the viewer's catalog,
// the vector map and the search box's warm-up all call loadShard on the same
// tick, and whichever resumed first became the starter — so the one with the
// callback usually wasn't it, and the page sat blank until the last byte.
const _watchers = new Map(); // view base → Set of onRows

/** Drop everything cached — the self-check reloads between fixtures, and the SSE
 *  watcher drops it when a domain gains shards. */
export const resetShard = () => { _shards.clear(); _watchers.clear(); _view = null; _active = null; _only = null; };

/**
 * Point every no-arg reader (browse, search, vectors, the SSE watcher) at one
 * app's view. `null` goes back to the relay's default.
 *
 * A module-level current view rather than a url threaded through catalogFromShard /
 * searchSubtitles / fileVectors at every call site: the UI shows exactly one app at
 * a time, and the cache below is keyed by view, so switching back is free rather
 * than a re-download.
 */
export function setView(url) {
    _active = url ? String(url).replace(/\/+$/, "").replace(/\/(stream|cdn)$/, "") : null;
}
export const activeView = () => _active;

/**
 * The view base — `{registry}/q/{viewId}` — from the relay's runtime config.
 *
 * The registry prints the `/stream` and `/cdn` URLs rather than the base, so either
 * is accepted and trimmed back to the thing every route hangs off. Cached; a failure
 * clears the slot so the next call retries.
 */
function viewBase() {
    return (_view ??= fetchText("/api/config")
        .then((t) => {
            const c = JSON.parse(t);
            // Read in the SAME response that resolves the view, so there is no
            // window where a load starts before the allowlist is known. Wiring it
            // through App.jsx would have exactly that race.
            if (_only === null) setDomains(c.domains);
            return String(c.quickbeam ?? "").replace(/\/+$/, "").replace(/\/(stream|cdn)$/, "");
        })
        .catch((e) => { _view = null; throw e; }));
}

/**
 * Which of a view's domains to actually download. `null` = all of them.
 *
 * A view fuses several publishers/namespaces, and load() pulled EVERY one — which
 * is right for a view built to be browsed whole and wrong for one that has last
 * month's test corpus still watched alongside this month's. Two corpora is twice
 * the bytes, twice the parse and twice the k-means, and the second one is not on
 * screen: it is just making the tab unresponsive.
 *
 * An entry matches a domain by exact name, by its namespace half (`0xabc/videos`
 * matched by `videos`), or as a prefix — the registry prints these three ways
 * depending on which surface you read them off, and requiring the exact form
 * means a filter that silently matches nothing.
 */
export function setDomains(only) {
    const list = (Array.isArray(only) ? only : String(only ?? "").split(","))
        .map((x) => String(x).trim()).filter(Boolean);
    _only = list.length ? list : null;
}

/** Does `name` (as the view lists it) match the configured allowlist? */
const wanted = (name) => !_only || _only.some((e) =>
    name === e || name.split("/").pop() === e || name.startsWith(e));

const NO_VIEW = "no quickbeam view configured — set QUICKBEAM_URL in the relay's .env to the registry's /q/<viewId> URL";

/** Fetch + parse a view's shards. Cached PER VIEW; concurrent callers share one
 *  fetch. Keyed by the resolved base, so two apps on screen in one session can't
 *  serve each other's rows out of a single global slot.
 *
 *  `onRows` is called with the merged rows so far after every shard, so a big
 *  catalog paints as it arrives instead of after the last byte. Only the caller
 *  that starts the download sees them — a second concurrent reader shares the
 *  same promise and just waits. */
export async function loadShard(base, onRows) {
    const at = base ?? _active ?? await viewBase();
    if (!at) throw new Error(NO_VIEW);
    // Subscribe BEFORE the cache check: a load already in flight still has rows to
    // come, and a late subscriber must get them. Registering first also means the
    // order these callers happen to resume in stops mattering.
    let subs = _watchers.get(at);
    if (!subs) _watchers.set(at, (subs = new Set()));
    if (onRows) subs.add(onRows);

    const hit = _shards.get(at);
    if (hit) return hit; // already downloaded: nothing to stream, the caller gets it whole
    // A rejected promise left in the cache poisons every later search until a page
    // reload, so failures clear the slot and the next call retries.
    const fan = (rows) => { for (const f of subs) { try { f(rows); } catch { /* one bad painter must not stop the rest */ } } };
    const p = load(at, fan)
        .finally(() => _watchers.delete(at))
        .catch((e) => { _shards.delete(at); throw e; });
    _shards.set(at, p);
    return p;
}

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`shard: HTTP ${res.status} for ${url}`);

    // Who gunzips depends on the server. `cdn serve` sends a shard as
    // `application/gzip` with no Content-Encoding, so the raw gzip arrives here; a
    // host (or a proxy) that labels it `Content-Encoding: gzip` has the BROWSER
    // decode it first, and a DecompressionStream would then choke on plain NDJSON.
    // Sniff the magic bytes rather than trusting headers — this has to work under
    // both, and the same function reads the plain-JSON catalog and manifests.
    return decodeMaybeGzip(new Uint8Array(await res.arrayBuffer()));
}

const decodeMaybeGzip = async (buf) => (buf[0] === 0x1f && buf[1] === 0x8b
    ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(buf));

/** Free text a lexical query can match, per entity type. */
const rowText = (f) => (f.cues?.length
    ? f.cues.map((c) => c.text).join(" ")
    : [f.name, f.path, f.desc].filter(Boolean).join(" "));

function toRow(row) {
    const f = row.fields ?? {};
    // Two wire forms for the same vector: `embedding` is the plain float array the
    // CDN bake writes, `fields.embed.vec` the base64 int8 a publisher commits.
    const v = Array.isArray(row.embedding) ? row.embedding
        : typeof f.embed?.vec === "string" ? unpackVec(f.embed.vec) : null;
    let norm = 0;
    if (v) for (const x of v) norm += x * x;
    return { id: row.track_id, owner: row.owner, ...f, text: rowText(f), vector: v, norm: Math.sqrt(norm) || 1 };
}

/** NDJSON as it arrives, a line at a time.
 *
 *  A shard is ONE file and it is big — the live view's is 34MB gzipped, 100MB of
 *  JSON, and `arrayBuffer()` means nothing at all exists until the last byte of
 *  it lands. Read the body as a stream and the first rows are usable after the
 *  first chunk, which is the difference between a blank page for the length of a
 *  34MB download and a catalog that fills in.
 *
 *  Same gzip sniff as fetchText and for the same reason (see there) — it just has
 *  to happen on the first chunk instead of on the whole buffer. No `res.body`
 *  (the self-check's fixtures, an ancient browser) falls back to the buffered
 *  read, so this is an optimisation and never a requirement.
 */
async function fetchLines(url, onLine) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`shard: HTTP ${res.status} for ${url}`);
    if (!res.body) {
        for (const line of (await res.arrayBuffer().then((b) => decodeMaybeGzip(new Uint8Array(b))))) onLine(line);
        return;
    }
    const reader = res.body.getReader();
    const first = await reader.read();
    const head = first.value ?? new Uint8Array();
    const raw = new ReadableStream({
        start(c) { if (head.length) c.enqueue(head); if (first.done) c.close(); },
        async pull(c) { const { done, value } = await reader.read(); done ? c.close() : c.enqueue(value); },
        cancel(r) { return reader.cancel(r); },
    });
    const bytes = head[0] === 0x1f && head[1] === 0x8b ? raw.pipeThrough(new DecompressionStream("gzip")) : raw;
    const dec = new TextDecoder();
    let buf = "";
    for (const r = bytes.getReader(); ;) {
        const { done, value } = await r.read();
        // A chunk boundary lands mid-line far more often than not, so the tail is
        // held back until its newline arrives. `stream: true` does the same for a
        // multi-byte character split across chunks.
        buf += done ? dec.decode() : dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = done ? "" : lines.pop();
        for (const line of lines) onLine(line);
        if (done) { if (buf) onLine(buf); return; }
    }
}

// How often a partial catalog is handed up. Every line would be correct and
// useless: the viewer rebuilds its tree, shelves, concepts and wiki from scratch
// on each one — ~200ms of derivation at 4k files. Painting four times a second
// is already faster than anyone reads.
const EMIT_MS = 250;

// ponytail: the download itself is not optimised, only its arrival. The live
// view's shard is 34MB gzipped and 56% of it is `embedding` — 256 floats per row
// as JSON text. toRow already reads the packed form (`fields.embed.vec`, base64
// int8, ~10x smaller); the win is in whatever bakes the shard, not here.

async function load(view, onRows) {
    const cdn = `${view}/cdn`;

    // The view's own domain list: one per watched (owner, namespace), already
    // filtered to this view by the registry worker. It's the only way the browser
    // learns which domains to pull — the view's sources aren't public here.
    const { domains: listed = [] } = JSON.parse(await fetchText(`${cdn}/catalog`));
    // Narrowed BEFORE any manifest is fetched: a domain that is filtered out must
    // cost nothing, not be downloaded and then hidden.
    const domains = listed.filter((d) => wanted(d.name));
    if (_only && domains.length !== listed.length) {
        console.info(`search: pulling ${domains.length} of ${listed.length} domains (QUICKBEAM_DOMAINS=${_only.join(",")})`);
    }
    if (_only && !domains.length) {
        console.warn(`search: QUICKBEAM_DOMAINS=${_only.join(",")} matched none of ${listed.map((d) => d.name).join(", ")} — nothing will load`);
    }
    // A view with nothing baked yet is the normal state of a brand-new one, not an
    // error (browsing falls back to the relay). Say which it is, or "search finds
    // nothing" is indistinguishable from a URL pointing at the wrong view.
    if (!domains.length) console.warn(`search: quickbeam view ${cdn} has no baked domains yet — nothing to search until the watcher bakes one.`);

    const byId = new Map();
    const dead = new Set();

    // Every manifest BEFORE any shard: a tombstone retracts an id whatever order
    // its shard arrives in, and knowing them all up front is what makes an
    // intermediate emit honest rather than a flash of deleted files.
    const domainsAt = await Promise.all(domains.map(async (d) => {
        const at = `${cdn}/domains/${encodeURIComponent(d.name)}`;
        const m = JSON.parse(await fetchText(`${at}/manifest`));
        for (const id of m.tombstones ?? []) dead.add(id);
        return { at, shards: m.shards ?? [] };
    }));

    // Domains stream in parallel: their track_ids are vertex CIDs, so rows can't
    // collide across publishers and the interleaving is free. Sequential WITHIN a
    // domain, because a delta shard re-delivers an updated record under the same
    // track_id and the later one has to win.
    let painted = Date.now(); // first paint is a shard in, or EMIT_MS in — whichever comes first
    // A shard boundary always paints — it's the honest checkpoint, and there are
    // one or two of them. The throttle is for the lines INSIDE one, where there
    // are tens of thousands.
    const emit = (force) => {
        if (!onRows || (!force && Date.now() - painted < EMIT_MS)) return;
        onRows([...byId.values()]);
        // Clocked from when the paint FINISHED, not when it started: the callback
        // rebuilds the viewer's whole page synchronously, so timing from the start
        // would queue the next one before the last had let go of the thread.
        painted = Date.now();
    };
    await Promise.all(domainsAt.map(async ({ at, shards }) => {
        for (const s of shards) {
            await fetchLines(`${at}/shards/${s.file}`, (line) => {
                if (!line.trim()) return;
                const r = toRow(JSON.parse(line));
                if (!dead.has(r.id)) byId.set(r.id, r);
                emit();
            });
            emit(true);
        }
    }));
    return [...byId.values()];
}

/**
 * Hold the view's SSE stream open and call `onChange` when a watched namespace gains
 * shards. Returns an unsubscribe.
 *
 * The stream says WHEN a domain changed, never what — so this only drops the cache
 * and lets the next read re-pull through the normal shard route. `snapshot` is the
 * connect-time census and it re-fires on every automatic reconnect, so treating it
 * as a change would reload the whole catalog each time a proxy cuts the socket.
 */
export function watchShard(onChange, base) {
    let es = null, stopped = false;
    (async () => {
        const view = base ?? _active ?? await viewBase();
        if (!view || stopped) return;
        es = new EventSource(`${view}/stream`);
        const changed = () => { resetShard(); onChange(); };
        es.addEventListener("added", changed);  // a namespace's first bake
        es.addEventListener("change", changed); // new delta shards
    })().catch(() => { }); // no view configured → no live updates; search still works
    return () => { stopped = true; es?.close(); };
}

// ── the catalog of catalogs ──────────────────────────────────────────────────
// Ranking domains the client has NOT downloaded. `load()` above pulls every domain
// in the view, which is right at this catalog's size and wrong the moment a view
// watches something big — at which point the choice of WHAT to pull has to be made
// before the bytes move, and the only thing available to make it with is the
// coverage centroids quickbeam bakes into catalog.json.
//
// The vector to pass is the session kernel's `q` (src/geometry/kernel.js), not its `mu`:
// mu is where you are and ranks what you already have, q is where you're heading.
// That difference is the entire point — it's what lets a domain arrive before the
// user knows they were going there.

/**
 * Rank catalog entries against a lookahead vector.
 *
 * A domain baked before coverage existed gets `affinity: null` and sorts last —
 * NOT 0, which would claim it was measured and found unrelated.
 */
export function rankDomains(domains = [], q) {
    let qn = 0;
    for (const x of q) qn += x * x;
    qn = Math.sqrt(qn) || 1;
    return domains
        .map((d) => {
            const c = d.coverage;
            if (!c?.vectors?.length) return { ...d, affinity: null };
            // Truncate the query to the centroids' dim, not the other way round:
            // these are matryoshka prefixes, so the leading components line up.
            let best = -1;
            for (const v of c.vectors) {
                let dot = 0, vn = 0;
                for (let i = 0; i < v.length && i < q.length; i++) { dot += v[i] * q[i]; vn += v[i] * v[i]; }
                const score = dot / ((Math.sqrt(vn) || 1) * qn);
                if (score > best) best = score;
            }
            return { ...d, affinity: best };
        })
        .sort((a, b) => (b.affinity ?? -Infinity) - (a.affinity ?? -Infinity));
}

/** The view's domain list, ranked. Not cached — it's one small JSON and it changes
 *  whenever the watcher bakes. */
export async function suggestDomains(q, { url } = {}) {
    const view = url ?? _active ?? await viewBase();
    if (!view) throw new Error(NO_VIEW);
    const { domains = [] } = JSON.parse(await fetchText(`${view}/cdn/catalog`));
    return rankDomains(domains, q);
}

/** Everything the buy + stream path reads off a node, from a content row.
 *  purchase.js/stream.js take exactly these fields — the shard IS the pointer.
 *
 *  A fixed projection, not a spread of the whole row: the tree is held in memory for
 *  the whole session and a shard row can carry anything a publisher felt like
 *  committing. The cost is that a field nobody listed here vanishes silently between
 *  the shard and the UI, which is what `url` did on the first free-content corpus. */
const pointer = (r) => ({
    owner: r.owner, path: r.path, name: r.name, desc: r.desc, price: r.price,
    resourceId: r.resourceId, workerUrl: r.workerUrl, plaintextHash: r.plaintextHash,
    chunks: r.chunks ?? 1, size: r.size, chunkSize: r.chunkSize, mime: r.mime,
    // Free content: the bytes already have a public URL, so there is no resource to
    // mint and nothing to decrypt. This is the entire mechanism by which an open
    // corpus is browsable without a worker, a wallet or a payment.
    url: r.url, entityType: r.entityType,
    // Display only, and cheap. Without them every card is a filename and the page
    // looks exactly like the fake data it replaced.
    thumb: r.thumb, year: r.year, creator: r.creator, source: r.source,
    // What a run is made of. A publisher who tagged episodes committed these to
    // the shard, and dropping them here left the UI guessing the order of a
    // season off filenames — which works right up until one of them isn't named
    // SxxEyy. See run() in browse.js.
    series: r.series, season: r.season, episode: r.episode, duration: r.duration,
});

// Rows that are STRUCTURE rather than content: the tree is synthesized from paths,
// so a folder row is redundant, and a subtitles row hangs off the video it belongs
// to. Everything else with a path is a thing you can look at.
const STRUCTURAL = new Set(["folder", "subtitles"]);

/** A row that is a FILE in the catalog — something that can be a node in the
 *  tree, be searched, and be ranked.
 *
 *  Stated as "not structure" rather than "is a video" on purpose. The allowlist
 *  version silently dropped every entity type nobody had thought of yet — an
 *  article, an image, a dataset — which on a browser over arbitrary corpora is a
 *  whole content type vanishing between the shard and the UI with no error. A
 *  publisher who invents a type gets it rendered; a publisher who invents a new
 *  kind of STRUCTURE has to say so here, which is the rarer event.
 *
 *  Note it does NOT require a resourceId: a catalog entry is a real file in the
 *  catalog that simply isn't for sale. Requiring one here is what used to drop
 *  the entire free half of a catalog before it reached the UI — invisible in the
 *  tree, absent from fileVectors, and so unreachable by the session kernel. */
const fileRow = (r) => !!r.path && !STRUCTURAL.has(r.entityType);
/** …and of those, the ones there is actually something to buy. */
const sellable = (r) => fileRow(r) && !!r.resourceId;
const fileKey = (owner, path) => `${String(owner).toLowerCase()}\n${path}`;

const cosine = (row, qv, qn) => {
    let d = 0;
    for (let i = 0; i < qv.length && i < row.vector.length; i++) d += row.vector[i] * qv[i];
    return d / (row.norm * qn);
};

/**
 * How far above the corpus mean a cosine has to sit to count as a hit.
 *
 * Raw nomic-256 cosine is offset per query, not per corpus: measured on this
 * catalog, EVERY row scores 0.38–0.65 against "panama", so `score > 0` admitted
 * all twelve and the one right answer was buried in eleven near-misses that
 * looked, by their printed scores, just as confident. Same measurement in z: the
 * right row lands 2.4σ above that query's own mean, the plausible ones ~1.3σ,
 * the rest below. Same trick probes.js uses to decide shelf membership.
 *
 * Lexical scores keep a meaningful zero (a term either matched or it didn't), so
 * this applies to the semantic half only.
 */
const Z_FLOOR = 1;

/** score ≥ mean + Z_FLOOR·σ, or -Infinity when there's no distribution to speak
 *  of (too few rows, or every row scored the same). */
function zFloor(scores) {
    if (scores.length < 3) return -Infinity;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length);
    return sd > 1e-6 ? mean + Z_FLOOR * sd : -Infinity;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (s) => new RegExp(`\\b${esc(s)}\\b`);

/**
 * Word-boundary term scoring, normalized to 0..1 so it merges with cosine scores.
 *
 * This used to be a bare `text.includes(q)`, which meant a search for "cat"
 * ranked "intoxi(cat)ed" and "edu(cat)ion" — every short query drowned in
 * substring noise. Terms must now match whole words; the full phrase and an
 * early position are bonuses on top.
 */
function lexScore(row, q) {
    const text = String(row.text ?? "").toLowerCase();
    if (!text) return 0;
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) return 0;

    let hits = 0;
    for (const t of terms) if (wordRe(t).test(text)) hits++;
    if (!hits) return 0;

    const at = text.indexOf(q);
    return Math.min(1,
        0.5 * (hits / terms.length)                       // how much of the query is present
        + (wordRe(q).test(text) ? 0.35 : 0)               // the whole phrase, intact
        + (at >= 0 ? 0.15 * (1 - at / text.length) : 0)); // earlier beats later
}

/** The cue a subtitle hit should quote and seek to: the line that best matches
 *  the query, or the first one when nothing matches lexically (a semantic hit on
 *  the transcript as a whole has no single line to point at). */
function bestCue(cues, ql) {
    let best = cues[0], score = 0;
    for (const c of cues) {
        const s = lexScore({ text: c.text }, ql);
        if (s > score) { score = s; best = c; }
    }
    return best;
}

/**
 * Collapse a ranked hit list into results a person can scan.
 *
 * Fifty-four episodes of one show share a description, a creator and a series
 * name, so they embed to near-identical vectors and arrive as fifty-four TIED
 * hits in whatever order the shard happened to hold them. That is not a ranking
 * bug and no ranker fixes it — the text really is the same. What's wrong is
 * treating a series as fifty-four results: "digimon adventure" should answer
 * with the show, opening at episode 1, not bury episode 1 forty rows down.
 *
 * So: one row per series+season, entered at its lowest episode, keeping the best
 * score the group scored. Everything untagged stays exactly one row per hit, and
 * subtitle hits are never grouped — a quoted line at 12:04 IS the result, and
 * folding it into a show would throw away the seek that makes it worth showing.
 */
export function groupHits(hits) {
    const out = [];
    const seen = new Map();
    for (const h of hits) {
        const node = h.episode;
        const key = h.entityType === "subtitles" ? null : seriesKey(node);
        if (!key) { out.push({ h, node, items: node ? [node] : [] }); continue; }
        const g = seen.get(key);
        if (g) g.items.push(node);
        else { const row = { h, node, items: [node] }; seen.set(key, row); out.push(row); }
    }
    for (const g of out) {
        if (g.items.length < 2) continue;
        g.items.sort(byEpisode);
        g.node = g.items[0]; // the door into a show is its first episode
    }
    return out;
}

/**
 * The same hits, grouped by the FILE they point at — one entry per file, with
 * every cue that matched kept underneath it.
 *
 * groupHits() above folds a SERIES into one row and deliberately leaves subtitle
 * hits alone, because the seek is the result. That is right about the seek and
 * wrong about the page: one episode that says the word nine times is nine
 * identical rows, and a dozen of those is the whole screen. Nothing is discarded
 * here either — the cues become `moments`, each still carrying its own `start`.
 *
 * `nodeFor` resolves a hit to its node; the caller owns the fallback for a row
 * baked without a payment pointer.
 *
 * @returns [{ key, node, name, score, mode, text, moments: [{ id, start, text }] }]
 *          in rank order — a file's place is its best cue's place.
 */
export function groupByFile(hits, nodeFor = (h) => h.episode) {
    const by = new Map();
    for (const h of hits) {
        const node = nodeFor(h);
        // No node: nothing to key on and nothing to open. The row is kept under
        // its own id rather than dropped — it still says the catalog matched.
        const key = node ? nodeKey(node) : `?${h.id}`;
        let g = by.get(key);
        if (!g) by.set(key, (g = { key, node, name: h.name, score: h.score, mode: h.mode, text: null, moments: [] }));
        // A file hit matched the file ITSELF (name, path, the publisher's
        // description) — no line to quote and nowhere to seek, so it contributes
        // the blurb instead of a moment.
        if (h.entityType !== "subtitles") g.text ??= h.text;
        else g.moments.push({ id: h.id, start: h.start, text: h.text });
    }
    return [...by.values()];
}

/**
 * Rank the catalog against `q` — published files by name/description, and the
 * lines of dialogue inside them.
 * @returns [{ id, videoPath, name, entityType, start, end, text, score, mode,
 *            episode }] — `start` is the seek target in seconds, `episode` the
 *          payment pointer, `mode` is "semantic" | "lexical".
 */
export async function searchSubtitles(q, { limit = 20, url, embed = embedQuery } = {}) {
    const query = q.trim();
    if (!query) return [];
    const rows = await loadShard(url);
    // A subtitles row is only playable through its video, and folders are not
    // sellable at all — so both resolve through the file index or drop out.
    const files = new Map();
    for (const r of rows) if (fileRow(r)) files.set(fileKey(r.owner, r.path), r);

    // Two different reasons every hit can come back lexical (≡), and they used to
    // be indistinguishable from the outside: the shard has no vectors at all, or
    // the embedder wouldn't load. Say which — silently degrading to substring
    // matching and leaving the user to guess is how "search stopped working" turns
    // into an afternoon.
    const embeddable = rows.some((r) => r.vector);
    let qv = null;
    if (!embeddable) {
        console.warn(`search: the view's shards carry no vectors (${rows.length} rows) — lexical only. Those rows were committed without embeddings; republish them.`);
    } else {
        try { qv = await embed(query); }
        catch (e) { console.warn("search: embedder unavailable, falling back to lexical —", e); }
    }
    let qn = 0;
    if (qv) { for (const x of qv) qn += x * x; qn = Math.sqrt(qn) || 1; }

    const ql = query.toLowerCase();
    const scored = rows
        .filter((r) => r.entityType !== "folder")
        .map((r) => (qv && r.vector
            ? { row: r, score: cosine(r, qv, qn), mode: "semantic" }
            : { row: r, score: lexScore(r, ql), mode: "lexical" }));
    // The floor is per QUERY, over the whole corpus — so it has to be measured
    // before anything is dropped.
    const floor = zFloor(scored.filter((x) => x.mode === "semantic").map((x) => x.score));
    const ranked = scored
        .filter((x) => (x.mode === "semantic" ? x.score >= floor : x.score > 0))
        .sort((a, b) => b.score - a.score)
        .map(({ row, score, mode }) => {
            const file = row.entityType === "subtitles" ? files.get(fileKey(row.owner, row.videoPath)) : row;
            if (!file) return null; // subtitles for a file that is no longer published
            const cue = row.cues?.length ? bestCue(row.cues, ql) : null;
            return {
                id: row.id, videoPath: file.path, name: file.name, entityType: row.entityType,
                episode: pointer(file),
                start: cue?.start ?? 0, end: cue?.end ?? 0,
                text: cue?.text ?? row.desc ?? row.path,
                score, mode,
            };
        })
        .filter(Boolean);

    // Limit RESULTS, not rows — and a series is ONE result (see groupHits).
    //
    // The naive slice(0, limit) is what made "digimon" answer with a single show:
    // fifty-four episodes of one series share a description, so they score tied,
    // and twenty of them filled the whole page before any other series got a
    // look in. Refining to "digimon adventure" only reshuffled which twenty won.
    // Every member of an admitted series is kept, because the row shows the
    // episode count and the queue plays them.
    const out = [];
    const kept = new Set();
    for (const h of ranked) {
        const key = h.entityType === "subtitles" ? h.id : (seriesKey(h.episode) ?? h.id);
        if (!kept.has(key)) {
            if (kept.size >= limit) break;
            kept.add(key);
        }
        out.push(h);
    }
    return out;
}

/**
 * The browse tree, from the view's shards instead of the relay.
 *
 * `/api/catalog` costs a getLogs from block 0, a status read per publisher, and
 * an IPFS DAG walk per publisher — on EVERY cold viewer, most of them wasted on
 * publishers who never published here. The shards already carry the answer:
 * every `video` row holds exactly the fields ViewNode and useWatch read (owner,
 * path, name, price, resourceId, workerUrl, plaintextHash, chunks, size,
 * chunkSize, mime). So browsing is a handful of cacheable CDN GETs, and the relay
 * drops out of the viewer path entirely.
 *
 * Shape matches /api/catalog's: each publisher's roots nested separately and
 * tagged with `owner`, because two publishers may hold the same relpath.
 *
 * ponytail: folders are synthesized from path prefixes and the snapshot's own
 * `folder` rows are ignored, so a published-but-empty folder can't appear —
 * nothing to buy in one anyway. An `owner` filter is applied here, not refetched.
 */
export async function catalogFromShard({ owner = "", url, onTree } = {}) {
    // `onTree` gets the tree rebuilt from the rows downloaded so far, once per
    // shard. Rebuilding the whole tree each time rather than patching it: it's a
    // nest of a few thousand rows, and a patch would need the same dedupe rules
    // in a second place.
    const rows = await loadShard(url, onTree && ((partial) => onTree(treeFrom(partial, owner))));
    return treeFrom(rows, owner);
}

function treeFrom(rows, owner) {
    const only = owner.toLowerCase();

    // One node per (owner, path). `video` rows are exactly one per published file
    // once tombstones and same-id delta rows are resolved (see load()).
    const byOwner = new Map();
    for (const r of rows) {
        if (!fileRow(r)) continue;
        if (only && r.owner?.toLowerCase() !== only) continue;
        const ep = pointer(r);
        let paths = byOwner.get(r.owner);
        if (!paths) byOwner.set(r.owner, (paths = new Map()));
        if (paths.has(ep.path)) continue;
        paths.set(ep.path, { ...ep, type: "video" });
        // Synthesize the ancestor folders. Hitting one that already exists means
        // its ancestors do too — every chain is added whole.
        for (let p = ep.path; p.includes("/");) {
            p = p.slice(0, p.lastIndexOf("/"));
            if (paths.has(p)) break;
            paths.set(p, { path: p, name: p.slice(p.lastIndexOf("/") + 1), type: "folder" });
        }
    }

    const tree = [];
    for (const ownerAddr of [...byOwner.keys()].sort()) {
        for (const root of nest([...byOwner.get(ownerAddr).values()])) tree.push({ ...root, owner: ownerAddr });
    }
    return { tree, publishers: [...byOwner.keys()] };
}

/**
 * resourceId → embedding, for every published file the shard carries a vector
 * for. The viewer ranks its shelves with this (see browse.js): the vectors are
 * already in the shard it downloaded to search with, so "more like this" costs
 * one Map build and never leaves the tab.
 *
 * Empty when nothing has been embedded yet — the caller drops the shelf rather
 * than inventing recommendations out of file order.
 */
export async function fileVectors(url, onVecs) {
    // Streams for the same reason the catalog does: everything ranked — the picks
    // row, topics, the wiki's recommendations — is dead until vectors exist, so
    // holding them back until the last byte means the page finishes arriving and
    // then sits there half-empty. Rebuilding the Map per emit is a few thousand
    // Map.set calls over rows that are already parsed.
    const build = (rows) => {
        const m = new Map();
        for (const r of rows) if (fileRow(r) && r.vector) m.set(nodeKey(r), r.vector);
        return m;
    };
    return build(await loadShard(url, onVecs && ((partial) => onVecs(build(partial)))));
}

/** First sellable node in a nested catalog matching `match` — a search hit's
 *  path, or the resourceId a permalink names. Folders are never returned. */
export function findNode(tree, match) {
    const stack = [...(tree ?? [])];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === "video" && match(n)) return n;
        if (n.children) stack.push(...n.children);
    }
    return null;
}

/** Node at `path`, FOLDERS INCLUDED — the studio's counterpart to findNode.
 *  Kept separate rather than adding a flag to findNode: the viewer's guarantee
 *  that a search hit or permalink never resolves to a folder is worth keeping
 *  un-negotiable, and the studio genuinely wants the folder. */
export function findStudioNode(tree, path) {
    const stack = [...(tree ?? [])];
    while (stack.length) {
        const n = stack.pop();
        if (n.path === path) return n;
        if (n.children) stack.push(...n.children);
    }
    return null;
}

/** Files under `node`, recursively: [all, published]. What deleting a folder
 *  actually destroys, which is what the confirm prompt has to say out loud. */
export function countFiles(node) {
    let all = 0, published = 0;
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        if (n.type !== "folder") { all++; if (n.published) published++; }
        if (n.children) stack.push(...n.children);
    }
    return [all, published];
}

// ── self-check: `node src/catalog/search.js` — ranking over a stubbed shard fetch ─────
// Runs in node (fetch/DecompressionStream are global there too) and never loads
// the real embedder: the `embed` seam is what a browser fills with transformers.js.
// `process` doesn't exist in the browser — this module is the one self-check that
// gets bundled, so the guard has to survive being evaluated by a browser.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const { gzipSync } = await import("node:zlib");
    console.warn = () => {}; // the fallback warnings are the behaviour under test, not output

    // ── fixtures in quickbeam's wire format ──
    const vid = (owner, path, extra = {}, embedding) => ({
        track_id: `${owner}:${path}`, owner, ...(embedding ? { embedding } : {}),
        fields: {
            entityType: "video", kind: "video", name: path.split("/").pop(), path,
            price: "1000", resourceId: `0x${path.length}`, workerUrl: "https://w",
            plaintextHash: "0xph", chunks: 1, size: 10, chunkSize: 64, mime: "video/mp4", ...extra,
        },
    });
    const subs = (owner, videoPath, cues, embedding) => ({
        track_id: `${owner}:${videoPath}#subs`, owner, ...(embedding ? { embedding } : {}),
        fields: { entityType: "subtitles", kind: "subtitles", name: videoPath.split("/").pop(), videoPath, cues },
    });
    const dir = (owner, path) => ({
        track_id: `${owner}:${path}#dir`, owner, embedding: [1, 0, 0],
        fields: { entityType: "folder", kind: "folder", name: path.split("/").pop(), path },
    });

    const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");
    const VIEW = "https://registry.test/q/qb_test";
    // Two chunks, split mid-body: the fixture exercises the streaming reader the
    // real loader uses, including a line cut across a chunk boundary.
    const body = (buf) => {
        const b = Buffer.from(buf), half = Math.max(1, Math.floor(b.length / 2));
        return {
            ok: true, headers: new Headers(), arrayBuffer: async () => b,
            body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b.subarray(0, half))); c.enqueue(new Uint8Array(b.subarray(half))); c.close(); } }),
        };
    };

    /** Stub a whole VIEW: /api/config → the base, /cdn/catalog → its domains, then a
     *  manifest + N shards each. `domains` is {domainName: [shard, shard, …]}, shards
     *  served in order. `gzipped: false` is the Content-Encoding case — the browser
     *  already decoded the body, so the loader receives plain NDJSON. `keep` leaves
     *  the caches alone, for the one test that must load through a poisoned slot. */
    const serveView = (domains, { tombstones = {}, gzipped = true, keep = false, coverage = {} } = {}) => {
        const state = new Map();
        for (const [name, shards] of Object.entries(domains)) {
            const files = shards.map((_, i) => `shard-000${i}-${name}.ndjson.gz`);
            state.set(name, {
                manifest: JSON.stringify({ name, shards: files.map((file) => ({ file })), tombstones: tombstones[name] ?? [] }),
                bodies: new Map(files.map((f, i) => [f, ndjson(shards[i])])),
            });
        }
        globalThis.fetch = async (url) => {
            const { pathname } = new URL(String(url), "https://relay.test");
            // The config carries the /stream URL the registry prints, so an untrimmed
            // base would ask for /stream/cdn/… — which must 404 here, not silently work.
            if (pathname.includes("/stream/")) return { ok: false, status: 404 };
            if (pathname === "/api/config") return body(JSON.stringify({ quickbeam: `${VIEW}/stream` }));
            if (pathname.endsWith("/cdn/catalog")) return body(JSON.stringify({ domains: [...state.keys()].map((name) => ({ name, ...(coverage[name] ? { coverage: coverage[name] } : {}) })) }));
            let m = pathname.match(/\/cdn\/domains\/([^/]+)\/manifest$/);
            if (m) return state.has(m[1]) ? body(state.get(m[1]).manifest) : { ok: false, status: 404 };
            m = pathname.match(/\/cdn\/domains\/([^/]+)\/shards\/([^/]+)$/);
            if (m) {
                const text = state.get(m[1])?.bodies.get(m[2]);
                if (text === undefined) return { ok: false, status: 404 };
                return body(gzipped ? gzipSync(Buffer.from(text)) : Buffer.from(text));
            }
            return { ok: false, status: 404 };
        };
        if (!keep) resetShard();
    };
    /** One domain — the shape most of these fixtures need. */
    const serve = (shards, opts = {}) => serveView({ d0: shards }, { ...opts, tombstones: { d0: opts.tombstones ?? [] } });

    // ── lexical: no vectors anywhere (the pre-embedding state) ──
    serve([[
        vid("0xaaa", "music/four to the floor.mp3", { desc: "four to the floor and the beat goes on" }),
        vid("0xaaa", "music/quiet.mp3", { desc: "nothing relevant at all" }),
    ]]);
    let hits = await searchSubtitles("four to the floor");
    if (hits[0]?.videoPath !== "music/four to the floor.mp3") throw new Error(`lexical: wrong top hit ${hits[0]?.id}`);
    if (hits[0].mode !== "lexical") throw new Error("no vectors must mean lexical mode");
    if (hits.some((h) => h.videoPath === "music/quiet.mp3")) throw new Error("non-matching row must be filtered out");

    // ── groupByFile: one card per file, every cue kept as a moment ────────────
    {
        const cue = (id, path, start, text, score) => ({
            id, videoPath: path, name: path.split("/").pop(), entityType: "subtitles",
            episode: { owner: "0xaaa", path }, start, text, score, mode: "semantic",
        });
        const g = groupByFile([
            cue("c1", "tv/ep1.mp4", 12, "the line", 0.9),
            cue("c2", "tv/ep1.mp4", 300, "again", 0.8),
            cue("c3", "tv/ep2.mp4", 5, "elsewhere", 0.7),
            cue("c4", "tv/ep1.mp4", 44, "and again", 0.6),
        ]);
        if (g.length !== 2) throw new Error(`three cues in one file must be one card, got ${g.length}`);
        if (g[0].moments.length !== 3) throw new Error("every cue must survive as a moment");
        if (g[0].score !== 0.9) throw new Error("a file's score is its BEST cue's, so rank order is kept");
        if (g[0].moments[0].start !== 12) throw new Error("a moment must keep its seek");
        if (g[1].key === g[0].key) throw new Error("two files must be two cards");

        // A file hit carries the blurb, not a moment — there is nowhere to seek.
        const f = groupByFile([{ id: "f1", name: "doc.pdf", entityType: "video", text: "a blurb", score: 0.5, mode: "lexical", episode: { owner: "0xaaa", path: "doc.pdf" } }]);
        if (f[0].moments.length) throw new Error("a file hit has no moment");
        if (f[0].text !== "a blurb") throw new Error("a file hit contributes its blurb");
        // A row with no pointer is kept, not dropped.
        if (groupByFile([{ id: "x", name: "n", entityType: "subtitles", start: 0, text: "t", score: 0.1 }], () => null).length !== 1) {
            throw new Error("a row with no payment pointer must still be shown");
        }
    }
    if ((await searchSubtitles("   ")).length !== 0) throw new Error("blank query must return nothing");

    // THE substring bug: "cat" must not match "intoxicated" or "education".
    // Every short query was drowning in mid-word matches.
    serve([[
        vid("0xaaa", "a.mp4", { desc: "welcome to the wonderland got to be intoxicated too" }),
        vid("0xaaa", "b.mp4", { desc: "workshops for kids excluded from mainstream education" }),
        vid("0xaaa", "c.mp4", { desc: "a cat drinking water" }),
    ]]);
    hits = await searchSubtitles("cat");
    if (hits.length !== 1) throw new Error(`"cat" matched inside words: ${hits.map((h) => h.videoPath)}`);
    if (hits[0].videoPath !== "c.mp4") throw new Error("whole-word match must win");

    // Partial multi-term queries still rank, they just rank lower than a full phrase.
    serve([[
        vid("0xaaa", "y0.mp4", { desc: "a red train pulling in" }),
        vid("0xaaa", "y1.mp4", { desc: "the train was late" }),
    ]]);
    hits = await searchSubtitles("red train");
    if (hits[0]?.videoPath !== "y0.mp4") throw new Error("intact phrase must outrank a single term");
    if (hits.length !== 2) throw new Error("a partial term match must still be a hit");

    // The Content-Encoding case: vite serves .gz with `Content-Encoding: gzip`, so
    // the browser hands over already-decoded NDJSON. Both wire forms must parse.
    serve([[vid("0xaaa", "z.mp4", { desc: "four to the floor" })]], { gzipped: false });
    if ((await searchSubtitles("four to the floor"))[0]?.videoPath !== "z.mp4") {
        throw new Error("pre-decompressed body (Content-Encoding: gzip) failed to parse");
    }

    // ── semantic: vectors present, query embedded through the seam ──
    serve([[
        vid("0xaaa", "a.mp4", { desc: "totally unrelated words" }, [1, 0, 0]),
        vid("0xaaa", "b.mp4", { desc: "also unrelated words" }, [0, 1, 0]),
    ]]);
    hits = await searchSubtitles("anything", { embed: async () => [0, 1, 0] });
    if (hits[0].videoPath !== "b.mp4") throw new Error(`semantic: cosine picked ${hits[0]?.videoPath}`);
    if (hits[0].mode !== "semantic" || Math.abs(hits[0].score - 1) > 1e-9) throw new Error(`cosine score off: ${hits[0].score}`);

    // The packed wire form a publisher commits: base64 int8 under fields.embed,
    // not a float array. Both must rank identically or the two bakes disagree.
    const { packVec } = await import("../llm/embed.js");
    serve([[
        vid("0xaaa", "a.mp4", { embed: { dim: 3, vec: packVec([1, 0, 0]) } }),
        vid("0xaaa", "b.mp4", { embed: { dim: 3, vec: packVec([0, 1, 0]) } }),
    ]]);
    hits = await searchSubtitles("anything", { embed: async () => [0, 1, 0] });
    if (hits[0]?.videoPath !== "b.mp4" || hits[0].mode !== "semantic") throw new Error("base64 int8 vectors must rank the same as float arrays");
    if (Math.abs(hits[0].score - 1) > 0.01) throw new Error(`quantized cosine drifted too far: ${hits[0].score}`);

    // The noise floor: cosine against a real corpus is positive for everything, so
    // `score > 0` returned the whole catalog for every query and the right answer
    // was one row among twelve equally-confident-looking ones. Only rows standing
    // out from THIS query's distribution are hits.
    serve([[
        vid("0xaaa", "hit.mp4", {}, [1, 0, 0]),
        vid("0xaaa", "n1.mp4", {}, [0.6, 0.8, 0]),
        vid("0xaaa", "n2.mp4", {}, [0.6, 0, 0.8]),
        vid("0xaaa", "n3.mp4", {}, [0.5, 0.5, 0.7]),
    ]]);
    hits = await searchSubtitles("anything", { embed: async () => [1, 0, 0] });
    if (hits.length !== 1 || hits[0].videoPath !== "hit.mp4") throw new Error(`noise floor let ${hits.length} rows through: ${hits.map((h) => h.videoPath)}`);
    // Too few rows to have a distribution — filtering there would just hide the
    // catalog, so everything still ranks.
    serve([[vid("0xaaa", "a.mp4", {}, [1, 0, 0]), vid("0xaaa", "b.mp4", {}, [0, 1, 0])]]);
    if ((await searchSubtitles("q", { embed: async () => [1, 0, 0] })).length !== 2) throw new Error("a tiny corpus must not be filtered by the z-floor");

    // A garbage vector must not throw mid-search — the row just goes lexical.
    serve([[vid("0xaaa", "c.mp4", { desc: "still findable", embed: { vec: "!!!" } })]]);
    if ((await searchSubtitles("findable"))[0]?.mode !== "lexical") throw new Error("a corrupt vector must degrade to lexical");

    // A dead embedder must degrade to lexical, not throw.
    serve([[
        vid("0xaaa", "a.mp4", { desc: "totally unrelated words" }, [1, 0, 0]),
        vid("0xaaa", "b.mp4", { desc: "also unrelated words" }, [0, 1, 0]),
    ]]);
    hits = await searchSubtitles("unrelated", { embed: async () => { throw new Error("no model"); } });
    if (hits[0]?.mode !== "lexical") throw new Error("embedder failure must fall back to lexical");

    // ── every hit carries the payment pointer, or it is not a hit ──
    // Hits span publishers and the loaded tree only ever holds one of them, so a
    // hit that can't pay for itself is unplayable (App.jsx reads `h.episode`).
    serve([[vid("0xaaa", "music/locura.mp3", { price: "5000", chunks: 3, desc: "spanish house" })]]);
    hits = await searchSubtitles("spanish house");
    if (hits[0]?.episode?.resourceId !== "0x16") throw new Error("hit dropped its payment pointer");
    if (hits[0].episode.price !== "5000" || hits[0].episode.chunks !== 3) throw new Error("pointer lost price/geometry");
    if (hits[0].entityType !== "video") throw new Error("entityType lost");

    // ── subtitles: a cue hit plays its VIDEO, seeked to that line ──
    serve([[
        vid("0xaaa", "videos/ep5.mp4"),
        subs("0xaaa", "videos/ep5.mp4", [
            { start: 0, end: 26, text: "thanks for watching" },
            { start: 26, end: 30, text: "the writing is on the wall" },
        ]),
    ]]);
    hits = await searchSubtitles("the writing is on the wall");
    const cueHit = hits.find((h) => h.entityType === "subtitles");
    if (!cueHit) throw new Error("a subtitle line must be findable");
    if (cueHit.start !== 26) throw new Error(`seek target lost: ${cueHit.start}`);
    if (cueHit.episode?.resourceId !== "0x14") throw new Error("subtitle hit must resolve to its video's pointer");
    if (cueHit.videoPath !== "videos/ep5.mp4" || cueHit.name !== "ep5.mp4") throw new Error("subtitle hit must name the video");
    // A semantic hit on the transcript has no matching line — it still needs a cue
    // to quote and a place to start, so it falls back to the first one.
    serve([[vid("0xaaa", "videos/ep5.mp4"), subs("0xaaa", "videos/ep5.mp4", [{ start: 7, end: 9, text: "hello" }], [0, 1, 0])]]);
    if ((await searchSubtitles("q", { embed: async () => [0, 1, 0] })).find((h) => h.entityType === "subtitles")?.start !== 7) {
        throw new Error("a semantic subtitle hit must still carry a seek target");
    }
    // Subtitles whose video is gone (unpublished, tombstoned) must vanish, not
    // render as a dead button.
    serve([[subs("0xaaa", "videos/ep5.mp4", [{ start: 0, end: 5, text: "orphaned line" }])]]);
    if ((await searchSubtitles("orphaned line")).length !== 0) throw new Error("subtitles for an unpublished file must not be a hit");

    // Folders are structure, not merchandise — a folder row must never rank.
    serve([[dir("0xaaa", "music"), vid("0xaaa", "music/x.mp3", { desc: "music" })]]);
    hits = await searchSubtitles("music", { embed: async () => [1, 0, 0] });
    if (hits.some((h) => h.entityType === "folder")) throw new Error("a folder row must never be a hit");

    // ── snapshot semantics: deltas and tombstones ──
    // Shards are immutable, so an edit re-delivers the same track_id in a later
    // shard and a delete lands in the manifest's tombstones. Ignoring either
    // resurrects deleted files or double-lists edited ones at a stale price.
    serve([
        [vid("0xaaa", "music/locura.mp3", { price: "1000" }), vid("0xaaa", "old.mp3", { desc: "deleted" })],
        [vid("0xaaa", "music/locura.mp3", { price: "9999" })],
    ], { tombstones: ["0xaaa:old.mp3"] });
    let cat = await catalogFromShard();
    let flat = [];
    (function walk(ns) { for (const n of ns) (n.type === "folder" ? walk(n.children) : flat.push(n)); })(cat.tree);
    if (flat.length !== 1) throw new Error(`delta/tombstone resolution wrong: ${flat.map((f) => f.path)}`);
    if (flat[0].price !== "9999") throw new Error("a later shard must displace the stale row, not lose to it");
    if ((await searchSubtitles("deleted")).length !== 0) throw new Error("a tombstoned row must not be searchable");

    // An unreachable view must surface its status, and must not poison the cache:
    // one failure used to break every later search until a page reload.
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    resetShard();
    let msg = "";
    try { await searchSubtitles("anything"); } catch (e) { msg = e.message; }
    if (!msg.includes("502")) throw new Error(`a dead view must name the HTTP status, got: ${msg}`);
    // `keep` on purpose — the retry has to work off the caches the failure left
    // behind, which is the actual bug being guarded.
    serve([[vid("0xaaa", "r.mp3", { desc: "recovered after a failure" })]], { keep: true });
    if ((await searchSubtitles("recovered")).length !== 1) throw new Error("a failed load poisoned the cache");

    // A relay with no QUICKBEAM_URL set must name the env var. Searching an empty
    // catalog instead is how "search returns nothing" becomes an afternoon.
    globalThis.fetch = async () => body(JSON.stringify({ readOnly: false }));
    resetShard();
    msg = "";
    try { await searchSubtitles("anything"); } catch (e) { msg = e.message; }
    if (!msg.includes("QUICKBEAM_URL")) throw new Error(`an unconfigured relay must name the env var, got: ${msg}`);

    // ── catalogFromShard: the browse tree, without touching the relay ──
    serve([[
        vid("0xaaa", "Show/S1/b.mp4", { price: "5000", mime: "video/mp4", size: 12, chunks: 3 }),
        vid("0xaaa", "Show/S1/a.mp4"),
        vid("0xbbb", "Show/S1/a.mp4"), // same relpath, different publisher
        // A subtitles row hangs off a file — it must not become a second node.
        subs("0xaaa", "Show/S1/b.mp4", [{ start: 4, end: 6, text: "hi" }]),
        dir("0xaaa", "Show/S1"),
    ]]);
    cat = await catalogFromShard();
    if (cat.tree.length !== 2) throw new Error(`one root per publisher, got ${cat.tree.length}`);
    const aRoot = cat.tree.find((n) => n.owner === "0xaaa");
    if (aRoot.type !== "folder" || aRoot.name !== "Show") throw new Error("ancestor folders not synthesized");
    const s1 = aRoot.children[0];
    if (s1.name !== "S1" || s1.children.length !== 2) throw new Error(`nesting wrong: ${JSON.stringify(s1.children.map((c) => c.name))}`);
    // Sorted like the relay's tree, and every field the player needs rides along.
    if (s1.children.map((c) => c.name).join(",") !== "a.mp4,b.mp4") throw new Error("children not sorted");
    const b = s1.children[1];
    if (b.type !== "video" || b.price !== "5000" || b.chunks !== 3 || b.mime !== "video/mp4" || b.size !== 12) {
        throw new Error(`payment/geometry pointer lost: ${JSON.stringify(b)}`);
    }
    if (!b.workerUrl || !b.plaintextHash || !b.chunkSize) throw new Error("node is missing what stream.js/purchase.js read");
    // Two publishers holding the same relpath must not merge into one node.
    if (cat.tree.find((n) => n.owner === "0xbbb").children[0].children.length !== 1) throw new Error("publishers' trees crossed over");
    // Filtering to one publisher must not need a different data source.
    const one = await catalogFromShard({ owner: "0xBBB" });
    if (one.tree.length !== 1 || one.tree[0].owner !== "0xbbb") throw new Error("owner filter must be case-insensitive and exclusive");

    // ── a view is N domains, one per watched (owner, namespace) ──
    // The catalog lists them all and the loader has to merge them: rows from every
    // domain are browsable and searchable, and one domain's tombstones must not
    // reach into another's rows.
    serveView({
        "aaa-media": [[vid("0xaaa", "music/a.mp3", { desc: "alpha" }), vid("0xaaa", "gone.mp3", { desc: "retracted" })]],
        "bbb-media": [[vid("0xbbb", "music/b.mp3", { desc: "beta" })]],
    }, { tombstones: { "aaa-media": ["0xaaa:gone.mp3"] } });
    cat = await catalogFromShard();
    if (cat.publishers.length !== 2) throw new Error(`every domain must merge into one catalog, got ${cat.publishers}`);
    if ((await searchSubtitles("alpha"))[0]?.videoPath !== "music/a.mp3") throw new Error("the first domain's rows must be searchable");
    if ((await searchSubtitles("beta"))[0]?.videoPath !== "music/b.mp3") throw new Error("the second domain's rows must be searchable");
    if ((await searchSubtitles("retracted")).length !== 0) throw new Error("a tombstone must retract its own domain's row");

    // Vectors for the "more like this" shelves, keyed the way browse.js looks them up.
    serve([[vid("0xaaa", "a.mp4", {}, [1, 0, 0]), vid("0xaaa", "b.mp4"), subs("0xaaa", "a.mp4", [{ start: 0, end: 1, text: "x" }], [0, 1, 0])]]);
    const vecs = await fileVectors();
    if (vecs.size !== 1 || !vecs.has("0x5")) throw new Error(`fileVectors must key published files by resourceId: ${[...vecs.keys()]}`);

    // A snapshot of nothing but folders yields nothing — folders are synthesized
    // from paths, so a bare folder row is never a node on its own.
    serve([[dir("0xaaa", "music")]]);
    if ((await catalogFromShard()).tree.length !== 0) throw new Error("a folder row must not become a browsable node on its own");

    // Streaming: a two-shard catalog must reach the caller in two installments,
    // growing, and a tombstoned row must never appear in one of them.
    serve([
        [vid("0xaaa", "a.mp3"), vid("0xaaa", "gone.mp3", { desc: "deleted" })],
        [vid("0xaaa", "b.mp3")],
    ], { tombstones: ["0xaaa:gone.mp3"] });
    const steps = [];
    const streamed = await catalogFromShard({ onTree: ({ tree }) => steps.push(tree.length) });
    if (steps.length !== 2 || steps[0] !== 1 || steps[1] !== 2) throw new Error(`catalog must stream per shard, got ${steps}`);
    if (streamed.tree.length !== 2) throw new Error("the streamed final tree must still be whole");
    if (steps.some((n) => n > 2)) throw new Error("a tombstoned row must never surface in a partial emit");

    // A LATE subscriber must stream too. The viewer's catalog, its vector map and
    // the search box's warm-up all call loadShard on the same tick; honouring only
    // the caller that happened to start the download meant the one holding the
    // paint callback usually wasn't it, and the page stayed blank until the last
    // byte even though every row was already parsed.
    serve([
        [vid("0xaaa", "a.mp3")],
        [vid("0xaaa", "b.mp3")],
    ]);
    {
        const first = [], second = [];
        // No callback on the starter, on purpose — this is the losing order.
        const a = loadShard(undefined, (r) => first.push(r.length));
        const b = catalogFromShard({ onTree: ({ tree }) => second.push(tree.length) });
        await Promise.all([a, b]);
        if (!first.length) throw new Error("the starting caller must still receive partials");
        if (!second.length) throw new Error("a caller that joins an in-flight load must receive partials too");
    }

    // Vectors stream on the same subscription. Without this the catalog paints and
    // then every ranked row on it stays empty until the download ends.
    // One domain, two shards — so they are read in order and the boundary between
    // them is an observable emit. Two owners would be two domains, fetched in
    // parallel, and the interleaving is not what is under test here.
    serve([
        // Different-length paths on purpose: the fixture derives resourceId from
        // path.length, and nodeKey keys on resourceId — same length, one entry.
        [vid("0xaaa", "a.mp3", {}, [1, 0, 0])],
        [vid("0xaaa", "bb.mp3", {}, [0, 1, 0])],
    ]);
    {
        const sizes = [];
        const all = await fileVectors(undefined, (m) => sizes.push(m.size));
        if (sizes.length < 2) throw new Error(`fileVectors must emit per shard, got ${sizes}`);
        if (sizes[0] !== 1 || sizes[1] !== 2) throw new Error(`vectors must arrive per shard, growing: ${sizes}`);
        if (all.size !== 2) throw new Error(`the final vector map must still be whole: ${all.size}`);
    }

    // Catalog entries — files with no resourceId. They are the free half of a
    // catalog and they must reach the tree AND the vector map, or bulk-ingested
    // corpora are published, indexed, and then invisible to everything the viewer
    // actually uses. Keyed by owner:path, matching browse.js's nodeKey.
    const entry = (owner, path, embedding) => ({
        track_id: `${owner}:${path}`, owner, ...(embedding ? { embedding } : {}),
        fields: { entityType: "video", kind: "video", name: path.split("/").pop(), path, mime: "text/plain", desc: "on umwelt" },
    });
    serve([[vid("0xaaa", "a.mp4", {}, [1, 0, 0]), entry("0xaaa", "papers/umwelt.txt", [0, 1, 0])]]);
    const mixed = await catalogFromShard();
    const papers = mixed.tree.find((n) => n.path === "papers");
    if (!papers) throw new Error("a catalog entry must appear in the browsable tree");
    if (papers.children[0].resourceId) throw new Error("a catalog entry must not acquire a payment pointer on the way to the tree");
    const both = await fileVectors();
    if (!both.has("0xaaa:papers/umwelt.txt")) throw new Error("a catalog entry's vector must reach the kernel, keyed owner:path");
    if (!both.has("0x5")) throw new Error("a real resourceId must still key by resourceId");
    if ((await searchSubtitles("umwelt"))[0]?.episode?.path !== "papers/umwelt.txt") throw new Error("a catalog entry must be findable by its description");

    // findNode walks the nested catalog the viewer actually holds.
    const tree = [{ type: "folder", path: "S1", children: [{ type: "video", path: "S1/b.mp4", name: "b.mp4", resourceId: "0xbb" }] }];
    if (findNode(tree, (n) => n.path === "S1/b.mp4")?.name !== "b.mp4") throw new Error("findNode missed a nested video");
    if (findNode(tree, (n) => n.path === "S1/gone.mp4")) throw new Error("findNode must return null for an unknown path");
    // The permalink route resolves by resourceId, not path.
    if (findNode(tree, (n) => n.resourceId === "0xbb")?.name !== "b.mp4") throw new Error("findNode missed a resourceId match");

    // The studio needs the opposite of findNode's video-only rule: selecting a
    // folder must yield the folder, or the inspector goes blank and there's no
    // way to upload into it. These two rules are why they're separate functions.
    if (findNode(tree, (n) => n.path === "S1")) throw new Error("findNode must never return a folder");
    if (findStudioNode(tree, "S1")?.type !== "folder") throw new Error("findStudioNode must return the folder");
    if (findStudioNode(tree, "S1/b.mp4")?.name !== "b.mp4") throw new Error("findStudioNode missed a nested file");
    if (findStudioNode(tree, "S1/gone.mp4")) throw new Error("findStudioNode must return null, not a ghost node");

    // Delete prompt arithmetic: an empty folder says nothing about contents, a
    // populated one counts nested files and flags the published ones.
    const studio = [
        { type: "folder", path: "Show", name: "Show", children: [
            { type: "folder", path: "Show/S1", name: "S1", children: [
                { type: "video", path: "Show/S1/a.mp4", name: "a.mp4", published: { resourceId: "0xaa" } },
                { type: "video", path: "Show/S1/b.mp4", name: "b.mp4" },
            ] },
        ] },
        { type: "folder", path: "Empty", name: "Empty", children: [] },
    ];
    if (String(countFiles(studio[1])) !== "0,0") throw new Error("an empty folder must count zero files");
    if (String(countFiles(studio[0])) !== "2,1") throw new Error("countFiles must recurse and flag published files");
    if (String(countFiles(studio[0].children[0].children[1])) !== "1,0") throw new Error("a file counts as itself");

    // ── watchShard: the streaming half ──
    // `change`/`added` drop the cache; `snapshot` must NOT — it's the connect-time
    // census and it re-fires on every automatic reconnect, so treating it as a
    // change re-downloads every shard whenever a proxy cuts the socket.
    serve([[vid("0xaaa", "a.mp3", { desc: "before the publish" })]]);
    const listeners = new Map();
    let opened = "", esClosed = false;
    globalThis.EventSource = class {
        constructor(url) { opened = url; }
        addEventListener(type, fn) { listeners.set(type, fn); }
        close() { esClosed = true; }
    };
    let bumps = 0;
    const stop = watchShard(() => { bumps++; });
    await new Promise((r) => setTimeout(r, 0)); // the base resolves a microtask later
    if (opened !== `${VIEW}/stream`) throw new Error(`watchShard must open the view's SSE stream, got ${opened}`);
    if (listeners.has("snapshot")) throw new Error("snapshot is the connect-time census, not a change");
    if ((await searchSubtitles("before the publish")).length !== 1) throw new Error("watchShard fixture never loaded");
    listeners.get("change")();
    if (bumps !== 1) throw new Error("a change event must notify the caller");
    serveView({ d0: [[vid("0xaaa", "b.mp3", { desc: "after the publish" })]] }, { keep: true });
    if ((await searchSubtitles("after the publish")).length !== 1) throw new Error("a change event must drop the cached rows");
    stop();
    if (!esClosed) throw new Error("unsubscribing must close the stream");

    // ── the domain allowlist: a filtered domain must cost nothing ────────────
    // The real shape of this: last month's test corpus is still watched alongside
    // this month's, so the view lists both and every viewer downloads both.
    {
        const fetched = [];
        serveView({
            "archive.videos.test.1": [[vid("0xaaa", "old.mp3", { desc: "stale" })]],
            "archive.videos.test.2": [[vid("0xbbb", "new.mp3", { desc: "current" })]],
        });
        const real = globalThis.fetch;
        globalThis.fetch = (u) => { fetched.push(String(u)); return real(u); };

        setDomains(["archive.videos.test.2"]);
        if ((await catalogFromShard()).tree.length !== 1) throw new Error("allowlist must exclude the other domain");
        if ((await searchSubtitles("stale")).length !== 0) throw new Error("a filtered domain's rows must not be searchable either");
        if (fetched.some((u) => u.includes("test.1"))) throw new Error("a filtered domain must never be fetched at all — not its manifest, not its shards");

        // A prefix matches every domain under it, which is how you keep a family
        // and drop everything else.
        resetShard(); setDomains(["archive.videos.test"]);
        if ((await catalogFromShard()).tree.length !== 2) throw new Error("a prefix must match every domain under it");

        // Unset means everything — the behaviour every existing deploy has today.
        resetShard(); setDomains(null);
        if ((await catalogFromShard()).tree.length !== 2) throw new Error("no allowlist must pull every domain");

        // A filter matching nothing yields nothing. It must NOT fall back to "all",
        // which would make a typo look like it worked.
        resetShard(); setDomains(["typo"]);
        if ((await catalogFromShard()).tree.length !== 0) throw new Error("an allowlist matching nothing must load nothing");

        // A comma string is accepted as-is: it arrives from an env var via config.
        resetShard(); setDomains("archive.videos.test.1, archive.videos.test.2");
        if ((await catalogFromShard()).tree.length !== 2) throw new Error("a comma-separated string must parse and trim");

        resetShard(); setDomains(null);
        globalThis.fetch = real;
    }

    // ── the catalog of catalogs: ranking domains nobody has downloaded ──
    // Two 4-d coverage summaries. Real ones are 128-d matryoshka prefixes; the
    // geometry under test (max cosine over centroids, unrankable != unrelated) is
    // the same at any width.
    const cov = (...vecs) => ({ dim: 4, sampled: 100, vectors: vecs, counts: vecs.map(() => 50) });
    const cooking = cov([1, 0, 0, 0], [0.9, 0.1, 0, 0]);
    const markets = cov([0, 0, 1, 0], [0, 0, 0.9, 0.1]);
    serveView({ "0xaaa/cooking": [[]], "0xaaa/markets": [[]], "0xaaa/legacy": [[]] },
        { coverage: { "0xaaa/cooking": cooking, "0xaaa/markets": markets } });
    let ranked = await suggestDomains([1, 0.1, 0, 0]);
    if (ranked[0].name !== "0xaaa/cooking") throw new Error(`lookahead must name the domain it points at, got ${ranked[0].name}`);
    if (!(ranked[0].affinity > 0.9)) throw new Error(`affinity should be near 1 for an on-region query, got ${ranked[0].affinity}`);
    // Drift: the SAME client, later, heading the other way. Nothing was downloaded
    // in between — this is the whole mechanism.
    ranked = await suggestDomains([0, 0, 1, 0.1]);
    if (ranked[0].name !== "0xaaa/markets") throw new Error("drift must change which domain is suggested");
    // A domain baked before coverage existed is UNRANKABLE, not unrelated: it sorts
    // last, and its affinity must stay null so a caller can tell the two apart
    // rather than treating an un-baked domain as measured-and-rejected.
    const legacy = ranked.find((d) => d.name === "0xaaa/legacy");
    if (legacy.affinity !== null) throw new Error("a domain with no coverage must rank null, not 0");
    if (ranked[ranked.length - 1].name !== "0xaaa/legacy") throw new Error("unrankable domains sort last");
    // Scale must not decide the ranking — centroids and queries are compared by
    // cosine, so a 10x query is the same query.
    if (Math.abs(rankDomains([{ name: "c", coverage: cooking }], [10, 1, 0, 0])[0].affinity
        - rankDomains([{ name: "c", coverage: cooking }], [1, 0.1, 0, 0])[0].affinity) > 1e-6) {
        throw new Error("ranking must be scale-invariant");
    }

    // The reported bug: one show with more episodes than the limit hid every
    // other show behind it. The limit counts RESULTS, so it cannot.
    {
        const many = [];
        // One show with more episodes than the limit, and one other show below it.
        for (let i = 1; i <= 30; i++) {
            many.push(vid("0xaaa", `fusion/E${i}.mp4`, { desc: "digimon", series: "Digimon Fusion", season: 1, episode: i }));
        }
        // Scored strictly BELOW every Fusion row (the term lands late in its text),
        // so a row-counting limit provably cannot reach it.
        many.push(vid("0xaaa", "adv/E1.mp4", { desc: `${"filler ".repeat(40)}digimon`, series: "Digimon Adventure", season: 1, episode: 1 }));
        serve([many]);
        const hits = await searchSubtitles("digimon", { limit: 5 });
        const shows = new Set(hits.map((h) => h.episode.series));
        if (!shows.has("Digimon Adventure")) {
            throw new Error(`a series with 30 tied episodes must not crowd out every other series (got ${[...shows]})`);
        }
        if (groupHits(hits).length > 5) throw new Error("the limit must cap RESULTS, not rows");
    }

    // A series is ONE result, entered at episode 1 — the fix for fifty-four tied
    // hits that all say "Digimon Adventure" and arrive in shard order.
    {
        const ep = (n, extra = {}) => ({
            id: `h${n}`, entityType: "video", name: `S01E${n}`, score: 0.5, mode: "semantic",
            episode: { owner: "0xa", series: "Show", season: 1, episode: n, name: `S01E${n}`, path: `p/${n}` , ...extra },
        });
        const grouped = groupHits([ep(36), ep(1), ep(12)]);
        if (grouped.length !== 1) throw new Error(`a series must collapse to one result, got ${grouped.length}`);
        if (grouped[0].node.episode !== 1) throw new Error("a collapsed series must open at its first episode");
        if (grouped[0].items.length !== 3) throw new Error("a collapsed series must keep every episode for the queue");
        // An untagged file and a subtitle hit are results in their own right.
        const cue = { id: "c1", entityType: "subtitles", name: "S01E36", start: 724, score: 0.6, mode: "semantic",
            episode: { owner: "0xa", series: "Show", season: 1, episode: 36, name: "S01E36", path: "p/36" } };
        const loose = { id: "u1", entityType: "video", name: "one-off.mp4", score: 0.4, mode: "lexical",
            episode: { owner: "0xa", name: "one-off.mp4", path: "one-off.mp4" } };
        const mixed = groupHits([cue, ep(1), loose]);
        if (mixed.length !== 3) throw new Error(`a quoted line and an untagged file must stay their own results, got ${mixed.length}`);
        if (mixed[0].node.episode !== 36) throw new Error("a subtitle hit must keep the episode it was quoted from");
    }

    console.log("search.js self-check ok — view catalog, series collapsed to one result → per-domain shards streamed line-by-line across chunk boundaries, deltas + tombstones, SSE invalidation, lexical/cosine rank, packed vectors, subtitle seek, payment pointer, catalog nesting, node lookup, domain ranking by lookahead, results grouped per file, late subscribers stream, vectors stream, domain allowlist");
}
