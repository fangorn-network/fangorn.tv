/**
 * Linear channels, with no scheduler.
 *
 * A guide grid needs an answer to "what is on channel 6 at 01:47?" — and the
 * expensive way to get one is a server that keeps a playlist, a cursor and a
 * clock, and hands out the same answer to everyone. There is nothing here to run
 * a server, and nothing to gain from one: make the schedule a PURE FUNCTION of
 * UTC and every viewer computes the identical answer independently, for any time,
 * past or future, off a static CDN bake. Sync falls out for free because nobody
 * is being told anything — they are all evaluating the same expression.
 *
 * A channel is therefore just a ring of items and its total length. Position in
 * the ring is `now mod total`; the ring repeats forever, which is exactly what a
 * FAST channel is.
 *
 * ponytail: rings are rebuilt whenever the catalog changes, so a re-crawl
 * reshuffles what is "on". Freeze the ring in the shard if that ever matters.
 */
import { byEpisode, hashOf, inRun, mimeFor, nodeKey, seriesKey, showOf } from "./browse.js";
import { POOL, pool, walk } from "../geometry/walk.js";
import { packBits, packVec, unpackBits, unpackVec } from "../llm/embed.js";

// How long a slot is. The guard is not decoration: the crawl has produced a
// 575,848,022-second row, and ONE bad duration doesn't just mislabel its own
// cell — it desynchronises everything after it in the ring, for every viewer.
const MAX = 6 * 3600;
export const FALLBACK = 1800;

// Where a row starts inside its own bytes. 0 for a file, the cut point for a
// moment — see moments() below.
export const inOf = (f) => (f?.in > 0 ? f.in : 0);

export const durOf = (f) => {
    // A moment is a WINDOW into a file, so the window is the slot: a 40-second
    // scene occupies 40 seconds of the ring, not the film's two hours.
    const d = Number(f?.out > inOf(f) ? f.out - inOf(f) : f?.duration);
    return d > 0 && d <= MAX ? d : FALLBACK;
};

// What can be on a channel: free, video, and something a <video> will take.
// Paid rows are excluded on purpose — a channel that stops to charge you is not
// a channel. ponytail: video only; audio would be radio, which is a different row.
const playable = (f) => inRun(f) && !!f.url && /^video\//.test(mimeFor(f) || "");

// ── what a slot is called ────────────────────────────────────────────────────
// A guide is a wall of names, so an unreadable one is the whole cell wasted. The
// crawl is full of names like "S02E07 - (NKIRI.COM).mp4" and
// "S01E01 - (NKIRI.COM).nciodsncisdncoisdnocisncdcin.mp4": a real episode number
// and then the uploader's signature, twice.
const MEDIA_EXT = /\.(mp4|mkv|avi|mov|m4v|webm|ogv|mpe?g|ts|flv)$/i;
// A second "extension" that is really a release tag — long, unspaced, and always
// last. Repeated because they come in pairs. No digits, because the same shape
// with numbers in it is a date or a course code, and eating those loses the name
// rather than the noise. ponytail: not a scene-tag parser; "H.264-FoxKID" gets
// through, which is untidy and not wrong.
const TRAILING_TAG = /\.[^.\s\d]{10,}$/;
const BRACKETED = /[([{][^)\]}]*[)\]}]/g;
// The episode number, when it is the first thing in the name — the row already
// says which show this is, so the code below re-renders it in one form.
const LEADING_CODE = /^\s*(s\s*\d{1,2}\s*[ex]\s*\d{1,3}|\d{1,2}\s*x\s*\d{1,3}|ep(?:isode)?\.?\s*\d{1,3})\b/i;

/** What to print in a cell: "S2E7 · The Execution", "S2E7", or the tidied name. */
export function slotLabel(f) {
    let rest = (f?.name ?? "").replace(MEDIA_EXT, "");
    for (let i = 0; i < 2 && TRAILING_TAG.test(rest); i++) rest = rest.replace(TRAILING_TAG, "");
    rest = rest.replace(BRACKETED, " ").replace(LEADING_CODE, " ")
        .replace(/[\s\-–—_.:]+/g, " ").trim();
    // isFinite, not != null: a crawl row whose episode came back NaN (a film, in a
    // feed that Number()s the field either way) is not episode NaN — it renders
    // "SNaNENaN" and eats the title, which is the one outcome this function exists
    // to prevent.
    const ep = Number.isFinite(f?.episode) ? f.episode : null;
    const season = Number.isFinite(f?.season) ? f.season : 1;
    const code = ep != null ? `S${season}E${ep}` : null;
    // Two letters, because "3, 2, 1 Let's Go!" is a title and "1" is a leftover.
    const titled = /\p{L}{2}/u.test(rest);
    const name = code ? (titled ? `${code} · ${rest}` : code) : (titled ? rest : (f?.name ?? ""));
    // A moment cell that says only which episode it came from is the one thing a
    // scene channel must not look like — three cells from one film would read as
    // the same slot three times.
    return inOf(f) ? `${clock(inOf(f))} ${name}` : name;
}

