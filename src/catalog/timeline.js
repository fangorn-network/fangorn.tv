// An edit list, in formats other people's software already reads.
//
// montage() produces the expensive half — which second of which film, found by
// semantic search over a corpus nobody has downloaded. cut.mjs then renders it,
// and for a long time that was the only thing that could: the list was our own
// JSON, so the work stopped at the edge of this repo.
//
// It should not. A cut is worth more on somebody's timeline than in an mp4, and
// the industry already standardised this handoff twice. So rather than an
// integration per editor — a Blender one, a Resolve one, a Premiere one, each
// with its own breakage — emit the two formats those editors already import and
// let them do the reading.
//
//   EDL (CMX3600)  every NLE on earth reads it, back to tape. Carries timecode
//                  and reel names, NOT paths — the editor relinks media itself.
//   OTIO           JSON, and its ExternalReference carries a `target_url`. That
//                  is the one that matters here: our sources ARE urls, so an
//                  OTIO timeline is self-resolving. Blender (via the adapter),
//                  Resolve and Nuke read it, and so does any agent holding a
//                  desktop MCP — it is machine-readable without an importer.
//
// ponytail: no FCPXML. It is a third dialect for the same two facts, and it is
// XML — a builder and an escaper for a format the other two already cover. Add
// it when someone's editor reads nothing else.
//
// Sources here run at whatever rate archive.org holds them at, and we cut on
// SECONDS, not frames. `rate` is therefore a presentation choice for timecode,
// not a property of the media — 30 unless a target insists otherwise. A cut may
// land a frame either side of the second it names; for a supercut that is under
// the noise floor of where the line actually starts.

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");

/** Seconds → HH:MM:SS:FF at `rate`. */
export function timecode(seconds, rate = 30) {
    const s = Math.max(0, seconds);
    const whole = Math.floor(s);
    // round(), not floor(): 2.999s of a 3s cut is frame 30 of 30, which is the
    // next second's frame 0. Rolling it forward keeps record-in monotonic.
    let f = Math.round((s - whole) * rate);
    let carry = 0;
    if (f >= rate) { f -= rate; carry = 1; }
    const t = whole + carry;
    return `${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}:${pad(f)}`;
}

/** A reel name EDL will not choke on: 8 chars, A–Z0–9, unique per source. */
const reelOf = (url, i) => {
    const base = (url.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
    const clean = decodeURIComponent(base).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return (clean.slice(0, 5) || "CLIP").padEnd(5, "0") + pad(i + 1, 3);
};

/**
 * CMX3600 EDL. `cuts` are `{ url, start, dur, note }` — montage's own output.
 *
 * Record time is CUMULATIVE: the editor needs to know where each clip lands on
 * the master, not just where it came from. Getting that wrong stacks every clip
 * at 0 and the import looks like one shot.
 */
export function toEDL(cuts, { title = "SOND3R", rate = 30 } = {}) {
    const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME"];
    let rec = 0;
    cuts.forEach((c, i) => {
        const start = c.start ?? 0, dur = c.dur ?? 5;
        lines.push(`${pad(i + 1, 3)}  ${reelOf(c.url, i)} AA/V  C        `
            + `${timecode(start, rate)} ${timecode(start + dur, rate)} `
            + `${timecode(rec, rate)} ${timecode(rec + dur, rate)}`);
        // The URL rides as a comment. EDL has nowhere to put it, but every
        // importer keeps comments, and without it nobody can relink the media.
        lines.push(`* FROM CLIP NAME: ${decodeURIComponent((c.url.split("/").pop() ?? ""))}`);
        lines.push(`* SOURCE URL: ${c.url}`);
        if (c.note) lines.push(`* COMMENT: ${c.note}`);
        rec += dur;
    });
    return lines.join("\n") + "\n";
}

/**
 * OpenTimelineIO, as a JSON string.
 *
 * One track, one clip per cut, each with an ExternalReference pointing at the
 * URL the bytes actually live at — so this timeline resolves with nothing
 * downloaded and nothing re-hosted.
 */
export function toOTIO(cuts, { title = "SOND3R", rate = 30 } = {}) {
    const time = (v) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value: Math.round(v * rate) });
    const range = (start, dur) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: time(start), duration: time(dur) });
    return JSON.stringify({
        OTIO_SCHEMA: "Timeline.1",
        name: title,
        tracks: {
            OTIO_SCHEMA: "Stack.1",
            name: "tracks",
            children: [{
                OTIO_SCHEMA: "Track.1",
                name: "V1",
                kind: "Video",
                children: cuts.map((c, i) => ({
                    OTIO_SCHEMA: "Clip.1",
                    name: c.note || decodeURIComponent((c.url.split("/").pop() ?? `clip ${i + 1}`)),
                    source_range: range(c.start ?? 0, c.dur ?? 5),
                    media_reference: {
                        OTIO_SCHEMA: "ExternalReference.1",
                        target_url: c.url,
                        // What the SOURCE spans, not what we take from it. An
                        // available_range that echoes source_range tells the
                        // reader the file is only as long as our clip, and
                        // trimming in the editor then refuses to extend.
                        available_range: null,
                    },
                    metadata: c.note ? { sond3r: { note: c.note } } : {},
                })),
            }],
        },
    }, null, 2);
}

