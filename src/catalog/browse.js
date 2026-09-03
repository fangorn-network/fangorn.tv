// What the viewer renders, derived from the catalog rather than mirroring it.
//
// The old storefront drew the publisher's tree verbatim: every folder expanded,
// every file on screen at once, no matter how many there were. That's the right
// shape for the person who UPLOADED the files and the wrong one for everyone
// else — a buyer arriving cold has no idea what "s5" is, and 400 cards of it is
// not a storefront.
//
// So the tree becomes two things instead:
//   · shelves — a generated front page. Which shelves exist, and in what order,
//     depends on the catalog's size and on what this browser has opened before.
//   · a location — one folder at a time, reachable by drilling in, with a
//     breadcrumb back. Nothing below the current level is drawn.
//
// The ranking signal is the shard's own embeddings (see search.js `fileVectors`).
// The model is already downloaded for search, the vectors are already in the
// 25 KB shard every viewer fetches, and the history never leaves localStorage —
// so "more like this" costs a pass over a few thousand 256-float rows and no
// network, no server, and nothing to opt out of.

import { cosine, rank, session, topics } from "../geometry/kernel.js";
import { packVec } from "../llm/embed.js";
import { probeShelves } from "../geometry/probes.js";

const HISTORY_KEY = "sond3r:opened";
const HISTORY_MAX = 40;

export const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Stable identity for anything in the catalog. The resourceId when there is one;
 * otherwise `owner:path`, which is what a catalog entry has instead.
 *
 * A free entry has no resourceId, and keying on a bare `node.resourceId` would
 * collapse every one of them onto the same `undefined` — one open would mark all
 * of them open, and the whole free half of a catalog would count as a single
 * item to the session kernel. Two publishers can hold the same relpath, so the
 * owner is part of the key for the same reason the shard namespaces its rows.
 */
// A MOMENT row (channels.js `moments()`) is the same file with an `in`/`out`
// window on it, and two moments cut from one film are two different things to
// rate, to hold out of a walk's no-repeat window, and to key a <video> on. One
// suffix here rather than a moment-aware key at each of those call sites — and a
// row with no `in` still hashes to exactly the bytes it always did.
export const nodeKey = (n) => ((n?.resourceId ?? `${n?.owner ?? ""}:${n?.path ?? ""}`)
    + (n?.in > 0 ? `#t=${n.in}` : "")).toLowerCase();
const rid = nodeKey;

// ── type ──────────────────────────────────────────────────────────────────────
// What a file IS, is a fact about the bytes — not something to infer. The mime is
// already on every node, and the extension covers the case where the relay's mime
// table shrugs and returns application/octet-stream (which is every .exe).
//
// Deliberately NOT the embedder's job. "Audius Setup 1.5.156.exe" carries almost
// no semantic content, so cosine against "software" is a coin flip, whereas the
// extension answers exactly. A model here would be slower, larger and wronger.
const KIND_EXT = {
    software: "exe msi dmg pkg deb rpm appimage apk jar bat sh ps1",
    archives: "zip tar gz tgz bz2 xz 7z rar iso",
    documents: "pdf doc docx odt rtf txt md epub csv xls xlsx ppt pptx",
};

// The same shrug, for the OTHER question: not "what category is this" but "what
// Content-Type do I hand the browser". A pointer that says application/octet-stream
// for an .mp4 is unplayable twice over — <video> is never chosen for it, and even
// forced, a blob typed octet-stream won't decode. Pointers predate the mime table,
// come from a publisher's stale commit, or from a relay whose table shrugged, so
// the extension is the backstop everywhere the bytes reach a media element.
const EXT_MIME = {
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
    pdf: "application/pdf",
};

