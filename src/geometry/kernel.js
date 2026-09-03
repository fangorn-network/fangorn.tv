// Two things the shard's vectors can do that a mime table can't: say what a
// catalog is ABOUT, and say where a session is HEADING.
//
//   topics()  — k-means over the 256-d vectors, each cluster named from the words
//               that are distinctive to it. This is categorization the publisher
//               never typed: browse.js already knows a file is `video` from its
//               bytes, but not that these eight are the cooking ones.
//
//   session() — the Markov kernel from ~/fangorn/sonder (app/src/renderer/src/
//               kernel/SessionKernel.ts) and quickbeam's places demo, cut down to
//               the signal sond3r actually has. State is a pure recompute from the
//               opened-history, so it needs no persistence of its own and can't
//               drift out of sync with what browse.js already stores:
//
//                 μ — recency-weighted mean of what you opened (where you are)
//                 v — recent mean minus older mean (where you're heading)
//                 q — μ̂ nudged along v̂ (a lookahead, the point of the whole thing)
//                 n — mean of what you gave a 👎 (where you are NOT going)
//
// Both run over the vectors already in the shard, in the tab, on a corpus of a few
// thousand rows. No model download, no network, no server, nothing to opt out of.

import { unpackVec } from "../llm/embed.js";
// One definition of catalog identity, shared with browse.js and search.js. This is a
// cycle (browse.js imports this file), and it is safe because nodeKey is only ever
// called from inside a function here, never at module scope — but it is the reason
// not to move top-level work into this module.
import { nodeKey } from "../catalog/browse.js";

const TOP_TERMS = 3;   // words in a generated topic name
const ITERS = 12;      // k-means passes; this corpus converges in ~5
const SAMPLE = 4000;   // rows the centroids are fitted on — see topics()

// ── vector helpers (plain arrays / Float32Array, cosine space) ────────────────

const dot = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length && i < b.length; i++) d += a[i] * b[i];
    return d;
};
const norm = (a) => Math.sqrt(dot(a, a));
/** Cosine. Both sides are normalized here, so callers can pass raw sums. */
export const cosine = (a, b) => dot(a, b) / ((norm(a) * norm(b)) || 1);

/** `v` scaled to length 1, so a later cosine against it is a plain dot product.
 *  cosine() re-derives BOTH norms on every call — three dot products where one
 *  will do. That is the right default for a one-off comparison and the wrong one
 *  inside a loop that scores every file against a fixed set of vectors, where one
 *  side never changes and the other is reused once per probe. */
export const unit = (v) => { const n = norm(v) || 1; return v.map((x) => x / n); };
/** Cosine of two vectors that are ALREADY unit length — see unit(). */
export const dotUnit = dot;

export function mean(vs) {
    const out = new Array(vs[0].length).fill(0);
    for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i] / vs.length;
    return out;
}

// ── the session kernel ───────────────────────────────────────────────────────

const LIKE = 2;   // a 👍 counts double a plain open — you said it out loud

/**
 * @param history  recall() — NEWEST FIRST, which is the opposite of what a
 *                 recency weight reads, so it's reversed once here.
 * @param vectors  Map<resourceId, vector> from fileVectors()
 * @returns { mu, v, speed, q, neg, taste } or null when nothing opened has a
 *          vector. `q` is what to rank by, `neg` what to rank AWAY from, and
 *          `taste` is signed weight per kind/collection.
 *
 * A 👎 is not a place you are, so it is excluded from μ and v entirely rather
 * than folded in with a negative weight — subtracting a vector from a centroid
 * moves you to the antipode of the thing you disliked, which is a different
 * place from "anywhere but there". It gets its own centroid, `neg`, and rank()
 * subtracts distance to it. That is the γ_reg term of the sonder kernel.
 *
 * The entry's OWN vector (`h.v`, stored by remember()) wins over the lookup, and
 * that ordering is the whole reason a session survives switching apps: `vectors` is
 * the active view's index, so every id opened in another app misses it and the
 * kernel used to come back null the moment you moved. The lookup stays as the
 * fallback for entries written before remember() stored vectors.
 */
