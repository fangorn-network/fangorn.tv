#!/usr/bin/env node
// Assemble a fake broadcast out of remote archive footage.
//
// cut.mjs makes a supercut; this makes a PROGRAM — titles, chyrons, a station
// bug, and the 1987 tape look — out of the same kind of edit list. Each piece is
// rendered on its own (range-requested, never downloaded whole) and joined with
// the concat demuxer, because one filter_complex spanning twenty pieces with
// per-piece text is unreadable and unfixable at 3am.
//
//   node scripts/program.mjs program.json out.mp4
//
// program.json: { bug?: "KZQP 9", pieces: [ { url, start, dur,
//   lower?: [big, small, at, len], title?: [big, small, at, len],
//   card?: [line, ...]  } ] }
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";

const [specPath, out] = process.argv.slice(2);
if (!specPath || !out) { console.error("usage: program.mjs program.json out.mp4"); process.exit(1); }
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const W = 640, H = 480, FPS = 30;            // 4:3, the shape a 1987 set actually was
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

// archive.org 5XXs on a range request often enough that a twenty-piece render
// would rarely finish without this. Rendered pieces are also kept next to the
// output, so a rerun resumes instead of re-fetching what already worked.
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
// drawtext cannot shrink text to fit, and a chyron that runs off a 640-wide
// frame is the one 1987 artifact nobody was going for. DejaVu's average advance
// is ~0.58em bold / ~0.55em regular, which is close enough to keep a line inside
// the margins without measuring glyphs.
const fit = (text, max, margin, em = 0.58) =>
    Math.min(max, Math.floor((W - margin) / (em * Math.max(text.length, 1))));

// A failed probe must not be read as "no audio" — that would silently mute a
// piece because the CDN hiccuped, which looks exactly like a source that is
// genuinely silent.
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

spec.pieces.forEach((p, i) => {
    const t = [];

    // ── the tape look ────────────────────────────────────────────────────────
    // Crush to 320x240 and blow it back up with nearest-neighbour: that is what
    // makes it read as a dub of a dub rather than as clean film. Chroma is
    // shifted separately because bleeding colour off the luma edges is the single
    // most recognisable VHS artifact. Footage is degraded BEFORE the text goes on
    // — a studio chyron was inserted on a clean signal and taped with it, so it
    // gets only the light grain applied at the end.
    t.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`,
        `pad=${W}:${H}:-1:-1:color=black`, "setsar=1", `fps=${FPS}`,
        "scale=320:240", `scale=${W}:${H}:flags=neighbor`,
        "eq=saturation=1.35:contrast=1.06:brightness=0.012",
        "chromashift=cbh=4:crh=-3", "gblur=sigma=0.4");

    const shadow = { shadowcolor: "black@0.8", shadowx: 2, shadowy: 2 };

    if (p.title) {
        const [big, small, at = 0, len = 6] = p.title;
        const on = `enable='between(t,${at},${at + len})'`;
        t.push(dt({ fontfile: FONT, text: `'${esc(big)}'`, fontcolor: "white", fontsize: fit(big, 46, 60),
            x: "(w-text_w)/2", y: "h/2-70", borderw: 3, bordercolor: "black", ...shadow }) + ":" + on);
        if (small) t.push(dt({ fontfile: FONT_R, text: `'${esc(small)}'`, fontcolor: "0xE8D34A", fontsize: fit(small, 24, 60, 0.55),
            x: "(w-text_w)/2", y: "h/2+10", borderw: 2, bordercolor: "black", ...shadow }) + ":" + on);
    }
    if (p.lower) {
        // ponytail: the bar is drawtext's own box, not an overlaid rectangle. One
        // filter instead of two inputs and a scale, and it tracks the text width
        // the way a real chyron generator did.
        const [big, small, at = 0.5, len = 7] = p.lower;
        const on = `enable='between(t,${at},${at + len})'`;
        t.push(dt({ fontfile: FONT, text: `'${esc(big)}'`, fontcolor: "white", fontsize: fit(big, 26, 120),
            x: 42, y: `h-104`, box: 1, boxcolor: "0x1a1a8c@0.78", boxborderw: 10, ...shadow }) + ":" + on);
        if (small) t.push(dt({ fontfile: FONT_R, text: `'${esc(small)}'`, fontcolor: "0xE8D34A", fontsize: fit(small, 19, 120, 0.55),
            x: 42, y: `h-64`, box: 1, boxcolor: "0x1a1a8c@0.78", boxborderw: 8, ...shadow }) + ":" + on);
    }
    (p.card ?? []).forEach((line, n) => {
        t.push(dt({ fontfile: n === 0 ? FONT : FONT_R, text: `'${esc(line)}'`,
            fontcolor: n === 0 ? "white" : "0xCCCCCC",
            fontsize: n === 0 ? fit(line, 30, 60) : fit(line, 20, 60, 0.55),
            x: "(w-text_w)/2", y: `${140 + n * 38}`, ...shadow }));
    });
    if (spec.bug) t.push(dt({ fontfile: FONT, text: `'${esc(spec.bug)}'`, fontcolor: "white@0.62",
        fontsize: 22, x: `w-text_w-24`, y: 24, ...shadow }));

    // Grain last so it sits over the chyrons too, then the darkened corners of a
    // camera nobody adjusted.
    t.push("noise=alls=8:allf=t", "vignette=PI/5", "format=yuv420p");

    // Broadcast audio was band-limited long before it reached anyone's TV, and
    // the levels across a 1953 B-movie and a 1990s video doc are nowhere near
    // each other — both get fixed here rather than in the join.
    const url = p.url;
    if (!audioCache.has(url)) audioCache.set(url, hasAudio(url));
    const silent = !audioCache.get(url);
    const part = join(dir, `p${String(i).padStart(2, "0")}.mp4`);
    if (existsSync(part)) { parts.push(part); console.log(`  [${i + 1}/${spec.pieces.length}] cached`); return; }
    const inputs = silent
        ? ["-f", "lavfi", "-t", String(p.dur), "-i", "anullsrc=r=48000:cl=stereo", "-ss", String(p.start), "-t", String(p.dur), "-i", url, "-map", "1:v", "-map", "0:a"]
        : ["-ss", String(p.start), "-t", String(p.dur), "-i", url, "-map", "0:v", "-map", "0:a"];
    run([...inputs, "-vf", t.join(","),
        "-af", "highpass=f=180,lowpass=f=6800,loudnorm=I=-17:TP=-1.5:LRA=11",
        "-c:v", "libx264", "-crf", "21", "-preset", "veryfast", "-r", String(FPS),
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", part]);
    parts.push(part);
    console.log(`  [${i + 1}/${spec.pieces.length}] ${p.dur}s  ${p.title?.[0] ?? p.lower?.[0] ?? p.card?.[0] ?? "—"}`);
});

// concat resolves each entry relative to the LIST file, not to the cwd — so
// these are basenames, not the paths we rendered to.
writeFileSync(join(dir, "list.txt"), parts.map((f) => `file '${basename(f)}'`).join("\n"));
run(["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-c", "copy", out]);
rmSync(dir, { recursive: true, force: true });

const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
    { encoding: "utf8" }).stdout.trim();
const det = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" }).stderr ?? "";
const mean = /mean_volume: (-?[\d.]+) dB/.exec(det)?.[1];
console.log(`\n${out} — ${spec.pieces.length} pieces, ${Math.round(Number(dur))}s, mean ${mean ?? "?"} dB`);
