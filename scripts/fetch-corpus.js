#!/usr/bin/env node
// Pull two real corpora off archive.org into quickbeam-shaped rows.
//
//   node scripts/fetch-corpus.js          → scripts/corpus/*.json
//   node scripts/bake-corpus.js           → adds vectors
//
// Separate from the embedding step because the network half is fast and worth
// iterating on, and the embedding half is slow and worth doing once.
//
// Fetched with no key and no account, and archive.org sends
// `access-control-allow-origin: *` — including the actual media bytes, with range
// support. That is the whole reason free content needs no worker and no R2 here:
// the file already has a public URL that a browser can play.
//
// Two apps, two mediums, two publishers: film on one side, audio on the other. They
// share no ids, no collections and no publisher — a 1980s computing programme and a
// 78rpm dance record are bridged only by the embedding space, which is the claim.

import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("./corpus/", import.meta.url);
// A contact address, because archive.org throttles anonymous bulk readers and
// being rate-limited is not a transient blip here — it comes out as a corpus that
// is quietly missing a whole collection.
const UA = {
    "user-agent": "sond3r-demo/0.1 (semantic browser research; https://github.com/sond3r)",
    "accept-encoding": "gzip",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One in flight at a time, with a floor between requests. Both APIs are free and
// neither owes us anything; hammering them is how you get a 429 and a corpus with a
// hole in it.
let last = 0;
async function paced(url, gap) {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fetch(url, { headers: UA });
}

const get = async (url, tries = 4) => {
    const gap = 250;
    let err;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await paced(url, gap);
            if (r.ok) return await r.json();
            if (r.status === 429) {
                // Honour Retry-After when they send one; otherwise back off properly
                // rather than knocking again a second later and making it worse.
                const after = Number(r.headers.get("retry-after")) || 0;
                const back = after ? after * 1000 : 5000 * (i + 1);
                console.warn(`\n  429 — backing off ${Math.round(back / 1000)}s`);
                await sleep(back);
                continue;
            }
            if (r.status < 500) throw new Error(`HTTP ${r.status} for ${url}`);
            err = new Error(`HTTP ${r.status}`);
        } catch (e) {
            if (String(e.message).startsWith("HTTP 4")) throw e; // a 404 is an answer
            err = e;
        }
        await sleep(1000 * (i + 1));
    }
    throw err ?? new Error(`gave up on ${url}`);
};

// A description arrives as a string, an array of strings, or not at all. HTML shows
// up in it often enough that leaving the tags in would put them in the embedding.
const clean = (d) => (Array.isArray(d) ? d.join(" ") : String(d ?? ""))
    .replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim();

// ── archive.org ──────────────────────────────────────────────────────────────

const COLLECTIONS = [
    ["computerchronicles", "Computer Chronicles"],
    ["prelinger", "Prelinger Ephemeral Films"],
    ["classic_cartoons", "Classic Cartoons"],
    ["universal_newsreels", "Universal Newsreels"],
];

// The second app. Different medium, different publisher, chosen to sit NEAR the
// film corpus without naming the same things — the overlap has to be semantic or
// the cross-app carry-over proves nothing.
// `78rpm` was the obvious pick and it is not usable: those items carry a title and
// nothing else, so every one of them fell to the description filter below and the
// collection came out of the fetch empty. Description length, not vibe, decides
// what can be in a corpus that is going to be embedded.
const AUDIO_COLLECTIONS = [
    ["oldtimeradio", "Old Time Radio"],
    ["audio_tech", "Tech Talks"],
    ["audio_news", "News & Public Affairs"],
    ["librivoxaudio", "LibriVox Audiobooks"],
];

/** Every item gets one, no extra request: archive.org derives a thumbnail per
 *  identifier and serves it CORS-open like everything else. */
const thumbOf = (id) => `https://archive.org/services/img/${encodeURIComponent(id)}`;

