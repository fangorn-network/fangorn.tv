// Build the "fat shard" the UI searches: every subtitle cue in media/, grouped
// into passages, written as gzipped NDJSON in the same row shape the Semantic CDN
// uses (`{track_id, embedding, fields}`) so the embedding step can fill in
// `embedding` in place and nothing downstream changes.
//
//   node server/shard.js            → public/subtitles.ndjson.gz
//   node server/shard.js --selfcheck
//
// Rows ship WITHOUT `embedding` until the embedding pipeline adds it; src/catalog/search.js
// falls back to lexical matching for any row that has no vector, so search works
// (worse) from the moment the first .vtt exists.
//
// Cues are one clause each ("and the beat") — too short to embed usefully. They're
// windowed into passages of a few sentences, keeping the FIRST cue's start as the
// seek target, so a hit still lands the viewer on the exact line.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { parseVtt } from "./subtitles.js";

/** Passage limits. Tune for the corpus: longer = better recall per vector and a
 *  smaller shard, shorter = a tighter seek target. */
export const PASSAGE_CHARS = 320;
export const PASSAGE_GAP_S = 8; // a silence this long ends a passage

/** Cues → passages. Breaks on the char budget or a long silence between cues. */
export function toPassages(cues, { chars = PASSAGE_CHARS, gap = PASSAGE_GAP_S } = {}) {
    const out = [];
    let cur = null;
    for (const c of cues) {
        const tooLong = cur && (cur.text.length + c.text.length + 1) > chars;
        const silence = cur && c.start - cur.end > gap;
        if (!cur || tooLong || silence) {
            cur = { start: c.start, end: c.end, text: c.text };
            out.push(cur);
        } else {
            cur.text += ` ${c.text}`;
            cur.end = c.end;
        }
    }
    return out;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One CDN-shaped row per passage. `track_id` is stable across rebuilds so an
 *  embedding cache can be keyed on it. */
export function passageRows(videoPath, name, passages) {
    return passages.map((p, i) => ({
        track_id: `${videoPath}#p${i}`,
        // vec: filled in from the graph payload by aggregateRows
        fields: {
            entityType: "Passage",
            title: `${name} @ ${mmss(p.start)}`,
            videoPath, name,
            start: p.start, end: p.end,
            text: p.text,
        },
    }));
}

/**
 * The text that represents a WHOLE file — what a search for "that spanish house
 * track" has to match when the file has no dialogue at all.
 *
 * Folder names are part of it because in a file-manager library they carry most
 * of the human labelling ("Live Sets/Berlin 2024"), and they're free.
 */
export function fileText({ name, path, desc }) {
    const folders = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/") : [];
    return [name, ...folders, desc].filter(Boolean).join(" — ");
}

/** One row for the file itself. Emitted for EVERY published file, cues or not —
 *  without it a track with no dialogue is unfindable, which was true of every
 *  audio file, image and PDF in the library. */
export function fileRow(videoPath, name, extra = {}) {
    return {
        track_id: `${videoPath}#file`,
        fields: { entityType: "File", title: name, videoPath, name, start: 0, text: fileText({ name, path: videoPath, ...extra }) },
    };
}

/**
 * Rows for EVERY publisher, read back from the chain. The graph already carries
 * both halves — video vertices hold the x402f pointer, subtitle vertices hold the
 * cues — so the aggregator needs no local files and no publisher's cooperation
 * beyond their commit.
 *
 * Each row carries the episode pointer, which is what makes a search hit playable
 * with no catalog loaded. The pointer is public by construction (it's on-chain);
 * the ciphertext stays paywalled at the worker's /access gate either way.
 *
 * @param listNamespace (namespace, publisher) => { vertices: [{ payload }] }
 */
export async function aggregateRows({ listNamespace, namespace, publishers, model, dim, onProgress }) {
    const rows = [];
    // A vector is usable only if it was produced by the model this shard is being
    // baked for. Mixing corpora is silent — cosine still returns a number — so a
    // stamp mismatch drops the vector and the row falls back to lexical.
    const usable = (e) => e && (!model || e.model === model) && (!dim || e.dim === dim);

    for (const owner of publishers) {
        let contents;
        try {
            contents = await listNamespace(namespace, owner);
        } catch (err) {
            // One unreachable/garbage namespace must not sink the whole catalog.
            onProgress?.({ owner, error: err.message });
            continue;
        }
        const payloads = (contents?.vertices ?? []).map((v) => v.payload).filter(Boolean);
        const videos = new Map(payloads.filter((p) => p.kind === "video").map((p) => [p.path, p]));
        const subsFor = new Map(payloads.filter((p) => p.kind === "subtitles").map((p) => [p.videoPath, p]));
        let n = 0;
        let dropped = 0;

        for (const video of videos.values()) {
            // A catalog entry has no resourceId, so it has no purchase pointer to
            // carry — it is findable and readable-about, but there is nothing to
            // buy and nothing to decrypt. Spreading the pointer fields
            // conditionally (rather than writing undefineds) keeps `"resourceId"
            // in episode` a reliable "is this buyable" test on the client.
            const episode = {
                owner, path: video.path, name: video.name, mime: video.mime,
                // Free content: a public URL instead of a purchase pointer. Both
                // are absent on a catalog entry that is neither.
                ...(video.url ? { url: video.url } : {}),
                ...(video.resourceId ? {
                    price: String(video.price),
                    resourceId: video.resourceId, workerUrl: video.workerUrl,
                    plaintextHash: video.plaintextHash, chunks: video.chunks ?? 1,
                    // Byte geometry + mime, or the hit plays by downloading the whole
                    // file and guessing what it is (see src/pay/stream.js streamBlocker).
                    size: video.size, chunkSize: video.chunkSize,
                } : {}),
            };
            // Namespaced by owner: two publishers can hold the same relpath.
            const emit = (row, vec) => {
                rows.push({ ...row, track_id: `${owner}:${row.track_id}`, ...(vec ? { vec } : {}), fields: { ...row.fields, episode } });
                n++;
            };

            // 1. the file itself — always, so a file with no dialogue is findable.
            if (video.embed && !usable(video.embed)) dropped++;
            emit(fileRow(video.path, video.name, { desc: video.desc }), usable(video.embed) ? video.embed.vec : null);

            // 2. its dialogue, if any.
            const subs = subsFor.get(video.path);
            if (!subs?.cues?.length) continue;
            const passages = toPassages(subs.cues);
            // Vectors are positional against toPassages(cues) — the ONLY thing
            // binding them is that both sides ran the same segmentation. A length
            // mismatch means the cues changed after embedding, so every vector is
            // shifted onto the wrong passage. Drop the lot; misaligned is worse
            // than absent.
            const vecs = usable(subs.embed) && subs.embed.vecs?.length === passages.length ? subs.embed.vecs : null;
            if (subs.embed && !vecs) dropped++;
            passageRows(video.path, video.name, passages).forEach((row, i) => emit(row, vecs?.[i]));
        }
        onProgress?.({ owner, passages: n, ...(dropped ? { dropped } : {}) });
    }
    return rows;
}

/** Walk media/ for .vtt sidecars and build every row. */
export function buildRows(mediaDir) {
    const rows = [];
    const rec = (rel) => {
        const abs = rel ? join(mediaDir, rel) : mediaDir;
        for (const d of readdirSync(abs, { withFileTypes: true })) {
            if (d.name.startsWith(".")) continue;
            const next = rel ? `${rel}/${d.name}` : d.name;
            if (d.isDirectory()) { rec(next); continue; }
            if (!d.name.toLowerCase().endsWith(".vtt")) continue;
            // Sidecars are "<file.ext>.vtt", so dropping the suffix IS the path
            // the catalog and the graph vertices are keyed by. ponytail: a
            // pre-rename "ep1.vtt" resolves to "ep1" and finds no video — the
            // server's own shard comes from aggregateRows, not this walk.
            const videoPath = next.replace(/\.vtt$/i, "");
            const cues = parseVtt(readFileSync(join(mediaDir, next), "utf-8"));
            rows.push(...passageRows(videoPath, videoPath.split("/").pop(), toPassages(cues)));
        }
    };
    if (existsSync(mediaDir)) rec("");
    return rows;
}

export function writeShard(rows, outFile) {
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(outFile, gzipSync(Buffer.from(ndjson, "utf-8")));
    return { rows: rows.length, bytes: readFileSync(outFile).length };
}

// ── CLI + self-check ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv.includes("--selfcheck")) {
        const cues = [
            { start: 0, end: 2, text: "Four to the floor," },
            { start: 2, end: 4, text: "and the beat goes on." },
            { start: 40, end: 42, text: "After a long silence." }, // > PASSAGE_GAP_S
        ];
        const ps = toPassages(cues);
        if (ps.length !== 2) throw new Error(`silence must split: got ${ps.length} passages`);
        if (ps[0].text !== "Four to the floor, and the beat goes on.") throw new Error(`joined text: ${ps[0].text}`);
        if (ps[0].start !== 0 || ps[0].end !== 4) throw new Error("passage must span first start → last end");
        if (ps[1].start !== 40) throw new Error("second passage must start at the post-silence cue");

        // Char budget splits too, and seek targets stay per-passage.
        const many = Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, text: "twenty chars of text" }));
        const split = toPassages(many);
        if (split.length < 2 || split.some((p) => p.text.length > PASSAGE_CHARS)) throw new Error("char budget not enforced");
        if (split[1].start <= split[0].start) throw new Error("passages must advance in time");

        const rows = passageRows("Show/a.mp4", "a.mp4", ps);
        if (rows[0].track_id !== "Show/a.mp4#p0") throw new Error("track_id shape changed — embedding cache keys on it");
        if (rows[0].fields.start !== 0 || !rows[0].fields.title.includes("0:00")) throw new Error("seek target lost");
        if ("embedding" in rows[0] || "vec" in rows[0]) throw new Error("shard builder must not invent embeddings");

        // File-level text carries the folders — most of the human labelling in a
        // file-manager library lives in folder names, and it's free.
        const ft = fileText({ name: "locura.mp3", path: "Live Sets/Berlin 2024/locura.mp3", desc: "spanish house" });
        if (!ft.includes("Berlin 2024") || !ft.includes("spanish house")) throw new Error(`fileText dropped context: ${ft}`);
        if (fileRow("a.mp3", "a.mp3").track_id !== "a.mp3#file") throw new Error("file row track_id shape changed");

        // ── aggregation across publishers, straight from graph payloads ──
        const MODEL = "nomic-ai/nomic-embed-text-v1.5", DIM = 256;
        const stamp = (extra) => ({ model: MODEL, dim: DIM, ...extra });
        const graph = {
            "0xaaa": {
                vertices: [
                    { payload: { kind: "video", path: "S1/a.mp4", name: "a.mp4", price: "1000", resourceId: "0xr1", workerUrl: "w", plaintextHash: "0xh1", chunks: 3, embed: stamp({ vec: "AAA=" }) } },
                    { payload: { kind: "subtitles", videoPath: "S1/a.mp4", cues, embed: stamp({ vecs: ["v0", "v1"] }) } },
                    { payload: { kind: "subtitles", videoPath: "S1/gone.mp4", cues } }, // video pruned → dropped
                ]
            },
            "0xbbb": {
                vertices: [
                    { payload: { kind: "video", path: "S1/a.mp4", name: "a.mp4", price: "5000", resourceId: "0xr2", workerUrl: "w2", plaintextHash: "0xh2" } },
                    { payload: { kind: "subtitles", videoPath: "S1/a.mp4", cues } },
                ]
            },
            // Audio with no dialogue at all — the case that used to vanish entirely.
            "0xddd": {
                vertices: [
                    { payload: { kind: "video", path: "locura.mp3", name: "locura.mp3", price: "1000", resourceId: "0xr3", workerUrl: "w", plaintextHash: "0xh3", mime: "audio/mpeg" } },
                ]
            },
            // Right shape, wrong model — must not be blended into the index.
            "0xeee": {
                vertices: [
                    { payload: { kind: "video", path: "x.mp4", name: "x.mp4", price: "1", resourceId: "0xr4", workerUrl: "w", plaintextHash: "0xh4", embed: { model: "some-other-model", dim: 256, vec: "ZZZ=" } } },
                    { payload: { kind: "subtitles", videoPath: "x.mp4", cues, embed: stamp({ vecs: ["only-one"] }) } }, // 1 vec, 2 passages
                ]
            },
            // A free catalog entry: committed to the graph and embedded, but never
            // minted as a resource. It must be searchable and must never look
            // buyable — no resourceId means no price, no worker, no bytes.
            "0xfff": {
                vertices: [
                    { payload: { kind: "video", path: "papers/umwelt.txt", name: "umwelt.txt", mime: "text/plain", desc: "on umwelt and biophilosophy", embed: stamp({ vec: "AAA=" }) } },
                ]
            },
            "0xccc": null, // unreachable namespace
        };
        const agg = await aggregateRows({
            namespace: "sond3r", model: MODEL, dim: DIM,
            publishers: ["0xaaa", "0xbbb", "0xddd", "0xeee", "0xfff", "0xccc"],
            listNamespace: async (_ns, owner) => graph[owner] ?? (() => { throw new Error("no head"); })(),
        });
        if (!agg.length) throw new Error("aggregation produced nothing");
        // Buyable rows must carry the whole pointer; a partial one is a hit that
        // takes payment and then can't decrypt.
        const buyable = agg.filter((r) => r.fields.episode?.resourceId);
        if (buyable.some((r) => !r.fields.episode.workerUrl || !r.fields.episode.price)) throw new Error("row with a resourceId but no way to fetch or price it");
        if (agg.some((r) => r.fields.videoPath === "S1/gone.mp4")) throw new Error("orphan cues must be dropped");
        // Same relpath under two publishers must not collide, and each keeps its own price.
        const ids = agg.map((r) => r.track_id);
        if (new Set(ids).size !== ids.length) throw new Error("track_id collision across publishers");
        if (agg.find((r) => r.fields.episode.owner === "0xbbb").fields.episode.price !== "5000") throw new Error("per-publisher pointer crossed over");
        if (agg.find((r) => r.fields.episode.owner === "0xaaa").fields.episode.chunks !== 3) throw new Error("chunk count lost");
        if (agg.find((r) => r.fields.episode.owner === "0xbbb").fields.episode.chunks !== 1) throw new Error("missing chunks must default to 1");

        // A file with no cues still gets exactly one row — the whole point of
        // fileRow. This is the regression that made locura.mp3 unsearchable.
        const solo = agg.filter((r) => r.fields.videoPath === "locura.mp3");
        if (solo.length !== 1 || solo[0].fields.entityType !== "File") throw new Error("a file with no dialogue must still produce one File row");
        if (!solo[0].fields.text.includes("locura")) throw new Error("file row lost its text");
        // Every video gets a file row, cues or not.
        if (agg.filter((r) => r.fields.entityType === "File").length !== 5) throw new Error("one File row per published file");

        // The catalog entry: findable, embedded, and unbuyable. If any of the
        // purchase fields leak in as undefined, `"resourceId" in episode` stops
        // being a usable test and the UI offers a Buy button for nothing.
        const free = agg.find((r) => r.track_id === "0xfff:papers/umwelt.txt#file");
        if (!free) throw new Error("a catalog entry must still be searchable — the index is the whole point of publishing it");
        if (!free.fields.text.includes("umwelt")) throw new Error("catalog entry lost its description text");
        if (free.vec !== "AAA=") throw new Error("catalog entry lost its vector");
        for (const k of ["resourceId", "price", "workerUrl", "plaintextHash", "size", "chunkSize"]) {
            if (k in free.fields.episode) throw new Error(`catalog entry leaked ${k} — it must be absent, not undefined`);
        }

        // Vectors ride through, positionally, and only when the stamp matches.
        if (agg.find((r) => r.track_id === "0xaaa:S1/a.mp4#file").vec !== "AAA=") throw new Error("file vector lost");
        if (agg.find((r) => r.track_id === "0xaaa:S1/a.mp4#p1").vec !== "v1") throw new Error("passage vectors misaligned");
        if (agg.some((r) => r.track_id.startsWith("0xbbb") && r.vec)) throw new Error("invented a vector for a publisher who committed none");
        if (agg.some((r) => r.track_id.startsWith("0xeee") && r.vec)) throw new Error("foreign-model / miscounted vectors must be dropped, not ranked");

        console.log("shard.js self-check ok — silence split, char budget, row shape, file rows, vector stamps, multi-publisher aggregation, unbuyable catalog entries");
    } else {
        const rows = buildRows(join(process.cwd(), "media"));
        const out = join(process.cwd(), "public", "subtitles.ndjson.gz");
        if (!existsSync(join(process.cwd(), "public"))) {
            const { mkdirSync } = await import("node:fs");
            mkdirSync(join(process.cwd(), "public"), { recursive: true });
        }
        const { rows: n, bytes } = writeShard(rows, out);
        const withVec = rows.filter((r) => r.embedding).length;
        console.log(`${out}: ${n} passages, ${(bytes / 1024).toFixed(1)} KiB gzipped, ${withVec} embedded`);
        if (!n) console.log("(no .vtt sidecars under media/ — publish generates them, or drop your own in)");
    }
}
