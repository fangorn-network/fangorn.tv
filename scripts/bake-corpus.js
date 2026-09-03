#!/usr/bin/env node
// Turn the fetched corpora into quickbeam rows with real vectors.
//
//   node scripts/fetch-corpus.js && node scripts/bake-corpus.js
//   → scripts/corpus/<app>.rows.json, which mock-quickbeam.js serves as shards
//
// Embeds with embedDocuments() from src/llm/embed.js: same model, same
// "search_document: " prefix, same matryoshka truncation to 256d a publisher's
// browser runs. Anything else and the query side ranks against it about as well as
// random, with no error to show for it.
//
// ~300 rows, one at a time. Minutes, not seconds — but only when the corpus changes.

import { readFileSync, writeFileSync } from "node:fs";
import { embedDocuments } from "../src/llm/embed.js";

const AT = new URL("./corpus/", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, AT), "utf8"));

// Owners are stand-ins for the wallets that would have published these. Real
// addresses, wrong people — nothing here was committed on-chain, and labelling it
// as if it had been would be the one dishonest thing in the demo.
const OWNER = {
    "film-archive": "0x1111111111111111111111111111111111111111",
    "sound-archive": "0x2222222222222222222222222222222222222222",
};

// Filesystem-shaped, because the tree is synthesized from paths. A slash inside a
// title would invent a folder that isn't there.
const seg = (s) => String(s).replace(/[/\\]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);

/** What gets embedded. Must match rowText() in src/catalog/search.js — the vector has to
 *  describe the same text the lexical path scores, or search and "more like this"
 *  disagree about what a row is. */
const text = (f) => [f.name, f.path, f.desc].filter(Boolean).join(" ");

/** One archive.org item → a quickbeam row. Both apps are the same shape — the only
 *  differences are the owner, the file extension and what kind of thing it is, so
 *  there is one shaper and not two. */
const item = (app, kind, ext) => (d) => {
    const path = `${seg(d.collection)}/${seg(d.title)}${ext}`;
    return {
        track_id: `archive:${d.id}`, owner: OWNER[app],
        fields: {
            entityType: kind, kind, name: `${seg(d.title)}${ext}`, path,
            desc: d.desc, price: "0", mime: d.mime, size: d.size ?? 0,
            // The whole point of free data: the bytes already have a public URL, so
            // there is no resource to mint, nothing to decrypt and no worker in the
            // path. src/ui/App.jsx plays this directly.
            url: d.url,
            // archive.org derives one per identifier, CORS-open like the bytes.
            // A card with a real picture on it is the difference between a catalog
            // and a spreadsheet.
            thumb: d.thumb ?? undefined,
            year: d.year ?? undefined,
            creator: d.creator ?? undefined,
            subject: d.subject?.length ? d.subject : undefined,
            source: "archive.org",
        },
    };
};

const APPS = [
    ["film-archive", "film-archive.json", item("film-archive", "video", ".mp4")],
    ["sound-archive", "sound-archive.json", item("sound-archive", "audio", ".mp3")],
];

// Checkpointed in chunks rather than one embedDocuments() call over the whole
// corpus. Embedding is the step that OOMs this box: the ONNX runtime holds an arena
// across calls, and a crash 280 rows into 295 that loses everything is the
// difference between "run it again" and "give up on real data". Each chunk is
// written to disk, so a re-run resumes instead of restarting.
const CHUNK = Number(process.env.CHUNK ?? 16);

for (const [app, file, shape] of APPS) {
    const at = new URL(`./${app}.rows.json`, AT);
    const rows = read(file).map(shape);

    // Resume: keep any row already embedded, by track_id. Re-shaping from the source
    // each run means a fix to `film()`/`article()` still lands — only the vector is
    // reused, and the vector only depends on the text.
    let done = new Map();
    try {
        for (const r of JSON.parse(readFileSync(at, "utf8"))) {
            if (r.embedding) done.set(r.track_id, { text: text(r.fields), embedding: r.embedding });
        }
    } catch { /* first run */ }

    const todo = rows.filter((r) => done.get(r.track_id)?.text !== text(r.fields));
    console.log(`\n${app}: ${rows.length} rows, ${rows.length - todo.length} already embedded, ${todo.length} to do`);

    for (let i = 0; i < todo.length; i += CHUNK) {
        const batch = todo.slice(i, i + CHUNK);
        const vecs = await embedDocuments(batch.map((r) => text(r.fields)));
        batch.forEach((r, j) => {
            done.set(r.track_id, {
                text: text(r.fields),
                embedding: Array.from(vecs[j], (x) => Math.round(x * 1e5) / 1e5),
            });
        });
        // Written every chunk, not at the end. That is the whole point.
        for (const r of rows) r.embedding = done.get(r.track_id)?.embedding;
        writeFileSync(at, JSON.stringify(rows.filter((r) => r.embedding)));
        process.stdout.write(`\r  ${Math.min(i + CHUNK, todo.length)}/${todo.length} embedded  `);
    }
    process.stdout.write("\n");
    console.log(`  → scripts/corpus/${app}.rows.json`);
}

// The demo only shows anything if the two catalogs actually meet somewhere. Two
// corpora that share no vocabulary can still be far apart in the space, and the way
// that fails is silent: every shelf looks plausible and none of it means anything.
const load = (a) => JSON.parse(readFileSync(new URL(`./${a}.rows.json`, AT), "utf8"));
const [F, E] = [load("film-archive"), load("sound-archive")];
const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
// Raw nomic-256 cosine is offset per document, not centred on zero: on this corpus
// almost every pair scores 0.5-0.7, so an absolute floor ("above 0.6") admits
// everything and proves nothing. The honest measure is the MARGIN — how far a film's
// best recording sits above that film's own mean over the whole sound archive. Same
// reasoning as Z_FLOOR in search.js and the probe z-scores in probes.js.
let margin = 0;
for (const f of F) {
    let best = -1, sum = 0;
    for (const e of E) { const c = cos(f.embedding, e.embedding); sum += c; if (c > best) best = c; }
    margin += best - sum / E.length;
}
margin /= F.length;
console.log(`\ncross-corpus margin: a film's best recording sits ${margin.toFixed(3)} above its mean over all ${E.length}`);
if (margin < 0.08) {
    console.error("the corpora do not meet in any particular place — every recording is equally (ir)relevant to every film.");
    console.error("widen the archive.org collections on either side so they actually overlap.");
    process.exit(1);
}
console.log("ok — the corpora overlap somewhere specific, so switching apps has something to say");