export function session(history = [], vectors = new Map()) {
    const all = [...history].reverse()
        .map((h) => ({ h, vec: (h.v ? unpackVec(h.v) : null) ?? vectors.get(h.resourceId) }))
        .filter((x) => x.vec);
    const opened = all.filter((x) => (x.h.r ?? 0) >= 0);
    const disliked = all.filter((x) => x.h.r < 0);
    // Everything disliked and nothing else is still a session: it has no position,
    // but it has somewhere to stay away from, and that is worth ranking by.
    if (!opened.length && !disliked.length) return null;
    const neg = disliked.length ? mean(disliked.map((x) => x.vec)) : null;
    if (!opened.length) return { mu: null, v: [], speed: 0, q: null, neg, taste: {} };

    const vs = opened.map((x) => x.vec);

    // μ: recency-weighted — the last thing opened says more about now than the
    // fortieth-last, and a flat mean is what made the old shelf feel stale. A 👍
    // multiplies its own weight, so saying it out loud outranks scrolling past.
    const n = vs.length;
    const w = vs.map((_, i) => (1 / Math.log(n - i + 1)) * (opened[i].h.r > 0 ? LIKE : 1));
    const wsum = w.reduce((s, x) => s + x, 0) || 1;
    const mu = new Array(vs[0].length).fill(0);
    vs.forEach((v, i) => { for (let c = 0; c < mu.length; c++) mu[c] += v[c] * w[i] / wsum; });

    // v: where the recent half sits relative to the earlier half. Two opens is the
    // minimum that can have a direction at all.
    let vel = new Array(mu.length).fill(0);
    if (n >= 2) {
        const half = Math.floor(n / 2);
        const older = mean(vs.slice(0, Math.max(1, half)));
        const newer = mean(vs.slice(half));
        vel = older.map((o, i) => newer[i] - o);
    }
    const speed = norm(vel);

    // q = μ̂ + λv̂. λ saturates, so a session that turns hard doesn't fling the
    // query out of the corpus entirely — that's the lambda_max of the original.
    const mn = norm(mu) || 1;
    const q = mu.map((x) => x / mn);
    if (speed > 1e-9) {
        const lambda = 0.4 * Math.tanh((2 * speed) / mn);
        for (let i = 0; i < q.length; i++) q[i] += (vel[i] / speed) * lambda;
    }

    // Taste over the tags sond3r already has on a row: what kind of thing it is
    // and whose collection it came from. A 👎 subtracts from its own tags, which
    // is how "never this collection again" gets said without a filter UI.
    const taste = {};
    const tag = (h, weight) => {
        for (const t of [h.mime?.split("/")[0], h.top && `top:${h.owner}/${h.top}`]) {
            if (t) taste[t] = (taste[t] ?? 0) + weight;
        }
    };
    opened.forEach(({ h }, i) => tag(h, w[i] / wsum));
    disliked.forEach(({ h }) => tag(h, -1 / Math.max(1, disliked.length)));

    return { mu, v: vel, speed, q, neg, taste };
}

const TAU_TASTE = 0.15; // taste's pull on the final score, from the places demo
const GAMMA = 0.6;      // the repulsion term: how hard a 👎 pushes its neighbours away

/**
 * The one score every surface ranks by, so the shelves, the compass, the rail and
 * the field cannot disagree about what the session wants.
 *
 * Attraction to `q`, minus repulsion from `neg`, plus signed taste. GAMMA sits
 * above TAU_TASTE deliberately: a dislike is the only thing a viewer ever says
 * explicitly and out loud, and it must visibly win against a drift the kernel
 * merely inferred, or pressing the button feels like it did nothing.
 */
export const score = (vec, state) =>
    (state.q ? cosine(state.q, vec) : 0)
    - (state.neg ? GAMMA * Math.max(0, cosine(state.neg, vec)) : 0);

/** Signed preference weight for a row, from the tags the session accumulated. */
const tasteOf = (f, state) =>
    [(f.mime ?? "").split("/")[0], `top:${f.owner}/${f.top}`]
        .reduce((s, tag) => s + (state.taste[tag] ?? 0), 0) / 2;

/**
 * Rank candidates by the session: cosine to the lookahead query, nudged by taste.
 * `key(file)` yields its vector; files without one are dropped, not guessed at.
 */