// ── self-check: `node src/catalog/timeline.js` ───────────────────────────────
// `typeof process` FIRST — this module is imported by the page, and a bare
// `process.argv` throws at evaluation in a browser, taking every WebMCP tool
// registration down with it. Same guard as browse.js and channels.js.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  want ${b}`); process.exit(1); } };
    const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } };

    eq(timecode(0), "00:00:00:00", "zero");
    eq(timecode(3661.5), "01:01:01:15", "hours, minutes, frames");
    // The rounding case that stacks a cut one frame into the next second.
    eq(timecode(2.999), "00:00:03:00", "a frame short of a second rolls over, it does not read 30");
    eq(timecode(59.999), "00:01:00:00", "…and carries through the minute");

    const cuts = [
        { url: "https://ar.org/download/x/Sitting%20Ducks%20S02E10.mp4", start: 64.5, dur: 11, note: "the order" },
        { url: "https://ar.org/download/y/Bring%20It%20On.mp4", start: 1273, dur: 13, note: "the denial" },
    ];

    const edl = toEDL(cuts, { title: "TRIAL" });
    ok(edl.startsWith("TITLE: TRIAL\n"), "edl is titled");
    // Record time is the property an importer cannot recover on its own.
    ok(edl.includes("00:00:00:00 00:00:11:00"), "first clip lands at the head of the master");
    ok(edl.includes("00:00:11:00 00:00:24:00"), "the second lands AFTER it, not back at zero");
    ok(edl.includes("00:21:13:00 00:21:26:00"), "…while keeping its own source timecode");
    ok(edl.includes("* SOURCE URL: https://ar.org/download/y/Bring%20It%20On.mp4"), "the url survives as a comment");
    ok(/^\d{3}  [A-Z0-9]{8} AA\/V  C /m.test(edl), "reels are 8 chars and edl-safe");
    ok(!/[^\x20-\x7e\n]/.test(edl), "no character an NLE parser can trip on");

    const otio = JSON.parse(toOTIO(cuts, { title: "TRIAL" }));
    const track = otio.tracks.children[0];
    eq(track.children.length, 2, "one clip per cut");
    eq(track.children[0].media_reference.target_url, cuts[0].url, "the clip resolves to the bytes");
    eq(track.children[0].source_range.start_time.value, Math.round(64.5 * 30), "source in, in frames");
    eq(track.children[0].source_range.duration.value, 11 * 30, "and its duration");
    eq(track.children[1].name, "the denial", "the note names the clip an editor sees");
    // Order is the whole product — see channels.js program().
    eq(track.children.map((c) => c.source_range.start_time.value).join(),
        [Math.round(64.5 * 30), 1273 * 30].join(), "clips keep the order they were cut in");

    console.log("timeline.js self-check ok — timecode rounding, edl record times, reels, otio references");
}
