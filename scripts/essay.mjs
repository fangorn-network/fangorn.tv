#!/usr/bin/env node
// Assemble an essay film out of remote archive footage.
//
// program.mjs makes a 1987 broadcast; this makes the other thing — black title
// cards, sparse captions, one continuous music bed under the whole cut. Same
// spine as program.mjs (render each piece on its own from a range request, join
// with the concat demuxer) because one filter_complex spanning thirty pieces
// with per-piece text is unreadable and unfixable at 3am.
//
//   node scripts/essay.mjs film.json out.mp4
//
// film.json: {
//   bed?: { url, start, dur, gain? },        // music under the whole cut
//   pieces: [
//     { url, start, dur, sound?, over?: [l1, l2], quote?: "…" }  // footage
//     { card: [line, …], dur }                                   // black card
//   ] }
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";

const [specPath, out] = process.argv.slice(2);
if (!specPath || !out) { console.error("usage: essay.mjs film.json out.mp4"); process.exit(1); }
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const W = 1280, H = 720, FPS = 24;
const SERIF = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf";
const SERIF_B = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf";
const SERIF_I = "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf";

// archive.org 5XXs on a range request often enough that a thirty-piece render
// would rarely finish without this. Rendered pieces are kept next to the output
// too, so a rerun resumes instead of re-fetching what already worked.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args) => {
    for (let attempt = 1; ; attempt++) {
        const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-stats", ...args],
            { stdio: "inherit" });
        if (r.status === 0) return;
        if (attempt === 4) { console.error(`ffmpeg failed on: ${args.join(" ")}`); process.exit(r.status ?? 1); }
        console.error(`  retry ${attempt} …`);
        sleep(3000 * attempt);
    }
};
// drawtext eats : ' \ and %. Escaping is the whole reason this is a function.
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
const dt = (o) => "drawtext=" + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(":");
// drawtext cannot shrink text to fit, and a card that runs off the frame is the
// one thing nobody forgives. Liberation Serif averages ~0.50em regular / ~0.52em
// bold, close enough to keep a line inside the margins without measuring glyphs.
const fit = (text, max, margin, em = 0.5) =>
    Math.min(max, Math.floor((W - margin) / (em * Math.max(text.length, 1))));
// A failed probe must not be read as "no audio" — that would silently mute a
// piece because the CDN hiccuped, which looks exactly like a genuinely silent source.
const hasAudio = (url) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries",
            "stream=index", "-of", "csv=p=0", url], { encoding: "utf8" });
        if (r.status === 0) return r.stdout.trim() !== "";
        sleep(2000 * attempt);
    }
    console.error(`could not probe ${url}`); process.exit(1);
};
const audioCache = new Map();

const dir = `${out}.parts`;
mkdirSync(dir, { recursive: true });
const parts = [];
let clock = 0;

