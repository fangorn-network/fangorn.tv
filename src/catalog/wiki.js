// You, as a wiki.
//
// The shape is ~/fangorn/second-brain's — a front page laid out like Wikipedia's,
// concept pages, wikilinks everywhere — but the SUBJECT is the reader, not the
// catalog. The front page is the session kernel written out in prose and links:
// what you opened, what you rated, the concepts you keep landing in, where that
// points next, and which app you carried it in from. Concepts are still the
// connective tissue; they are just weighted by your history instead of by the
// publisher's.
//
// Why not a wiki OF the catalog: nobody has a second question about a stranger's
// shard, and every fact on such a page is one the publisher already wrote. The
// one thing on this screen that exists nowhere else is the reader's own kernel —
// 40 rows of localStorage that never leave the tab and that no server has ever
// seen. Mirroring that back is the only page here that could not be printed.
//
// Two things are deliberately NOT the same as second-brain:
//
//   No model. There, llama3.2 reads each note and writes its title, summary and
//   concepts. Here the corpus is already written — the publisher's name, path and
//   description — and kernel.js `words()`/`label()` already extract what is
//   distinctive about a group by document frequency. A concept is a term that
//   appears in more than one item and isn't everywhere. That is the whole
//   extractor, it runs in a tab in milliseconds, and it needs no download.
//
//   Not deterministic across users — that IS the feature here rather than a
//   compromise. Second-brain's front page is fixed because a picked-at-random
//   feature would rewrite the page's CID on every run. Nothing here is published,
//   so the same catalog opens as a different wiki for two people, because the
//   page is about the person.
//
// ponytail: extraction is document frequency over name/path/description, not a
// model and not entity linking. It finds "chiptune", it will not find that "the
// Amiga" and "Commodore's 16-bit machine" are the same thing. Swap the extractor
// for a model here if a catalog ever needs that; nothing else in this file cares
// where a concept came from.

import { nodeKey } from "./browse.js";
import { cosine, mean, rank, words } from "../geometry/kernel.js";

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const title = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * Every concept in the catalog: a term, and every item that mentions it.
 *
 * @param maxDf  a term in more than this share of the corpus describes nothing —
 *               "music" in a music catalog is not a concept, it's the catalog.
 *               This is the same judgement label() makes with idf, as a cutoff.
 * @param min    a term in one item joins nothing up — and a page listing one item
 *               is a dead end with extra steps, which is the exact failure a wiki
 *               is supposed to not have. Two is the floor for a link worth taking.
 *               It also drops most of the extraction noise for free: "onward",
 *               "produced", "everywhere" are each in exactly one description.
 * @returns Map<slug, { slug, name, items }>, biggest first
 */