const extOf = (name = "") => {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The Content-Type to actually use for a node: its own mime when that says
 *  something, the extension's when it shrugs. Every path that renders or decrypts
 *  bytes goes through this — Media picks the element with it, purchase.js types
 *  the blob and the stream descriptor with it. */
export const mimeFor = ({ mime = "", name = "" } = {}) =>
    (mime && mime !== "application/octet-stream" ? mime : EXT_MIME[extOf(name)] ?? mime);

// How many of a shelf's items a CAROUSEL shows before "Show all". The rows below
// carry every item they matched — truncating the data was how a shelf that said
// "412 files" opened onto a page with eight on it. The view decides how many to
// draw; this is only the number it starts with.
const TILES = 8;

const LABEL = {
    music: "Music", video: "Video", images: "Images", articles: "Articles",
    documents: "Documents", software: "Software", archives: "Archives",
    other: "Everything else",
};

export function kindOf(node = {}) {
    const mime = mimeFor(node);
    switch (mime.split("/")[0]) {
        case "audio": return "music";
        case "video": return "video";
        case "image": return "images";
        // An article is not a "document" in the download-it sense — it is a thing
        // to read in place, and the front page groups it as such.
        case "text": return mime === "text/plain" ? "documents" : "articles";
    }
    if (mime === "application/pdf") return "documents";
    const ext = extOf(node.name ?? "");
    for (const kind in KIND_EXT) if (ext && KIND_EXT[kind].split(" ").includes(ext)) return kind;
    return "other";
}

// The words someone actually types when they mean a category. Typing one of them
// filters instead of searching: it's an exact answer, available with no shard, no
// model and no embeddings baked — "software" shows the .exe, today, on a library
// that has never been embedded.
const ALIASES = {
    software: "software app apps application applications program programs exe executable executables installer binary",
    music: "music audio song songs track tracks album albums sound sounds",
    video: "video videos movie movies film films clip clips episode episodes show",
    images: "image images picture pictures photo photos art artwork",
    documents: "document documents doc docs pdf pdfs book books text paper papers",
    archives: "archive archives zip zips backup backups",
};

/** The category a query IS, or null if it's a real search. Only ever matches a
 *  query that is exactly one alias word — "software licensing agreement" is a
 *  search for a document, not a request for every .exe. */
export const kindForQuery = (q) => {
    const s = q.trim().toLowerCase();
    return Object.keys(ALIASES).find((k) => ALIASES[k].split(" ").includes(s)) ?? null;
};

/** Categories present in this catalog, most files first. A category nobody has
 *  published is not a filter, it's a dead end. */
export function kinds(files) {
    const n = new Map();
    for (const f of files) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
}

/** Every sellable file in the catalog, flat, each tagged with the top-level
 *  folder it lives under. `owner` already rides on the node from the shard. */
export function flatten(tree, owner = null, out = []) {
    for (const n of tree ?? []) {
        const o = n.owner ?? owner;
        if (n.type === "folder") flatten(n.children, o, out);
        else out.push({ ...n, owner: o, dir: parentOf(n.path), top: n.path.split("/")[0], kind: kindOf(n) });
    }
    return out;
}

/** One level of the hierarchy: the folders directly under `dir`, and the files
 *  directly in it. Scoped to one publisher, because two publishers may hold the
 *  same relpath and merging them would put someone else's files in your folder. */
export function levelAt(files, { owner, dir }) {
    const here = files.filter((f) => f.owner === owner);
    const prefix = dir ? `${dir}/` : "";
    const folders = new Map();
    const inDir = [];
    for (const f of here) {
        if (dir && !f.path.startsWith(prefix)) continue;
        const rest = f.path.slice(prefix.length);
        if (!rest.includes("/")) { inDir.push(f); continue; }
        const name = rest.slice(0, rest.indexOf("/"));
        const path = prefix + name;
        const cur = folders.get(path) ?? { type: "folder", name, path, owner, count: 0, kinds: new Set() };
        cur.count++;
        cur.kinds.add((f.mime ?? "").split("/")[0]);
        folders.set(path, cur);
    }
    return {
        folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
        files: inDir.sort((a, b) => a.name.localeCompare(b.name)),
    };
}

// FNV-1a. Not a hash for security, a hash for *stability*: the same string must
// give the same number in every tab, forever, so that a colour, a shuffle or a
// schedule built from it agrees with itself across viewers and reloads.
export const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** Playable in a run: something a <video>/<audio> element can actually take.
 *  A season folder holds a cover image and a nfo alongside the episodes, and a
 *  channel is ranked over everything published — neither belongs in a queue that
 *  advances by itself. */
export const inRun = (f) => !f?.shelf && /^(video|audio)\//.test(mimeFor(f) || "");

// Episode 2 before episode 10. localeCompare's default is lexicographic, which
// puts "E10" between "E1" and "E2" — the one thing a season queue must not do.
const ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Running order for two episodes of the same thing: the publisher's own
 *  numbering when they committed one, the numeric filename collation otherwise.
 *  Shared by run() and by the search results, which group a series into one hit
 *  and have to pick which episode that hit points at. */
export const byEpisode = (a, b) =>
    (Number(a.season ?? 0) - Number(b.season ?? 0)) ||
    (a.episode != null && b.episode != null
        ? Number(a.episode) - Number(b.episode)
        : ORDER.compare(a.name ?? "", b.name ?? ""));

/**
 * Where an untagged file sits in a show, read off its name.
 *
 * The tagged catalog is the easy half: a publisher who committed
 * `series`/`season`/`episode` has already answered this. Most of the wild is not
 * tagged — it is `Code Lyoko/Season 1/S01E11 - Plagued.mp4`, and on a shelf that
 * became eleven cards all called S01E__. So the name is parsed, but ONLY for the
 * two markers that are unambiguous:
 *
 *   S01E11, s1.e11, 1x11   → season and episode
 *   E11, Ep 11, Episode 11 → episode, season unknown
 *
 * Deliberately nothing looser. "Part 2", a bare leading number, a date — all of
 * them match films, lectures and live sets as readily as episodes, and folding a
 * folder of unrelated movies into one card is a worse failure than not folding a
 * show. A folder only becomes a show when TWO of its files carry a marker.
 */
const SXXEXX = /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?![0-9])/i;
const NxNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?![0-9])/i;
const EPNUM = /(?:^|[^a-z0-9])(?:ep?|episode)[\s._-]*(\d{1,3})(?![0-9])/i;

export function episodeOf(name = "") {
    const m = SXXEXX.exec(name) ?? NxNN.exec(name);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
    const e = EPNUM.exec(name);
    return e ? { season: null, episode: Number(e[1]) } : null;
}

// `Season 1`, `S02`, `Series 3`, `Temporada 4` — a folder that is a SEASON, not a
// show. The show is then its parent: `Code Lyoko/Season 1` is Code Lyoko.
const SEASON_DIR = /^(?:s|se|season|series|temporada|staffel|saison)[\s._-]*(\d{1,2})$/i;

/**
 * The show a file belongs to: `{ key, title, season, episode }`, or null.
 *
 * Two catalogs, one answer. A tagged file uses what the publisher wrote. An
 * untagged one is placed by its folder — with the season folder skipped, because
 * a viewer looking for Code Lyoko is not looking for four things called Season 1.
 * The season number survives as a division INSIDE the show's page.
 */
export function showOf(f) {
    if (!f) return null;
    if (f.series) {
        return {
            key: `${f.owner ?? ""}:${f.series}`.toLowerCase(),
            title: f.series, season: f.season ?? null, episode: f.episode ?? null,
        };
    }
    const ep = inRun(f) ? episodeOf(f.name ?? "") : null;
    // `dir` is put on by flatten(), but a search hit is a raw shard row and never
    // went through it — derive rather than return null, or the same show groups on
    // the front page and doesn't in the results.
    const dir = f.dir ?? parentOf(f.path ?? "");
    if (!ep || !dir) return null;
    const parts = dir.split("/");
    const sd = SEASON_DIR.exec(parts.at(-1) ?? "");
    return {
        key: `${f.owner ?? ""}:dir:${parts.slice(0, sd && parts.length > 1 ? -1 : parts.length).join("/")}`.toLowerCase(),
        title: pretty(parts[sd && parts.length > 1 ? parts.length - 2 : parts.length - 1]),
        season: ep.season ?? (sd ? Number(sd[1]) : null),
        episode: ep.episode,
    };
}

/** What a SHOW is called, as a grouping key — the season is deliberately not in
 *  it. A show with four seasons is one thing to a viewer; keying by season put
 *  it on the shelf four times, once per season, which is the duplicate everybody
 *  saw. Seasons are a level *inside* the series page (see seriesShelves), not
 *  four separate shows. null when nothing identifies a show. */
export const seriesKey = (f) => showOf(f)?.key ?? null;

// `classic_tv_1980s` is a storage key, not a name. Nobody typed it for a reader,
// so unpick it for one: separators become spaces, words get a capital, and the
// handful of initialisms that would come out looking silly stay upper.
const CAPS = new Set(["tv", "dvd", "hd", "uhd", "sd", "bbc", "pbs", "nasa", "us", "uk", "usa", "ost", "ep", "vhs", "3d"]);
export const pretty = (s = "") => s.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").map((w) => (CAPS.has(w.toLowerCase()) ? w.toUpperCase() : (w[0]?.toUpperCase() ?? "") + w.slice(1))).join(" ");

