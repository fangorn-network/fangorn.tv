// What aisle is this in?
//
// kindOf() (browse.js) answers "what IS this file" from its mime type — video,
// music, documents. That is a fact about bytes, and it is not what anyone browses
// by. A video store had aisles: Comedy, Anime, Documentary, Kids. Nothing in a
// shard says which aisle a file belongs in, and no publisher is going to tag six
// thousand of them.
//
// So this derives it, in two passes:
//
//  1. Rules — the words a path already contains. Free, instant, needs no model,
//     and on a real library (folders named "anime", "standup", "documentaries")
//     it places a large share of the catalog on its own.
//  2. A small in-browser LLM (llm.js), just in time, for the files the rules
//     can't place. It answers one bounded question — genre, and whether the thing
//     is animated — from a CLOSED list; this file composes the aisle name from
//     that plus the form (episodic or not), which is a fact the code already has
//     and the model would only get wrong.
//
// The model NEVER starts on its own: it is a large download and this is a
// storefront, not a lab. The UI has a button. Results are cached in localStorage
// forever, so the second visit is free and the sorting is incremental — every
// answer lands on the page as it arrives.

import { useEffect, useMemo, useState } from "react";
import { kindOf, nodeKey } from "./browse.js";
import { chat, getLlmStatus, onLlmStatus, warmLLM } from "../llm/llm.js";
import { lede } from "./wiki.js";

// The closed menu the model picks from. Short, lowercase, unambiguous — a 0.5B
// picks reliably from twelve plain words and badly from a taxonomy.
const GENRES = ["comedy", "drama", "action", "sci-fi", "horror", "documentary",
    "kids", "reality", "sports", "news", "instructional", "music"];

// Aisles that are the aisle whether or not they're episodic. Nobody looks for
// "Documentary Movies" as distinct from "Documentary TV".
const NO_FORM = new Set(["documentary", "reality", "sports", "news", "instructional", "music"]);
const TITLE = {
    comedy: "Comedy", drama: "Drama", action: "Action & Adventure", "sci-fi": "Sci-Fi & Fantasy",
    horror: "Horror", documentary: "Documentaries", kids: "Kids & Family", reality: "Reality & Talk",
    sports: "Sports", news: "News & Politics", instructional: "How-To & Instructional", music: "Music & Concerts",
};

/** Episodic or not — the difference between "Comedy TV" and "Comedy Movies".
 *  The publisher's own tag when they committed one, the filename otherwise. */
const episodic = (f) =>
    f.series != null || f.episode != null ||
    /\bs\d{1,2}\s?e\d{1,2}\b|\bepisode\b|\bep\.?\s?\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(`${f.name ?? ""} ${f.path ?? ""}`);

/** Compose the aisle name from the model's two answers plus the form. */
export function labelFor(file, genre, animation) {
    if (animation === "anime") return "Anime";
    if (animation === "cartoon") return "American Cartoons";
    if (!TITLE[genre]) return null;
    if (NO_FORM.has(genre)) return TITLE[genre];
    return `${TITLE[genre]} ${episodic(file) ? "TV" : "Movies"}`;
}

// ── pass 1: rules ────────────────────────────────────────────────────────────
// Words that appear in the PATH of a library someone actually organised. Matched
// against the folder path and filename, longest-first so "standup" doesn't lose
// to "up". Deliberately conservative: a wrong aisle is worse than no aisle, and
// anything unmatched simply falls through to the model.
const RULES = [
    [/\banime\b|\bsubbed\b|\bdubbed\b|\bova\b|\bfansub/i, () => "Anime"],
    [/\bcartoons?\b|\blooney\b|\bhanna.?barbera\b|\bsaturday morning\b/i, () => "American Cartoons"],
    [/\bstand.?up\b|\bcomedy\b|\bsitcom\b|\bsketch\b/i, (f) => labelFor(f, "comedy")],
    [/\bdocumentar|\bdocuseries\b|\bnature\b|\bnova\b/i, () => TITLE.documentary],
    [/\bhorror\b|\bslasher\b|\bzombie\b/i, (f) => labelFor(f, "horror")],
    [/\bsci.?fi\b|\bscience fiction\b|\bfantasy\b|\bstar trek\b|\bstar wars\b/i, (f) => labelFor(f, "sci-fi")],
    [/\bkids?\b|\bchildren|\bpreschool\b|\bnursery\b|\bfamily\b/i, () => TITLE.kids],
    [/\bsports?\b|\bnfl\b|\bnba\b|\bfootball\b|\bsoccer\b|\bolympic/i, () => TITLE.sports],
    [/\bnews\b|\bpolitic|\bdebate\b|\binterview\b/i, () => TITLE.news],
    [/\btutorial\b|\bhow.?to\b|\blecture\b|\bcourse\b|\btraining\b|\blesson/i, () => TITLE.instructional],
    [/\bconcert\b|\blive at\b|\bmusic video\b|\bunplugged\b/i, () => TITLE.music],
    [/\breality\b|\btalk show\b|\bpodcast\b/i, () => TITLE.reality],
    [/\baction\b|\bmartial arts\b|\bwestern\b|\bheist\b/i, (f) => labelFor(f, "action")],
    [/\bdrama\b|\bthriller\b|\bnoir\b/i, (f) => labelFor(f, "drama")],
];

