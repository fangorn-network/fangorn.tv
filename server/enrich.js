// What a file is ABOUT, read from the file itself.
//
// fileText() (shard.js) is the honest floor: a name, its folders, and whatever
// the publisher typed. For most libraries that's a filename and nothing else,
// and a vector built from a filename ranks about as well as one — measured on
// this storefront, "philosophy reading" put a metalcore mp3 above a
// phenomenology PDF, and "something spacey" ranked milky-way.mp4 dead last.
//
// The file usually knows better than its name. A PDF carries its real title
// ("Jakob_von_Uexkull_Beyond_Bubbles_On_Umwe.pdf" is truncated mid-word; the
// document says "Beyond Bubbles: On Umwelt and Biophilosophy" — the two concept
// words the filename lost). An mp3 carries artist, album and genre. Reading
// them moved top-1 accuracy on an 11-query probe from 7/11 to 9/11, where
// filename cleanup alone moved it 7/11 → 7/11.
//
// This runs at publish time on the publisher's own machine, over a file already
// being read to encrypt and upload. Extraction is stdlib-only and every step is
// best-effort: a malformed PDF, an exotic tag, an unreadable file all fall back
// to the name, because a weaker vector is not a reason to fail a publish.
//
// ponytail: format sniffing by mime, no parser dependencies. PDF and ID3 cover
// the text and music cases. Images and speech need a model, not a parser — see
// the note at the bottom.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** How much extracted content joins the text. The vector is 256-d and averaged
 *  over the whole document, so a long tail of boilerplate dilutes the title it
 *  was meant to reinforce. */
export const CONTENT_CHARS = 600;

/** Filename → words. Extensions, separators and release-note brackets are
 *  tokens the model has to average over and none of them mean anything:
 *  "Bilmuri - KINDA HARD [OFFICIAL VISUALIZER].mp3" → "Bilmuri KINDA HARD". */