/** The run `node` belongs to: its season, in the order it should play.
 *
 *  Two catalogs in one function, because both exist in the wild:
 *
 *   · A publisher who tagged episodes committed `series`/`season`/`episode` to
 *     the shard. Then the run is that series+season and the order is the number
 *     they published, not a guess — which is the only version that survives a
 *     file named "[Christaras] Digimon Adventure GREEK Blu Ray Box.mp4".
 *   · Everyone else: a season IS a folder, ordered by filename with a NUMERIC
 *     collator so E2 comes before E10.
 *
 *  Scoped to one publisher either way, for the same reason levelAt is: two of
 *  them can hold the same relpath.
 *  ponytail: one season per run — S01 and S02 stay separate, and a series with
 *  no season tag is one run. Stitch them when someone asks to binge a whole show. */
export function run(files, node) {
    if (!node || !inRun(node)) return [];
    const tagged = node.series != null && node.episode != null;
    const same = (f) => f.owner === node.owner && inRun(f) && (tagged
        ? f.series === node.series && String(f.season ?? "") === String(node.season ?? "") && f.episode != null
        : f.dir === node.dir);
    const items = files.filter(same).sort(byEpisode);
    return items.length > 1 ? items : [];
}

/** Every show in the catalog, as a shelf — the same {id,title,items,why} shape
 *  shelves() emits, so wiki.jsx's ListPage draws a series page with no new view.
 *
 *  One episode is not a show: a folder holding a single S01E01 is a file.
 */
export function seriesShelves(files) {
    const by = new Map();
    for (const f of files) {
        const sh = showOf(f);
        if (!sh) continue;
        let g = by.get(sh.key);
        if (!g) by.set(sh.key, (g = { title: sh.title, items: [], at: new Map() }));
        g.items.push(f);
        g.at.set(nodeKey(f), sh);
    }
    return [...by.entries()]
        .filter(([, g]) => g.items.length > 1)
        // Season, then episode, then the numeric name collation — the parsed
        // numbers, not the tag fields, so an untagged show orders correctly too.
        .map(([id, g]) => shelfOfSeries(id, g.items.sort((a, b) => {
            const x = g.at.get(nodeKey(a)), y = g.at.get(nodeKey(b));
            return (Number(x.season ?? 0) - Number(y.season ?? 0))
                || (Number(x.episode ?? 0) - Number(y.episode ?? 0))
                || ORDER.compare(a.name ?? "", b.name ?? "");
        }), g))
        .sort((a, b) => a.title.localeCompare(b.title));
}

/** One show, as a shelf — the same {id,title,items,why} shape shelves() emits,
 *  so wiki.jsx's ListPage draws a series page with no new view.
 *
 *  `seasons` is the middle shell: [{season, items}] whenever the publisher tagged
 *  more than one, so the page reads season 1 / season 2 instead of one 96-item
 *  wall. One season means there is nothing to divide, and the field is absent.
 *
 *  `node` is what the show looks like on a carousel: a file-shaped object so
 *  FileCard draws it with no branch, carrying the shelf so a click opens the show
 *  rather than buying episode one. */
function shelfOfSeries(id, items, g) {
    const seasons = new Map();
    for (const f of items) {
        const s = g.at.get(nodeKey(f))?.season ?? "";
        if (!seasons.has(s)) seasons.set(s, []);
        seasons.get(s).push(f);
    }
    const n = seasons.size;
    const why = `${items.length} episodes${n > 1 ? ` · ${n} seasons` : ""}`;
    const sh = {
        id, title: g.title, owner: items[0].owner, items, why,
        seasons: n > 1 ? [...seasons.entries()].map(([season, its]) => ({ season, items: its })) : null,
        peek: items.filter((f) => f.thumb).slice(0, 4),
    };
    // The card. A file-shaped object so FileCard draws it with no branch, named
    // for the SHOW — the thing that was wrong was eleven cards called S01E__ —
    // and carrying the shelf, so a click opens the show rather than episode one.
    sh.node = {
        ...items[0], name: sh.title, why, shelf: sh, kind: "video",
        thumb: sh.peek[0]?.thumb, resourceId: undefined, size: 0,
    };
    return sh;
}

/**
 * The episode to play when someone presses play on a SHOW: the first one this
 * browser has not finished. Falls back to the first episode — a show you have
 * watched to the end starts again at the beginning rather than refusing.
 */
export function nextUp(shelf, seen = watched()) {
    const items = (shelf?.items ?? []).filter(inRun);
    return items.find((f) => !isWatched(f, seen)) ?? items[0] ?? null;
}

/** Every shelf row, with each show folded down to one card.
 *
 *  A shelf is built out of FILES, and a 96-episode show is 96 of them — which is
 *  how a "Comedy" row ended up being one sitcom eight times over. Folding happens
 *  once, here, over the finished shelves, so every row on the front page and every
 *  page they open through gets it: rank first, then collapse, so the show's place
 *  in the row is still the best episode's place.
 */
export function foldSeries(rows, index) {
    if (!index.size) return rows;
    return rows.map((r) => {
        if (!r.items?.length) return r;
        const out = foldItems(r.items, index);
        return out.length === r.items.length ? r : { ...r, items: out };
    });
}

/** One list, with each show folded down to its single card. Exported on its own
 *  because the picks row is built by mirror(), not by shelves() — and a pick has
 *  to be a show or a film, never episode 11 of one. */
export function foldItems(items, index) {
    if (!index?.size) return items;
    const out = [], seen = new Set();
    for (const f of items) {
        const k = seriesKey(f);
        const sh = k && index.get(k);
        if (!sh) { out.push(f); continue; }
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(sh.node);
    }
    return out;
}

/** seriesShelves() as a lookup, for foldSeries. */
export const seriesIndex = (rows) => new Map(rows.map((s) => [s.id, s]));

// ── the local signal ──────────────────────────────────────────────────────────
// Nothing here is sent anywhere. It exists so the second visit is not identical
// to the first.

export function recall() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
}

/** Newest first, deduped by node key — re-opening something moves it up rather
 *  than filling the history with one file. Catalog entries are remembered too:
 *  opening a free entry is exactly the signal the session kernel needs, and on a
 *  corpus that is mostly free entries it is the ONLY signal there is.
 *
 *  `vec` is the row's own vector, STORED WITH THE ENTRY rather than looked up
 *  later. That is what makes the session portable across apps: a resourceId only
 *  means something inside the index it came from, so a history of ids is dead the
 *  moment you switch views — but a 256-d nomic vector means the same thing in every
 *  app that embeds with the same model. The kernel then runs on your history alone,
 *  and where you were heading in one app is still where you're heading in the next.
 *
 *  Packed int8 (~344 chars), so 40 entries is ~14 KB of localStorage. It never
 *  leaves the browser — same as the rest of this file.
 *
 *  `app` is which app it was opened in, and exists only so the UI can SAY that a
 *  shelf was informed by another app. Drifting somewhere you can't account for is
 *  unsettling; naming the source is the difference between spooky and useful. */