spec.pieces.forEach((p, i) => {
    const part = join(dir, `p${String(i).padStart(2, "0")}.mp4`);
    const label = p.card?.[0] ?? p.over?.[0] ?? p.quote ?? "—";
    const dur = p.dur ?? 4;
    parts.push(part);
    if (existsSync(part)) { clock += dur; console.log(`  [${i + 1}/${spec.pieces.length}] cached  ${label}`); return; }

    const t = [];
    let inputs, mute = true;

    if (p.card) {
        // A card is a fade to black with words on it; fading the whole frame is
        // exactly the right gesture, so no per-line alpha maths.
        inputs = ["-f", "lavfi", "-t", String(dur), "-i", `color=c=0x080807:s=${W}x${H}:r=${FPS}`,
            "-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo",
            "-map", "0:v", "-map", "1:a"];
        const n = p.card.length;
        p.card.forEach((line, k) => {
            if (!line) return;
            const lead = k === 0 ? 0 : 8;
            const size = k === 0 ? fit(line, 56, 200, 0.52) : fit(line, 30, 240);
            t.push(dt({
                fontfile: k === 0 ? SERIF_B : SERIF_I, text: `'${esc(line)}'`,
                fontcolor: k === 0 ? "0xF2EFE6" : "0x9C968A", fontsize: size,
                x: "(w-text_w)/2", y: `(h-${n * 62})/2+${k * 62 + lead}`,
            }));
        });
        t.push("format=yuv420p", `fade=t=in:st=0:d=0.45`, `fade=t=out:st=${(dur - 0.5).toFixed(2)}:d=0.5`);
    } else {
        const silent = !p.sound || !(audioCache.has(p.url) ? audioCache.get(p.url)
            : (audioCache.set(p.url, hasAudio(p.url)), audioCache.get(p.url)));
        mute = silent;
        inputs = silent
            ? ["-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo",
               "-ss", String(p.start), "-t", String(dur), "-i", p.url, "-map", "1:v", "-map", "0:a"]
            : ["-ss", String(p.start), "-t", String(dur), "-i", p.url, "-map", "0:v", "-map", "0:a"];

        // The sources are 4:3 nitrate scans, 512kbps derivatives and 320x240
        // computer animation. Pillarbox rather than crop: the framing of a 1936
        // industrial film is the one thing an editor has no right to restage.
        t.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
            `pad=${W}:${H}:-1:-1:color=0x080807`, "setsar=1", `fps=${FPS}`,
            "eq=contrast=1.05:saturation=0.96");

        if (p.over) {
            // Source credit, bottom left, up for the first few seconds only —
            // enough to make the provenance legible without captioning the film.
            const on = `enable='between(t,0.5,${Math.min(dur, 4.5).toFixed(2)})'`;
            t.push(dt({ fontfile: SERIF, text: `'${esc(p.over[0])}'`, fontcolor: "0xF2EFE6",
                fontsize: 30, x: 56, y: `h-${p.over[1] ? 116 : 78}`,
                shadowcolor: "black@0.85", shadowx: 1, shadowy: 2 }) + ":" + on);
            if (p.over[1]) t.push(dt({ fontfile: SERIF_I, text: `'${esc(p.over[1])}'`, fontcolor: "0xB9B2A4",
                fontsize: 24, x: 56, y: "h-78",
                shadowcolor: "black@0.85", shadowx: 1, shadowy: 2 }) + ":" + on);
        }
        if (p.quote) {
            const on = `enable='between(t,0.3,${(dur - 0.2).toFixed(2)})'`;
            t.push(dt({ fontfile: SERIF_I, text: `'${esc(p.quote)}'`, fontcolor: "0xF2EFE6",
                fontsize: fit(p.quote, 38, 260), x: "(w-text_w)/2", y: "h-160",
                box: 1, boxcolor: "0x080807@0.55", boxborderw: 16,
                shadowcolor: "black@0.9", shadowx: 1, shadowy: 2 }) + ":" + on);
        }
        // Grain last so it sits over the captions too — a caption printed on a
        // clean plate over a grainy plate reads as a screenshot, not a film.
        t.push("noise=alls=5:allf=t", "vignette=PI/6", "format=yuv420p");
        if (p.fadein) t.push(`fade=t=in:st=0:d=${p.fadein}`);
        if (p.fadeout) t.push(`fade=t=out:st=${(dur - p.fadeout).toFixed(2)}:d=${p.fadeout}`);
    }

    // loudnorm on a pure anullsrc emits NaN and kills the encoder, so silence
    // stays silence rather than being "normalized".
    run([...inputs, "-vf", t.join(","),
        ...(mute ? [] : ["-af", "loudnorm=I=-18:TP=-1.5:LRA=11" +
            (p.fadeout ? `,afade=t=out:st=${(dur - p.fadeout).toFixed(2)}:d=${p.fadeout}` : "")]),
        "-c:v", "libx264", "-crf", "19", "-preset", "veryfast", "-r", String(FPS),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", part]);
    clock += dur;
    console.log(`  [${i + 1}/${spec.pieces.length}] ${dur}s @${clock.toFixed(1)}  ${label}`);
});

// concat resolves each entry relative to the LIST file, not to the cwd.
writeFileSync(join(dir, "list.txt"), parts.map((f) => `file '${basename(f)}'`).join("\n"));
const joined = spec.bed ? join(dir, "joined.mp4") : out;
run(["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-c", "copy", joined]);

// The bed is one unbroken take of score laid under the cut, so the picture can
// change thirty times without the film sounding like thirty films. It stops
// where the spec says it stops; from there the last source carries its own sound.
if (spec.bed) {
    const b = spec.bed;
    run(["-i", joined, "-ss", String(b.start), "-t", String(b.dur), "-i", b.url,
        "-filter_complex",
        `[1:a]loudnorm=I=-20:TP=-2:LRA=11,volume=${b.gain ?? 1},` +
        `afade=t=in:st=0:d=1.5,afade=t=out:st=${(b.dur - 3).toFixed(2)}:d=3,` +
        `apad=whole_dur=${clock.toFixed(2)}[bed];` +
        `[0:a][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
        "-map", "0:v", "-map", "[a]", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out]);
}
rmSync(dir, { recursive: true, force: true });

const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
    { encoding: "utf8" }).stdout.trim();
const det = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" }).stderr ?? "";
const mean = /mean_volume: (-?[\d.]+) dB/.exec(det)?.[1];
console.log(`\n${out} — ${spec.pieces.length} pieces, ${Number(dur).toFixed(1)}s, mean ${mean ?? "?"} dB`);
