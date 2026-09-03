#!/usr/bin/env node
// Does sond3r's client actually consume what the crawler publishes?
//
//   node scripts/ingest/verify_shard.mjs [stage_volumes]
//
// The crawler writes quickbeam vertices; quickbeam bakes them into CDN shard rows;
// src/catalog/search.js reads those. That is three hops, and the middle one is a service we
// do not run here — so this stands in for it: take the staged vertices, wrap them
// the way `cdn.py` does (`{track_id, owner, fields}`), and run the REAL client
// functions over the result.
//
// It is the only thing that checks the field contract end to end without standing up
// Qdrant, and it catches the class of bug that is otherwise invisible until a page
// is blank: a renamed key, an entityType that stops matching STRUCTURAL, a path that
// nests wrong, a row that browse.js drops on the floor.
//
// It does NOT verify the embedding half — there are no vectors until quickbeam bakes
// them, so the semantic path degrades to lexical here and says so.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] ?? "stage_volumes";
const OWNER = "0x7a7849231cf7ab1ea003bcf0063cb89704d7cce9";

const read = (f) => {
    try { return JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch { return []; }
};

// Exactly the wrap `_publish_to_fangorn` + quickbeam's bake apply: the node's
// `fields` becomes the vertex payload, and the CDN row carries that payload through
// as `fields`. If this shape is wrong, everything below is testing a fiction.
const rows = [
    ...read("volume_1_videos.json"),
    ...read("volume_1_transcripts.json"),
    ...read("volume_1_collections.json"),
].map((n) => ({ track_id: n.name, owner: OWNER, fields: n.fields }));

if (!rows.length) {
    console.error(`no staged vertices under ${DIR}/ — run publish_archive.py first`);
    process.exit(2);
}

// Stub the network: search.js fetches a catalog, a manifest and a gzipped shard.
// Serving the rows straight back exercises every parse and filter it applies.
const { gzipSync } = await import("node:zlib");
const SHARD = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n")));
// search.js reads EVERYTHING through fetchText(), which sniffs gzip magic bytes off
// an arrayBuffer — the catalog, the manifests and the shard all come through the
// same function. So the stub has to answer bytes, not `.json()`.
const bytes = (x) => {
    const b = typeof x === "string" || x instanceof Uint8Array ? x : JSON.stringify(x);
    const u = typeof b === "string" ? new TextEncoder().encode(b) : b;
    return { ok: true, status: 200, arrayBuffer: async () => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) };
};
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/catalog")) return bytes({ domains: [{ name: "d", count: rows.length, dim: 256 }] });
    if (u.includes("/manifest")) return bytes({ name: "d", dim: 256, shards: [{ file: "s.ndjson.gz", count: rows.length }], tombstones: [] });
    if (u.includes("/shards/")) return bytes(SHARD);
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
};
globalThis.EventSource = class { constructor() {} close() {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { setView, catalogFromShard, fileVectors, searchSubtitles } = await import("../../src/catalog/search.js");
const { flatten, levelAt, shelves, nodeKey, kinds } = await import("../../src/catalog/browse.js");
const { topics } = await import("../../src/geometry/kernel.js");
const { concepts } = await import("../../src/catalog/wiki.js");
const warn = console.warn; console.warn = () => {};

setView("http://stub");
const { tree } = await catalogFromShard({});
const files = flatten(tree);
const vectors = await fileVectors();

let bad = 0;
const check = (cond, msg) => { if (!cond) { console.log(`  ✗ ${msg}`); bad++; } };

console.log(`\nstaged: ${rows.length} vertices  →  ${files.length} browsable files\n`);

// ── the contract, row by row ─────────────────────────────────────────────────
check(files.length > 0, "the tree came back empty — no row survived fileRow()");
const structural = files.filter((f) => ["folder", "subtitles"].includes(f.entityType));
check(!structural.length, `${structural.length} STRUCTURAL row(s) leaked into the browse tree`);
const noUrl = files.filter((f) => !/^https:\/\/archive\.org\//.test(f.url ?? ""));
check(!noUrl.length, `${noUrl.length} file(s) carry no playable archive.org URL — e.g. ${noUrl[0]?.path}`);
const noThumb = files.filter((f) => !f.thumb);
check(!noThumb.length, `${noThumb.length} file(s) carry no thumbnail`);
const mkv = files.filter((f) => /\.mkv$/i.test(f.url ?? ""));
check(!mkv.length, `${mkv.length} file(s) point at an .mkv no browser will play`);
const dupUrl = new Map();
for (const f of files) dupUrl.set(f.url, (dupUrl.get(f.url) ?? 0) + 1);
const repeated = [...dupUrl.values()].filter((n) => n > 1).length;
check(!repeated, `${repeated} URL(s) appear on more than one row — the same video published twice`);
check(new Set(files.map(nodeKey)).size === files.length, "two files collapsed onto one node key");

// ── the tree actually nests ──────────────────────────────────────────────────
const tops = tree.filter((t) => t.type === "folder");
check(tops.length > 1, `expected several top-level collections, got ${tops.length}`);
const seriesFolder = tops.flatMap((t) => (t.children ?? []).filter((c) => c.type === "folder"));
check(seriesFolder.length > 0, "no series folder — <collection>/<series>/<episode> did not nest");
const deep = files.filter((f) => (f.path.match(/\//g) ?? []).length >= 2);
check(deep.length > 0, "no row is three levels deep, so no series survived as a folder");

// One folder, drilled into, the way the viewer does it.
const anySeries = seriesFolder[0];
if (anySeries) {
    const level = levelAt(files, { owner: OWNER, dir: anySeries.path });
    check(level.files.length > 0, `drilling into ${anySeries.path} showed no episodes`);
    const ordered = level.files.map((f) => f.name);
    check(ordered.join() === [...ordered].sort().join(), "episodes are not in lexical order — S01E10 before S01E02?");
}

// ── what the front page will be made of ──────────────────────────────────────
const rowsOut = shelves(files, [], vectors);
check(rowsOut.length > 0, "shelves() generated no front page");
// With no vectors there is no "heading" shelf and no topics — the honest shape is
// the folder row plus one section per kind, and browse.js is explicit about
// dropping the ranked rows rather than faking them.
check(rowsOut.some((r) => r.id === "folders"), "no collections row on the front page");
const cs = concepts(files);
const groups = topics(files, vectors);
console.log(`  tree: ${tops.length} collections, ${seriesFolder.length} series folders, ${deep.length} episodes`);
// kinds() returns [kind, count] PAIRS, not objects. Note `kind` is not on
// pointer()'s allowlist and does not survive the shard — flatten() recomputes it
// from the mime, which is why it is present here at all.
console.log(`  kinds: ${kinds(files).map(([k, n]) => `${k}×${n}`).join(", ")}`);
check(!kinds(files).some(([k]) => !k), "a file reached the UI with no kind — the Type filter would show 'undefined'");
console.log(`  shelves: ${rowsOut.length}  ·  concepts: ${cs.size}  ·  topics: ${groups.length}`);
console.log(`  vectors: ${vectors.size} (0 is expected — quickbeam bakes those, not us)`);

// ── search, lexically (there are no vectors yet) ─────────────────────────────
for (const q of ["digimon", "greymon", "blue"]) {
    const hits = await searchSubtitles(q, { embed: async () => { throw new Error("no model"); } });
    console.log(`  search ${JSON.stringify(q).padEnd(10)} → ${String(hits.length).padStart(3)} hits` +
        (hits[0] ? `  (top: ${hits[0].videoPath})` : ""));
    check(hits.every((h) => h.videoPath), `a hit for "${q}" resolved to no videoPath`);
    check(hits.every((h) => h.episode?.url || !h.episode), `a hit for "${q}" lost its playable URL`);
}

console.warn = warn;
console.log(bad ? `\n✗ ${bad} contract violation(s)\n` : "\n✓ the staged graph is consumable by src/catalog/search.js and src/catalog/browse.js unchanged\n");
process.exit(bad ? 1 : 0);
