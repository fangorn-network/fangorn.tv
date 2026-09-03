// A channel that is a QUERY, not a list.
//
// channels.js builds a ring by GROUPING the catalog — this show, that aisle — and
// that is every ring it can ever build. "rainy cyberpunk" is not a folder, so the
// only way to have a channel for it is to generate one, and the only material
// available in the tab is the same 256-d vectors topics() and session() already
// run over.
//
// The obvious way to generate one is top-k against the query, and it is wrong.
// Top-k over an embedding space returns eight near-identical things and then
// dies: it is a search result, and a search result is not a channel. What makes a
// channel is that it keeps going and stays recognisable while it does.
//
// So: a Markov walk. Pick the next item with probability ∝ exp(cos(v, current)/T),
// re-aim, repeat. Two knobs, both legible, both the viewer's:
//
//   temp   — how surprising the next pick is. Low is a tight loop of the same
//            thing; high is a channel that wanders. This is the dial the product
//            means when it says you own the algorithm.
//   anchor — how hard the walk returns to the prompt after each step. 1 never
//            leaves the query (top-k with noise); 0 is a free random walk that
//            forgets what channel it is within a dozen hops.
//
// Everything here is a pure function of (pool, q, seed). Same three in, same ring
// out, in every tab, forever — which is what lets channels.js keep scheduling by
// `now mod total` with no server, and what makes a channel shareable as ~150
// bytes of spec instead of a playlist.
//
// ponytail: pool-then-walk, not walk-over-everything. Re-scoring a few thousand
// rows at every one of a few hundred steps is ~150M multiply-adds in a phone tab
// for a ring nobody will watch past item four. Scoring them ONCE against q and
// walking inside the best few hundred is ~50ms and means the same thing: a
// channel is a neighbourhood.

import { dotUnit, unit } from "./kernel.js";
import { hashOf, nodeKey } from "../catalog/browse.js";

// The pool IS the channel's whole library, so this is the real quality/variety
// knob and not a perf constant. Measured against a top-k baseline on 21k rows:
// 40 costs ~0.003 mean cosine, 80 costs ~0.008, 400 costs ~0.020 — bigger pools
// monotonically dilute. 80 buys twice the library for a ~1% quality loss, which
// is the trade an all-day channel wants and a search box would not.
export const POOL = 80;
// Temperature in STANDARD DEVIATIONS of the pool's own similarity spread, not in
// raw cosine. Cosine nominally lives in [-1,1] and a 256-d normalized corpus
// actually uses about a tenth of that: a real pool measured top=0.694, median
// 0.588, floor 0.575. A temperature picked against the nominal range is a softmax
// so flat it samples the pool uniformly — the best row twice as likely as the
// 400th, out of 400 — which is a shuffle wearing a kernel's clothes, and it is
// what the first version of this file shipped. Standardizing per step makes the
// knob mean the same thing on any corpus, and makes `anchor` matter at all.
export const TEMP = 0.6;
export const ANCHOR = 0.5;  // pull back to q after each hop
export const WINDOW = 24;   // no-repeat memory
const MAX = 4096;           // hard stop, so a pool of 20s clips can't spin forever

/**
 * mulberry32, seeded through browse.js's FNV-1a so a seed can be a string.
 *
 * NOT Math.random, for the same reason channels.js's shuffle isn't: two viewers
 * who disagree about the ring are not watching one channel.
 */