export function remember(node, vec = null, app = null, r = undefined) {
    if (!node?.resourceId && !node?.path) return recall();
    const was = recall();
    const prev = was.find((h) => h.resourceId === rid(node));
    const entry = {
        resourceId: rid(node), owner: node.owner, top: node.path?.split("/")[0],
        mime: node.mime, at: Date.now(),
        // A rating survives a later plain open: pressing 👎 and then clicking the
        // row again must not quietly clear the 👎. An explicit `r` (0 to clear)
        // wins; `undefined` means "not saying", so the old one carries forward.
        ...(((r === undefined ? prev?.r : r) || 0) ? { r: r === undefined ? prev.r : r } : {}),
        ...(vec ? { v: packVec(vec) } : prev?.v ? { v: prev.v } : {}),
        ...(app ? { app } : prev?.app ? { app: prev.app } : {}),
    };
    const next = [entry, ...was.filter((h) => h.resourceId !== rid(node))].slice(0, HISTORY_MAX);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
}

/**
 * The explicit signal: 👍 / 👎 / neither.
 *
 * Until this existed the kernel only ever learned from an open, which is an
 * ambiguous signal — you clicked it, so you were curious, so it must be more of
 * what you want. There was no way at all to say "not this". A rating is one field
 * on the same history entry rather than a second store: it dedupes with the open,
 * it packs into the same ~14 KB, it crosses apps with the same vector, and there
 * is exactly one thing to clear.
 *
 * @param sign  1 like, -1 dislike, 0 clear. Pressing the button that is already
 *              lit clears it — the caller decides, `ratingOf` tells it which.
 */
export function rate(node, vec = null, app = null, sign = 0) {
    return remember(node, vec, app, sign);
}

/** What this browser said about a row last, as -1 | 0 | 1. */
export const ratingOf = (node, history = recall()) =>
    history.find((h) => h.resourceId === rid(node))?.r ?? 0;

// ── how far you got ──────────────────────────────────────────────────────────
// A scrobble, kept to one number. The history above is the SESSION signal (forty
// entries, each carrying a 256-d vector, feeding the kernel); this is the far
// dumber fact of "did I already watch this episode", which a 96-episode show
// needs and forty entries cannot hold. Separate key, separate cap, and the kernel
// never reads it.
const WATCH_KEY = "sond3r:watched";
const WATCH_MAX = 600;
// Below this a scrobble is an accident — a click, a preview, a file that opened
// and was closed. Above it the episode is done, whatever the credits do.
const STARTED = 0.02, DONE = 0.95;

/** nodeKey → [furthest fraction, seconds, when], for everything ever played.
 *  `when` is a millisecond timestamp, and it is the field that makes this
 *  mergeable: without it two browsers holding the same key have no way to say
 *  which one is later, so there is no "continue watching" ordered by recency and
 *  no story for handing this to anything else. Entries written before it existed
 *  are 2-tuples and read back as undefined, which is the correct "don't know". */
export function watched() {
    try { return JSON.parse(localStorage.getItem(WATCH_KEY) ?? "{}"); } catch { return {}; }
}

/** Record the play head. Monotone: it keeps the FURTHEST point reached, so
 *  rewinding to catch a line does not un-watch the episode, and a rewatch does
 *  not reset the tick until it passes where it got to before.
 *  ponytail: no per-session history, no timestamps. "How far did I get" is the
 *  question a list of episodes is asking; a viewing log is a different feature. */
export function watch(node, t, d) {
    if (!node || !(d > 30) || !(t >= 0)) return; // a 12-second clip has no progress
    const p = Math.min(1, t / d);
    const all = watched();
    const k = rid(node);
    if (p <= (all[k]?.[0] ?? 0)) return;
    all[k] = [Number(p.toFixed(3)), Math.round(t), Date.now()];
    // Oldest-inserted first out. JSON objects keep string-key insertion order, so
    // this is the same LRU the history has without a second structure to hold it.
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - WATCH_MAX))) delete all[old];
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(all)); } catch { /* full or blocked */ }
}

/** Where to drop the play head when this is opened again, or null. Not at the
 *  very start (nothing to resume) and not at the end (that is a rewatch, and
 *  landing on the credits is worse than landing at zero). */
export const resumeAt = (node, all = watched()) => {
    const [p, t] = all[rid(node)] ?? [];  // [, , when] is for callers that order by recency
    return p > STARTED && p < DONE ? t : null;
};

/** Watched enough to tick. */
export const isWatched = (node, all = watched()) => (all[rid(node)]?.[0] ?? 0) >= DONE;

export const forget = () => {
    try { localStorage.removeItem(HISTORY_KEY); localStorage.removeItem(WATCH_KEY); } catch { /* ignore */ }
};

/**
 * The generated front page.
 *
 * @param files        flatten(tree)
 * @param history      recall()
 * @param vectors      Map<resourceId, Float32Array> from fileVectors(); may be empty
 * @param precomputed  { groups, probes } — the two rows below that depend only on
 *                     (files, vectors) and not on history. Hand them in from a memo;
 *                     this function runs on every click and they do not change.
 * @returns [{ id, title, why, items }] — `why` is shown to the viewer, because a
 *          layout that rearranges itself without saying why is just unstable.
 */