/** The aisle a file's own path already names, or null — no model involved. */
export function ruleGenre(file) {
    // Only the things an aisle is for. A .zip has a kind, not a genre.
    if (!["video", "music"].includes(kindOf(file))) return null;
    const hay = `${file.path ?? ""} ${file.name ?? ""}`;
    for (const [re, label] of RULES) if (re.test(hay)) return label(file);
    // Audio with nothing else to go on is music. That's not a guess, it's the mime.
    return kindOf(file) === "music" ? TITLE.music : null;
}

// ── the cache ────────────────────────────────────────────────────────────────
// Keyed by nodeKey (resourceId when there is one), so a file keeps its aisle
// across apps, publishers and re-bakes. Bump the version to re-sort everything.
const KEY = "sond3r.genres.v1";
const readCache = () => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}"))); } catch { return new Map(); }
};
const writeCache = (m) => {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m))); } catch { /* full or blocked */ }
};
export const forgetGenres = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

// ── pass 2: the model ────────────────────────────────────────────────────────
const SYSTEM =
    "You sort a video library into store aisles. Given one file's title and folder, " +
    "reply with ONLY a JSON object, no prose: " +
    `{"genre":"<one of: ${GENRES.join(", ")}>","animation":"<anime, cartoon, or none>"}. ` +
    'Use "anime" only for Japanese animation and "cartoon" only for Western animation. ' +
    "Judge from the words in the title and folder. Never invent other values.";

function extractJson(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/** One file → aisle, via the model. null when it won't answer usefully. */
async function askGenre(file) {
    const about = lede(file, 160);
    const user = `TITLE: ${file.name ?? file.path}\nFOLDER: ${file.dir || "/"}${about ? `\nABOUT: ${about}` : ""}`;
    const obj = extractJson(await chat(SYSTEM, user, 48));
    if (!obj) return null;
    const genre = String(obj.genre ?? "").toLowerCase().trim();
    const anim = String(obj.animation ?? "").toLowerCase().trim();
    return labelFor(file, genre, anim === "anime" ? "anime" : anim === "cartoon" ? "cartoon" : null);
}

/**
 * Sort the catalog, just in time.
 *
 * Rules run over everything immediately and are reported in one go. Then the
 * model takes the leftovers ONE at a time — this runs in the viewer's tab, and a
 * batch big enough to matter is a batch big enough to lock it — reporting each
 * answer as it lands so the page fills in while you look at it.
 *
 * `cap` bounds a session's model work: a 6,000-file catalog is not worth an hour
 * of someone's laptop, and the shelves are already useful long before then.
 * ponytail: unsorted-first order, no priority for what's on screen. Feed it the
 * visible files first if a big catalog ever feels slow.
 */
export async function sortCatalog(files, onLabels, { cap = 300, signal } = {}) {
    const cache = readCache();
    const out = new Map(cache);
    let dirty = false;

    for (const f of files) {
        const k = nodeKey(f);
        if (out.has(k)) continue;
        const r = ruleGenre(f);
        if (r) { out.set(k, r); dirty = true; }
    }
    if (dirty) { writeCache(out); onLabels(new Map(out)); }

    const todo = files.filter((f) => !out.has(nodeKey(f)) && kindOf(f) === "video").slice(0, cap);
    if (!todo.length) return out;

    let n = 0;
    for (const f of todo) {
        if (signal?.aborted) break;
        try {
            const label = await askGenre(f);
            // A file the model can't place still gets an entry, so the next visit
            // doesn't pay for the same non-answer again.
            out.set(nodeKey(f), label ?? "");
        } catch { break; } // model died — keep what we have rather than spinning
        if (++n % 5 === 0 || n === todo.length) { writeCache(out); onLabels(new Map(out)); }
    }
    writeCache(out);
    onLabels(new Map(out));
    return out;
}

// ── shelves ──────────────────────────────────────────────────────────────────
// Two files is not an aisle.
const MIN_ITEMS = 3;

/** Aisle rows in shelves()' own {id,title,why,items} shape, biggest first, so
 *  the front page and ListPage draw them with no new view. */
export function genreShelves(files, labels) {
    if (!labels?.size) return [];
    const by = new Map();
    for (const f of files) {
        const label = labels.get(nodeKey(f));
        if (!label) continue;
        if (!by.has(label)) by.set(label, []);
        by.get(label).push(f);
    }
    return [...by.entries()]
        .filter(([, items]) => items.length >= MIN_ITEMS)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([label, items]) => ({
            id: `genre:${label}`, title: label,
            why: `${items.length} in this aisle`, items,
        }));
}