export function rng(seed) {
    let a = (typeof seed === "number" ? seed : hashOf(String(seed))) >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The neighbourhood a channel is allowed to wander in: the `k` rows closest to
 * `q`, unit-normalized once so every later step is a plain dot product.
 *
 * Ties break on nodeKey. Not decoration: the pool arrives from a Map whose
 * iteration order is insertion order, and insertion order is whatever order the
 * shard streamed in. Two viewers with the same catalog and a different fetch
 * order would otherwise cut the pool differently at the boundary and drift apart
 * — the one bug in here that would show up as "sometimes".
 */
export function pool(files, q, vectors, k = POOL) {
    const qu = unit(q);
    const scored = [];
    for (const f of files) {
        const key = nodeKey(f);
        const raw = vectors.get(key);
        if (!raw) continue;               // no vector is not a guess, it's an omission
        const vec = unit(raw);
        scored.push({ f, key, vec, sim: dotUnit(qu, vec) });
    }
    scored.sort((a, b) => b.sim - a.sim || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return scored.slice(0, k);
}

/**
 * Walk `cands` (from pool()) until `seconds` of runtime is covered.
 *
 * `dur` is passed in rather than imported: this file knows about vectors and the
 * catalog's duration rules live in channels.js, and one import of the other is
 * enough. The default makes `seconds` a plain item count, which is what the
 * self-check and any non-scheduling caller wants.
 *
 * Returns `{ items, total }` — the same shape the rest of channels.js rings have.
 */
export function walk(cands, {
    q, seed = "", seconds = 32, dur = () => 1,
    temp = TEMP, anchor = ANCHOR, window = WINDOW, max = MAX,
} = {}) {
    const items = [];
    if (!cands.length || !q) return { items, total: 0 };

    const qu = unit(q);
    const rand = rng(seed);
    // A window that covers the whole pool leaves nothing to pick and the walk
    // stops one item in. Small pools get a short memory instead of no channel.
    const win = Math.min(window, cands.length - 1);
    const recent = [];
    const held = new Set();
    let cur = qu;
    let total = 0;

    while (total < seconds && items.length < max) {
        // Score the pool from where we are, skipping what just played.
        const live = [];
        let best = -Infinity;
        for (const c of cands) {
            if (held.has(c.key)) continue;
            const s = dotUnit(cur, c.vec);
            if (s > best) best = s;
            live.push([c, s]);
        }
        if (!live.length) break;

        // Softmax over the z-scored similarities, shifted by the max so exp()
        // never overflows. std can be 0 — a pool of identical vectors — and then
        // every row is equally good and uniform is the right answer, not NaN.
        let mu = 0, sq = 0;
        for (const [, s] of live) { mu += s; sq += s * s; }
        mu /= live.length;
        const std = Math.sqrt(Math.max(0, sq / live.length - mu * mu)) || 1;
        let sum = 0;
        const p = live.map(([, s]) => (sum += Math.exp((s - best) / (temp * std))));
        const cut = rand() * sum;
        const pick = live[p.findIndex((acc) => acc >= cut)] ?? live[live.length - 1];
        const [c] = pick;

        items.push(c.f);
        total += dur(c.f);

        // Re-aim: part of the way toward what we just played, the rest back at the
        // prompt. This is the whole difference between a channel and a drift.
        cur = unit(c.vec.map((x, i) => anchor * qu[i] + (1 - anchor) * x));

        recent.push(c.key);
        held.add(c.key);
        if (recent.length > win) held.delete(recent.shift());
    }
    return { items, total };
}

// ── self-check: `node src/geometry/walk.js` ──────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
    const ok = (c, m) => { if (!c) throw new Error(m); };

    // A ring of unit vectors on a circle: neighbours in index are neighbours in
    // cosine, so "did the walk stay near the query" is a question about integers.
    const N = 64;
    const files = Array.from({ length: N }, (_, i) => ({ owner: "0x1", path: `f${i}`, name: `f${i}`, i }));
    const vecs = new Map(files.map((f) => {
        const th = (2 * Math.PI * f.i) / N;
        return [nodeKey(f), [Math.cos(th), Math.sin(th)]];
    }));
    const q = [1, 0]; // "0 o'clock" — files near i=0 and i=63 are the query's neighbourhood

    // rng: deterministic, and actually spread over [0,1).
    const r1 = rng("a"), r2 = rng("a"), r3 = rng("b");
    eq(r1(), r2(), "the same seed is the same stream");
    ok(rng("a")() !== r3(), "a different seed is a different stream");
    const draws = Array.from({ length: 4000 }, rng("spread"));
    ok(Math.min(...draws) < 0.02 && Math.max(...draws) > 0.98, "rng must cover the unit interval");
    ok(Math.abs(draws.reduce((s, x) => s + x, 0) / draws.length - 0.5) < 0.02, "and be centred");

    // pool: the k nearest, and nothing without a vector.
    const p = pool(files, q, vecs, 8);
    eq(p.length, 8, "pool is capped at k");
    ok(p.every(({ f }) => Math.min(f.i, N - f.i) <= 4), `pool must be the query's neighbourhood, got ${p.map((x) => x.f.i)}`);
    eq(p[0].f.i, 0, "closest first");
    eq(pool([...files, { owner: "0x1", path: "novec" }], q, vecs, 99).length, N, "a row with no vector is dropped, not guessed");
    // The ordering trust boundary: same rows, different insertion order, same pool.
    const shuffled = [...files].reverse();
    eq(pool(shuffled, q, vecs, 8).map((x) => x.key).join(),
        p.map((x) => x.key).join(), "the pool must not depend on catalog order");

    // walk: determinism is the whole premise of the scheduler downstream.
    const opts = { q, seed: "rainy cyberpunk", seconds: 20 };
    const a = walk(pool(files, q, vecs), opts);
    const b = walk(pool(files, q, vecs), opts);
    eq(a.items.length, 20, "seconds with the default dur is an item count");
    eq(a.total, 20, "and total counts the same way");
    eq(a.items.map((f) => f.i).join(), b.items.map((f) => f.i).join(), "same spec, same ring — in every tab");
    ok(walk(pool(files, q, vecs), { ...opts, seed: "sunlit pastoral" }).items.map((f) => f.i).join()
        !== a.items.map((f) => f.i).join(), "a different seed is a different ring");

    // ...and it is a channel, not a search result: no immediate repeats, more than
    // a handful of distinct rows, still recognisably about the query.
    const long = walk(pool(files, q, vecs), { ...opts, seconds: 40 });
    eq(new Set(long.items.slice(0, WINDOW + 1).map((f) => f.i)).size, WINDOW + 1,
        "nothing repeats inside the no-repeat window");
    ok(new Set(long.items.map((f) => f.i)).size >= 12, "a channel that plays four things is top-k with extra steps");
    const near = long.items.filter((f) => Math.min(f.i, N - f.i) <= 12).length;
    ok(near / long.items.length > 0.6, `the walk must stay in its neighbourhood, ${near}/${long.items.length} did`);

    // The knobs have to actually turn.
    const tight = walk(pool(files, q, vecs), { ...opts, seconds: 60, temp: 0.05 });
    const loose = walk(pool(files, q, vecs), { ...opts, seconds: 60, temp: 8 });
    ok(new Set(tight.items.map((f) => f.i)).size < new Set(loose.items.map((f) => f.i)).size,
        "low temperature must be the narrower channel");
    const spread = (r) => r.items.reduce((s, f) => s + Math.min(f.i, N - f.i), 0) / r.items.length;
    ok(spread(walk(pool(files, q, vecs), { ...opts, seconds: 60, anchor: 0.95 }))
        < spread(walk(pool(files, q, vecs), { ...opts, seconds: 60, anchor: 0.05 })),
        "a high anchor must stay closer to the prompt than a low one");

    // Real durations: the walk fills a span, it doesn't count to it.
    const timed = walk(pool(files, q, vecs), { ...opts, seconds: 6 * 3600, dur: () => 1800 });
    eq(timed.items.length, 12, "twelve half-hours fills six hours");
    ok(timed.total >= 6 * 3600, "and it fills it, never underruns");

    // Degenerate inputs are a shrug, not a throw.
    eq(walk([], opts).items.length, 0, "an empty pool is an empty ring");
    eq(walk(pool(files, q, vecs), { seed: "x" }).items.length, 0, "no query is no channel");
    const two = walk(pool(files.slice(0, 2), q, vecs), { ...opts, seconds: 10 });
    eq(two.items.length, 10, "a pool smaller than the window still yields a ring");
    ok(walk(pool(files, q, vecs), { ...opts, seconds: 1e9, max: 50 }).items.length === 50, "max stops the spin");

    console.log("walk.js self-check ok — seeded rng, stable pool, deterministic ring, temp/anchor, duration fill");
}