/** m:ss / h:mm:ss, for a cell that has to say WHERE in the film it is. */
const clock = (s) => {
    const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(t % 60).padStart(2, "0")}`;
};

/** Deterministic order from a seed. Not Math.random: two viewers must shuffle
 *  the same catalog into the same ring or they are not watching one channel. */
const shuffle = (seed, items) => items
    .map((f) => [hashOf(`${seed}#${nodeKey(f)}`), f])
    .sort((a, b) => a[0] - b[0])
    .map(([, f]) => f);

const push = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);

// A folder named "-" is a real row in the crawl, and pretty() faithfully renders
// it as a channel called "-". One guard, not a title parser: a channel nobody can
// read the name of is worse than one fewer channel.
const named = (t) => /\p{L}{2}/u.test(t ?? "");

const channel = (id, kind, title, items) => ({
    id, kind, title, items,
    total: items.reduce((s, i) => s + durOf(i), 0),
});

/**
 * The lineup, from data the catalog already has.
 *
 *  · one show, in broadcast order — the "Anger Management Channel" of every FAST
 *    grid, and the reason scattered one-off episodes were worth grouping.
 *  · one aisle, shuffled — genres.js already decided what an aisle is, and its
 *    labels are cached per viewer, so this fills in as they sort.
 *
 * Alphabetical, like every guide anyone has ever read.
 */
export function lineup(files, labels = new Map(), { minEpisodes = 5, minItems = 8 } = {}) {
    const pool = files.filter(playable);
    const shows = new Map();
    const aisles = new Map();
    for (const f of pool) {
        const k = seriesKey(f);
        if (k) push(shows, k, f);
        const label = labels.get(nodeKey(f));
        if (label) push(aisles, label, f);
    }

    const out = [];
    for (const [k, items] of shows) {
        if (items.length < minEpisodes) continue;
        out.push(channel(`show:${k}`, "show", showOf(items[0])?.title ?? "Series", items.sort(byEpisode)));
    }
    for (const [label, items] of aisles) {
        if (items.length < minItems) continue;
        out.push(channel(`aisle:${label}`, "aisle", label, shuffle(`aisle:${label}`, items)));
    }
    return out
        .filter((c) => named(c.title))
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((c, i) => ({ ...c, number: i + 1 }));
}

// ── a channel that is a query over SCENES ────────────────────────────────────
//
// The difference this exists to make: a "firetrucks" channel built out of files
// is every film that mentions a firetruck, most of which is not about one. Built
// out of moments it is the ninety seconds in each film where one is on screen.
//
// searchSubtitles() already ranks moments across the whole corpus and hands back,
// per hit, the file it plays through and the second it happens at. So a moment
// channel needs no new index and no new bake — it is that result list, cut into
// windows, in a ring. `in`/`out` are the only new fields, and durOf/inOf/nodeKey
// are the three places that had to learn about them.
//
// ponytail: ranked then deterministically shuffled — no vector walk. tuned()'s
// pool+walk exists because 20k files need a neighbourhood to wander in; a few
// dozen moments ARE the neighbourhood. Give this walk() if a moment channel ever
// runs long enough to feel repetitive.
/**
 * A ring cut out of scenes. `hits` is searchSubtitles() output.
 *
 * `lead` is not decoration. A scene caption is anchored at the frame the VLM was
 * shown, and a cut that lands exactly on it has already missed the moment — you
 * arrive as it ends. Back up a few seconds and the described thing happens on
 * screen instead of behind you.
 */
export function moments(hits, { id = "moments", title = "Moments", seed = id,
    lead = 4, dur = 45, min = 8 } = {}) {
    const items = [];
    const seen = new Set();
    for (const h of hits ?? []) {
        // The hit's `episode` IS the file pointer — same playability rule as every
        // other channel, so a moment inside a paid film is not a slot.
        const f = h?.episode;
        if (!playable(f)) continue;
        // WHOLE SECONDS, both ends. airing() floors ms to seconds and schedule()
        // walks by feeding endsAt back into it — so a fractional slot length makes
        // that walk land back INSIDE the slot it just left, and the guide renders
        // the same cell until its cap. Subtitle starts are fractional (2472.04),
        // so this is not a tidiness round; it is the ring's invariant.
        const at = Math.max(0, Math.round((h.start ?? 0) - lead));
        // A `scene` row has start === end (one sampled frame, no extent), so the
        // window is built AROUND the anchor rather than read off it. An `asr` or
        // `summary` row does have an extent, and gets its own, capped: some ASR
        // passages run 800 seconds and that is a programme, not a moment.
        const span = (h.end ?? 0) > h.start ? h.end - h.start + lead : dur;
        const row = { ...f, in: at, out: at + Math.round(Math.min(dur, Math.max(min, span))),
            // What the moment IS, where the UI already prints a description.
            // Without this every card in a scene channel is a filename.
            desc: h.text ?? f.desc };
        const k = nodeKey(row);
        if (seen.has(k)) continue; // one second matched twice, on two roles
        seen.add(k);
        items.push(row);
    }
    return channel(id, "moment", title, shuffle(seed, items));
}