export function concepts(files, { maxDf = 0.25, min = 2 } = {}) {
    // Term → items. `words()` already strips extensions, stopwords and numbers.
    const at = new Map();
    for (const f of files) for (const t of new Set(words(f))) {
        // push, NOT `at.set(t, [...old, f])`. Rebuilding the array on every
        // insertion is O(k²) in a term's document count, so one ordinary word
        // spread across most of the corpus makes this whole function quadratic:
        // 61ms at 2k files, 794ms at 8k, 6.9s at 16k — the main thread gone for
        // seconds at a time, which reads as "the page is frozen".
        let items = at.get(t);
        if (!items) at.set(t, (items = []));
        items.push(f);
    }

    // One concept, one page. A small model spelled things two ways in
    // second-brain; a filesystem spells them singular and plural. Fold the plural
    // into the singular when both are present — same idea, and a catalog that
    // says "episodes" nine times and "episode" once should not get two pages.
    for (const [t, items] of [...at]) {
        const stem = t.replace(/(?:ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
        if (stem !== t && at.has(stem)) {
            at.set(stem, [...new Set([...at.get(stem), ...items])]);
            at.delete(t);
        }
    }

    // The floor of 3 is what makes this work on a small catalog: a share-based cut
    // alone drops every concept out of a ten-row shard, because two mentions IS a
    // fifth of it. On a real corpus the share is what binds.
    const cap = Math.max(3, files.length * maxDf);
    const out = [...at]
        .filter(([, items]) => items.length >= min && items.length <= cap)
        .map(([t, items]) => [slugify(t), { slug: slugify(t), name: title(t), items }])
        .filter(([slug]) => slug);
    // Most-mentioned first, ties by name, so the page order is stable between
    // renders of the same catalog.
    out.sort((a, b) => b[1].items.length - a[1].items.length || a[0].localeCompare(b[0]));
    return new Map(out);
}

/** A concept's position in the same vector space everything else is ranked in —
 *  what "go there" means when you click one. Null when none of its items is
 *  embedded. */
export function centroid(concept, vectors) {
    const vs = concept.items.map((f) => vectors.get(nodeKey(f))).filter(Boolean);
    return vs.length ? mean(vs) : null;
}

/** How many *hub* concepts an item shares with the rest of the catalog — how tied
 *  in it is, rather than how big it is. Second-brain's reachOf, keyed by node. */
export function reachOf(cs) {
    const reach = new Map();
    for (const [, c] of cs) {
        if (c.items.length < 2) continue;
        for (const f of c.items) reach.set(nodeKey(f), (reach.get(nodeKey(f)) ?? 0) + 1);
    }
    return reach;
}

/** The concepts on one item, most-connected first — the wikilinks at the foot of
 *  its page, and the reason two unrelated files are two clicks apart. */
export function conceptsOf(file, cs, k = 8) {
    const key = nodeKey(file);
    return [...cs.values()].filter((c) => c.items.some((f) => nodeKey(f) === key)).slice(0, k);
}

/** First sentence of a description — the one line a listing can afford. */
export const lede = (f, n = 180) => {
    const d = String(f.desc ?? "").trim();
    if (!d) return "";
    const cut = d.slice(0, n);
    const stop = cut.lastIndexOf(". ");
    return stop > 40 ? cut.slice(0, stop + 1) : cut + (d.length > n ? "…" : "");
};

/**
 * The front page: YOU, not the catalog.
 *
 * The wiki used to be a Wikipedia of the shard — a featured file, the catalog's
 * hub concepts, a cross-section of descriptions. But a stranger's catalog is not
 * a subject anyone has a second question about, and every fact on that page was
 * one the publisher wrote, not one the reader made. So the subject of the wiki is
 * the reader: the session kernel's own aggregate, spelled out in words and links
 * instead of a vector. What you opened, what you said 👍/👎 to, which concepts you
 * keep landing in, where that points next, and which app you brought it from.
 *
 * It is a MIRROR, so nothing on it is invented: every line traces back to a row
 * this browser actually opened (`history`) or to a number the kernel derived from
 * those rows (`state`). Recommendations are the one forward-looking section and
 * they name the item they came from, because "because you opened X" is the only
 * form of recommendation the reader can check.
 *
 * Cold start is a real state, not a bug: a browser with no history has no
 * reflection, and the honest page says so and offers the catalog's most connected
 * items as a door in rather than pretending to know anyone.
 *
 * @param state    session() — the kernel, aggregated. Null until something is opened.
 * @param history  recall(), newest first.
 */
export function mirror(files, vectors, state, history = [], cs = concepts(files)) {
    const reach = reachOf(cs);
    const at = new Map(files.map((f) => [nodeKey(f), f]));
    // History is portable across apps and catalogs, so most of it is about rows
    // that aren't in THIS shard. Only the ones that are can be linked to.
    const seen = [];
    const took = new Set();
    for (const h of history) {
        const f = at.get(String(h.resourceId ?? "").toLowerCase())
            ?? at.get(`${h.owner}:${h.top}`.toLowerCase());
        if (!f || took.has(nodeKey(f))) continue;
        took.add(nodeKey(f));
        seen.push({ f, h });
    }
    const cold = !seen.length;

    const liked = seen.filter((x) => x.h.r > 0).map((x) => x.f);
    const disliked = seen.filter((x) => x.h.r < 0).map((x) => x.f);
    const last = seen.find((x) => (x.h.r ?? 0) >= 0)?.f ?? null;

    // Did you know: lines from things you actually opened — a fact about your own
    // shelf. Never the item at the top of the page, never one without prose.
    const dyk = seen.map((x) => x.f).filter((f) => f !== last)
        .map((f) => ({ f, line: lede(f) })).filter((x) => x.line).slice(0, 5);

    // Your concepts: the catalog's extraction, weighted by how many of YOUR items
    // mention each one. This is the vocabulary of the session in words — the same
    // thing `heading()` says about where it points, said about where it has been.
    const yours = [...cs.values()]
        .map((c) => ({ ...c, mine: c.items.filter((f) => took.has(nodeKey(f))).length }))
        .filter((c) => c.mine)
        .sort((a, b) => b.mine - a.mine || a.slug.localeCompare(b.slug))
        .slice(0, 12);

    // Recommendations: ranked by the kernel, over what you have NOT opened, each
    // carrying the item it is nearest among the ones you have. Without vectors (or
    // without a session) it falls back to how connected an item is, which is the
    // catalog's answer and is labelled as such by `cold`.
    const fresh = files.filter((f) => !took.has(nodeKey(f)));
    const byReach = (a, b) =>
        (reach.get(nodeKey(b)) ?? 0) - (reach.get(nodeKey(a)) ?? 0) ||
        (a.path ?? "").localeCompare(b.path ?? "");
    const recs = (state ? rank(fresh, state, vectors, 8) : [...fresh].sort(byReach).slice(0, 8))
        .map((f) => ({ f, because: nearestSeen(f, liked.length ? liked : seen.map((x) => x.f), vectors) }));

    // Which app each signal came from. The kernel crosses apps by vector, so a
    // page that can't say where a drift came from is exactly the spooky version.
    const apps = [...seen.reduce((m, { h }) => m.set(h.app ?? "here", (m.get(h.app ?? "here") ?? 0) + 1), new Map())]
        .map(([app, n]) => ({ app, n })).sort((a, b) => b.n - a.n);

    // The kernel's tag weights, strongest first — signed, because "never this
    // collection again" is a fact about you too.
    const taste = Object.entries(state?.taste ?? {})
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6)
        .map(([tag, w]) => ({ tag, w }));

    const out = {
        cold, seen: seen.map((x) => x.f), liked, disliked, last, dyk, yours, recs, apps, taste,
        concepts: cs, reach,
        stats: { opened: seen.length, liked: liked.length, disliked: disliked.length, catalog: files.length },
    };
    return { ...out, who: alias(state, out) };
}

/**
 * A handle for the session — "Restless Chiptune", "Deep Amiga", "Choosy Audio".
 *
 * The kernel is four numbers and a 256-d vector, which is exactly the kind of
 * thing a person cannot feel. A name they can. Both halves are read straight off
 * the kernel and nothing is invented:
 *
 *   the noun  — the concept most of your opens land in, or the medium if the
 *               catalog is lexical-only and has no concepts to land in
 *   the adjective — whichever of the four numbers below is loudest
 *
 * So it MOVES. Open three things from one corner and you settle into Deep; swing
 * across the catalog and you are Restless by the next click. That's the point: the
 * name is a readout, not a badge, and watching it change is the cheapest way to
 * see that the kernel is actually tracking you.
 *
 * ponytail: thresholds, not a classifier. They are tuned against a session of a
 * few dozen opens — if a name feels wrong on a big library, move the numbers here
 * and nothing else changes.
 */
function alias(state, { yours = [], liked = [], disliked = [], seen = [], taste = [] } = {}) {
    if (!state || !seen.length) return null;

    // Drift: how far the recent half of the session sits from the earlier half,
    // relative to where it sits at all. This is `speed / |μ|` — the same ratio the
    // kernel's own λ saturates on, so the name and the steering agree.
    const mag = Math.hypot(...(state.mu ?? [0])) || 1;
    const drift = Math.min(1, Math.hypot(...(state.v ?? [0])) / mag);
    // Focus: the share of your opens that land in one concept.
    const focus = yours.length ? yours[0].mine / seen.length : 0;
    // Decisiveness: how much of this was said out loud rather than inferred.
    const said = (liked.length + disliked.length) / seen.length;

    // The labels are descriptive, not evaluative: each names the measurement that
    // produced it and none of them is a better score than another.
    const [adj, why] =
        disliked.length >= 2 && disliked.length >= liked.length
            ? ["Selective", "You have rejected more items than you have kept."]
            : drift > 0.5 ? ["Restless", "Recent selections sit well away from earlier ones."]
                : drift > 0.15 ? ["Drifting", "Selections are moving, along a consistent line."]
                    : focus > 0.6 ? ["Focused", "Most items you open belong to one theme."]
                        : said > 0.5 ? ["Deliberate", "You rate most of what you open."]
                            : ["Settled", "Selections are clustered; no direction is measurable yet."];

    const noun = yours[0]?.name ?? title(String(taste.find((t) => t.w > 0)?.tag ?? "").split("/")[0]);
    return {
        name: noun ? `${adj} ${noun}` : adj, adj, noun, why,
        // The numbers behind the name, so it is a readout rather than a fortune.
        meters: [
            { label: "drift", v: drift, note: "Distance between recent and earlier selections." },
            { label: "focus", v: focus, note: noun ? `Share of opened items in ${noun.toLowerCase()}.` : "Share held by the largest theme." },
            { label: "rated", v: said, note: "Share of opened items you rated explicitly." },
        ],
    };
}

/** The item you already opened that this one is closest to — a recommendation's
 *  receipt. Null when nothing is embedded, in which case the UI says nothing
 *  rather than inventing a reason. */
function nearestSeen(f, mine, vectors) {
    const v = vectors.get(nodeKey(f));
    if (!v || !mine.length) return null;
    let best = null, bs = -Infinity;
    for (const m of mine) {
        const mv = vectors.get(nodeKey(m));
        if (!mv) continue;
        const s = cosine(v, mv);
        if (s > bs) { bs = s; best = m; }
    }
    return best;
}

/** Items nearest a concept, so a concept page is ordered by the same geometry
 *  the rest of the app ranks with instead of by filename. */
export function nearest(concept, vectors, k = 40) {
    const c = centroid(concept, vectors);
    if (!c) return concept.items.slice(0, k);
    return [...concept.items]
        .map((f) => ({ f, s: cosine(c, vectors.get(nodeKey(f)) ?? c) }))
        .sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.f);
}