export function shelves(files, history = [], vectors = new Map(), precomputed = {}) {
    if (!files.length) return [];

    // A catalog small enough to see all at once doesn't need to be broken up —
    // shelves over 9 files is ceremony around nothing.
    if (files.length <= 9) return [{ id: "all", title: "Everything published", why: null, items: files }];

    const out = [];
    const byId = new Map(files.map((f) => [rid(f), f]));
    const opened = history.map((h) => byId.get(h.resourceId)).filter(Boolean);
    const seen = new Set(opened.map(rid));

    if (opened.length) {
        out.push({ id: "again", title: "Open again", why: "", items: opened });
    }

    // Where the session is heading, not just where it has been — see kernel.js.
    // Only when the shard actually carries vectors; a lexical-only shard skips
    // this shelf rather than showing a "for you" row that is really "the first 12
    // files". A session that is moving gets the lookahead and says so; a single
    // open has no direction, so it's plain nearest-neighbours and reads as that.
    const state = session(history, vectors);
    if (state) {
        const near = rank(files.filter((f) => !seen.has(rid(f))), state, vectors, TILES);
        const moving = state.speed > 1e-6;
        const anchor = opened[0]?.name;
        // Where the session was BUILT, which is not necessarily where it is being
        // spent. A shelf here ordered by what you did in another app is the point of
        // the whole thing, and it is also the moment a viewer decides the page is
        // reading their mind — so say it out loud, with the app named.
        // An entry that carries a vector but is NOT in this catalog came from
        // somewhere else — that test needs no knowledge of which app is on screen.
        const elsewhere = [...new Set(
            history.filter((h) => h.v && h.app && !byId.has(h.resourceId)).map((h) => h.app),
        )];
        const from = elsewhere.length ? `, carried over from ${elsewhere.join(", ")}` : "";
        if (near.length >= 3) {
            out.push({
                id: "near",
                title: moving ? "Where you're heading" : "In the same vein",
                why: (moving ? "picked up from the last few you opened" : anchor && `close to ${anchor}`) + from,
                items: near,
            });
        }
    }

    // What the catalog is ABOUT — clusters of the shard's own vectors, named by
    // the words distinctive to each. The type sections below answer "what is this
    // file"; these answer "what is in here", which no mime table knows.
    // `groups` and `probes` are passed IN when the caller has them, because neither
    // depends on `history` — and this function re-runs on every open and every
    // 👍/👎. Recomputing k-means over the whole catalog on each click cost 719ms of
    // a 784ms click at 6,000 rows, which is a visible hitch on exactly the
    // interaction that is supposed to feel immediate. Measured, not guessed.
    for (const t of (precomputed.groups ?? topics(files, vectors))) {
        out.push({ id: t.id, title: t.title, why: `(${t.items.length})`, items: t.items });
    }

    // Then the rows that are a question rather than a bucket — "somebody explains
    // it properly" across every publisher at once. Topics are what this catalog
    // happens to contain; probes are things worth asking for whether or not
    // anyone published them, so they come second and stay silent when the answer
    // is no. See probes.js.
    out.push(...(precomputed.probes ?? probeShelves(files, vectors)));

    // Then the aisles — Comedy TV, Anime, Documentaries. Passed in (never derived
    // here) because they come from a cache plus an in-browser model, on the
    // viewer's schedule, not the catalog's. See genres.js.
    out.push(...(precomputed.genres ?? []));

    // Then the catalog itself, one section per type. What a thing IS is the
    // grouping a buyer arrives with — they know they want music long before they
    // know whose folder it came out of. Biggest section first.
    const byKind = new Map();
    for (const f of files) {
        if (!byKind.has(f.kind)) byKind.set(f.kind, []);
        byKind.get(f.kind).push(f);
    }
    const sections = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [k, items] of sections) {
        out.push({
            id: `kind:${k}`,
            title: LABEL[k] ?? k,
            why: items.length > TILES ? `${items.length} files` : null,
            items,
        });
    }

    // Folder browsing doesn't disappear behind the type sections: one shelf of
    // folder tiles at the end, ordered by how much of your history came out of
    // each, then by size. A collection whose files all sit at the root is not a
    // folder — there is nothing to drill into.
    const weight = new Map();
    for (const h of history) weight.set(`${h.owner}/${h.top}`, (weight.get(`${h.owner}/${h.top}`) ?? 0) + 1);

    const tops = new Map();
    for (const f of files) {
        const key = `${f.owner}/${f.top}`;
        if (!tops.has(key)) tops.set(key, []);
        tops.get(key).push(f);
    }
    const folders = [...tops.entries()]
        .filter(([, items]) => items.some((f) => f.dir))
        .sort((a, b) => (weight.get(b[0]) ?? 0) - (weight.get(a[0]) ?? 0) || b[1].length - a[1].length)
        .map(([key, items]) => {
            // A cover made of what's actually inside, and a count that says what
            // kind of thing that is — "1,415 files" tells a browser nothing.
            const n = new Map();
            for (const f of items) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
            const kinds = [...n].sort((a, b) => b[1] - a[1]).slice(0, 2)
                .map(([k, c]) => `${c.toLocaleString()} ${(LABEL[k] ?? k).toLowerCase()}`).join(" · ");
            return {
                path: items[0].top, name: items[0].top, owner: items[0].owner,
                count: items.length, key, kinds, peek: items.slice(0, 4),
            };
        });
    if (folders.length) out.push({ id: "folders", title: "Collections", why: null, items: [], folders });

    return out;
}