/** One collection → rows. `rows` items per collection, newest-relevance first. */
async function archiveCollection(id, label, rows, mediatype = "movies") {
    const fl = ["identifier", "title", "description", "year", "subject", "creator"]
        .map((f) => `fl%5B%5D=${f}`).join("&");
    const url = `https://archive.org/advancedsearch.php?q=collection%3A${id}+AND+mediatype%3A${mediatype}`
        + `&${fl}&rows=${rows}&page=1&output=json`;
    const docs = (await get(url)).response?.docs ?? [];
    console.log(`  ${label}: ${docs.length} items`);

    const out = [];
    for (const d of docs) {
        const desc = clean(d.description);
        // A row with no description is a filename in a list. It embeds to noise and
        // it makes the corpus look like the fake one this replaces.
        if (desc.length < 60) continue;
        const subject = Array.isArray(d.subject) ? d.subject.slice(0, 6) : [d.subject].filter(Boolean);
        out.push({
            id: d.identifier, title: clean(d.title) || d.identifier, desc,
            year: d.year ?? null, creator: clean(d.creator) || null,
            subject, collection: label, thumb: thumbOf(d.identifier),
        });
    }
    return out;
}

/** Resolve each item's actual playable file. One metadata call per item, so this is
 *  the slow half — but a row without a real URL is exactly the fake data we're
 *  replacing, so it is worth the round trips.
 *
 *  `want` picks the derivative for the medium. Prefer a small one: these are demo
 *  streams, not archival masters, and an 800 MB MPEG2 or a 300 MB FLAC would make
 *  the player look broken. */
const DERIVATIVE = {
    movies: [[/_512kb\.mp4$/, "video/mp4"], [/\.mp4$/, "video/mp4"], [/\.ogv$/, "video/ogg"]],
    audio: [[/_vbr\.mp3$/, "audio/mpeg"], [/\.mp3$/, "audio/mpeg"], [/\.ogg$/, "audio/ogg"]],
};

async function withMedia(items, mediatype = "movies") {
    const want = DERIVATIVE[mediatype];
    const out = [];
    for (const [i, it] of items.entries()) {
        process.stdout.write(`\r  resolving media ${i + 1}/${items.length}  `);
        let meta;
        try { meta = await get(`https://archive.org/metadata/${it.id}`); } catch { continue; }
        const files = meta.files ?? [];
        let pick = null, mime = null;
        for (const [re, m] of want) {
            pick = files.find((f) => re.test(f.name));
            if (pick) { mime = m; break; }
        }
        if (!pick) continue;
        out.push({
            ...it,
            file: pick.name,
            url: `https://archive.org/download/${it.id}/${encodeURIComponent(pick.name)}`,
            size: Number(pick.size ?? 0) || null,
            mime,
        });
    }
    process.stdout.write("\n");
    return out;
}

// ── go ───────────────────────────────────────────────────────────────────────

const PER_COLLECTION = Number(process.env.PER_COLLECTION ?? 40);

mkdirSync(OUT, { recursive: true });

// Re-run one app without paying for the other: each costs one metadata round trip
// per item, and that is the slow part.
const ONLY = process.env.ONLY ?? "";

/** One app = a list of collections at one mediatype. Same code both times; the only
 *  differences are which collections, which derivative, and who "publishes" it. */
async function corpus(app, collections, mediatype) {
    console.log(`${app} (archive.org ${mediatype}):`);
    let items = [];
    for (const [id, label] of collections) {
        items.push(...await archiveCollection(id, label, PER_COLLECTION, mediatype));
    }
    items = await withMedia(items, mediatype);
    writeFileSync(new URL(`./${app}.json`, OUT), JSON.stringify(items, null, 1));
    console.log(`  → ${items.length} items with playable URLs\n`);
}

if (ONLY !== "audio") await corpus("film-archive", COLLECTIONS, "movies");
if (ONLY !== "film") await corpus("sound-archive", AUDIO_COLLECTIONS, "audio");

console.log("next: node scripts/bake-corpus.js");