export function nameWords(s) {
    return String(s)
        .replace(/\.[a-z0-9]{1,5}$/i, "")          // extension
        .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")     // [OFFICIAL VISUALIZER], (ver 2 by …)
        .replace(/[_\-.]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")       // camelCase
        .replace(/\s+/g, " ").trim();
}

// The mime never reached the embedded text at all, which is why "movies"
// matched nothing in a catalog full of video/mp4. Plain words, not mime
// strings — the query side says "movie", never "video/mp4".
//
// Kept short on purpose: a long shared phrase on every video pulls all videos
// toward each other and away from what makes each one different.
const KIND = [
    [/^audio\//, "music track"],
    [/^video\//, "video, a movie you watch"],
    [/^image\//, "picture, a photo you look at"],
    [/pdf$/, "PDF document you read"],
    [/^text\//, "text document"],
];
export const kindWords = (mime = "") => KIND.find(([re]) => re.test(String(mime)))?.[1] ?? "";

/**
 * PDF → its title and the top of its text.
 *
 * Enough of a reader to find words, not a PDF library: pull `/Title` from the
 * info dictionary, then inflate the first few content streams and keep what's
 * inside the string literals the text operators draw. Everything that isn't a
 * flate stream is skipped silently, which is most of a PDF.
 *
 * ponytail: first streams, not first page — page order isn't stream order, so
 * this can catch a cover page instead of an abstract. It still beat the
 * filename by two ranks. Reach for a real parser when a measured miss says to.
 */
export function pdfText(buf, max = CONTENT_CHARS) {
    const s = buf.toString("latin1");
    const title = /\/Title\s*\(([^)]{0,200})\)/.exec(s)?.[1] ?? "";
    let out = "", streams = 0;
    for (const m of s.matchAll(/stream\r?\n/g)) {
        if (streams >= 3 || out.length > max) break;
        const start = m.index + m[0].length;
        const end = s.indexOf("endstream", start);
        if (end < 0) break;
        try {
            const page = inflateSync(buf.subarray(start, end)).toString("latin1");
            // Text lives inside ( … ) literals; \) is an escaped paren, not a close.
            const text = [...page.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((x) => x[0].slice(1, -1)).join("");
            if (text.length > 80) { out += `${text} `; streams++; }
        } catch { /* not a flate stream — most of them aren't */ }
    }
    return `${title} ${out}`.replace(/\\\d{3}|\s+/g, " ").trim().slice(0, max);
}

// The four ID3v2 frames that say what a track is. TCON is genre, which is the
// one a query like "something mellow" can actually reach.
const ID3_FRAMES = { TIT2: 1, TPE1: 1, TALB: 1, TCON: 1 };

/** mp3 → "title artist album genre" from its ID3v2 header, or "". */
export function id3Text(buf) {
    if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return "";
    // Syncsafe integer: 7 bits per byte, so a size can never contain 0xFF and be
    // mistaken for a frame sync. Masking is not optional.
    const size = ((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) | ((buf[8] & 127) << 7) | (buf[9] & 127);
    const end = Math.min(10 + size, buf.length);
    const out = [];
    let o = 10;
    while (o + 10 <= end) {
        const id = buf.toString("latin1", o, o + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding, or v2.2 — either way, done
        const len = buf.readUInt32BE(o + 4);
        if (len <= 0 || o + 10 + len > end) break;
        if (ID3_FRAMES[id]) {
            // Byte 0 of a text frame is its encoding; utf8 decoding of latin1 and
            // utf16 payloads is wrong in ways that are still more searchable than
            // nothing, so strip the nulls and move on.
            const v = buf.toString("utf8", o + 11, o + 10 + len).replace(/\0/g, " ").trim();
            if (v) out.push(v);
        }
        o += 10 + len;
    }
    return out.join(" ").slice(0, CONTENT_CHARS);
}

/** Read whatever the bytes will tell us. Never throws — an unreadable or
 *  unsupported file simply contributes nothing. */
export function contentText(abs, mime = "") {
    try {
        if (/pdf$/.test(mime)) return pdfText(readFileSync(abs));
        if (/^audio\/(mpeg|mp3)$/.test(mime)) return id3Text(readFileSync(abs));
    } catch { /* missing, unreadable, or not what its extension claims */ }
    return "";
}

/**
 * The text a buyer's query has to match, for one file.
 *
 * Ordered strongest-signal-first — mean pooling doesn't care about position,
 * but the truncation at CONTENT_CHARS does, and what gets cut should be the
 * boilerplate at the end of a cover page, not the title.
 *
 * @param abs absolute path, or null to skip content extraction (the shard bake
 *            reads from the chain and has no files).
 */
export function enrichText({ name, path, desc, mime, abs = null }) {
    const folders = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/") : [];
    return [
        nameWords(name),
        ...folders.map(nameWords),
        desc,
        kindWords(mime),
        abs ? contentText(abs, mime) : "",
    ].filter(Boolean).join(" — ");
}

// Images and dialogue-free video are the gap this can't close: there is nothing
// in a JPEG's bytes that says "scifi western". That needs a captioning model,
// which is a real dependency and a real runtime, not a parser — and it belongs
// in the same browser that already runs the embedder at publish time.

// ── self-check: `node server/enrich.js` — no files, no model ──────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const { deflateSync } = await import("node:zlib");
    const eq = (got, want, msg) => { if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)}`); };

    eq(nameWords("Bilmuri - KINDA HARD [OFFICIAL VISUALIZER].mp3"), "Bilmuri KINDA HARD", "release junk survived");
    eq(nameWords("Jakob_von_Uexkull_Beyond_Bubbles.pdf"), "Jakob von Uexkull Beyond Bubbles", "underscores survived");
    eq(nameWords("milky-way.mp4"), "milky way", "hyphens survived");
    eq(nameWords("myGreatFile.mp4"), "my Great File", "camelCase not split");
    // A name that is nothing but junk must not become empty and take the file
    // out of the index entirely.
    if (!nameWords("track (2).gp5").length) throw new Error("stripping must not empty a name");

    // The bug that started this: mime never reached the text, so "movies" had
    // nothing to match in a catalog full of video/mp4.
    if (!kindWords("video/mp4").includes("movie")) throw new Error("video must read as a movie");
    if (!kindWords("application/pdf").includes("read")) throw new Error("pdf must read as a document");
    eq(kindWords("application/x-gp5"), "", "unknown mime must add nothing rather than guess");
    eq(kindWords(), "", "missing mime must not throw");

    // A minimal PDF: info dict + one flate content stream.
    const body = deflateSync(Buffer.from("BT (Beyond Bubbles: On Umwelt and Biophilosophy, a review of the work of Jakob von Uexkull) Tj ET"));
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n/Title (REVIEW)\n5 0 obj\n<<>>\nstream\n", "latin1"), body, Buffer.from("\nendstream\n", "latin1")]);
    const got = pdfText(pdf);
    if (!got.includes("REVIEW")) throw new Error(`/Title lost: ${got}`);
    if (!got.includes("Umwelt")) throw new Error(`stream text lost: ${got}`);
    if (pdfText(Buffer.from("not a pdf at all")) !== "") throw new Error("garbage must extract to nothing, not throw");
    if (pdfText(Buffer.from("%PDF-1.4 stream\nnot deflate data endstream")) !== "") throw new Error("undeflatable stream must be skipped");
    if (pdfText(pdf, 10).length > 10) throw new Error("max not honoured");

    // ID3v2: syncsafe size, four frames, one ignored.
    const frame = (id, text) => { const v = Buffer.from(`\0${text}`, "latin1"); const h = Buffer.alloc(10); h.write(id, 0, "latin1"); h.writeUInt32BE(v.length, 4); return Buffer.concat([h, v]); };
    const frames = Buffer.concat([frame("TIT2", "Kinda Hard"), frame("TPE1", "Bilmuri"), frame("TCON", "Metalcore"), frame("TENC", "ignored")]);
    const head = Buffer.alloc(10); head.write("ID3", 0, "latin1"); head[3] = 3;
    // Syncsafe: 200 is > 127, so it must occupy two 7-bit groups.
    const n = frames.length; head[6] = (n >> 21) & 127; head[7] = (n >> 14) & 127; head[8] = (n >> 7) & 127; head[9] = n & 127;
    const tag = id3Text(Buffer.concat([head, frames]));
    eq(tag, "Kinda Hard Bilmuri Metalcore", "id3 frames wrong");
    if (id3Text(Buffer.from("no tag here")) !== "") throw new Error("untagged mp3 must yield nothing, not throw");
    if (id3Text(Buffer.alloc(3)) !== "") throw new Error("truncated file must not read past its end");
    // A frame claiming to run past the tag must stop the walk, not read garbage.
    const bad = Buffer.concat([head, frame("TIT2", "x")]); bad.writeUInt32BE(9999, 14);
    if (id3Text(bad) !== "") throw new Error("overlong frame must be rejected");

    // enrichText: order and graceful degradation.
    const t = enrichText({ name: "milky-way.mp4", path: "videos/milky-way.mp4", mime: "video/mp4" });
    if (!t.startsWith("milky way")) throw new Error(`name must lead: ${t}`);
    if (!t.includes("videos") || !t.includes("movie")) throw new Error(`folder and kind missing: ${t}`);
    // No abs path (the shard bake has no files) must still produce usable text.
    if (enrichText({ name: "a.mp3", path: "a.mp3", mime: "audio/mpeg" }) !== "a — music track") throw new Error("bare file text wrong");
    // A file that vanished between prepare and embed must not fail the publish.
    if (!enrichText({ name: "gone.pdf", path: "x/gone.pdf", mime: "application/pdf", abs: "/nope/gone.pdf" }).includes("gone")) throw new Error("missing file must degrade to the name");

    console.log("enrich.js self-check ok — name hygiene, kind words, pdf title+text, id3 frames, degradation");
}