/**
 * A ring cut out of shots somebody CHOSE, in the order they chose them.
 *
 * moments() is a search result: ranked, then shuffled, because a bag of clips
 * about one subject has no order worth keeping. This is the other thing — the
 * order IS the content. Six clips that happen to mention a milkshake are noise;
 * the same six in the right order are an accusation, a denial and a verdict, and
 * shuffling them destroys exactly the thing that made them worth cutting.
 *
 * So: no shuffle, no seed. Everything else — the in/out window, the whole-second
 * rule, the per-shot key — is moments()' and has to stay identical, because
 * airing() and schedule() only know how to walk one shape of row.
 *
 * `shots` are `{ file, start, dur, note }`, already resolved and bounds-checked
 * by whoever picked them. This does the arithmetic and nothing else.
 *
 * ponytail: an authored ring is DATA, not a running agent. It is built once and
 * then plays off the clock like every other channel — so a viewer with no agent,
 * or the same viewer tomorrow, gets the same programme at the same second. An
 * agent that had to be present at playback would be a channel that only exists
 * while someone is paying for tokens.
 */
export function program(shots, { id = "program", title = "Program" } = {}) {
    const items = [];
    for (const s of shots ?? []) {
        const f = s?.file;
        if (!playable(f)) continue;
        // Whole seconds, both ends — see moments(): a fractional slot makes
        // schedule()'s walk land back inside the slot it just left.
        const at = Math.max(0, Math.round(s.start ?? 0));
        const dur = Math.max(1, Math.round(s.dur ?? 5));
        items.push({ ...f, in: at, out: at + dur, desc: s.note ?? f.desc });
    }
    return channel(id, "moment", title, items);
}

// ── a channel that is a query ────────────────────────────────────────────────
//
// lineup() can only build rings out of groups the catalog already has. "rainy
// cyberpunk" is not a folder, so walk.js generates its ring instead — but a
// generated ring must still answer "what is on at 01:47?" the same way for
// everyone, off no server, for any time past or future. Two properties get it
// there:
//
//   · the walk is a pure function of (pool, q, seed), and
//   · time is cut into fixed BLOCKs, block n seeded `<seed>#<n>`.
//
// So block n is computable on its own, in O(1), without knowing block n-1 — which
// is the difference between "what's on next Tuesday at 3am" being an expression
// and being a simulation. The price is that each block starts the walk over at
// the prompt, so the channel visibly reshuffles every BLOCK. That reads as a
// feature (the channel refreshes on the six) and it is the only reason any of
// this stays serverless.
//
// A block is generated to fill BLOCK seconds. It nearly always can: walk.js
// shrinks its no-repeat window to fit a small pool, so even a two-row
// neighbourhood alternates for six hours rather than running dry. The one way a
// block comes back short is walk.js's hard `max` — a pool of very short clips —
// and then the ring simply laps inside its own block. A repeat within six hours,
// never dead air.
export const BLOCK = 6 * 3600;
const KEEP = 4; // blocks memoized: the guide renders a few hours around now

/**
 * A tuned channel from a query vector.
 *
 * `spec` is the whole channel — `{ id, title, q, seed, temp, anchor }` — and it is
 * kept on the returned object on purpose: a channel that is fully described by
 * ~150 bytes is a channel that can be shared as a link, forked, or published as a
 * row, and none of that works if the spec only ever existed as arguments.
 */
export function tuned(spec, files, vectors, { number = 0 } = {}) {
    const { id, title, seed = id, temp, anchor, poolSize = POOL } = spec;
    // The vector the LINK carries, not the float one it was embedded as: a
    // receiver only ever holds the packed vector, so walking anything else here
    // would put the two of us in different pools of the same catalog. signs() is
    // idempotent, so an opened link round-trips to itself.
    const q = signs(spec.q);
    // playable(), same as lineup(): a channel that stops to charge you is not a
    // channel, and a cover .jpg is not a slot.
    const cands = pool(files.filter(playable), q, vectors, poolSize);
    const cache = new Map();
    return {
        id, kind: "walk", title, number, spec, total: BLOCK,
        block(n) {
            let ring = cache.get(n);
            if (!ring) {
                ring = walk(cands, { q, seed: `${seed}#${n}`, seconds: BLOCK, dur: durOf, temp, anchor });
                cache.set(n, ring);
                // Bounded, not cleared: someone leaving the guide open overnight
                // must not accumulate a ring per six hours forever.
                if (cache.size > KEEP) cache.delete(cache.keys().next().value);
            }
            return ring;
        },
    };
}

// ── saving, sharing, and watching together ───────────────────────────────────
// A tuned channel IS its spec: a query vector, a seed and two knobs. Nothing
// else — the ring is regenerated from them, and the schedule is a pure function
// of UTC, so two people who hold the same spec are watching the same frame at
// the same moment without a room, a socket or a server between them. Sync is
// not a feature here; it is the absence of one.
//
// The query vector travels PACKED rather than as its prompt, for two reasons.
// It is exact — re-embedding "rainy cyberpunk" on another device could land a
// hair away and cut the pool differently at the boundary, and the ring would
// silently drift. And it needs no model: opening a shared channel is 32 bytes
// of base64, not a 131MB download before anything plays.
//
// Packed as SIGN BITS (see packBits): 43 characters, not 344. A link is pasted
// into a message by a person, and 256 int8 dimensions of base64 made one that
// wrapped four times and looked broken. The whole channel still fits, because
// what a channel needs from the vector is a neighbourhood, not a coordinate.
//
// ponytail: the spec assumes both viewers are looking at the same catalog. Same
// app, same publishers, same shard — otherwise the pool differs and so does the
// ring. Stamp the shard's hash into the link when the corpus starts moving under
// people mid-watch.
/** ±1 per dimension — what packBits keeps, applied in the tab so a channel is
 *  built from the same vector its link carries. */
