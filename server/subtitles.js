// WebVTT → cues, for the semantic graph. Unlike the media bytes, cues are
// PUBLIC: they ride in the Fangorn commit as their own vertex, so they can be
// embedded for semantic search ("which episode says X, and at what timestamp")
// without anyone paying for the video.
//
// This module used to also RUN whisper. It doesn't any more: publishing happens
// in the publisher's browser, so no media file ever reaches this process and
// there is nothing here to transcribe. Cues come from `.vtt` sidecars the
// publisher writes, which was always the hand-correction path anyway — edit the
// file and the next publish commits your text.
//
// Parsing only, so no ffmpeg, no python and no model weights in the image.

/** "00:01:02.500" | "01:02.500" → seconds. */
const toSeconds = (t) =>
    t.split(":").reverse().reduce((s, part, i) => s + Number(part) * 60 ** i, 0);

/** WebVTT → [{ start, end, text }]. Ignores the header, NOTEs and cue ids. */
export function parseVtt(text) {
    const cues = [];
    for (const block of text.replace(/\r/g, "").trim().split(/\n{2,}/)) {
        const lines = block.split("\n").filter((l) => l.trim());
        const i = lines.findIndex((l) => l.includes("-->"));
        if (i < 0) continue; // WEBVTT header, NOTE block, styling
        const [start, end] = lines[i].split("-->").map((s) => s.trim().split(/\s+/)[0]);
        const body = lines.slice(i + 1).join(" ").trim();
        if (body) cues.push({ start: toSeconds(start), end: toSeconds(end), text: body });
    }
    return cues;
}

/** Caps on a cue list arriving from a browser. Generous for a feature film's
 *  dialogue, small enough that one publish cannot commit a novel to the chain. */
export const MAX_CUES = 4000;
export const MAX_CUE_CHARS = 1000;

/**
 * Untrusted `[{start,end,text}]` → the same, or throw.
 *
 * Cues are the ONE field of a published library whose contents are neither
 * derived from the filesystem nor bounded by an upload — a .vtt sidecar, or now
 * an agent's scene descriptions. They land in a public on-chain graph, so they
 * get the same deliberate field-by-field treatment normalizeLibrary gives
 * everything else rather than riding in as whatever the caller sent.
 *
 * Sorted by start, because toPassages() windows on the gap between consecutive
 * cues and reads an out-of-order list as one long silence per cue.
 */
export function normalizeCues(cues, { max = MAX_CUES, chars = MAX_CUE_CHARS } = {}) {
    if (!Array.isArray(cues)) throw new Error("cues must be an array");
    if (cues.length > max) throw new Error(`too many cues: ${cues.length} > ${max}`);
    const out = cues.map((c, i) => {
        const start = Number(c?.start);
        // `end` is optional: a scene description is a point in time that the
        // caller may not have bothered to close. A zero-length cue still seeks.
        const end = c?.end == null ? start : Number(c.end);
        const text = typeof c?.text === "string" ? c.text.trim().slice(0, chars) : "";
        if (!Number.isFinite(start) || start < 0) throw new Error(`cue ${i}: bad start ${JSON.stringify(c?.start)}`);
        if (!Number.isFinite(end) || end < start) throw new Error(`cue ${i}: bad end ${JSON.stringify(c?.end)}`);
        if (!text) throw new Error(`cue ${i}: empty text`);
        return { start, end, text };
    });
    return out.sort((a, b) => a.start - b.start);
}

// ── self-check: `node server/subtitles.js` — parser only, no ffmpeg/whisper ────
// `process` doesn't exist in the browser, and src/ui/webmcp.js imports
// normalizeCues from here so an agent's scenes meet the same validation in the
// tab that they will meet at the publish boundary — so this guard has to survive
// being evaluated by a browser, same as the one in server/graph.js.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const cues = parseVtt(`WEBVTT

NOTE whisper output

1
00:00:00.000 --> 00:00:02.500
Four to the floor,

00:01:02.500 --> 01:00:04.000 align:start position:0%
and the beat
goes on.
`);
    const want = [
        { start: 0, end: 2.5, text: "Four to the floor," },
        { start: 62.5, end: 3604, text: "and the beat goes on." },
    ];
    if (JSON.stringify(cues) !== JSON.stringify(want)) {
        throw new Error(`parseVtt: got ${JSON.stringify(cues)}`);
    }
    if (parseVtt("WEBVTT\n").length !== 0) throw new Error("empty vtt must yield no cues");

    // normalizeCues: the browser-facing half. Every throw here is a shape that
    // would otherwise reach a public graph or misalign a vector array.
    const threw = (f, why) => { try { f(); } catch { return; } throw new Error(`must reject: ${why}`); };
    const n = normalizeCues([
        { start: 40, end: 44, text: "  a man lights a cigarette in the rain  " },
        { start: 2, text: "close on her face" },
    ]);
    if (n[0].start !== 2) throw new Error("cues must come back sorted — toPassages windows on the gap between them");
    if (n[0].end !== 2) throw new Error("a cue with no end must close at its start, not NaN");
    if (n[1].text !== "a man lights a cigarette in the rain") throw new Error("text not trimmed");
    if (normalizeCues([{ start: 0, text: "x".repeat(2000) }])[0].text.length !== MAX_CUE_CHARS) throw new Error("cue text not capped");
    threw(() => normalizeCues("nope"), "a non-array");
    threw(() => normalizeCues([{ start: -1, text: "t" }]), "a negative start");
    threw(() => normalizeCues([{ start: 5, end: 1, text: "t" }]), "an end before its start");
    threw(() => normalizeCues([{ start: 0, text: "   " }]), "empty text");
    threw(() => normalizeCues([{ start: "soon", text: "t" }]), "a non-numeric start");
    threw(() => normalizeCues(Array.from({ length: MAX_CUES + 1 }, (_, i) => ({ start: i, text: "t" }))), "more cues than the cap");

    console.log("subtitles.js self-check ok — vtt parse, header/NOTE skip, multi-line cue, hh:mm:ss, cue normalization");
}