export function rank(files, state, vectors, k = 8) {
    if (!state) return [];
    return files
        .map((f) => {
            // nodeKey, NOT resourceId: a catalog entry that is free has no resource
            // minted, and fileVectors() keys those by owner+path. Looking up the
            // resourceId dropped every free row out of the ranking silently.
            const vec = vectors.get(nodeKey(f));
            if (!vec) return null;
            return { f, score: score(vec, state) + TAU_TASTE * tasteOf(f, state) };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => x.f);
}

// ── topics: what the catalog is about ────────────────────────────────────────

// Words that describe nothing. Extensions are stripped before this ever sees them.
//
// The second and third lines are prose, not filenames, and they were added when the
// corpus stopped being invented. On made-up one-line descriptions "became" and
// "clearly" never appear; over real archive.org prose they are everywhere, and a
// heading group that spans topics has no shared NOUNS — so the common verbs win and
// the compass reads "Became · Call · Method". Document frequency alone does not
// catch them: they are frequent enough to be noise and rare enough to score.
const STOP = new Set(("the a an and or of to in on for with at by from is it this that " +
    "part ep episode s e vol final new full hd 1080p 720p 4k x264 x265 web dl rip mp4 mkv " +
    "copy untitled file files video audio " +
    "was were are be been being has have had will would can could may might must " +
    "not but its his her their they them then than there here when where which who " +
    "what how why all any both each few more most other some such only own same so " +
    "one two three first second also into out over under after before during while " +
    "became become call called known used using use made make making set gets get " +
    "clearly directed states state method methods way ways time times year years " +
    "until since about above below between through against among within without " +
    "including included include often usually generally typically " +
    // Archive boilerplate. Every public-domain description on archive.org carries
    // some of this, so it is frequent enough to be noise and — because it is not in
    // literally every row — rare enough to score. The compass read "Public · Domain"
    // over a Betty Boop cartoon, which describes the LICENCE and not the film.
    "public domain database archive org copyright rights reserved presented courtesy " +
    "collection collections item items available online www http https download " +
    "http com net edu uploaded digitized scanned").split(" "));

// Name and path always; description only as far as the LEDE. A real catalog
// description runs to a thousand characters and the distinctive nouns are in its
// first sentence — everything after dilutes the count and pulls in generic verbs.
const LEDE = 160;

export const words = (f) => `${f.name ?? ""} ${f.path ?? ""} ${String(f.desc ?? "").slice(0, LEDE)}`
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,4}\b/g, " ")        // extensions
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));

/**
 * Deterministic maximin seeding (k-means++ without the randomness): start at the
 * point farthest from the corpus centroid, then repeatedly take the point farthest
 * from every seed so far. A seeded RNG would work too; this needs no seed and
 * gives the same shelves on every visit, which matters more than optimality.
 */
function seeds(vs, k) {
    const c = mean(vs);
    let far = 0;
    vs.forEach((v, i) => { if (cosine(v, c) < cosine(vs[far], c)) far = i; });
    const picked = [far];
    while (picked.length < k) {
        let best = -1, bestD = -Infinity;
        vs.forEach((v, i) => {
            if (picked.includes(i)) return;
            const d = Math.min(...picked.map((p) => 1 - cosine(v, vs[p])));
            if (d > bestD) { bestD = d; best = i; }
        });
        if (best < 0) break;
        picked.push(best);
    }
    return picked.map((i) => vs[i]);
}

/**
 * Cluster the catalog into named topics.
 *
 * @returns [{ id, title, items }] biggest first, or [] when there are too few
 *          embedded files for clusters to mean anything.
 *
 * ponytail: plain Lloyd's k-means on cosine, k = √(n/2) capped at 6, no silhouette
 * search over k. On a few thousand rows this is milliseconds; if topics come out
 * visibly lumpy, scoring two or three k's and keeping the best is the next step.
 */