const signs = (q) => Float32Array.from(q ?? [], (x) => (x < 0 ? -1 : 1));
const b64url = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => s.replace(/-/g, "+").replace(/_/g, "/");

/** A tuned channel as a URL fragment. Round-trips through unpackChan(). */
export function packChan(spec) {
    const p = new URLSearchParams({ b: b64url(packBits(spec.q)), t: spec.title ?? "" });
    if (spec.seed && spec.seed !== spec.title) p.set("s", spec.seed);
    if (spec.temp != null) p.set("x", String(spec.temp));
    if (spec.anchor != null) p.set("a", String(spec.anchor));
    return p.toString();
}

/** The inverse. Returns null on anything malformed — a pasted link is untrusted
 *  input, and a half-decoded spec would produce a channel that is silently not
 *  the one that was shared. */
export function unpackChan(str) {
    try {
        const p = new URLSearchParams((str ?? "").replace(/^#/, ""));
        // `v` is the old int8 encoding — links people already sent still open.
        const q = p.has("b") ? unpackBits(unb64url(p.get("b"))) : unpackVec(unb64url(p.get("v") ?? ""));
        if (!q?.length) return null;
        const title = p.get("t") || "shared channel";
        const seed = p.get("s") || title;
        const num = (k) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : undefined);
        return { id: `ch:${seed}`, title, seed, q, temp: num("x"), anchor: num("a") };
    } catch { return null; }
}

/** The link to hand someone. Everything is in the fragment, so it never reaches
 *  a server and a static bake serves it unchanged. */
export const chanLink = (spec, base = here()) => `${base.split("#")[0]}#${packChan(spec)}`;

const here = () => (typeof location !== "undefined" ? location.href : "");

// ── sharing a channel the catalog already had ────────────────────────────────
// A tuned channel IS a vector, so its link carries one. "Wonder Showzen" is not:
// it is a group lineup() made out of rows both ends already have, and the honest
// encoding of it is its name, not an embedding of its name. Re-deriving a folder
// from a query vector would land near it and sometimes beside it, which is a
// worse answer than simply asking for the row.
//
// The id travels with the title because the two kinds of id are not equally
// stable: a `show:` key comes from the crawl and matches on any viewer, while an
// `aisle:` label is genre work done per tab and can land differently. Title is
// the fallback that catches that.
//
// ponytail: same catalog assumption as packChan, one step louder — a row the
// receiver's shard does not hold leaves them on the first channel rather than on
// an error. Nothing to do about that until channels can name a shard.

/** A catalog channel as a URL fragment. Round-trips through unpackRow(). */
export const packRow = (chan) => new URLSearchParams({ c: chan.id, t: chan.title ?? "" }).toString();

/** The row a fragment names, or null when it names none. */
export function unpackRow(str) {
    const p = new URLSearchParams((str ?? "").replace(/^#/, ""));
    const id = p.get("c");
    return id ? { id, title: p.get("t") || "" } : null;
}

/** The link for ANY channel on the set — the one thing the share buttons call,
 *  so no surface has to know which kind of channel it is looking at. */
export const linkFor = (chan, base = here()) =>
    chan?.spec ? chanLink(chan.spec, base) : `${base.split("#")[0]}#${packRow(chan)}`;

// The saved list. localStorage because a channel is worth exactly as much as
// the tab it was made in until someone shares the link — which is the real
// persistence layer, and the one that works across devices.
const SAVED = "sond3r.channels";
const readLS = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};

/** Saved specs, newest first, already decoded. */
export const savedChans = () =>
    readLS(SAVED, []).map((row) => unpackChan(row)).filter(Boolean);

/** Save, deduped on the packed string so saving the same channel twice is a
 *  no-op rather than a second identical row in the deck. */
export function saveChan(spec) {
    const packed = packChan(spec);
    const rows = readLS(SAVED, []).filter((r) => r !== packed);
    rows.unshift(packed);
    try { localStorage.setItem(SAVED, JSON.stringify(rows.slice(0, 24))); } catch { /* full or blocked */ }
    return savedChans();
}

export function dropChan(id) {
    const rows = readLS(SAVED, []).filter((r) => unpackChan(r)?.id !== id);
    try { localStorage.setItem(SAVED, JSON.stringify(rows)); } catch { /* full or blocked */ }
    return savedChans();
}

/** Where block arithmetic replaces ring arithmetic. Same return shape as airing(). */
function inBlock(chan, sec) {
    const n = Math.floor(sec / BLOCK);
    const base = n * BLOCK;
    const ring = chan.block(n);
    if (!ring?.total) return null;
    const at = sec - base;          // 0 .. BLOCK-1, and non-negative before the epoch too
    const pos = at % ring.total;    // a thin block laps inside itself
    const laps = at - pos;
    let acc = 0;
    for (const item of ring.items) {
        const d = durOf(item);
        if (pos < acc + d) {
            const startsAt = base + laps + acc;
            // Clamped to the block edge: the last slot before a reshuffle is cut
            // there, so feeding endsAt back into airing() lands on offset 0 of the
            // next block rather than somewhere inside a ring that no longer exists.
            return {
                item, offset: inOf(item) + (pos - acc),
                startsAt: startsAt * 1000,
                endsAt: Math.min(startsAt + d, base + BLOCK) * 1000,
            };
        }
        acc += d;
    }
    return null; // unreachable while total is the sum of durOf
}

/**
 * What is on `chan` at `t` (ms), and how far into it we are.
 *
 * Whole seconds throughout, so that `endsAt` fed straight back in lands on
 * offset 0 of the next slot rather than one millisecond short of it — which is
 * what schedule() below relies on to walk forward.
 */
/** A channel that is not the one you are on. Surfing's other gesture: the
 *  schedule is a pure function of the clock, so landing anywhere lands you
 *  mid-slot, which is the only way an unfamiliar channel ever feels like one.
 *
 *  Excludes `notId` rather than rejection-sampling — "random" that can hand back
 *  the channel you are already watching reads as a broken button. */
export function randomChan(channels, notId) {
    const rows = channels.filter((c) => c.id !== notId);
    if (!rows.length) return channels[0] ?? null;
    return rows[Math.floor(Math.random() * rows.length)];
}

export function airing(chan, t) {
    if (!chan?.total) return null;
    const sec = Math.floor(t / 1000);
    if (chan.block) return inBlock(chan, sec);
    let at = ((sec % chan.total) + chan.total) % chan.total;
    for (const item of chan.items) {
        const d = durOf(item);
        if (at < d) return { item, offset: inOf(item) + at, startsAt: (sec - at) * 1000, endsAt: (sec - at + d) * 1000 };
        at -= d;
    }
    return null; // unreachable while total is the sum of durOf
}

/** Every slot overlapping [from, to) — one row of the grid. Capped so a channel
 *  of 20-second clips can't render ten thousand cells into someone's tab. */
export function schedule(chan, from, to, cap = 60) {
    const cells = [];
    for (let cur = airing(chan, from); cur && cur.startsAt < to && cells.length < cap; cur = airing(chan, cur.endsAt)) {
        cells.push(cur);
    }
    return cells;
}

// ── self-check: `node src/catalog/channels.js` ───────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
    const ok = (c, m) => { if (!c) throw new Error(m); };
    const vid = (name, extra = {}) => ({
        owner: "0x1", name, path: `tv/show/${name}`, dir: "tv/show", mime: "video/mp4",
        url: `https://x/${name}`, duration: 100, ...extra,
    });
    const ch = channel("t", "show", "T", [vid("a.mp4"), vid("b.mp4"), vid("c.mp4")]);
    eq(ch.total, 300, "total is the sum of the ring");

    // The whole premise: same t, same answer, and it wraps forever.
    eq(airing(ch, 150_000).item.name, "b.mp4", "the clock indexes the ring");
    eq(airing(ch, 150_000).offset, 50, "and says how far in");
    eq(airing(ch, 150_000 + 300_000).item.name, "b.mp4", "one lap later is the same slot");
    eq(airing(ch, 0).item.name, "a.mp4", "the epoch is the top of the ring");
    eq(airing(ch, -50_000).item.name, "c.mp4", "before the epoch still lands inside it");

    // schedule() walks by feeding endsAt back in — this is what breaks first if
    // airing() ever rounds, and a one-slot-per-call infinite loop is the symptom.
    const cells = schedule(ch, 0, 500_000);
    eq(cells.length, 5, "five slots cover 500s of 100s items");
    eq(cells.map((c) => c.item.name).join(","), "a.mp4,b.mp4,c.mp4,a.mp4,b.mp4", "in ring order, looping");
    eq(cells[0].endsAt, cells[1].startsAt, "no gap between slots");
    eq(schedule(ch, 150_000, 160_000).length, 1, "a window inside one slot is one cell");
    eq(schedule(ch, 150_000, 160_000)[0].startsAt, 100_000, "and it starts before the window");

    // ── moments: a ring of windows into files ────────────────────────────────
    // The whole risk here is that `in` leaks into ring arithmetic in one place and
    // not the other: a slot that is 40 seconds long but seeks to 0, or one that
    // seeks correctly and holds the ring open for the film's full runtime.
    const hit = (name, start, end, extra = {}) =>
        ({ episode: vid(name, extra), start, end, text: `a thing at ${start}` });
    const mo = moments([
        hit("a.mp4", 100, 100),          // a scene row: no extent
        hit("a.mp4", 900, 900),          // same film, a different moment
        hit("b.mp4", 60, 80),            // an asr passage: 20s + lead
        hit("c.mp4", 30, 3000),          // 2970s — a programme, not a moment
        hit("paid.mp4", 10, 10, { url: undefined, resourceId: "0xfeed" }),
    ], { id: "m", title: "M", dur: 45, lead: 4, min: 8 });

    eq(mo.items.length, 4, "a moment inside an unplayable row is not a slot");
    const byIn = [...mo.items].sort((a, b) => a.in - b.in);
    eq(byIn.map((f) => f.in).join(","), "26,56,96,896", "every window backs up by the lead-in");
    eq(durOf(byIn[0]), 45, "a 2970s span is capped to one moment");
    eq(durOf(byIn[1]), 24, "an asr passage keeps its own extent");
    eq(durOf(byIn[2]), 45, "a zero-extent scene row gets the default window");
    eq(mo.total, 45 + 24 + 45 + 45, "the ring is the sum of the WINDOWS, not the runtimes");

    // Two moments from one film are two rows everywhere it counts — otherwise the
    // second is silently held out of the ring, and rating one rates both.
    ok(nodeKey(byIn[2]) !== nodeKey(byIn[3]), "two moments from one file are two keys");
    eq(nodeKey(vid("a.mp4")), "0x1:tv/show/a.mp4", "a plain file's key is untouched");

    // Seeking is the half that has no visible symptom until someone watches it:
    // the ring says slot 2, and the player must open the film 896 seconds in.
    const m0 = airing(mo, 0);
    eq(m0.offset, inOf(m0.item), "a slot starts at its own cut point, not at zero");
    eq(airing(mo, 10_000).offset, inOf(m0.item) + 10, "and runs forward from there");
    eq(airing(mo, (durOf(m0.item) - 1) * 1000).item, m0.item, "…up to the last second of the window");
    eq(airing(mo, durOf(m0.item) * 1000).item, mo.items[1], "then hands over to the next moment");
    eq(schedule(mo, 0, mo.total * 1000).length, 4, "a lap of the ring is four cells");

    // Real subtitle starts are fractional. A fractional slot length makes
    // schedule()'s walk land back inside the slot it just left, and the guide
    // renders one cell over and over until its cap — which is what shipped.
    const frac = moments([hit("a.mp4", 100.04, 100.04), hit("b.mp4", 2472.04, 2481.62),
        hit("c.mp4", 51.7, 51.7)], { id: "f", title: "F" });
    ok(frac.items.every((f) => Number.isInteger(f.in) && Number.isInteger(durOf(f))),
        "fractional cue times still make whole-second slots");
    const walked = schedule(frac, 0, frac.total * 1000);
    eq(walked.length, 3, "a fractional ring still walks forward");
    eq(new Set(walked.map((c) => c.item.in)).size, 3, "…onto a different slot each time");
    ok(slotLabel(byIn[3]).startsWith("14:56 "), `a moment cell says where it is: ${slotLabel(byIn[3])}`);
    eq(slotLabel(vid("a.mp4")), "a.mp4", "a file cell does not");

    // ── program: the same ring, in the order it was written ──────────────────
    // The one property this has that moments() must not: authored order survives.
    // If it ever shuffles, the cut stops being a story and nobody can tell from
    // the guide — every cell still looks right, in the wrong sequence.
    const pg = program([
        { file: vid("c.mp4"), start: 90, dur: 11, note: "the order" },
        { file: vid("a.mp4"), start: 78.9, dur: 10, note: "the crime" },
        { file: vid("b.mp4"), start: 91.5, dur: 12, note: "the accusation" },
        { file: vid("paid.mp4", { url: undefined, resourceId: "0xfeed" }), start: 5, dur: 5 },
    ], { id: "p", title: "P" });

    eq(pg.items.length, 3, "a shot in an unplayable row is not a slot");
    eq(pg.items.map((f) => f.in).join(","), "90,79,92", "shots play in the order they were written");
    eq(pg.items.map((f) => f.desc).join(","), "the order,the crime,the accusation", "each slot says what it is");
    ok(pg.items.every((f) => Number.isInteger(f.in) && Number.isInteger(durOf(f))),
        "fractional shot times still make whole-second slots");
    eq(pg.total, 11 + 10 + 12, "the ring is the sum of the shots");
    eq(airing(pg, 0).offset, 90, "the first slot opens at its own cut point");
    eq(airing(pg, 11_000).item.in, 79, "and hands over to the NEXT shot, not a shuffled one");
    eq(schedule(pg, 0, pg.total * 1000).map((c) => c.item.in).join(","), "90,79,92",
        "the guide reads the programme in order too");

    // A single bad duration would otherwise drag every later cell with it.
    const bad = channel("b", "show", "B", [vid("junk.mp4", { duration: 575_848_022 }), vid("d.mp4")]);
    eq(bad.total, FALLBACK + 100, "a garbage duration falls back");
    eq(durOf({ duration: 0 }), FALLBACK, "so does zero");
    eq(durOf({}), FALLBACK, "and absent");
    eq(airing(channel("e", "show", "E", []), 0), null, "an empty channel is off air");

    // Lineup: what makes a channel, and what doesn't.
    const eps = Array.from({ length: 6 }, (_, i) => vid(`S01E0${i + 1}.mp4`));
    const paid = vid("paid.mp4", { url: undefined, resourceId: "0xdead" });
    const rows = lineup([...eps, paid, vid("lonely.mp4", { dir: "other", path: "other/lonely.mp4" })]);
    eq(rows.length, 1, "six episodes are a channel; one stray file is not");
    eq(rows[0].items.length, 6, "and the paid row never joins it");
    eq(rows[0].number, 1, "channels are numbered");

    // Aisles come from genres.js labels, and the shuffle must be reproducible.
    const many = Array.from({ length: 8 }, (_, i) => vid(`m${i}.mp4`, { dir: `d${i}`, path: `d${i}/m${i}.mp4` }));
    const labels = new Map(many.map((f) => [nodeKey(f), "Comedy Movies"]));
    const one = lineup(many, labels), two = lineup(many, labels);
    eq(one.length, 1, "eight labelled files are an aisle");
    eq(one[0].items.map((f) => f.name).join(), two[0].items.map((f) => f.name).join(),
        "the shuffle is a function of the seed, not of luck");
    if (one[0].items.map((f) => f.name).join() === many.map((f) => f.name).join()) {
        throw new Error("an aisle that comes back in catalog order was not shuffled");
    }
    eq(lineup(many, labels, { minItems: 9 }).length, 0, "under the floor is not an aisle");

    // Straight off the crawl: a folder called "-" is a show with 22 episodes.
    const junk = Array.from({ length: 6 }, (_, i) => vid(`e${i}.mp4`, { dir: "-", path: `-/e${i}.mp4` }));
    eq(lineup(junk).length, 0, "a channel with no readable name is not a channel");

    // Straight off the crawl. The first two are the whole reason this exists.
    eq(slotLabel({ name: "S02E07 - (NKIRI.COM).mp4", season: 2, episode: 7 }), "S2E7", "a name that is only junk becomes its number");
    eq(slotLabel({ name: "S01E01 - (NKIRI.COM).nciodsncisdncoisdnocisncdcin.mp4", season: 1, episode: 1 }),
        "S1E1", "including the second extension nobody meant to publish");
    eq(slotLabel({ name: "S01E04 - The Execution.mp4", season: 1, episode: 4 }), "S1E4 · The Execution", "a real title survives");
    eq(slotLabel({ name: "S01E14 - 3, 2, 1 Let's Go!.mp4", season: 1, episode: 14 }), "S1E14 · 3, 2, 1 Let's Go!",
        "and so does one that is mostly digits");
    eq(slotLabel({ name: "Airplane.mp4" }), "Airplane", "a film keeps its name");
    eq(slotLabel({ name: "1977.mp4" }), "1977.mp4", "nothing readable to shorten to: leave it alone");
    eq(slotLabel({ name: "ChamberOfHorrors.mp4", season: NaN, episode: NaN }), "ChamberOfHorrors",
        "a NaN episode is a film, not episode NaN");
    eq(slotLabel({ name: "The Vampire.mp4", season: NaN, episode: 5 }), "S1E5 · The Vampire",
        "and a NaN season falls back to one rather than poisoning a real episode");
    eq(slotLabel({ name: "ocw-6.450-f06-2003-09-03_220k.mp4" }), "ocw 6 450 f06 2003 09 03 220k",
        "a trailing run WITH digits is a date or a code, not a release tag");

    // ── tuned channels: the ring is generated, the schedule still isn't fetched ──
    const M = 300;
    const gen = Array.from({ length: M }, (_, i) =>
        vid(`g${i}.mp4`, { dir: `g${i}`, path: `g${i}/g${i}.mp4`, duration: 1800, i }));
    const gvecs = new Map(gen.map((f) => {
        const th = (2 * Math.PI * f.i) / M;
        return [nodeKey(f), [Math.cos(th), Math.sin(th)]];
    }));
    const spec = { id: "tune:rainy", title: "Rainy Cyberpunk", q: [1, 0], seed: "rainy cyberpunk" };
    const tv = tuned(spec, gen, gvecs);

    eq(tv.kind, "walk", "a tuned channel is its own kind");
    eq(tv.total, BLOCK, "its lap is the block, not a playlist length");
    ok(tv.block(0).total >= BLOCK, "a block is generated to FILL its span, not to fit in it");

    // Random never hands back the channel you are on — that reads as a dead button.
    const deck = [{ id: "a" }, { id: "b" }, { id: "c" }];
    for (let i = 0; i < 50; i++) ok(randomChan(deck, "b").id !== "b", "random skips the current channel");
    ok(randomChan([{ id: "only" }], "only").id === "only", "a one-channel deck still answers");
    ok(randomChan([], null) === null, "an empty deck answers null, not undefined");
    eq(tv.block(0).items.map((f) => f.i).join(), tuned(spec, gen, gvecs).block(0).items.map((f) => f.i).join(),
        "two viewers, same spec, same block — this is the whole premise");
    ok(tv.block(0).items.map((f) => f.i).join() !== tv.block(1).items.map((f) => f.i).join(),
        "and it reshuffles on the six, or it is a playlist");
    ok(tv.block(0).items.every((f) => Math.min(f.i, M - f.i) < M / 4),
        "a tuned channel must stay in the neighbourhood it was tuned to");

    // The clock indexes it exactly as it indexes a ring.
    const t0 = airing(tv, 0);
    eq(t0.offset, 0, "the epoch is the top of block 0");
    eq(t0.item.name, tv.block(0).items[0].name, "and the top of block 0 is the walk's first item");
    eq(airing(tv, 1000 * 1799).item.name, t0.item.name, "still in the first slot one second before it ends");
    eq(airing(tv, 1000 * 1800).item.name, tv.block(0).items[1].name, "and the second slot after it");
    eq(airing(tv, -1000).item.name, tv.block(-1).items.at(-1).name ?? "", "before the epoch is the tail of block -1")

    // schedule() walks by feeding endsAt back in, so the block seam is where an
    // off-by-one turns into an infinite loop or a gap in the guide.
    const grid = schedule(tv, 0, (BLOCK + 3 * 3600) * 1000, 40);
    ok(grid.length > 12, "the grid must cross the seam, not stop at it");
    for (let i = 1; i < grid.length; i++) eq(grid[i - 1].endsAt, grid[i].startsAt, `no gap or overlap at cell ${i}`);
    const seam = grid.find((c) => c.endsAt === BLOCK * 1000);
    ok(seam, "a slot must end exactly on the block edge");
    eq(airing(tv, seam.endsAt).offset, 0, "and the next block starts at offset 0");
    eq(airing(tv, seam.endsAt).item.name, tv.block(1).items[0].name, "with the next block's first item");

    // A neighbourhood of two still fills six hours — walk.js shrinks its
    // no-repeat window rather than running dry, so a thin channel alternates
    // instead of going off air.
    const thin = tuned({ ...spec, poolSize: 2 }, gen, gvecs);
    eq(new Set(thin.block(0).items.map((f) => f.i)).size, 2, "a two-row pool is a two-row channel");
    ok(thin.block(0).total >= BLOCK, "and it still fills its block");
    ok(airing(thin, (BLOCK - 60) * 1000), "so it is on air at the end of one");

    // The other way out: a block that came back SHORT (walk.js's hard `max`, i.e.
    // a neighbourhood of very short clips) laps inside its own block. Stubbed,
    // because reaching it through tuned() needs 4096 real rows.
    const short = { total: BLOCK, block: () => ({ items: [vid("s.mp4", { duration: 600 })], total: 600 }) };
    const late = airing(short, (BLOCK - 300) * 1000);
    ok(late, "a short block laps rather than going off air");
    eq(late.offset, 300, "half way through its tenth lap");
    eq(late.endsAt, BLOCK * 1000, "and its last lap is still cut at the block edge");

    // Same exclusions as lineup(): nothing that stops to charge you, nothing a
    // <video> won't take.
    const withPaid = tuned(spec, [...gen, vid("paid.mp4", { url: undefined, resourceId: "0xdead", i: 0 })], gvecs);
    ok(!withPaid.block(0).items.some((f) => f.name === "paid.mp4"), "a paid row never joins a tuned channel");
    eq(tuned(spec, gen, new Map()).block(0).items.length, 0, "no vectors is no channel, not a wrong one");
    eq(airing(tuned(spec, gen, new Map()), 0), null, "and an unvectorised channel is off air");

    // Sharing: the spec survives the round trip, and a mangled link is refused
    // rather than quietly becoming a different channel.
    {
        const q = Float32Array.from({ length: 16 }, (_, i) => (i % 5 - 2) / 3);
        const spec = { title: "rainy cyberpunk", seed: "rainy cyberpunk", q, temp: 0.8, anchor: 0.3 };
        const back = unpackChan(packChan(spec));
        eq(back.title, "rainy cyberpunk", "title round trips");
        eq(back.seed, "rainy cyberpunk", "seed defaults to the title");
        eq(back.temp, 0.8, "temp round trips");
        eq(back.anchor, 0.3, "anchor round trips");
        eq(back.q.length, 16, "vector round trips at length");
        ok(back.q.every((v, i) => Math.sign(v) === (q[i] < 0 ? -1 : 1)), "vector round trips by sign");
        // The vector itself carries no + or / — URLSearchParams would percent-encode
        // them and the link would triple in length for no reason.
        const v = new URLSearchParams(packChan(spec)).get("b");
        ok(!/[+/=]/.test(v), "packed vector is url-safe");
        // The point of the sign encoding: a link a person can paste. 256 dims is
        // the real corpus, and it must stay well under a wrapped line.
        const big = { title: "x", q: Float32Array.from({ length: 256 }, (_, i) => Math.sin(i)) };
        ok(chanLink(big, "https://sond3r.xyz/").length < 100,
            `a 256-d channel link stays short, got ${chanLink(big, "https://sond3r.xyz/").length}`);
        // Links already sent carry the old int8 `v` and must still open.
        const legacy = unpackChan(`v=${packVec(q).replace(/\+/g, "-").replace(/\//g, "_")}&t=old`);
        eq(legacy.title, "old", "an int8 link still opens");
        eq(legacy.q.length, 16, "and still decodes its vector");
        ok(chanLink(spec, "https://x/y?z=1#old").startsWith("https://x/y?z=1#"), "link replaces the fragment");
        eq(unpackChan(""), null, "an empty fragment is not a channel");
        eq(unpackChan("t=hi"), null, "a fragment with no vector is not a channel");
    }

    // A catalog channel shares as its row, not as a vector.
    {
        const row = { id: "show:wonder-showzen", title: "Wonder Showzen", items: [] };
        const link = linkFor(row, "https://sond3r.xyz/#whatever");
        const back = unpackRow(link.split("#")[1]);
        eq(back.id, "show:wonder-showzen", "the row id round trips");
        eq(back.title, "Wonder Showzen", "with its title as the fallback match");
        eq(unpackRow("b=abc&t=x"), null, "a tuned link is not a row");
        eq(unpackChan(packRow(row)), null, "and a row link is not a tuned channel");
        ok(linkFor({ spec: { title: "t", q: new Float32Array(8) } }, "https://x/").includes("#b="),
            "a tuned channel still packs its spec");
    }

    console.log("channels.js self-check ok — ring arithmetic, wrap, bad durations, lineup, slot labels, tuned blocks, share round trip, catalog row links, random pick");
}