/** Other concepts that share items with this one — "see also", and the thing
 *  that makes the wiki walkable rather than a two-level index. */
export function related(concept, cs, k = 8) {
    const mine = new Set(concept.items.map(nodeKey));
    return [...cs.values()]
        .filter((c) => c.slug !== concept.slug)
        .map((c) => ({ c, n: c.items.filter((f) => mine.has(nodeKey(f))).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || a.c.slug.localeCompare(b.c.slug))
        .slice(0, k).map((x) => x.c);
}

// ── self-check: `node src/catalog/wiki.js` ───────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const mk = (name, desc) => ({ owner: "0x1", top: "d", path: `d/${name}`, name, desc, mime: "audio/mpeg" });
    const files = [
        mk("chiptune covers.mp3", "Chiptune square wave arcade music. Written for the Amiga."),
        mk("chiptune arcade.mp3", "Chiptune arcade music from a cabinet."),
        mk("amiga demos.mp3", "Amiga demoscene music."),
        mk("string quartet.mp3", "Romantic string quartet chamber music."),
        mk("cello suite.mp3", "Solo cello baroque suite music."),
    ];
    const cs = concepts(files);
    // The word every row shares is the catalog, not a concept.
    if (cs.has("music")) throw new Error("a term in every item must not become a concept");
    if (!cs.has("chiptune") || !cs.has("amiga")) throw new Error(`the distinctive terms must survive: ${[...cs.keys()]}`);
    if (cs.get("chiptune").items.length !== 2) throw new Error("a concept must carry every item that mentions it");
    // Plural folding: both spellings, one page.
    const plural = concepts([...files, mk("demo reel.mp3", "Amiga demo reel"), mk("demos two.mp3", "More Amiga demos")]);
    if (plural.has("demos") && plural.has("demo")) throw new Error("singular and plural must not be two concepts");

    const r = reachOf(cs);
    if (!(r.get(nodeKey(files[0])) > 0)) throw new Error("an item sharing hub concepts must have reach");

    // ── the mirror: the front page is about the reader ──
    const at = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const vectors = new Map(files.map((f, i) => [nodeKey(f), at(i < 3 ? i * 4 : 90 + i)]));
    const key = (f) => nodeKey(f);
    const hist = [
        { resourceId: key(files[1]), owner: "0x1", top: "d", mime: "audio/mpeg", r: 1, app: "flix" },
        { resourceId: key(files[0]), owner: "0x1", top: "d", mime: "audio/mpeg" },
        { resourceId: key(files[3]), owner: "0x1", top: "d", mime: "audio/mpeg", r: -1 },
    ];
    const state = { q: at(2), taste: { audio: 0.8, "top:0x1/d": -0.2 }, mu: at(2), v: [0, 0], speed: 0 };

    const m = mirror(files, vectors, state, hist, cs);
    if (m.cold) throw new Error("a browser with history must not read as cold");
    if (m.last !== files[1]) throw new Error("the top of the page must be the last thing opened");
    if (m.liked.length !== 1 || m.liked[0] !== files[1]) throw new Error("liked must be exactly the 👍 rows");
    if (m.disliked[0] !== files[3]) throw new Error("a 👎 row must be reflected, not hidden");
    if (m.stats.opened !== 3) throw new Error(`the stats must count the reader's own rows: ${m.stats.opened}`);
    // Did you know is about things YOU touched, and never repeats the item above.
    if (!m.dyk.length || m.dyk.some((d) => d.f === m.last)) throw new Error("did-you-know must be your other items");
    if (m.dyk.some((d) => !hist.some((h) => h.resourceId === key(d.f)))) {
        throw new Error("did-you-know must only cite content the reader interacted with");
    }
    // Concepts are weighted by the reader's items, and only the ones they hit.
    if (!m.yours.some((c) => c.slug === "chiptune")) throw new Error("a concept the reader keeps landing in must surface");
    if (m.yours.some((c) => c.mine === 0)) throw new Error("a concept the reader never touched is not theirs");
    // Recommendations are forward-looking, never something already opened, and
    // each names the item it came from.
    if (m.recs.some((r) => hist.some((h) => h.resourceId === key(r.f)))) {
        throw new Error("a recommendation must not be something already opened");
    }
    if (!m.recs.length || !m.recs[0].because) throw new Error("a recommendation must name what it came from");
    if (m.recs.some((r) => r.because && !m.seen.includes(r.because))) {
        throw new Error("a recommendation's receipt must be one of the reader's own rows");
    }
    if (m.apps[0].app !== "here" && m.apps[0].app !== "flix") throw new Error("the page must say where the signal came from");
    if (m.taste[0].tag !== "audio") throw new Error("taste must be the kernel's own weights, strongest first");

    // The handle is a readout of the kernel, so it must move when the kernel does.
    if (!m.who?.name) throw new Error("a session with history must have a name");
    if (!m.yours.some((c) => c.name === m.who.noun)) throw new Error(`the name must come from where the reader lands: ${m.who.name}`);
    if (m.who.meters.some((x) => !(x.v >= 0 && x.v <= 1))) throw new Error("every meter must be a share, not a raw magnitude");
    const drifting = mirror(files, vectors, { ...state, v: at(90), speed: 1 }, hist, cs);
    if (drifting.who.adj === m.who.adj) throw new Error("a session that turns hard must not read the same as one standing still");
    // Two dislikes and one like is a fact about the reader, and it outranks the geometry.
    const picky = mirror(files, vectors, state, [...hist, { resourceId: key(files[4]), owner: "0x1", top: "d", r: -1 }], cs);
    if (picky.who.adj !== "Selective") throw new Error(`rejections must name the session: ${picky.who.adj}`);

    // Cold start: no history, no reflection — say so rather than invent one.
    const cold = mirror(files, vectors, null, [], cs);
    if (!cold.cold || cold.seen.length || cold.liked.length) throw new Error("an empty history must read as cold");
    if (cold.who) throw new Error("a browser with no history must not be given a name");
    if (!cold.recs.length) throw new Error("a cold page must still offer a door in");
    if (cold.recs.some((r) => r.because)) throw new Error("a cold page cannot claim a reason it does not have");

    if (!centroid(cs.get("chiptune"), vectors)) throw new Error("a concept with embedded items must have a position");
    if (centroid(cs.get("chiptune"), new Map())) throw new Error("a lexical-only catalog must have no concept position, not a zero vector");
    if (!related(cs.get("amiga"), cs).some((c) => c.slug === "chiptune")) {
        throw new Error("concepts sharing an item must be related");
    }
    if (related(cs.get("amiga"), cs).some((c) => c.slug === "amiga")) throw new Error("a concept must not be related to itself");
    if (nearest(cs.get("chiptune"), vectors).length !== 2) throw new Error("a concept page must list its own items");
    if (!conceptsOf(files[0], cs).some((c) => c.slug === "chiptune")) throw new Error("an item must carry its own concepts");
    if (conceptsOf(mk("orphan.mp3", ""), cs).length) throw new Error("an item in no concept must have no wikilinks, not all of them");
    // Every concept must be worth clicking: a page listing one item is a dead end.
    for (const [slug, c] of cs) if (c.items.length < 2) throw new Error(`concept "${slug}" has nothing to join up`);

    // ── concepts() must stay linear in the corpus ────────────────────────────
    // Guards the bug noted at the top of concepts(): rebuilding a term's array on
    // every insertion is O(k²) in that term's document count, so ordinary words
    // shared across the catalog took the whole function quadratic — 6.9s on a real
    // 16k-row corpus, which is the main thread gone for seconds and a page that
    // does not answer clicks.
    //
    // A wall-clock budget, not a ratio. Measured on this fixture: 105ms fixed,
    // 4784ms with the copying restored — so 1500ms sits 14x above the good case
    // and 3x below the bad one, and is not a benchmark that drifts into flaking.
    // The text is deliberately corpus-shaped: several words in EVERY row (the ones
    // that trigger it, and that maxDf then discards) plus a rare word per row that
    // survives the filter, so the fixture is provably extracting and not no-oping.
    {
        const RARE = ["astronomy", "botany", "chemistry", "geology", "history",
            "linguistics", "mathematics", "philosophy", "robotics", "zoology",
            "aviation", "cartography", "ecology", "genetics", "metallurgy",
            "oceanography", "paleontology", "seismology", "toxicology", "virology"];
        const SHOWS = ["johnny bravo", "dexters laboratory", "cow and chicken",
            "ed edd eddy", "courage cowardly dog", "powerpuff girls"];
        const N = 16000;
        const big = Array.from({ length: N }, (_, i) => ({
            owner: "0xaaa",
            path: `${SHOWS[i % SHOWS.length]}/season one/episode ${i}.mp4`,
            name: `episode ${i} title here.mp4`,
            desc: `a classic animated cartoon television episode from the archive `
                + `collection featuring ${RARE[i % RARE.length]} and assorted nonsense, item ${i}`,
        }));
        const t0 = Date.now();
        const cs = concepts(big);
        const ms = Date.now() - t0;
        if (cs.size < RARE.length) throw new Error(`the fixture must extract its rare terms, got ${cs.size} — it is measuring nothing`);
        if (ms > 1500) throw new Error(`concepts() took ${ms}ms on ${N} files — it has gone superlinear again (expect ~100ms)`);
    }

    console.log("wiki.js self-check ok — concept extraction, plural folding, reach, the reader's own mirror (opened/rated/concepts/recs/apps/taste), the kernel's handle, cold start, concept geometry, see-also, linear concept extraction");
}