/**
 * The viewer's handle on all of the above.
 *
 * Cached labels are read on mount, so a returning visitor sees their aisles with
 * no model and no delay. `start()` is what a button calls: it downloads the model
 * and fills in the rest. Nothing here runs by itself.
 */
export function useGenres(files) {
    const [labels, setLabels] = useState(readCache);
    const [status, setStatus] = useState(getLlmStatus);
    const [on, setOn] = useState(false);

    useEffect(() => onLlmStatus(setStatus), []);

    // Rules are free, so they run on every catalog change whether or not the
    // model was ever asked for — the aisles a path already names cost nothing.
    useEffect(() => {
        if (!files.length) return;
        const ac = new AbortController();
        sortCatalog(files, setLabels, { cap: on ? 300 : 0, signal: ac.signal });
        return () => ac.abort();
    }, [files, on]);

    // Both of these are O(files) and they sit in an object literal, so they ran on
    // EVERY render whether or not the caller destructured them — and the Guide
    // re-renders on a wall clock. 9ms each at 21k rows, for a number nobody read.
    const shelves = useMemo(() => genreShelves(files, labels), [files, labels]);
    // How much of the catalog has an aisle — the honest progress readout, since
    // the model's own bar only covers the download.
    const sorted = useMemo(() => files.filter((f) => labels.get(nodeKey(f))).length, [files, labels]);

    return {
        labels,
        shelves,
        start: () => { setOn(true); warmLLM(); },
        on,
        status,
        sorted,
    };
}

// ── self-check: `node src/catalog/genres.js` — composition and rules, no model ───────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${a} !== ${b}`); };
    const ep = { name: "The Office - S03E04.mkv", path: "tv/the office/S03E04.mkv", mime: "video/x-matroska" };
    const film = { name: "Airplane.mp4", path: "movies/Airplane.mp4", mime: "video/mp4" };
    eq(labelFor(ep, "comedy"), "Comedy TV", "episodic composes to TV");
    eq(labelFor(film, "comedy"), "Comedy Movies", "standalone composes to Movies");
    eq(labelFor(ep, "documentary"), "Documentaries", "form-free aisles take no suffix");
    eq(labelFor(film, "comedy", "anime"), "Anime", "animation wins over genre");
    eq(labelFor(film, "not-a-genre"), null, "an off-menu genre is no label");
    eq(ruleGenre({ name: "ep1.mkv", path: "anime/digimon/ep1.mkv", mime: "video/x-matroska" }), "Anime", "path rule");
    eq(ruleGenre({ name: "song.mp3", path: "x/song.mp3", mime: "audio/mpeg" }), "Music & Concerts", "audio falls back to music");
    eq(ruleGenre({ name: "backup.zip", path: "backup.zip", mime: "application/zip" }), null, "a zip has no aisle");
    eq(ruleGenre({ name: "untitled.mp4", path: "clips/untitled.mp4", mime: "video/mp4" }), null, "unmatched video goes to the model");
    const rows = genreShelves(
        [ep, ep, ep, film].map((f, i) => ({ ...f, path: `${f.path}#${i}` })),
        new Map([["e0", "x"]]),
    );
    eq(rows.length, 0, "labels keyed by nodeKey; a miss is not a shelf");
    console.log("genres.js self-check ok — composition, rules, empty shelves");
}