export function topics(files, vectors, { min = 12, max = 6 } = {}) {
    const rows = files.filter((f) => vectors.get(nodeKey(f)));
    if (rows.length < min) return [];
    const vs = rows.map((f) => vectors.get(nodeKey(f)));

    const k = Math.max(2, Math.min(max, Math.round(Math.sqrt(rows.length / 2))));

    // Fit on a sample, assign everything. Six centroids do not get meaningfully
    // better between 4,000 rows and 20,000 — but seeds() and Lloyd's are both
    // O(k·n) per pass over 384-dim vectors, so the full corpus cost 1.9s of blocked
    // main thread on the archive catalog and 0.45s this way. The stride is
    // deterministic, so the same catalog clusters the same way every load; a random
    // sample would mean the shelves were named differently each visit.
    // ponytail: stride sampling, no mini-batch schedule. If k ever needs to grow
    // past a handful, this wants to be a worker rather than a bigger sample.
    const stride = Math.ceil(vs.length / SAMPLE);
    const fit = stride > 1 ? vs.filter((_, i) => i % stride === 0) : vs;

    let centers = seeds(fit, k);
    let assign = new Array(fit.length).fill(0);

    for (let it = 0; it < ITERS; it++) {
        let moved = false;
        fit.forEach((v, i) => {
            let best = 0, bestS = -Infinity;
            centers.forEach((c, j) => { const s = cosine(v, c); if (s > bestS) { bestS = s; best = j; } });
            if (assign[i] !== best) { assign[i] = best; moved = true; }
        });
        // An empty cluster has no centroid to recompute — keep the old center so it
        // can still win a point next pass instead of becoming NaN.
        centers = centers.map((c, j) => {
            const members = fit.filter((_, i) => assign[i] === j);
            return members.length ? mean(members) : c;
        });
        if (!moved) break;
    }

    // One pass, every row, against the fitted centres — the sample decided where the
    // regions are, not which of them each file is in. Both sides are unit-length so
    // the inner comparison is one dot product, not cosine()'s three.
    const cu = centers.map(unit);
    const at = vs.map((v) => {
        const u = unit(v);
        let best = 0, bestS = -Infinity;
        cu.forEach((c, j) => { const s = dotUnit(u, c); if (s > bestS) { bestS = s; best = j; } });
        return best;
    });

    const out = [];
    for (let j = 0; j < k; j++) {
        const members = rows.filter((_, i) => at[i] === j);
        if (members.length < 2) continue; // a cluster of one is a file, not a topic
        const title = label(members, rows);
        if (!title) continue; // nothing distinctive to say → not a shelf
        out.push({ id: `topic:${j}`, title, items: members });
    }
    return out.sort((a, b) => b.items.length - a.items.length);
}

/**
 * Document frequency over a corpus, memoized on the corpus ARRAY's identity.
 *
 * `label()` is called once per topic shelf plus once for the compass, and each call
 * re-tokenized every row to count df — 33ms per call at 6,000 rows, on a path that
 * re-runs whenever you open or rate something. df depends only on `all`, so it is
 * computed once per catalog instead.
 *
 * A WeakMap because the key is the caller's array: App.jsx memoizes `files`, so the
 * same array comes back until the catalog actually changes, and when it does the old
 * entry is collectable rather than a leak keyed on a stale corpus.
 */
const DF = new WeakMap();

function docFreq(all) {
    const hit = DF.get(all);
    if (hit) return hit;
    const df = new Map();
    for (const f of all) for (const t of new Set(words(f))) df.set(t, (df.get(t) ?? 0) + 1);
    DF.set(all, df);
    return df;
}

/**
 * Name a group of rows by the words distinctive to it: term frequency inside over
 * document frequency everywhere. "show" is in every row of a one-show catalog and
 * names nothing; "risotto" is in four and names them.
 *
 * @param group  the rows to name
 * @param all    the corpus they were drawn from — what "distinctive" is relative to
 */
export function label(group, all, n = TOP_TERMS) {
    if (!group.length || !all.length) return "";
    const df = docFreq(all);

    const here = new Map();
    for (const f of group) for (const t of new Set(words(f))) here.set(t, (here.get(t) ?? 0) + 1);

    return [...here.entries()]
        .map(([t, c]) => [t, (c / group.length) * Math.log(all.length / (df.get(t) || 1))])
        .filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([t]) => t[0].toUpperCase() + t.slice(1))
        .join(" · ");
}

/**
 * What the kernel is pointing at NEXT, in words.
 *
 * The session vector is the honest state of this thing, and it is 256 numbers — a
 * page that silently rearranges itself around a number nobody can see is just an
 * unstable page. So: rank the catalog by the lookahead, then name that group by what
 * is distinctive about it relative to the whole catalog. The label is DERIVED from
 * the same ranking that reorders the shelves, so it cannot drift out of agreement
 * with them the way a hand-written caption would.
 *
 * @returns { terms, moving, speed, items } or null when there is no session yet.
 */
export function heading(state, files, vectors, { look = 8 } = {}) {
    // A session made only of dislikes has somewhere to avoid but nowhere to point,
    // and naming the top of an avoid-ranking as a heading would be a lie.
    if (!state?.q) return null;
    const embedded = files.filter((f) => vectors.get(nodeKey(f)));
    const near = rank(files, state, vectors, look);
    if (!near.length) return null;
    return {
        terms: label(near, embedded),
        // Below this, `q` is essentially μ — the session has a position but no
        // direction, and calling that "heading" would be overclaiming.
        moving: state.speed > 1e-6,
        speed: state.speed,
        items: near,
    };
}


