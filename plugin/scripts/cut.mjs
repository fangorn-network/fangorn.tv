#!/usr/bin/env node
// Cut clips out of remote films without downloading them.
//
// The storefront's WebMCP tools find the shot — semantic search over the corpus,
// scan-film to check what a reel actually contains — and hand back a URL and a
// timestamp. This turns that into a file. `-ss` BEFORE `-i` makes ffmpeg range-
// request only the bytes it needs, so a minute out of a 700MB feature moves ~6MB
// and takes a couple of seconds. That is the whole trick: the edit list is the
// expensive part to produce, and an agent with the catalog open produces it.
//
//   node scripts/cut.mjs edits.json out.mp4     supercut
//   node scripts/cut.mjs edits.json out.gif     gif (video only, 12fps, 480w)
//
// edits.json: [{ "url": "https://…", "start": 2000, "dur": 60 }, …]
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [listPath, out] = process.argv.slice(2);
if (!listPath || !out) {
    console.error("usage: cut.mjs edits.json out.mp4|out.gif");
    process.exit(1);
}
const edits = JSON.parse(readFileSync(listPath, "utf8"));
if (!edits.length) { console.error("edit list is empty"); process.exit(1); }

const gif = out.endsWith(".gif");
const W = gif ? 480 : 854, H = gif ? 270 : 480, FPS = gif ? 12 : 30;
const run = (args) => {
    const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-stats", ...args],
        { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
};

// One clip, straight to mp4: stream-copy it. No re-encode, no quality loss, and
// the cut lands on the nearest keyframe — which for a rough clip is fine.
if (edits.length === 1 && !gif) {
    const e = edits[0];
    run(["-ss", String(e.start ?? 0), "-i", e.url, "-t", String(e.dur ?? 5), "-c", "copy", out]);
    console.log(`\n${out} — 1 clip, stream copy`);
    process.exit(0);
}

const inputs = edits.flatMap((e) => ["-ss", String(e.start ?? 0), "-t", String(e.dur ?? 5), "-i", e.url]);

// ponytail: normalize every clip to one size and rate. The sources are whatever
// the archive happened to hold — 480p, 576p, 4:3, 24 and 30fps — and concat
// refuses mismatched streams. Detecting which inputs happen to already match is
// more code than normalizing all of them.
const norm = edits.map((_, i) =>
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:-1:-1:color=black,setsar=1,fps=${FPS}[v${i}]`).join(";");

// Audio only survives if EVERY source has some: concat with a=1 errors out on an
// input with no audio stream, and a supercut that dies on the one silent reel in
// the list is worse than a silent supercut.
const hasAudio = (url) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "a",
    "-show_entries", "stream=index", "-of", "csv=p=0", url], { encoding: "utf8" }).stdout.trim() !== "";
const audio = !gif && edits.every((e) => hasAudio(e.url));

// MEASURED: across a 1941 cartoon, a 1953 B-movie and a 2005 studio film the
// integrated loudness spanned 12 LU (-27.3 to -15.2 LUFS) — the last shot is
// roughly four times as loud as the first. Nobody notices that in a single clip
// and everybody notices it in a supercut, so each source is normalized to -16
// LUFS (the web streaming target) before the join.
// ponytail: single-pass loudnorm. Two-pass measures first and is more accurate,
// but it doubles the remote reads for a difference nobody hears on archive audio.
const lvl = edits.map((_, i) => `[${i}:a]loudnorm=I=-16:TP=-1.5:LRA=11[a${i}]`).join(";");
const streams = edits.map((_, i) => audio ? `[v${i}][a${i}]` : `[v${i}]`).join("");
const concat = `${streams}concat=n=${edits.length}:v=1:a=${audio ? 1 : 0}[v]${audio ? "[a]" : ""}`;
const graph = audio ? `${norm};${lvl};${concat}` : `${norm};${concat}`;

if (gif) {
    run([...inputs, "-filter_complex",
        `${graph};[v]split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer`,
        "-loop", "0", out]);
} else {
    run([...inputs, "-filter_complex", graph,
        "-map", "[v]", ...(audio ? ["-map", "[a]", "-c:a", "aac", "-ar", "48000", "-ac", "2"] : []),
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", out]);
}
// Say whether the result actually MAKES A SOUND. "Has an aac stream" and "is
// audible" are different claims, and a supercut of silent films can honestly be
// both muxed and mute — which looks identical to a broken render unless it is
// stated here.
let heard = audio ? "" : " (no audio: a source had none)";
if (audio) {
    const det = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "volumedetect", "-f", "null", "-"],
        { encoding: "utf8" }).stderr ?? "";
    const mean = /mean_volume: (-?[\d.]+) dB/.exec(det)?.[1];
    heard = mean === undefined ? " (audio present, level unread)"
        : Number(mean) < -50 ? ` — WARNING: audio is silent (mean ${mean} dB), the sources carry no score`
        : ` — audio levelled, mean ${mean} dB`;
}
console.log(`\n${out} — ${edits.length} clips${heard}`);