// ── self-check: `node src/catalog/browse.js` ─────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const file = (owner, path, mime = "video/mp4") => ({
        type: "video", owner, path, name: path.split("/").pop(), mime,
        resourceId: `0x${owner.slice(2)}:${path}`, // unique per (owner, path), like the real one
    });
    const tree = [
        { type: "folder", owner: "0xaaa", path: "Show", children: [
            { type: "folder", path: "Show/S1", children: [file("0xaaa", "Show/S1/a.mp4"), file("0xaaa", "Show/S1/b.mp4")] },
            file("0xaaa", "Show/trailer.mp4"),
        ] },
        { type: "folder", owner: "0xbbb", path: "Show", children: [file("0xbbb", "Show/a.mp4")] },
    ];

    // Type is a lookup, not a guess. The .exe case is the one that matters: the
    // relay's mime table shrugs at it, so only the extension knows.
    if (kindOf({ mime: "application/octet-stream", name: "Audius Setup 1.5.156.exe" }) !== "software") throw new Error("an .exe must be software even when the mime shrugs");
    if (kindOf({ mime: "audio/mpeg", name: "a.mp3" }) !== "music") throw new Error("mime wins when it says something");
    if (kindOf({ mime: "application/pdf", name: "x.pdf" }) !== "documents") throw new Error("pdf is a document");
    if (kindOf({ mime: "", name: "noextension" }) !== "other") throw new Error("an unknown file must be 'other', not a crash");
    if (kindOf({ mime: "", name: ".bashrc" }) !== "other") throw new Error("a dotfile has no extension to read");
    // The same shrug at the OTHER end: an .mp4 typed application/octet-stream must
    // still reach a <video> AND be handed to the blob/stream as video/mp4. Getting
    // this wrong is silent — the file downloads fine and simply refuses to play.
    if (mimeFor({ mime: "application/octet-stream", name: "FTTF5_EP_5.mp4" }) !== "video/mp4") throw new Error("a shrugged mime must fall back to the extension");
    if (kindOf({ mime: "application/octet-stream", name: "FTTF5_EP_5.mp4" }) !== "video") throw new Error("a shrugged .mp4 must still be video");
    if (mimeFor({ mime: "", name: "locura.mp3" }) !== "audio/mpeg") throw new Error("an absent mime must fall back to the extension");
    if (mimeFor({ mime: "image/png", name: "x.png" }) !== "image/png") throw new Error("a mime that says something must win");
    // A real octet-stream (no media extension) must stay one — the player's honest
    // "use save" branch is the right answer for a .gp5, not a forced <video>.
    if (mimeFor({ mime: "application/octet-stream", name: "Nocturne.gp5" }) !== "application/octet-stream") throw new Error("a genuinely opaque file must not be dressed up as media");
    if (mimeFor({}) !== "") throw new Error("an empty node must not crash the player");

    // Typing a category word IS the filter — no shard, no model, no embeddings.
    if (kindForQuery("software") !== "software") throw new Error("the example from the bug report must work");
    if (kindForQuery("  Apps ") !== "software") throw new Error("aliases must be case- and space-insensitive");
    if (kindForQuery("songs") !== "music") throw new Error("plural aliases must resolve");
    if (kindForQuery("software licensing agreement")) throw new Error("a real query must not be swallowed by the type filter");
    if (kindForQuery("")) throw new Error("a blank query is not a category");

    const files = flatten(tree);
    if (files.length !== 4) throw new Error(`flatten missed files: ${files.length}`);
    if (files.some((f) => f.kind !== "video")) throw new Error("flatten must tag every file with its kind");
    if (String(kinds(files)) !== "video,4") throw new Error(`kinds must count what's present: ${kinds(files)}`);
    if (files.some((f) => !f.owner)) throw new Error("owner must survive the flatten — it scopes every lookup below");
    if (files.find((f) => f.path === "Show/S1/a.mp4").top !== "Show") throw new Error("top-level folder not tagged");

    // Drill-down shows ONE level: the folder S1, and the file next to it. Not
    // S1's contents — that was the whole bug.
    const root = levelAt(files, { owner: "0xaaa", dir: "Show" });
    if (root.folders.length !== 1 || root.folders[0].path !== "Show/S1") throw new Error("folders at this level wrong");
    if (root.folders[0].count !== 2) throw new Error("folder count must be recursive");
    if (root.files.length !== 1 || root.files[0].name !== "trailer.mp4") throw new Error("only files IN the dir belong at this level");
    if (levelAt(files, { owner: "0xaaa", dir: "Show/S1" }).files.length !== 2) throw new Error("drilling in must reach the leaves");
    // Two publishers, same relpath: browsing one must never show the other's.
    if (levelAt(files, { owner: "0xbbb", dir: "Show" }).files.length !== 1) throw new Error("publishers' folders crossed over");

    // Small catalog: one shelf, no ceremony.
    const small = shelves(files);
    if (small.length !== 1 || small[0].id !== "all") throw new Error("a tiny catalog must not be split into shelves");

    const many = flatten([{ type: "folder", owner: "0xaaa", path: "Big", children:
        Array.from({ length: 14 }, (_, i) => file("0xaaa", `Big/f${i}.mp4`)) }]);
    const bulk = [...many, ...files];
    if (shelves(bulk).some((s) => s.id === "again")) throw new Error("no history must mean no history shelf");

    // History promotes the collection it came from, and never re-offers what you
    // already opened as a recommendation.
    const hist = [{ resourceId: many[0].resourceId.toLowerCase(), owner: "0xaaa", top: "Big", at: 1 }];
    const sh = shelves(bulk, hist);
    if (sh[0].id !== "again" || sh[0].items[0].path !== "Big/f0.mp4") throw new Error("opened-again shelf missing or wrong");
    // Everything here is video, so it's one section — and a lone section must not
    // hide files behind a cap nobody can lift.
    const vid = sh.find((s) => s.id === "kind:video");
    if (!vid) throw new Error("content must be sectioned by type");
    if (vid.items.length !== bulk.length) throw new Error("the only section must show everything it has");

    // Mixed types: one section each, biggest first, each carrying all of its own.
    const mixed = [...many, ...flatten([{ type: "folder", owner: "0xccc", path: "Docs",
        children: [file("0xccc", "Docs/a.pdf", "application/pdf")] }])];
    const ms = shelves(mixed).filter((s) => s.id.startsWith("kind:"));
    if (ms.map((s) => s.id).join() !== "kind:video,kind:documents") throw new Error(`sections must be biggest-first: ${ms.map((s) => s.id)}`);
    // Rows carry EVERYTHING they matched; capping is the view's job (wiki.jsx
    // More). A shelf that says 412 and opens onto 8 is the bug this replaced.
    const vids = mixed.filter((f) => f.kind === "video").length;
    if (ms[0].items.length !== vids) throw new Error(`a section carries every match, got ${ms[0].items.length} of ${vids}`);
    if (!ms[0].why) throw new Error("a section past one carousel must say how many it holds");

    // Folder browsing survives the retype: one shelf of folder tiles, and only
    // for collections that actually have something to drill into.
    const fold = sh.find((s) => s.id === "folders");
    if (!fold || fold.folders[0].path !== "Big") throw new Error("folder tiles missing or unweighted by history");
    if (shelves([...many.map((f) => ({ ...f, dir: "" }))]).some((s) => s.id === "folders")) throw new Error("a flat collection is not a folder to drill into");

    // Vectors: nearest to the centroid wins, and an already-opened file is excluded.
    const vec = new Map(bulk.map((f, i) => [f.resourceId.toLowerCase(), [Math.cos(i), Math.sin(i)]]));
    const near = shelves(bulk, hist, vec).find((s) => s.id === "near");
    if (!near) throw new Error("vectors present but no similarity shelf");
    if (near.items.some((f) => f.resourceId.toLowerCase() === hist[0].resourceId)) throw new Error("recommended something already opened");
    if (cosine(vec.get(near.items[0].resourceId.toLowerCase()), [Math.cos(0), Math.sin(0)])
        < cosine(vec.get(near.items.at(-1).resourceId.toLowerCase()), [Math.cos(0), Math.sin(0)])) {
        throw new Error("similarity shelf is not sorted by similarity");
    }
    // No vectors in the shard → no fake "for you" row built out of arbitrary files.
    if (shelves(bulk, hist, new Map()).some((s) => s.id === "near")) throw new Error("a lexical-only shard must not fake recommendations");
    // A session with a direction says so; the shelf is only renamed, never dropped.
    const two = [{ resourceId: many[1].resourceId.toLowerCase(), owner: "0xaaa", top: "Big", at: 2 }, ...hist];
    if (shelves(bulk, two, vec).find((s) => s.id === "near")?.title !== "Where you're heading") {
        throw new Error("two opens have a heading — the shelf must lead, not just recall");
    }
    // Topic shelves are wired in and carry files, not empties.
    const topical = shelves(bulk, hist, vec).filter((s) => s.id.startsWith("topic:"));
    if (!topical.length || topical.some((s) => s.items.length < 2)) throw new Error("clustered topic shelves missing or empty");

    // Catalog entries have no resourceId, so identity falls back to owner:path.
    // Keying on a bare `node.resourceId` collapses every free entry onto the same
    // undefined — opening one marks them all opened, and the session kernel sees a
    // corpus of a million abstracts as a single item. Silent, and fatal to
    // discovery on exactly the catalogs this is meant to serve.
    const e1 = { owner: "0xAAA", path: "papers/a.txt", name: "a.txt" };
    const e2 = { owner: "0xaaa", path: "papers/b.txt", name: "b.txt" };
    const e3 = { owner: "0xbbb", path: "papers/a.txt", name: "a.txt" };
    if (nodeKey(e1) === nodeKey(e2)) throw new Error("two catalog entries collapsed onto one key");
    if (nodeKey(e1) === nodeKey(e3)) throw new Error("same relpath under two publishers must not collide");
    if (nodeKey(e1) !== "0xaaa:papers/a.txt") throw new Error("catalog entry key must be lowercased owner:path");
    if (nodeKey({ resourceId: "0xRR", owner: "0xaaa", path: "x" }) !== "0xrr") throw new Error("a real resourceId must still win over the fallback");
    // Opening a free entry is remembered — on a mostly-free catalog it's the only
    // signal the kernel ever gets.
    forget();
    if (!remember(e1).some((h) => h.resourceId === "0xaaa:papers/a.txt")) throw new Error("a catalog entry open must be remembered");

    // Ratings live on the same entry as the open, so pressing 👎 must not add a
    // second row — and opening the thing again must not silently clear it.
    {
        // recall() is a localStorage read, and node has none — so the round trip
        // this is actually testing needs somewhere to land.
        const store = new Map();
        globalThis.localStorage = {
            getItem: (k) => store.get(k) ?? null,
            setItem: (k, v) => store.set(k, v),
            removeItem: (k) => store.delete(k),
        };
        if (ratingOf(e1) !== 0) throw new Error("an unrated row must read as 0, not undefined");
        const after = rate(e1, null, null, -1);
        if (ratingOf(e1) !== -1) throw new Error("a 👎 must be readable back");
        if (after.filter((h) => h.resourceId === nodeKey(e1)).length !== 1) throw new Error("rating must update the open, not duplicate it");
        remember(e1);
        if (ratingOf(e1) !== -1) throw new Error("re-opening a disliked row must not clear the dislike");
        rate(e1, null, null, 1);
        if (ratingOf(e1) !== 1) throw new Error("a 👍 must replace a 👎");
        rate(e1, null, null, 0);
        if (ratingOf(e1) !== 0) throw new Error("pressing the lit button again must clear it");
        forget();
        if (recall().length) throw new Error("forget() must empty the history");
        delete globalThis.localStorage;
    }
    forget();

    // ── the session survives switching apps ──────────────────────────────────
    // The demo this whole seam exists for: browse in one app, switch to another,
    // and the front page there is ordered by where you were heading. It works only
    // because remember() stores the VECTOR — an id from another app's index resolves
    // to nothing in this one, which is what used to make the kernel go null on
    // switch and the shelf silently vanish.
    {
        const vec = (a, b) => { const v = new Array(256).fill(0); v[0] = a; v[1] = b; return v; };
        // Opened in app A. Nothing here appears in app B's catalog.
        const hist = [
            { resourceId: "0xaaa:jazz/2.mp3", app: "sond3r", v: packVec(vec(0.95, 0.31)), at: 2 },
            { resourceId: "0xaaa:jazz/1.mp3", app: "sond3r", v: packVec(vec(1, 0)), at: 1 },
        ];
        // App B's catalog: ten files so shelves() doesn't short-circuit to "everything",
        // one of them sitting where app A's session was pointing.
        const bFiles = [];
        const bVecs = new Map();
        for (let i = 0; i < 10; i++) {
            const f = { owner: "0xbbb", path: `vg/${i}.mp4`, name: `${i}.mp4`, kind: "video", mime: "video/mp4", resourceId: `0xb${i}` };
            bFiles.push(f);
            // #7 is the match; the rest point the other way.
            bVecs.set(nodeKey(f), i === 7 ? vec(0.9, 0.44) : vec(-0.5, 0.86));
        }
        const rows = shelves(bFiles, hist, bVecs);
        const near = rows.find((r) => r.id === "near");
        if (!near) throw new Error("the session must survive a switch into an app where nothing was opened");
        if (near.items[0].name !== "7.mp4") throw new Error(`carried-over session ranked wrong: ${near.items[0].name}`);
        if (!near.why.includes("sond3r")) throw new Error(`a carried-over shelf must name its source app, got: ${near.why}`);
        // An id-only history (written before vectors were stored) must degrade to
        // no shelf, not to a wrong one.
        const old = hist.map(({ v, ...rest }) => rest);
        if (shelves(bFiles, old, bVecs).some((r) => r.id === "near")) {
            throw new Error("history with no vectors must not produce a heading shelf in another app");
        }
    }

    // A run is the folder, in episode order — numeric, not lexicographic.
    {
        const show = flatten([{ owner: "0xaaa", name: "S1", type: "folder", children: [
                { name: "E10.mp4", path: "S1/E10.mp4", type: "file", mime: "video/mp4", resourceId: "0x10" },
                { name: "E2.mp4", path: "S1/E2.mp4", type: "file", mime: "video/mp4", resourceId: "0x2" },
                { name: "E1.mp4", path: "S1/E1.mp4", type: "file", mime: "video/mp4", resourceId: "0x1" },
                { name: "cover.jpg", path: "S1/cover.jpg", type: "file", mime: "image/jpeg", resourceId: "0xc" },
        ] }, { owner: "0xaaa", name: "S2", type: "folder", children: [
            { name: "E1.mp4", path: "S2/E1.mp4", type: "file", mime: "video/mp4", resourceId: "0x21" },
        ] }]);
        const here = show.find((f) => f.path === "S1/E1.mp4");
        const order = run(show, here).map((f) => f.name);
        if (order.join() !== "E1.mp4,E2.mp4,E10.mp4") throw new Error(`a season must play in episode order, got ${order}`);
        if (run(show, show.find((f) => f.path === "S1/cover.jpg")).length) throw new Error("a cover image is not a run");
        if (run(show, show.find((f) => f.path === "S2/E1.mp4")).length) throw new Error("a folder of one is not a run");
    }

    // Tagged episodes beat filenames: the publisher's own numbering wins, and it
    // is the only thing that works when the names carry no order at all.
    {
        const tagged = flatten([{ owner: "0xaaa", name: "mix", type: "folder", children: [
            { name: "zzz.mp4", path: "mix/zzz.mp4", type: "file", mime: "video/mp4", series: "Show", season: 1, episode: 2 },
            { name: "aaa.mp4", path: "mix/aaa.mp4", type: "file", mime: "video/mp4", series: "Show", season: 1, episode: 1 },
            { name: "mmm.mp4", path: "mix/mmm.mp4", type: "file", mime: "video/mp4", series: "Show", season: 2, episode: 1 },
            { name: "other.mp4", path: "mix/other.mp4", type: "file", mime: "video/mp4", series: "Else", season: 1, episode: 1 },
        ] }]);
        const s1 = run(tagged, tagged.find((f) => f.name === "aaa.mp4"));
        if (s1.map((f) => f.name).join() !== "aaa.mp4,zzz.mp4") throw new Error(`tagged episodes must play in published order, got ${s1.map((f) => f.name)}`);
        if (s1.some((f) => f.season === 2 || f.series === "Else")) throw new Error("a run must not cross a season or a series");
    }

    // A tagged series collapses to one shelf in episode order; an untagged folder
    // stays a collection, and a lone episode is nobody's series.
    {
        const eps = [1, 3, 2].map((n) => ({ ...file("0xaaa", `Show/E${n}.mp4`), series: "Show", season: 1, episode: n }));
        const sh = seriesShelves([...eps, { ...file("0xbbb", "Loose/x.mp4"), series: "Solo", season: 1, episode: 1 }, file("0xccc", "Plain/y.mp4")]);
        if (sh.length !== 1) throw new Error(`one tagged series with >1 episode → one shelf, got ${sh.length}`);
        if (sh[0].items.map((f) => f.episode).join() !== "1,2,3") throw new Error("a series shelf must be in episode order");
        if (sh[0].why !== "3 episodes") throw new Error(`series subtitle wrong: ${sh[0].why}`);
        if (sh[0].seasons) throw new Error("one season is not a division");
    }

    // The duplicate this was written for: four seasons of one show are ONE show,
    // divided inside its own page, and one card on any row it lands on.
    {
        const eps = [[1, 1], [1, 2], [2, 1]].map(([s, e]) => ({ ...file("0xaaa", `Show/S${s}E${e}.mp4`), series: "Show", season: s, episode: e }));
        const sh = seriesShelves(eps);
        if (sh.length !== 1) throw new Error(`two seasons of one show is one series, got ${sh.length}`);
        if (sh[0].why !== "3 episodes · 2 seasons") throw new Error(`series subtitle wrong: ${sh[0].why}`);
        if (sh[0].seasons?.map((x) => x.season).join() !== "1,2") throw new Error("seasons must divide the page in order");
        if (sh[0].items.map((f) => f.name).join() !== "S1E1.mp4,S1E2.mp4,S2E1.mp4") throw new Error("episodes must sort by season then episode");
        const rows = foldSeries([{ id: "k", items: [...eps, file("0xccc", "loose.mp4")] }], seriesIndex(sh));
        if (rows[0].items.length !== 2) throw new Error(`a shelf must carry one card per show, got ${rows[0].items.length}`);
        if (rows[0].items[0].shelf !== sh[0]) throw new Error("a folded card must open the show, not episode one");
        if (rows[0].items[0].resourceId) throw new Error("a show is not a purchasable file");
    }

    // A folder of untagged episodes is one show, named for the folder, with the
    // season folder skipped — this is most of the real world, and it was eleven
    // cards called S01E__ before.
    {
        const eps = [1, 2, 3].map((n) => file("0xaaa", `code_lyoko/Season 1/S01E0${n} - Ep.mp4`));
        const two = file("0xaaa", "code_lyoko/Season 2/S02E01 - Ep.mp4");
        const movies = ["Alien.mp4", "Solaris.mp4", "Stalker.mp4"].map((n) => file("0xaaa", `films/${n}`));
        const rows = seriesShelves([...eps, two, ...movies]);
        if (rows.length !== 1) throw new Error(`one show, not one per season or per film, got ${rows.length}`);
        if (rows[0].title !== "Code Lyoko") throw new Error(`the show is named for its folder, got ${rows[0].title}`);
        if (rows[0].items.length !== 4) throw new Error("every season's episodes belong to the one show");
        if (rows[0].seasons?.map((x) => x.season).join() !== "1,2") throw new Error("seasons divide the show's page");
        if (rows[0].node.name !== "Code Lyoko") throw new Error("the card is named for the show");
        // A folder of unrelated films must NOT become a show — no episode markers,
        // so nothing to fold, and three films stay three cards.
        if (rows.some((r) => r.title === "Films")) throw new Error("a folder of films is not a series");
    }

    // The scrobble: furthest point wins, a rewind does not un-watch, and a clip
    // too short to have progress is not tracked at all.
    {
        const store = {};
        globalThis.localStorage = {
            getItem: (k) => store[k] ?? null,
            setItem: (k, v) => { store[k] = v; },
            removeItem: (k) => { delete store[k]; },
        };
        const ep = file("0xaaa", "Show/E1.mp4");
        watch(ep, 900, 1800);
        if (Math.abs(watched()[nodeKey(ep)][0] - 0.5) > 1e-6) throw new Error("a scrobble must record how far in it got");
        watch(ep, 60, 1800);
        if (Math.abs(watched()[nodeKey(ep)][0] - 0.5) > 1e-6) throw new Error("a rewind must not lower the furthest point reached");
        if (resumeAt(ep) !== 900) throw new Error("resume must land where the play head got to");
        if (isWatched(ep)) throw new Error("halfway is not watched");
        watch(ep, 1790, 1800);
        if (!isWatched(ep)) throw new Error("the end of an episode must mark it watched");
        if (resumeAt(ep) !== null) throw new Error("a finished episode must start over, not resume on the credits");
        if (!(watched()[nodeKey(ep)][2] > 0)) throw new Error("a scrobble must say WHEN — nothing merges without it");
        const clip = file("0xaaa", "Show/bumper.mp4");
        watch(clip, 4, 12);
        if (watched()[nodeKey(clip)]) throw new Error("a twelve-second clip has no progress worth keeping");
        delete globalThis.localStorage;
    }

    // A folder named "-" is a real row in the crawl. Without the ?? "" this
    // returned the literal string "undefined", which then got rendered.
    if (pretty("-") !== "") throw new Error(`pretty("-") should be empty, got ${JSON.stringify(pretty("-"))}`);

    console.log("browse.js self-check ok — flatten, season runs in episode order, one-level drill-down, publisher scoping, generated shelves, taste ranking, like/dislike round-trip, catalog-entry identity, cross-app session carry-over, watch progress");
}