// ── field: the catalog as a place ────────────────────────────────────────────
//
// heading() says where the session points in WORDS. This says it in geometry:
// every embedded row gets a position in a unit disc around one attractor point.
//
//   radius — how far the row is from the attractor (near = center)
//   angle  — which conceptual region it belongs to, and how firmly
//
// The regions are topics() clusters, so the sectors are the same convex regions
// the shelf titles are named from; a row that sits between two clusters is drawn
// between their sectors, which is what makes the boundaries visibly bend when the
// session moves. Nothing here is a layout heuristic — move the attractor and the
// whole field re-sorts because the cosines changed.

/**
 * @param state   session() state, or null before anything is opened
 * @param groups  topics() output — memoize it, it is k-means and this runs on
 *                every slider tick
 * @param drift   how far along the session's velocity the attractor is pushed:
 *                0 = strict (where you are), 1 = serendipity (where you're going)
 * @param to      an impulse vector (an embedded query) that pulls the attractor
 *                toward a coordinate the session never visited
 * @returns { nodes: [{ f, x, y, w, score }], regions: [{ title, angle }] } or null
 */
export function field(files, vectors, state, { groups = [], drift = 0.4, k = 64, to = null } = {}) {
    const rows = files.map((f) => ({ f, vec: vectors.get(nodeKey(f)) })).filter((r) => r.vec);
    if (!rows.length) return null;

    // The attractor. With no session it is the middle of the corpus — the field
    // has to draw something on a first visit, and the centroid is the honest
    // "no opinion yet" position rather than an arbitrary row.
    let q;
    if (state?.mu) {
        const mn = norm(state.mu) || 1;
        q = state.mu.map((x) => x / mn);
        if (state.speed > 1e-9) for (let i = 0; i < q.length; i++) q[i] += (state.v[i] / state.speed) * drift;
    } else q = mean(rows.map((r) => r.vec));
    // An impulse adds, it doesn't replace: typing steers the session, it doesn't
    // erase it. Renormalized so the pull is a direction, not a magnitude.
    if (to) { const tn = norm(to) || 1; q = q.map((x, i) => x + to[i] / tn); }

    // Regions: one angular sector per topic, width proportional to how much of
    // the catalog lives there. Sectors move when the clusters do.
    const regions = groups.map((g) => ({
        title: g.title,
        c: mean(g.items.map((f) => vectors.get(nodeKey(f))).filter(Boolean)),
        n: g.items.length,
    })).filter((r) => r.c);
    const total = regions.reduce((s, r) => s + r.n, 0) || 1;
    let acc = 0;
    for (const r of regions) {
        r.angle = 2 * Math.PI * (acc + r.n / 2) / total;
        acc += r.n;
    }

    const T = 0.04; // how sharply a row commits to its region; ~the spread of nomic-256 cosines

    // Blend between the two nearest regions along the shortest arc. Equal scores
    // put the row exactly on the boundary, which is the point: a boundary is
    // where the argmax flips, not a line someone drew.
    const angleOf = (v, i) => {
        if (regions.length < 2) return (i / rows.length) * 2 * Math.PI;
        const s = regions.map((r) => cosine(v, r.c));
        const [a, b] = s.map((x, j) => j).sort((x, y) => s[y] - s[x]);
        const w = 0.5 * Math.exp(-(s[a] - s[b]) / T);
        const d = Math.atan2(Math.sin(regions[b].angle - regions[a].angle), Math.cos(regions[b].angle - regions[a].angle));
        return regions[a].angle + d * w;
    };

    // Not score(): the field has its own attractor (μ pushed by `drift`, plus any
    // impulse), and only the repulsion half is shared. Ranking it by state.q would
    // ignore the slider the viewer is dragging.
    const near = rows
        .map((r) => ({
            ...r,
            score: cosine(q, r.vec)
                - (state?.neg ? GAMMA * Math.max(0, cosine(state.neg, r.vec)) : 0)
                + (state ? TAU_TASTE * tasteOf(r.f, state) : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

    // ponytail: radius is the RANK, not the cosine. Raw nomic-256 cosines sit in a
    // narrow band (see probes.js), so radius-by-value draws every row on the same
    // ring. Rank spreads the disc evenly and preserves the only thing the geometry
    // must be honest about — the ordering. Swap in the value once vectors are
    // spread enough that it separates.
    const n = near.length;
    return {
        regions: regions.map(({ title, angle }) => ({ title, angle })),
        nodes: near.map((r, i) => {
            const w = 1 - i / Math.max(1, n - 1);           // 1 at the attractor, 0 at the rim
            const rad = 0.14 + 0.86 * (1 - w);
            // A fixed nudge per row so rows sharing a sector don't stack on one
            // ray. Deterministic in the index, so it never jitters between frames.
            const a = angleOf(r.vec, i) + ((i % 5) - 2) * 0.03;
            return { f: r.f, score: r.score, w, x: rad * Math.cos(a), y: rad * Math.sin(a) };
        }),
    };
}

// ── self-check: `node src/geometry/kernel.js` ─────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    // Two well-separated directions in the plane; a session that walks from one
    // toward the other must have a query vector AHEAD of its own centroid.
    const at = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const vecs = new Map([["a", at(0)], ["b", at(20)], ["c", at(40)]]);
    const hist = [{ resourceId: "c" }, { resourceId: "b" }, { resourceId: "a" }]; // newest first
    const st = session(hist, vecs);
    if (!st) throw new Error("a history with vectors must produce a state");
    if (st.speed < 1e-6) throw new Error("a moving session must have velocity");
    if (cosine(st.q, at(60)) <= cosine(st.mu, at(60))) {
        throw new Error("the query vector must lead the centroid in the direction of travel");
    }
    // Order is the whole point: the same opens in reverse must head the other way.
    const back = session([...hist].reverse(), vecs);
    if (cosine(st.q, at(60)) <= cosine(back.q, at(60))) throw new Error("reversing the session must reverse the heading");
    if (session([{ resourceId: "nope" }], vecs)) throw new Error("history with no embedded rows must be null, not a zero vector");
    if (session([], vecs)) throw new Error("empty history must be null");

    // Ranking: nearest the heading wins, and taste breaks ties toward the kind
    // that was actually opened.
    const files = [
        { resourceId: "X", owner: "0x1", top: "t", mime: "video/mp4", name: "x" },
        { resourceId: "Y", owner: "0x1", top: "t", mime: "video/mp4", name: "y" },
    ];
    const fv = new Map([["x", at(55)], ["y", at(180)]]);
    if (rank(files, st, fv, 2)[0].resourceId !== "X") throw new Error("ranking must follow the heading");
    if (rank(files, st, new Map(), 2).length) throw new Error("no vectors must mean no recommendations, not arbitrary files");
    if (rank(files, null, fv).length) throw new Error("no session must rank nothing");

    // ── the negative half: a 👎 has to move something ────────────────────────
    // The whole reason this exists. Saying "not this" and watching the page not
    // change is worse than having no button at all.
    {
        const both = [
            { resourceId: "X", owner: "0x1", top: "t", mime: "video/mp4", name: "x" },
            { resourceId: "Y", owner: "0x1", top: "u", mime: "video/mp4", name: "y" },
        ];
        const vv = new Map([["x", at(0)], ["y", at(12)]]);
        // History entries as remember() writes them — tags included, since taste
        // is scored off the tags and not off the file.
        const hx = { resourceId: "x", owner: "0x1", top: "t", mime: "video/mp4" };
        const hy = { resourceId: "y", owner: "0x1", top: "u", mime: "video/mp4" };
        const likeX = session([{ ...hx, r: 1 }], vv);
        if (rank(both, likeX, vv, 2)[0].resourceId !== "X") throw new Error("a 👍 must rank its own row first");
        // Same history, X disliked instead: X must lose the top spot to Y even
        // though Y was never opened.
        const hateX = session([{ ...hx, r: -1 }, hy], vv);
        if (!hateX.neg) throw new Error("a disliked row must produce a repulsion centroid");
        if (rank(both, hateX, vv, 2)[0].resourceId !== "Y") throw new Error("a 👎 must push its own row down the ranking");
        // A dislike must not become a position: μ is built only from what you
        // opened, so disliking everything leaves nowhere to point.
        const onlyHate = session([{ ...hx, r: -1 }], vv);
        if (onlyHate.q) throw new Error("a session of nothing but dislikes must have no heading");
        if (!onlyHate.neg) throw new Error("...but it must still know what to avoid");
        if (heading(onlyHate, both, vv)) throw new Error("no heading must mean no compass, not an empty one");
        if (rank(both, onlyHate, vv, 2)[0].resourceId !== "Y") throw new Error("with only a dislike, the far row must still win");
        // Taste is signed: the disliked row's own collection must score below zero.
        if (!(hateX.taste["top:0x1/t"] < 0)) throw new Error("a 👎 must subtract from its own collection's taste");
        // Clearing it must undo it, or the button is a one-way door.
        if (rank(both, session([hx, hy], vv), vv, 2)[0].resourceId !== "X") {
            throw new Error("an unrated history must rank the way it did before anyone pressed anything");
        }
    }

    // Topics: two lexically and geometrically distinct groups must come back as
    // two shelves, named by what separates them.
    const mk = (id, name, deg) => ({ resourceId: id, owner: "0x1", top: "t", name, path: name });
    const cook = Array.from({ length: 7 }, (_, i) => mk(`c${i}`, `Risotto lesson ${i}.mp4`, 0));
    const box = Array.from({ length: 7 }, (_, i) => mk(`b${i}`, `Boxing highlights ${i}.mp4`, 90));
    const tv = new Map([
        ...cook.map((f, i) => [f.resourceId.toLowerCase(), at(i)]),
        ...box.map((f, i) => [f.resourceId.toLowerCase(), at(90 + i)]),
    ]);
    const t = topics([...cook, ...box], tv);
    if (t.length < 2) throw new Error(`two separated groups must yield two topics, got ${t.length}`);
    const names = t.map((s) => s.title.toLowerCase()).join(" ");
    if (!names.includes("risotto") || !names.includes("boxing")) throw new Error(`topics must be named by what is distinctive: ${names}`);
    // The word every row shares describes nothing and must not become a title.
    if (names.includes("lesson") && names.includes("highlights") === false) throw new Error("topic naming picked the wrong axis");
    // Every file lands in exactly one topic, and none is invented.
    const seen = t.flatMap((s) => s.items.map((f) => f.resourceId));
    if (new Set(seen).size !== seen.length) throw new Error("a file must not appear in two topics");
    if (topics(cook.slice(0, 3), tv).length) throw new Error("too few embedded files must yield no topics, not one-file shelves");
    if (topics([...cook, ...box], new Map()).length) throw new Error("a lexical-only shard must not fake topics");

    // ── heading(): the session, in words ─────────────────────────────────────
    // The readout has to agree with the shelves, because it is generated from the
    // same ranking — and it has to say something specific, or it is decoration.
    {
        const v = (a, b) => { const x = new Array(8).fill(0); x[0] = a; x[1] = b; return x; };
        const mk = (name, desc, vec) => ({ file: { owner: "0x1", path: `d/${name}`, name, desc, mime: "audio/mpeg" }, vec });
        const corpus = [
            mk("chiptune covers.mp3", "chiptune square wave game music", v(1, 0)),
            mk("chiptune arcade.mp3", "chiptune arcade game music", v(0.99, 0.1)),
            mk("chiptune boss theme.mp3", "chiptune game music boss", v(0.98, 0.15)),
            // "music" is in EVERY row, so it must score zero and never be picked —
            // that is the whole point of scoring against document frequency.
            mk("string quartet.mp3", "romantic string quartet chamber music", v(-0.5, 0.86)),
            mk("cello suite.mp3", "solo cello baroque suite music", v(-0.55, 0.83)),
            mk("piano nocturne.mp3", "romantic piano nocturne chamber music", v(-0.6, 0.8)),
        ];
        const files = corpus.map((c) => c.file);
        const vectors = new Map(corpus.map((c) => [nodeKey(c.file), c.vec]));
        // A session walking toward the chiptune side.
        const hist = [{ resourceId: nodeKey(files[1]) }, { resourceId: nodeKey(files[3]) }];
        const h = heading(session(hist, vectors), files, vectors, { look: 3 });
        if (!h) throw new Error("a session with vectors must produce a heading");
        if (!/chiptune/i.test(h.terms)) throw new Error(`heading must name what it points at, got: ${h.terms}`);
        if (/music/i.test(h.terms)) throw new Error(`heading must be distinctive, not generic: ${h.terms}`);
        // It must agree with the ranking it came from, or the page and its caption
        // are describing different things.
        if (h.items[0] !== rank(files, session(hist, vectors), vectors, 3)[0]) {
            throw new Error("heading must be derived from the same ranking that reorders the page");
        }
        if (heading(null, files, vectors)) throw new Error("no session must mean no readout, not an empty one");

        // The df memo is keyed on the corpus ARRAY, so the thing that can go wrong
        // is a stale or shared entry: a second corpus must be scored against its
        // OWN document frequencies, not the first one's.
        const twice = label(files.slice(0, 3), files);
        if (label(files.slice(0, 3), files) !== twice) throw new Error("memoized document frequency changed its answer");
        // Same rows, a corpus where "chiptune" is no longer distinctive because
        // every row has it — the label must move.
        const allChip = files.slice(0, 3);
        if (label(allChip, allChip) === twice) throw new Error("df must be per-corpus: a word in every row names nothing");
    }


    // ── field(): the same ranking, as geometry ───────────────────────────────
    {
        const v = (a, b) => { const x = new Array(8).fill(0); x[0] = a; x[1] = b; return x; };
        const mk = (name, desc, vec) => ({ file: { owner: "0x1", path: `d/${name}`, name, desc, mime: "audio/mpeg" }, vec });
        const corpus = [
            mk("chiptune covers.mp3", "chiptune square wave game", v(1, 0)),
            mk("chiptune arcade.mp3", "chiptune arcade game", v(0.99, 0.1)),
            mk("chiptune boss.mp3", "chiptune game boss", v(0.98, 0.15)),
            mk("string quartet.mp3", "romantic string quartet chamber", v(-0.5, 0.86)),
            mk("cello suite.mp3", "solo cello baroque suite", v(-0.55, 0.83)),
            mk("piano nocturne.mp3", "romantic piano nocturne chamber", v(-0.6, 0.8)),
        ];
        const files = corpus.map((c) => c.file);
        const vectors = new Map(corpus.map((c) => [nodeKey(c.file), c.vec]));
        const groups = [
            { title: "Chiptune", items: files.slice(0, 3) },
            { title: "Chamber", items: files.slice(3) },
        ];
        const st = session([{ resourceId: nodeKey(files[0]), v: null }], vectors);
        // Without a session the field must still draw — a first visit is not an
        // error, it is the corpus centroid.
        const cold = field(files, vectors, null, { groups });
        if (cold.nodes.length !== files.length) throw new Error("a cold field must place every embedded row");
        if (!cold.nodes.every((n) => Math.hypot(n.x, n.y) <= 1.001)) throw new Error("nodes must land inside the unit disc");

        const f = field(files, vectors, st, { groups, drift: 0 });
        // The attractor is what the session opened, so that row must be nearest
        // the centre and the far cluster must be out at the rim.
        if (f.nodes[0].f !== files[0]) throw new Error("the field must be ordered by distance to the attractor");
        if (Math.hypot(f.nodes[0].x, f.nodes[0].y) >= Math.hypot(f.nodes.at(-1).x, f.nodes.at(-1).y)) {
            throw new Error("radius must grow with distance from the attractor");
        }
        // Angle carries region membership: the two clusters must not overlap.
        const ang = (n) => Math.atan2(n.y, n.x);
        const by = new Map(f.nodes.map((n) => [n.f.name, ang(n)]));
        const chip = files.slice(0, 3).map((x) => by.get(x.name));
        const cham = files.slice(3).map((x) => by.get(x.name));
        const gap = Math.abs(Math.atan2(Math.sin(chip[0] - cham[0]), Math.cos(chip[0] - cham[0])));
        if (gap < 0.5) throw new Error(`two topics must occupy separated sectors, got ${gap} rad apart`);
        if (f.regions.length !== 2) throw new Error("every topic must become a region");
        // An impulse must move the field: pulling toward the far cluster has to
        // bring one of its rows to the centre.
        const pulled = field(files, vectors, st, { groups, drift: 0, to: v(-0.6, 0.8) });
        if (pulled.nodes[0].f === f.nodes[0].f) throw new Error("an impulse must re-order the field");
        if (field([], vectors, st, { groups })) throw new Error("no rows must mean no field, not an empty disc");
    }
    console.log("kernel.js self-check ok — session heading, order sensitivity, taste ranking, like/dislike repulsion, topic clustering + naming, heading readout, attractor field");
}
