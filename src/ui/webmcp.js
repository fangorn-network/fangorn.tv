// WebMCP — the storefront as tools, for a browser-resident agent.
//
// https://github.com/webmachinelearning/webmcp: the page registers tools on
// `document.modelContext` and the browser's agent calls them. No server, no
// transport, no dependency — the tools ARE these functions, running in the tab
// with the catalog already downloaded and the wallet already connected.
//
// That is why this belongs here rather than in a Node MCP server: sond3r's
// search is client-side on purpose (src/catalog/search.js streams shards into
// the tab so the query never leaves it). An out-of-process MCP server would
// have to re-download the corpus and would see every query — the two properties
// the Semantic CDN exists to avoid.
//
// The tools that follow the first three are the point of doing this in the page
// at all: `capture-frame` reads pixels out of the <video> the person is watching
// and hands them to the agent, which no backend MCP can do without downloading
// the film to a server first. Same for the transport controls — they move the
// player that is already open, not a copy of it.
//
// ponytail: NONE of these tools spends money. `open-item` walks the
// page to the item and its buy button; the human presses it. WebMCP has no
// confirmation primitive, so an agent-callable `buy` would be an agent-callable
// wallet. Add one when the spec grows a consent step.
import { useEffect, useRef, useState } from "react";
import { loadShard, searchSubtitles, groupByFile } from "../catalog/search.js";
import { addScenes, draftFor, dropScene } from "../catalog/scenes.js";
import { nodeKey } from "../catalog/browse.js";
import { airing, chanLink, linkFor, schedule, slotLabel, unpackChan, unpackRow } from "../catalog/channels.js";
import { toEDL, toOTIO } from "../catalog/timeline.js";
import { answer, emit, mark, next, propose, since, watch } from "./intent.js";
import { normalizeCues } from "../../server/subtitles.js";

const idOf = (n) => n.resourceId ?? `${n.owner}/${n.path}`;
const brief = (n) => ({
    id: idOf(n), name: n.name, path: n.path, publisher: n.owner, mime: n.mime,
    price: n.resourceId ? `${(Number(n.price ?? 0) / 1e6).toFixed(3)} USDC` : "free",
    // The public URL of a free file. An agent that can only open things in this
    // tab cannot do anything else with them — clip one, hand it to a person, run
    // it through a tool of its own. A paid file has no url until it is bought.
    ...(n.url ? { url: n.url } : {}),
    ...(n.desc ? { description: n.desc.slice(0, 300) } : {}),
});
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });


// ── what the agent has drawn ─────────────────────────────────────────────────
// A module-level store rather than React state threaded through the Viewer: the
// tools are registered once, outside the tree, and the only consumer is the strip
// under the player. `for` is the file the marks belong to, so film A's bookmarks
// cannot end up drawn on film B — the overlay renders nothing when it does not
// match what is open.
let notes = { for: null, marks: [], boxes: [] };
const watchers = new Set();
const setNotes = (n) => { notes = n; for (const f of watchers) f(n); };

/** The marks for `node`, live. Empty for anything they were not drawn on. */
export function useAnnotations(node) {
    const [n, set] = useState(notes);
    useEffect(() => { watchers.add(set); return () => { watchers.delete(set); }; }, []);
    return node && n.for === idOf(node) ? n : { for: null, marks: [], boxes: [] };
}


// ── the archive's own frames, without hosting a byte ─────────────────────────
//
// archive.org's /download URL 302s to a mirror that sends no ACAO header, so the
// canvas is tainted and the pixels of most of this catalog cannot be read here.
// (Forcing crossOrigin="anonymous" on the player to fix that makes those files
// fail to load outright — MEDIA_ELEMENT_ERROR, videoWidth 0. Measured.)
//
// But archive.org derives a periodic frame strip for every video item and there
// IS a CORS-open route to it: `archive.org/cors/{id}/{file}` answers with
// `access-control-allow-origin: <origin>`. The strip is one ~2KB JPEG per
// interval, so this is a couple of kilobytes to look at a scene rather than a
// 350MB download — and nothing is proxied, mirrored or re-hosted.
//
// ponytail: the strip's cadence is the archive's, not ours (typically one a
// minute, 160x110). It is a contact sheet, not a frame grab. The exact frame is
// only readable for files whose bytes we can actually touch — see capture-frame.
const IA = /archive\.org\/(?:download|cors|serve)\/([^/]+)\/(.+)$/;
const strips = new Map(); // identifier → [{ name, n }], one metadata fetch each

async function archiveStrip(id) {
    if (!strips.has(id)) {
        strips.set(id, fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`)
            .then((r) => r.json())
            .then((meta) => (meta.files ?? [])
                .map((f) => ({ name: f.name, n: Number(/_(\d+)\.jpe?g$/i.exec(f.name)?.[1]) }))
                .filter((f) => /\.thumbs\//i.test(f.name) && Number.isFinite(f.n))
                .sort((a, b) => a.n - b.n))
            .catch(() => []));
    }
    return strips.get(id);
}

/** The archive's own frame nearest `seconds`, as base64 JPEG, or null. */
export async function archiveFrame(url, seconds, duration) {
    const m = IA.exec(url ?? "");
    if (!m) return null;
    const [, id, rest] = m;
    const all = await archiveStrip(id);
    if (!all.length) return null;
    // ONE ITEM CAN HOLD FIFTY EPISODES. The thumbs directory mirrors the item's
    // whole file tree — `{id}.thumbs/{dir}/{stem}_000779.jpg` — so taking every
    // .thumbs file in the item hands back a frame from a different episode, which
    // is exactly what it did: a dog from S01 while S02E09 was open. Filter to the
    // file that is actually playing.
    const stem = decodeURIComponent(rest).replace(/\.[^./]+$/, "");
    const mine = all.filter((f) => f.name.startsWith(`${id}.thumbs/${stem}_`));
    // No match: an item that names its strip differently. Only safe to fall back
    // when the item holds ONE file's worth of thumbs — otherwise it is the bug.
    const stems = new Set(all.map((f) => f.name.replace(/_\d+\.jpe?g$/i, "")));
    const shots = mine.length ? mine : (stems.size === 1 ? all : []);
    if (!shots.length) return null;
    // The number in the filename is USUALLY seconds (…_000900.jpg is 15:00 in),
    // but some items number by index instead. If the last one lands nowhere near
    // the running time, read the strip as evenly spaced samples — which is what
    // it is either way — so the timestamp reported back is still honest.
    const last = shots[shots.length - 1].n;
    const indexed = !!duration && !!last && (last < duration * 0.5 || last > duration * 1.5);
    const target = indexed ? Math.round((seconds / duration) * last) : seconds;
    const pick = shots.reduce((best, t) => (Math.abs(t.n - target) < Math.abs(best.n - target) ? t : best));
    const at = indexed ? Math.round((pick.n / last) * duration) : pick.n;
    const buf = await fetch(`https://archive.org/cors/${encodeURIComponent(id)}/${pick.name.split("/").map(encodeURIComponent).join("/")}`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
    if (!buf) return null;
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { seconds: at, data: btoa(bin), mimeType: "image/jpeg", count: shots.length };
}

// ── a film as one picture ────────────────────────────────────────────────────
//
// Twelve frames sent as twelve images cost twelve reads and twelve base64
// payloads to answer one question — "what is actually in this film?". As a
// single contact sheet it is one read and about a fifth of the bytes, which is
// the difference between an agent checking four candidates in a sitting and
// checking forty. MEASURED on this corpus: 12 strip frames ran 24–64KB each;
// the sheet of all twelve is ~90KB.
//
// The timestamps are burnt into the tiles rather than listed beside them. A
// separate list has to be correlated back position by position, and that is
// exactly the step that puts a scene description on the wrong second.

/** Columns and rows for `n` tiles — four across, which reads as a filmstrip and
 *  keeps a 12-frame sheet close to square. */
export const gridFor = (n) => { const cols = Math.min(4, Math.max(1, n)); return { cols, rows: Math.ceil(n / cols) }; };

/** Frames laid out as one JPEG, or null where there is no canvas to draw on
 *  (node, the self-check) — the caller then falls back to the frames themselves,
 *  which costs more but is never wrong. The strip comes from archive.org/cors,
 *  which sends ACAO, so unlike the player these pixels are readable. */
async function contactSheet(frames, tileW = 240) {
    if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
    try {
        const bmps = await Promise.all(frames.map((f) => fetch(`data:${f.mimeType};base64,${f.data}`)
            .then((r) => r.blob()).then((b) => createImageBitmap(b))));
        // One film's strip is uniform, so the first frame sets the cell. Never
        // upscale: a 150px archive thumbnail blown up to 240 is a blurrier
        // thumbnail, not more detail.
        const tw = Math.min(tileW, bmps[0].width);
        const th = Math.round((bmps[0].height / bmps[0].width) * tw);
        const { cols, rows } = gridFor(bmps.length);
        const pad = 2;
        const c = document.createElement("canvas");
        c.width = cols * (tw + pad) + pad;
        c.height = rows * (th + pad) + pad;
        const g = c.getContext("2d");
        g.fillStyle = "#111";
        g.fillRect(0, 0, c.width, c.height);
        bmps.forEach((b, i) => {
            const x = pad + (i % cols) * (tw + pad);
            const y = pad + Math.floor(i / cols) * (th + pad);
            g.drawImage(b, x, y, tw, th);
            const label = mmss(frames[i].seconds);
            g.font = "bold 13px system-ui, sans-serif";
            g.fillStyle = "rgba(0,0,0,0.72)";
            g.fillRect(x, y + th - 17, g.measureText(label).width + 10, 17);
            g.fillStyle = "#fff";
            g.fillText(label, x + 5, y + th - 5);
            b.close?.();
        });
        return { data: c.toDataURL("image/jpeg", 0.75).split(",")[1], mimeType: "image/jpeg", cols, rows };
    } catch { return null; }
}

/** Every cue containing each phrase, best first.
 *
 *  "Best" is TIGHTNESS: how much of the line is the phrase. A cue that is almost
 *  nothing but these words cuts clean; one where they are buried drags half a
 *  sentence of context in with them, and a supercut made of those is unwatchable.
 *
 *  Only files with a `url` — a paid file has no public bytes, so montage could
 *  not cut it and offering the hit would waste the agent's next call.
 *
 *  ponytail: a linear pass, no cue index. The caller asks for four phrases once,
 *  over an array already in the tab. Index it when something types into this. */
export function findLines(subs, files, phrases, per = 4) {
    const n = Math.max(1, Math.min(10, Math.round(per)));
    return phrases.map((phrase) => {
        // Intact and on word boundaries: "assembled" must not match "reassembled",
        // and a supercut is built from the words themselves, not from near ones.
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
        const hits = [];
        for (const row of subs) {
            const file = files.find((f) => f.owner === row.owner && f.path === row.videoPath);
            if (!file?.url) continue;
            for (const c of row.cues) {
                if (!re.test(c.text)) continue;
                const dur = Math.max(0.4, (c.end ?? c.start) - c.start);
                hits.push({
                    id: idOf(file), name: file.name, start: c.start, dur: +dur.toFixed(2),
                    said: c.text, tightness: +(phrase.length / Math.max(1, c.text.length)).toFixed(2),
                });
            }
        }
        hits.sort((a, b) => b.tightness - a.tightness);
        return { phrase, matches: hits.slice(0, n), total: hits.length };
    });
}

/** Register the storefront's verbs with the browser's agent, for as long as this
 *  component is mounted.
 *
 *  ONCE, on mount, reading through a ref that every render refreshes. The
 *  obvious version — effect deps on the context — re-registers on every render,
 *  and `w` is a new object each time: the agent then watches six tools vanish
 *  and reappear continuously, and a call in flight dies with the abort as
 *  "the operation failed for an unknown transient reason". */
export function useModelContext(ctx) {
    const live = useRef(ctx);
    live.current = ctx;
    useEffect(() => {
        // No agent in this browser — nothing to do.
        if (!document.modelContext?.registerTool) return;
        return registerTools(document.modelContext, () => live.current);
    }, []);
}

/** The tools themselves, off React, so the self-check below can call them.
 *  `get()` returns the current { files, show, setHits, onError, w } — read per
 *  call, never captured, so a tool registered at mount still sees the catalog
 *  that streamed in afterwards.
 *  @returns an unregister function. */
export function registerTools(mc, get) {
    const ctl = new AbortController();
    const opts = { signal: ctl.signal };
    const find = (id) => get().files.find((f) => idOf(f) === id || f.resourceId === id || f.path === id);

    mc.registerTool({
        name: "search-catalog",
        description: "Semantically search this storefront — titles, descriptions and subtitle lines across every publisher in the current view. Also shows the results on the page.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "What to look for, in natural language" },
                limit: { type: "number", description: "Max files to return (default 10)" },
            },
            required: ["query"],
        },
        async execute({ query, limit = 10 }) {
            try {
                const hits = await searchSubtitles(query);
                get().setHits(hits);
                const found = groupByFile(hits).slice(0, limit)
                    .filter((g) => g.node)
                    .map((g) => ({ ...brief(g.node), moments: g.moments.slice(0, 3).map((m) => `${Math.round(m.start)}s: ${m.text}`) }));
                return text(found.length ? found : `No matches for "${query}".`);
            } catch (e) { get().onError(e.message); return text(`Search failed: ${e.message}`); }
        },
    }, opts);

    // ── the words, not the topic ─────────────────────────────────────────────
    //
    // search-catalog ranks by the SUBTITLE ROW's vector, which is the whole
    // file — so it answers "which film is about factories", and cannot answer
    // "where does anyone say the words *was assembled*". The phrase is spoken
    // once in ninety minutes; the file's vector knows nothing about it, and a
    // better embedding never will. That is not a ranking failure, it is the
    // wrong index for the question, so this walks the cues directly.
    //
    // Linear over every cue in the view. MEASURED shape, not guessed: a cue is a
    // LINE — two to four seconds, six to twelve words. So a hit is a line you can
    // cut, and a supercut built from these is a sentence made of sentences.
    //
    // ponytail: no cue index. It is one pass over an array already in the tab,
    // and the caller asks for four phrases once. Build an index when someone is
    // typing into this.
    mc.registerTool({
        name: "find-line",
        description: "Find where words are actually SPOKEN, across every subtitle in this view — the exact-phrase counterpart to search-catalog, which ranks whole files by topic and therefore cannot find a phrase said once. Give it phrases; it returns the lines containing them, with the timestamps to cut. Use it to build a supercut that says something the corpus never meant to say.",
        inputSchema: {
            type: "object",
            properties: {
                phrases: { type: "array", items: { type: "string" }, description: "The words to find, each matched intact and on word boundaries" },
                per: { type: "number", description: "Best matches per phrase, 1–10, default 4" },
            },
            required: ["phrases"],
        },
        async execute({ phrases, per = 4 } = {}) {
            const want = (Array.isArray(phrases) ? phrases : [phrases]).map((p) => String(p ?? "").trim()).filter(Boolean);
            if (!want.length) return text("Give it at least one phrase.");
            const rows = await loadShard();
            const subs = rows.filter((r) => r.entityType === "subtitles" && r.cues?.length);
            if (!subs.length) return text("No subtitles in this view yet — nothing here has been transcribed, so there are no spoken words to search. search-catalog still works on titles and descriptions.");
            const found = findLines(subs, get().files, want, per);
            const dry = found.filter((f) => !f.total).map((f) => f.phrase);
            return text({
                searched: `${subs.length} transcripts`,
                found,
                ...(dry.length ? { missing: dry, note: "Not spoken anywhere in this view. Rewrite the line around what the corpus actually says — that is the cheap direction; making the corpus say your line is not." } : {}),
                next: "Feed the picked matches to montage as { id, start, dur } in the order they should play.",
            });
        },
    }, opts);

    mc.registerTool({
        name: "browse-catalog",
        description: "List what this storefront holds, without searching. Filter by publisher address or media kind.",
        inputSchema: {
            type: "object",
            properties: {
                publisher: { type: "string", description: "Only this publisher's wallet address" },
                kind: { type: "string", description: "video, audio, image, text, software…" },
                limit: { type: "number", description: "Max files to return (default 50)" },
            },
        },
        async execute({ publisher, kind, limit = 50 } = {}) {
            const rows = get().files.filter((f) =>
                (!publisher || f.owner?.toLowerCase() === publisher.toLowerCase()) &&
                (!kind || f.kind === kind || (f.mime ?? "").startsWith(`${kind}/`)));
            return text({ total: rows.length, files: rows.slice(0, limit).map(brief) });
        },
    }, opts);

    mc.registerTool({
        name: "open-item",
        description: "Open one file's page in the storefront — its description, price and, for a paid file, the buy button the person presses themselves. Free files start playing.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "An id from search-catalog or browse-catalog" } },
            required: ["id"],
        },
        async execute({ id }) {
            const node = find(id);
            if (!node) return text(`No such file: ${id}`);
            get().show(node);
            return text({ opened: brief(node), note: node.resourceId ? "Paid — the buyer must press Buy on the page." : "Free — playing." });
        },
    }, opts);

    // ── channels ─────────────────────────────────────────────────────────────
    // The reason these are worth an agent's time: a channel here is not a
    // playlist somebody curated, it is a QUERY, and its schedule is a pure
    // function of UTC. So an agent can invent one from a sentence, hand back a
    // link, and everyone who opens that link is on the same frame — with no
    // room to join, no server to ask and no model to download. `tune-channel`
    // is the tool that makes a television channel out of a mood, which is a
    // thing no backend MCP can do without shipping the corpus somewhere first.
    const chans = () => get().channels ?? [];
    /** By number, id, or a case-insensitive prefix of the title — an agent has
     *  usually just read `list-channels` and will say "channel 3" or "the noir one". */
    const chanOf = (ref) => {
        const rows = chans();
        if (ref == null || ref === "") return rows.find((c) => c.id === get().tv) ?? rows[0];
        const n = Number(ref);
        if (Number.isInteger(n) && String(ref).trim() === String(n)) return rows.find((c) => c.number === n);
        const k = String(ref).toLowerCase();
        return rows.find((c) => c.id === ref) ?? rows.find((c) => c.title.toLowerCase().startsWith(k))
            ?? rows.find((c) => c.title.toLowerCase().includes(k));
    };
    const onNow = (c) => {
        const cur = airing(c, Date.now());
        if (!cur) return { number: c.number, title: c.title, on: null };
        const nxt = airing(c, cur.endsAt);
        return {
            number: c.number, title: c.title,
            tuned: c.kind === "walk" || c.kind === "moment",   // generated from a query, not a folder
            // Slots are windows into films, not whole films — so `secondsIn` is a
            // position in the SOURCE, and the label carries the timecode.
            scenes: c.kind === "moment",
            now: { id: idOf(cur.item), label: slotLabel(cur.item), name: cur.item.name,
                   secondsIn: Math.round(cur.offset), secondsLeft: Math.round((cur.endsAt - Date.now()) / 1000) },
            next: nxt ? { label: slotLabel(nxt.item), at: new Date(nxt.startsAt).toISOString() } : null,
        };
    };

    mc.registerTool({
        name: "list-channels",
        description: "Every channel on this TV and what is playing on each right now, with what is up next. Channels marked `tuned:true` were generated from a natural-language query rather than grouped out of the catalog.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
            const rows = chans();
            if (!rows.length) return text("No channels — this catalog has no playable video yet. Try tune-channel.");
            return text({ watching: chanOf(null)?.number ?? null, channels: rows.map(onNow) });
        },
    }, opts);

    mc.registerTool({
        name: "tune-channel",
        description: "Make a brand-new television channel and turn the set to it. Three kinds of evidence, mixable: a mood in words ('rainy cyberpunk', 'slow nature documentary'), `blend` — how far to pull toward where THIS viewer's session is already heading, from read-taste — and specific items to move toward or away from. A channel built with blend or like/unlike is derived from behaviour that exists only in this browser, so it cannot be produced anywhere else. Returns a link that puts anyone else on the exact same frame.",
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "The mood or theme, in natural language" },
                blend: { type: "number", description: "0–1: how much of the viewer's own heading (read-taste) to mix in. 0 = the words alone, 1 = purely where they are already going." },
                like: { type: "array", items: { type: "string" }, description: "Item ids to pull the channel toward" },
                unlike: { type: "array", items: { type: "string" }, description: "Item ids to push the channel away from" },
                title: { type: "string", description: "What to call it, when the channel is not just a prompt" },
                scenes: { type: "boolean", description: "Build the channel out of MOMENTS instead of whole files. A 'firetrucks' channel with scenes:false is every film that mentions one; with scenes:true it is the ~45 seconds in each film where one is actually on screen. Needs a corpus with subtitle, scene or summary rows — say so if the channel comes back empty." },
            },
        },
        async execute({ prompt, blend = 0, like = [], unlike = [], title, scenes = false } = {}) {
            if (!get().tuneTo) return text("This page cannot tune channels.");
            if (!prompt && !blend && !like.length) return text("Give a prompt, a blend, or something to steer toward.");
            const made = await get().tuneTo(prompt, { blend, like, unlike, title, scenes });
            if (!made && scenes) return text(`Nothing in this catalog has a described moment near "${prompt ?? title}". Moment channels need subtitle/scene rows; a plain tune-channel over whole files may still work.`);
            if (!made) return text(blend && !get().state?.q
                ? "This viewer has no heading yet — nothing has been opened, so there is no session to blend. Use a prompt."
                : `Could not tune to "${prompt ?? title}".`);
            const { spec, chan } = made;
            if (!airing(chan, Date.now())) return text(`Nothing in this catalog is near "${spec.title}" — the channel would be empty.`);
            // `made`, not `tuned` — onNow() already uses `tuned` for "this channel
            // was generated rather than grouped", and spreading it over a title
            // silently turned the name into `true`.
            // A moment ring is not rebuildable from its spec alone — the windows came
            // out of a subtitle search, and packChan carries only the vector. Saying
            // so beats handing back a link that quietly reopens as a channel of
            // whole films.
            if (spec.scenes) {
                return text({ made: spec.title, ...onNow(chan), slots: chan.items.length,
                    note: "A channel of moments: each slot is a window into a film, and the TV seeks to it. Not shareable as a link yet — the ring came from a subtitle search, and a link carries only the query vector." });
            }
            return text({ made: spec.title, ...onNow(chan), share: chanLink(spec),
                note: "Now playing on the TV. The share link carries the whole channel in its fragment — no account, no server, and whoever opens it sees the same frame at the same moment." });
        },
    }, opts);

    mc.registerTool({
        name: "watch-channel",
        description: "Turn the TV to an existing channel, by number or by name.",
        inputSchema: {
            type: "object",
            properties: { channel: { type: "string", description: "A channel number or title from list-channels" } },
            required: ["channel"],
        },
        async execute({ channel }) {
            const c = chanOf(channel);
            if (!c) return text(`No such channel: ${channel}`);
            get().onWatch?.(c.id);
            return text({ watching: onNow(c) });
        },
    }, opts);

    mc.registerTool({
        name: "channel-schedule",
        description: "What is coming up on a channel — the running order for the next few hours, computed from the clock alone. Works for any channel, whether or not it is the one on screen.",
        inputSchema: {
            type: "object",
            properties: {
                channel: { type: "string", description: "Channel number or title (default: what is on screen)" },
                hours: { type: "number", description: "How far ahead to look (default 3)" },
            },
        },
        async execute({ channel, hours = 3 } = {}) {
            const c = chanOf(channel);
            if (!c) return text(`No such channel: ${channel}`);
            const from = Date.now();
            const cells = schedule(c, from, from + Math.max(0.25, Math.min(12, hours)) * 3600e3);
            return text({
                channel: c.number, title: c.title,
                slots: cells.map((s) => ({ at: new Date(s.startsAt).toISOString(), label: slotLabel(s.item), id: idOf(s.item) })),
            });
        },
    }, opts);

    mc.registerTool({
        name: "share-channel",
        description: "Get the shareable link for any channel, and optionally keep a tuned one in this browser's channel list. Anyone who opens the link watches in sync — the schedule is a pure function of UTC, so there is nothing to synchronise.",
        inputSchema: {
            type: "object",
            properties: {
                channel: { type: "string", description: "Channel number or title (default: what is on screen)" },
                save: { type: "boolean", description: "Also keep it in this browser's channel list" },
            },
        },
        async execute({ channel, save } = {}) {
            const c = chanOf(channel);
            if (!c) return text(`No such channel: ${channel}`);
            // A tuned channel encodes its vector; a catalog one encodes the row it
            // is, since the receiver's own lineup builds that group. Saving is only
            // for tuned ones — a catalog channel is already in everyone's deck.
            if (save && c.spec) get().onSave?.(c.spec);
            return text({
                channel: c.number, title: c.title, link: linkFor(c),
                tuned: !!c.spec, saved: !!(save && c.spec),
                ...(save && !c.spec ? { note: "A catalog channel is in the lineup already — nothing to keep." } : {}),
            });
        },
    }, opts);

    // ── the viewer ───────────────────────────────────────────────────────────
    // The two tools below are the reason this is a WebMCP page and not an MCP
    // server with a copy of the corpus. `read-taste` reads a vector that exists
    // only in this tab. `await-viewer-signal` INVERTS the protocol: an agent
    // parked in it is subscribed to a person, and the page wakes it. Nothing in
    // the spec says a tool must resolve immediately, and a promise that stays
    // pending is a subscription with no socket, no queue and no server.

    mc.registerTool({
        name: "read-taste",
        description: "What this viewer is actually into, right now — derived in the browser from what they have opened, rated and sat through, and never sent anywhere. Returns their heading in words, how fast it is moving, what they have rejected, and the items nearest to where they are going next. This is the signal that makes a channel personal; feed it back through tune-channel's `blend`.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
            const st = get().state;
            if (!st) return text("No session yet — this person has not opened anything, so there is nothing to read. Everything here is built from local behaviour; there is no profile to look up.");
            const h = get().heading;
            const taste = Object.entries(st.taste ?? {}).sort((a, b) => b[1] - a[1]);
            return text({
                heading: h?.terms ?? null,
                moving: !!h?.moving,
                speed: Number((st.speed ?? 0).toFixed(4)),
                drawnTo: taste.filter(([, w]) => w > 0).slice(0, 6).map(([k, w]) => ({ tag: k, weight: +w.toFixed(2) })),
                avoiding: taste.filter(([, w]) => w < 0).slice(0, 6).map(([k, w]) => ({ tag: k, weight: +w.toFixed(2) })),
                rejected: st.neg ? "yes — there are thumbs-down in this session, and ranking already steers away from them" : "nothing rated down yet",
                // heading().items is rank()'s output, which is bare files — it maps
                // the {f, score} pairs away before returning.
                headingToward: (h?.items ?? []).slice(0, 5).map((f) => ({ id: idOf(f), name: f.name })),
                note: "Computed in this tab from local history. It is not a stored profile and it does not exist on any server.",
            });
        },
    }, opts);

    mc.registerTool({
        name: "await-viewer-signal",
        description: "Wait until the viewer DOES something, and return what it was. Blocks — this is a subscription, not a poll. Signals: `skip` (left a slot early — the strongest negative this surface produces), `finished` (sat through one), `like`/`dislike` (rated it), `channel`, `tuned`. Returns null if nothing happens before the timeout, which means they are still watching and is not an error. Call it again with `after` set to the last `seq` you saw to avoid missing anything in between.",
        inputSchema: {
            type: "object",
            properties: {
                seconds: { type: "number", description: "How long to wait before giving up (default 45, max 120)" },
                after: { type: "number", description: "Only signals newer than this `seq`" },
            },
        },
        async execute({ seconds = 45, after } = {}) {
            const at = typeof after === "number" ? after : mark();
            const sig = await next({ after: at, ms: Math.min(120, Math.max(1, seconds)) * 1000 });
            if (!sig) return text({ signal: null, seq: mark(), note: "Quiet — still watching. Not an error; call again." });
            return text({ ...sig, pending: since(sig.seq).length });
        },
    }, opts);

    mc.registerTool({
        name: "propose",
        description: "Ask the viewer something on the screen they are already looking at, and wait for their answer. A card appears over the TV with your question and your buttons; this call stays pending until they press one, dismiss it, or let it expire — and silence comes back as null, never as consent. Use it before doing anything they did not ask for: retuning what they are watching, saving a channel, changing direction. This is the consent step WebMCP has no primitive for, and it only works because the tools are running in the page the person is looking at.",
        inputSchema: {
            type: "object",
            properties: {
                question: { type: "string", description: "Short, answerable by pressing a button. Say what you would do and why." },
                options: { type: "array", items: { type: "string" }, description: "The buttons (default Yes / No). Keep them to two or three." },
                seconds: { type: "number", description: "How long the card stands before it expires (default 60, max 300)" },
            },
            required: ["question"],
        },
        async execute({ question, options, seconds = 60 } = {}) {
            const picked = await propose({
                question,
                options: Array.isArray(options) && options.length ? options.slice(0, 3) : undefined,
                ms: Math.min(300, Math.max(5, seconds)) * 1000,
            });
            return text(picked == null
                ? { answer: null, note: "No answer — dismissed or expired. Treat this as NO and do not proceed." }
                : { answer: picked });
        },
    }, opts);

    // ── the live player ──────────────────────────────────────────────────────
    // Every tool below acts on the element the person is looking at. `w.media`
    // is the same ref the transport bar and the cast button use, so the agent
    // and the human are driving one player, not two.
    const el = () => get().w?.media?.current ?? null;
    const open = () => get().w?.open ?? null;
    const playing = () => (open() ? { ...brief(open().node), currentTime: el()?.currentTime ?? 0, duration: el()?.duration ?? null, paused: el()?.paused ?? true } : null);

    /** How long `node` runs, in seconds, or null if nothing knows.
     *
     *  The catalog carries `duration` on 99% of rows — which is the whole reason
     *  an agent can scan or cut a film it has not opened. Reaching for the PLAYER's
     *  duration instead is the bug this replaced: it belongs to the film in the
     *  player and to no other, so scanning film B while film A is open scaled B's
     *  frame strip to A's running time and labelled every frame with a second that
     *  is not in it. The element still wins for the open film — it read the real
     *  file, where the catalog holds archive.org's rounded integer. */
    const runtime = (node) => {
        if (open() && idOf(open().node) === idOf(node) && el()?.duration > 0) return el().duration;
        return Number(node.duration) > 0 ? Number(node.duration) : null;
    };

    mc.registerTool({
        name: "player-state",
        description: "What is playing in this tab right now, and where the playhead is.",
        inputSchema: { type: "object", properties: {} },
        async execute() { return text(playing() ?? "Nothing is playing."); },
    }, opts);

    mc.registerTool({
        name: "control-player",
        description: "Drive the open player: play, pause, or jump to a timestamp.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["play", "pause", "seek"] },
                seconds: { type: "number", description: "Playhead position, for seek" },
            },
            required: ["action"],
        },
        async execute({ action, seconds }) {
            const m = el();
            if (!m) return text("Nothing is playing — open something first.");
            if (action === "seek") {
                if (typeof seconds !== "number") return text("seek needs `seconds`.");
                m.currentTime = seconds;
            } else if (action === "play") await m.play().catch(() => {});
            else m.pause();
            return text(playing());
        },
    }, opts);

    mc.registerTool({
        name: "capture-frame",
        description: "Look at the video: the frame at a given timestamp (or the current one), returned as an image. Reads the real frame off the canvas where the file allows it, and falls back to the archive's own frame strip — a couple of kilobytes — where it does not.",
        inputSchema: {
            type: "object",
            properties: {
                at: { type: "number", description: "Seconds to seek to first; omit for the current frame" },
                width: { type: "number", description: "Downscale to this width, default 640" },
            },
        },
        async execute({ at, width = 640 } = {}) {
            const m = el();
            if (!m?.videoWidth) return text("No video frame to capture — nothing is playing, or it is audio.");
            if (typeof at === "number" && Math.abs(m.currentTime - at) > 0.05) {
                m.currentTime = at;
                // A seek that never completes (a dead range request, a paused
                // decoder) must not hang the agent's call forever.
                await Promise.race([
                    new Promise((r) => m.addEventListener("seeked", r, { once: true })),
                    new Promise((r) => setTimeout(r, 3000)),
                ]);
            }
            const cw = Math.min(width, m.videoWidth);
            const c = document.createElement("canvas");
            c.width = cw;
            c.height = Math.round((m.videoHeight * cw) / m.videoWidth);
            c.getContext("2d").drawImage(m, 0, 0, c.width, c.height);
            let url;
            // MEASURED, not assumed: archive.org's /download URL 302s to a node
            // host (dnNNNNNN.us.archive.org) that sends no ACAO header at all, so
            // its frames CANNOT be read here — and setting crossOrigin="anonymous"
            // on the player to try makes those files fail to load outright
            // (MEDIA_ELEMENT_ERROR, videoWidth 0). So the attribute stays off and
            // this is a per-file capability: a bought file is a blob: URL and a
            // streamed one is served by our own service worker, and both read
            // fine; a public mirror that opts out of CORS says so below.
            try { url = c.toDataURL("image/png"); }
            catch {
                // Tainted canvas — the common case on this corpus. Ask the archive
                // for its own frame near here instead of returning nothing.
                const f = await archiveFrame(open()?.node?.url, m.currentTime, m.duration);
                if (!f) return text(`Frame at ${m.currentTime.toFixed(1)}s could not be read: this file's host allows no cross-origin canvas read, and the archive has no frame strip for it.`);
                return {
                    content: [
                        { type: "text", text: `${open()?.node?.name ?? "frame"} — the archive's own frame at ~${mmss(f.seconds)} (its strip has ${f.count}; the exact frame is unreadable, this file's host sends no CORS header)` },
                        { type: "image", data: f.data, mimeType: f.mimeType },
                    ],
                };
            }
            return {
                content: [
                    { type: "text", text: `${open()?.node?.name ?? "frame"} at ${m.currentTime.toFixed(1)}s` },
                    { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: "image/png" },
                ],
            };
        },
    }, opts);

    mc.registerTool({
        name: "annotate",
        description: "Draw on the open player: bookmarks on its timeline (the person can click one to jump there) and boxes over the picture for a stretch of time. Replaces whatever was drawn before; call with nothing to clear.",
        inputSchema: {
            type: "object",
            properties: {
                marks: {
                    type: "array", description: "Bookmarks on the timeline",
                    items: {
                        type: "object",
                        properties: { at: { type: "number", description: "Seconds" }, label: { type: "string" } },
                        required: ["at", "label"],
                    },
                },
                boxes: {
                    type: "array", description: "Boxes over the picture, in 0–1 fractions of the frame",
                    items: {
                        type: "object",
                        properties: {
                            at: { type: "number" }, until: { type: "number", description: "Seconds; defaults to at + 3" },
                            x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
                            label: { type: "string" },
                        },
                        required: ["at", "x", "y", "w", "h"],
                    },
                },
            },
        },
        async execute({ marks = [], boxes = [] } = {}) {
            const node = open()?.node;
            if (!node) return text("Nothing is open — nothing to draw on.");
            // Numbers from a model, going straight into CSS percentages. A NaN
            // here is an invisible mark and a silent bug report later, so the bad
            // rows are named rather than dropped quietly.
            const bad = [];
            const num = (v, i, k) => { if (typeof v !== "number" || !Number.isFinite(v)) bad.push(`${k} of #${i}`); return v; };
            const ms = marks.map((m, i) => ({ at: num(m.at, i, "at"), label: String(m.label ?? "") }));
            const bs = boxes.map((b, i) => ({
                at: num(b.at, i, "at"), until: typeof b.until === "number" ? b.until : num(b.at, i, "at") + 3,
                // Clamped, not rejected: a box that runs off the edge is still
                // pointing at the right thing.
                x: clamp01(num(b.x, i, "x")), y: clamp01(num(b.y, i, "y")),
                w: clamp01(num(b.w, i, "w")), h: clamp01(num(b.h, i, "h")),
                label: b.label ? String(b.label) : "",
            }));
            if (bad.length) return text(`Not a number: ${bad.join(", ")}. Nothing was drawn.`);
            setNotes({ for: idOf(node), marks: ms.sort((a, b) => a.at - b.at), boxes: bs });
            return text({ drawn: { marks: ms.length, boxes: bs.length }, on: node.name });
        },
    }, opts);

    mc.registerTool({
        name: "scan-film",
        description: "Flip through a film without watching it: frames spread across its running time (or across a range), in ONE call. Costs a couple of kilobytes per frame — the way to check what a film actually contains before spending an hour on it.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "A file id; omit for whatever is open" },
                from: { type: "number", description: "Start of the range in seconds, default 0" },
                to: { type: "number", description: "End of the range in seconds, default the whole film" },
                count: { type: "number", description: "How many frames, 2–12, default 8" },
            },
        },
        async execute({ id, from = 0, to, count = 8 } = {}) {
            const node = id ? find(id) : open()?.node;
            if (!node) return text("No film named and nothing open.");
            // The strip is the archive's, so its length is what it is — asking for
            // 200 frames of a 90-frame strip returns the same picture 200 times.
            const n = Math.max(2, Math.min(12, Math.round(count)));
            const end = to ?? runtime(node) ?? 0;
            if (!(end > from)) return text(`No running time known for ${node.name} — open it first, or pass \`to\`.`);
            const want = Array.from({ length: n }, (_, i) => from + ((end - from) * i) / (n - 1));
            const shots = await Promise.all(want.map((t) => archiveFrame(node.url, t, end)));
            const got = shots.filter(Boolean);
            if (!got.length) return text(`${node.name}: no frame strip published for this one, and its bytes are not readable from here.`);
            // Duplicates are the honest answer when the range is tighter than the
            // strip's cadence — but sending the same JPEG six times is not, so they
            // collapse and the text says the real cadence.
            const seen = new Set();
            const uniq = got.filter((f) => !seen.has(f.seconds) && seen.add(f.seconds));
            const head = `${node.name} — ${uniq.length} frame${uniq.length === 1 ? "" : "s"} between ${mmss(from)} and ${mmss(end)}, from the archive's own strip of ${got[0].count}`;
            const sheet = uniq.length > 1 ? await contactSheet(uniq) : null;
            if (sheet) {
                return {
                    content: [
                        { type: "text", text: `${head}. One sheet, ${sheet.cols} across and ${sheet.rows} down, read left to right — each tile is stamped with its own time.` },
                        { type: "image", data: sheet.data, mimeType: sheet.mimeType },
                    ],
                };
            }
            return {
                content: [
                    { type: "text", text: head },
                    ...uniq.flatMap((f) => [
                        { type: "text", text: `at ${mmss(f.seconds)}` },
                        { type: "image", data: f.data, mimeType: f.mimeType },
                    ]),
                ],
            };
        },
    }, opts);

    // ── contribution: what the agent saw, back into the catalog ─────────────
    //
    // The other direction from every tool above. Those let an agent read the
    // storefront; this one lets it WRITE what it worked out, so the next
    // person's search starts where this one finished.
    //
    // It stages a draft and draws it on the timeline. It does not publish:
    // committing to Fangorn is a wallet signature under a registered publisher,
    // and that is the person's to give — same reason `open-item` walks to the buy
    // button instead of pressing it.
    mc.registerTool({
        name: "describe-scenes",
        description: "Write down what happens in a film, at timestamps — the thing the catalog does not know. Scan it with scan-film or capture-frame first, then describe what you actually saw: subject, action, shot, setting. Each description becomes a searchable moment that lands the next person on that exact second, so write for a stranger's query ('a man lights a cigarette in the rain'), not as a caption. Stages a draft for the person to review and publish; call it again after a closer pass and the better description wins.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "A file id; omit for whatever is open" },
                scenes: {
                    type: "array", description: "What happens, and when",
                    items: {
                        type: "object",
                        properties: {
                            start: { type: "number", description: "Seconds into the film" },
                            end: { type: "number", description: "Seconds; defaults to start" },
                            text: { type: "string", description: "What is on screen, in a sentence or two" },
                        },
                        required: ["start", "text"],
                    },
                },
                summary: { type: "string", description: "One line about the film as a whole, if you have one" },
            },
            required: ["scenes"],
        },
        async execute({ id, scenes, summary } = {}) {
            const node = id ? find(id) : open()?.node;
            if (!node) return text("No film named and nothing open.");
            // Same trust boundary as the server's, applied early: the agent gets a
            // usable error now rather than a 400 at publish time, long after it
            // has stopped thinking about this film.
            let clean;
            try { clean = normalizeCues(scenes ?? []); }
            catch (e) { return text(`Nothing staged — ${e.message}`); }
            if (!clean.length) return text("Nothing staged — no scenes given.");

            const draft = addScenes({ ...node, ...brief(node), desc: summary }, clean);
            // Draw them where the person is already looking. The agent describing
            // a film and the person watching it are looking at one timeline.
            setNotes({ for: idOf(node), marks: draft.scenes.map((s) => ({ at: s.start, label: s.text })), boxes: [] });
            return text({
                staged: clean.length, film: node.name, scenes_now: draft.scenes.length,
                next: "Shown on the timeline. The person reviews them and presses Publish — committing to Fangorn is their signature to give, not yours.",
            });
        },
    }, opts);

    // ── out of the tab: an edit list something else can render ───────────────
    //
    // The last thing the agent cannot do from in here. It can find the shot —
    // that is the expensive half, and search + scan-film + describe-scenes do it
    // — but a browser tab cannot cut video, and the corpus is public-domain film
    // nobody wants to watch 90 minutes of. So the tool's job is to hand off:
    // resolve each id to the URL its BYTES live at, check the numbers, and emit
    // the edit list verbatim. `ffmpeg -ss` before `-i` range-requests only the
    // frames in the cut, so rendering it moves megabytes, not gigabytes.
    //
    // ponytail: no store and no publish step. describe-scenes stages a draft
    // because it writes to the catalog and that needs a signature; an edit list
    // is scratch output, and the caller already has it in the response. Persist
    // it when something in the page reads it back.
    /** Resolve a shot list to files, and refuse the whole thing if any shot is
     *  unusable. Shared by montage (which renders it) and program-channel (which
     *  airs it) so a shot list that survives one survives the other — the two
     *  tools take the same array on purpose, and a cut worth watching is a cut
     *  worth broadcasting.
     *
     *  `bad` comes back a STRING for "there is no list at all" and an ARRAY for
     *  "these shots are wrong", because the first is one message and the second
     *  is a report. */
    const stage = (shots) => {
        if (!Array.isArray(shots) || !shots.length) return { bad: "An edit list needs `shots`; none given.", cuts: [] };
        const bad = [];
        const cuts = shots.map((s, i) => {
            const at = `#${i}`;
            const node = s.id ? find(s.id) : open()?.node;
            if (!node) { bad.push(s.id ? `${at}: no such file: ${s.id}` : `${at}: no id, and nothing is open`); return null; }
            // A paid file streams into THIS tab through the service worker and
            // has no URL anyone else can fetch. Emitting one would produce an
            // edit list that renders three seconds of 402.
            if (!node.url) { bad.push(`${at}: ${node.name} is paid — no public URL until it is bought`); return null; }
            const start = Number(s.start), dur = s.dur === undefined ? 5 : Number(s.dur);
            if (!Number.isFinite(start) || start < 0) { bad.push(`${at}: start must be a number of seconds, got ${JSON.stringify(s.start)}`); return null; }
            if (!Number.isFinite(dur) || dur <= 0) { bad.push(`${at}: dur must be more than zero, got ${JSON.stringify(s.dur)}`); return null; }
            // Every shot gets bounds-checked, in whatever film it came from —
            // the catalog knows how long they all run, so a montage across six
            // features fails here rather than rendering six seconds of black.
            const known = runtime(node);
            if (known && start >= known) bad.push(`${at}: ${node.name} ends at ${mmss(known)}, ${mmss(start)} is past it`);
            else if (known && start + dur > known) bad.push(`${at}: ${node.name} ends at ${mmss(known)}, ${mmss(start)}+${dur}s runs off the end`);
            return { node, cut: { url: node.url, start, dur }, note: s.note };
        });
        return { bad, cuts };
    };

    mc.registerTool({
        name: "program-channel",
        description: "Put an ORDERED run of clips on the television, as a channel. Takes the same `shots` as montage — but instead of rendering a file, it becomes a channel the set turns to, each slot a window the player seeks into. Use it when the order is the point: a channel where clip two answers clip one is a programme, while the same clips shuffled are only a subject. The ring is data, so it keeps playing on the clock for a viewer with no agent, long after this conversation ends.",
        inputSchema: {
            type: "object",
            properties: {
                shots: {
                    type: "array",
                    description: "The clips, in the order they should play",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "A file id; omit for whatever is open" },
                            start: { type: "number", description: "Seconds into the film" },
                            dur: { type: "number", description: "Seconds to take, default 5" },
                            note: { type: "string", description: "What this clip is — printed on its cell in the guide" },
                        },
                        required: ["start"],
                    },
                },
                title: { type: "string", description: "What to call the channel" },
            },
            required: ["shots"],
        },
        async execute({ shots, title } = {}) {
            if (!get().programTo) return text("This page cannot make channels.");
            const { bad, cuts } = stage(shots);
            if (typeof bad === "string") return text(bad);
            if (bad.length) return text(`Nothing aired — ${bad.length} shot${bad.length === 1 ? "" : "s"} unusable:\n${bad.join("\n")}`);
            const name = (title ?? "").trim() || "Programme";
            const chan = get().programTo(cuts.map((c) => ({ file: c.node, start: c.cut.start, dur: c.cut.dur, note: c.note })), name);
            if (!chan?.items?.length) return text("Nothing aired — no shot resolved to a playable slot.");
            return text({
                made: name, ...onNow(chan), slots: chan.items.length, runtime: mmss(chan.total),
                note: "On the television now, and it stays on it — the ring plays off the clock, so this programme runs for anyone who opens the set, with or without an agent. Not shareable as a link yet.",
            });
        },
    }, opts);

    mc.registerTool({
        name: "montage",
        description: "Turn shots you picked into an edit list — to render here, or to hand to software off this machine. Resolves each file to the URL its bytes actually live at and checks the numbers, so a bad supercut fails here, in one call, instead of after three features have been fetched. `format` decides who the list is for: `json` for `node scripts/cut.mjs <list>.json out.mp4`, `edl` or `otio` for an editor — Blender, Resolve, Premiere and Nuke all import one of those, and an OTIO clip carries the source URL, so the timeline resolves with nothing downloaded. Hand the text straight to whatever desktop tool you also have open. Marks the open film's shots on its timeline so the person can see the cut before it is rendered.",
        inputSchema: {
            type: "object",
            properties: {
                shots: {
                    type: "array",
                    description: "The cuts, in the order they should play",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "A file id; omit for whatever is open" },
                            start: { type: "number", description: "Seconds into the film" },
                            dur: { type: "number", description: "Seconds to take, default 5" },
                            note: { type: "string", description: "What this shot is, for the person reviewing it" },
                        },
                        required: ["start"],
                    },
                },
                format: { type: "string", enum: ["json", "edl", "otio"], description: "Who the list is for. `json` (default) renders with scripts/cut.mjs. `edl` is CMX3600, which every NLE imports. `otio` is OpenTimelineIO — JSON, and each clip carries its source URL, so it is the one to hand another tool or an agent." },
                title: { type: "string", description: "What to call the timeline, for edl/otio" },
            },
            required: ["shots"],
        },
        async execute({ shots, format = "json", title = "SOND3R" } = {}) {
            const { bad, cuts } = stage(shots);
            if (typeof bad === "string") return text(bad);
            if (bad.length) return text(`Nothing staged — ${bad.length} shot${bad.length === 1 ? "" : "s"} unusable:\n${bad.join("\n")}`);

            // Draw the open film's shots on its timeline. Shots from other films
            // are in the list but not on screen; the overlay is per-file on purpose.
            const here = open()?.node;
            if (here) {
                setNotes({
                    for: idOf(here),
                    marks: cuts.filter((c) => idOf(c.node) === idOf(here))
                        .map((c) => ({ at: c.cut.start, label: c.note || `${c.cut.dur}s` }))
                        .sort((a, b) => a.at - b.at),
                    boxes: [],
                });
            }
            const total = cuts.reduce((n, c) => n + c.cut.dur, 0);
            const head = {
                shots: cuts.length,
                films: new Set(cuts.map((c) => idOf(c.node))).size,
                runtime: mmss(total),
            };
            // An interchange list is handed on WHOLE, as the text the other tool
            // parses. Returning it beside a JSON copy of itself would double the
            // payload and invite the reader to paste the wrong half.
            if (format === "edl" || format === "otio") {
                const list = cuts.map((c) => ({ ...c.cut, note: c.note }));
                const body = format === "edl" ? toEDL(list, { title }) : toOTIO(list, { title });
                return text(`${head.shots} shots from ${head.films} film${head.films === 1 ? "" : "s"}, `
                    + `${head.runtime}. Save as ${title.replace(/[^\w.-]+/g, "_")}.${format} and import it, `
                    + `or hand the text to a tool that reads ${format.toUpperCase()}.\n\n${body}`);
            }
            return text({
                ...head,
                edits: cuts.map((c) => c.cut),
                next: "Write `edits` to a .json file and run: node scripts/cut.mjs that.json out.mp4",
            });
        },
    }, opts);

    return () => { setNotes({ for: null, marks: [], boxes: [] }); ctl.abort(); };
}

// ── self-check: `node src/ui/webmcp.js` ─────────────────────────────────────────
// Covers the two tools that touch no network. search-catalog is search.js's
// ranking with a `setHits` after it, and that ranking has its own self-check.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
    // What <Annotations> would see for a given file, without a React tree.
    const notesFor = (n) => (notes.for === idOf(n) ? notes : { marks: [], boxes: [] });
    const files = [
        { owner: "0xA", path: "Show/ep1.mp4", name: "ep1.mp4", mime: "video/mp4", kind: "video", resourceId: "0xr1", price: "2500000" },
        { owner: "0xB", path: "song.flac", name: "song.flac", mime: "audio/flac", kind: "music", url: "https://x/song.flac" },
        { owner: "0xB", path: "reel.mp4", name: "reel.mp4", mime: "video/mp4", kind: "video", url: "https://archive.org/download/Item/film.mp4", duration: 300 },
    ];
    const tools = new Map();
    let opened = null;
    // Honours the signal the way the browser does — otherwise the abort assertion
    // below is testing the stub, not the code.
    const mc = { registerTool: (t, o) => { tools.set(t.name, t); o?.signal?.addEventListener("abort", () => tools.delete(t.name)); } };
    // A stub <video>: enough surface for the transport tools, and a canvas that
    // is not there — so capture-frame is exercised only for its refusals.
    const media = { current: { currentTime: 12, duration: 90, paused: true, play: async () => { media.current.paused = false; }, pause: () => { media.current.paused = true; } } };
    const w = { media, open: { node: files[0] }, close: () => {} };
    // Two channels: one grouped out of the catalog (no spec, not shareable) and
    // one tuned (a spec, so it encodes). Rings, not stubs — airing() is the thing
    // under test as much as the tools are.
    const spec = { id: "ch:noir", title: "rainy noir", seed: "rainy noir", q: Float32Array.from([0.5, -0.5, 0.25, 1]) };
    const chansList = [
        { id: "ch:noir", kind: "walk", title: "rainy noir", number: 0, spec, items: [files[2]], total: 300 },
        { id: "cat", kind: "shelf", title: "Catalog Ch", number: 1, items: [files[2]], total: 300 },
    ];
    const walkch = chansList[0];
    let watched = null, saved = null, tunedTo = null, state = null, head = null;
    const off = registerTools(mc, () => ({
        files, show: (n) => { opened = n; }, setHits: () => {}, onError: () => {}, w,
        channels: chansList, tv: "ch:noir", state, heading: head,
        onWatch: (id) => { watched = id; }, onSave: (sp) => { saved = sp; },
        tuneTo: async (prompt, o = {}) => { tunedTo = prompt; return o.blend && !state ? null : { spec, chan: walkch }; },
    }));
    const call = async (n, a) => JSON.parse((await tools.get(n).execute(a)).content[0].text);

    eq([...tools.keys()].join(), "search-catalog,find-line,browse-catalog,open-item,list-channels,tune-channel,watch-channel,channel-schedule,share-channel,read-taste,await-viewer-signal,propose,player-state,control-player,capture-frame,annotate,scan-film,describe-scenes,program-channel,montage", "every tool registers");
    const all = await call("browse-catalog", {});
    eq(all.total, 3, "everything by default");
    eq(all.files[0].price, "2.500 USDC", "a minted resource carries its price");
    eq(all.files[1].price, "free", "no resourceId, no payment");
    // The id has to round-trip: an agent gets it from browse and hands it back to open.
    eq((await call("browse-catalog", { publisher: "0xa" })).total, 1, "publisher filter is case-insensitive");
    eq((await call("browse-catalog", { kind: "audio" })).total, 1, "kind falls back to the mime prefix");
    eq((await call("open-item", { id: all.files[0].id })).opened.name, "ep1.mp4", "open by id");
    eq(opened?.resourceId, "0xr1", "and the page actually moved");
    eq((await call("open-item", { id: "0xB/song.flac" })).note.startsWith("Free"), true, "a free file plays");
    const miss = await tools.get("open-item").execute({ id: "nope" });
    eq(miss.content[0].text, "No such file: nope", "an unknown id is a message, not a throw");

    // ── the supercut: finding words, not topics ─────────────────────────────
    // Driven directly rather than through the tool, so it needs no shard and no
    // network. The tool is loadShard + this + a wrapper.
    const cues = (owner, videoPath, rows) => ({ entityType: "subtitles", owner, videoPath, cues: rows });
    const spoken = [
        cues("0xB", "reel.mp4", [
            { start: 12, end: 14.2, text: "This broadcast." },
            { start: 40, end: 44, text: "Everything you see was assembled by hand in this very building." },
            { start: 61, end: 63, text: "They reassembled the engine overnight." },
        ]),
        cues("0xB", "song.flac", [{ start: 3, end: 5, text: "This broadcast is brought to you by the council." }]),
        cues("0xA", "Show/ep1.mp4", [{ start: 9, end: 11, text: "This broadcast is a secret." }]),
    ];
    const lines = findLines(spoken, files, ["This broadcast", "was assembled", "in your browser"]);
    eq(lines[0].total, 2, "a phrase is found across files — and never in a paid one, whose bytes montage cannot cut");
    eq(lines[0].matches[0].said, "This broadcast.", "the tightest line wins: the cue that is almost nothing else");
    eq(lines[0].matches[0].dur, 2.2, "the cut is the cue's own length");
    eq(lines[1].total, 1, "a phrase inside a long line still matches");
    eq(lines[1].matches[0].start, 40, "and cuts from the line's start");
    eq(lines[2].total, 0, "a phrase nobody says comes back empty, not approximated");
    // The whole reason for word boundaries: a supercut is built from the words
    // themselves, so "assembled" must not be satisfied by "reassembled".
    eq(findLines(spoken, files, ["assembled"])[0].total, 1, "matches are intact words, not substrings");
    eq(findLines(spoken, files, ["THIS BROADCAST"])[0].total, 2, "and case-insensitive");
    // A phrase carrying regex punctuation must search, not throw.
    // Literal, not a regex: the "." is a period the line has to actually contain,
    // so it matches "This broadcast." and not "This broadcast is brought to you".
    eq(findLines(spoken, files, ["broadcast."])[0].total, 1, "punctuation in a phrase is literal, not a wildcard");

    // ── channels ────────────────────────────────────────────────────────────
    const lst = await call("list-channels", {});
    eq(lst.channels.length, 2, "both channels listed");
    eq(lst.watching, 0, "and it says which one is on");
    eq(lst.channels[0].tuned, true, "a walk channel is marked as generated");
    eq(lst.channels[1].tuned, false, "a catalog channel is not");
    eq(typeof lst.channels[0].now.secondsLeft, "number", "what's on carries a countdown");
    // Resolution: by number, by title prefix, and by default to what's on screen.
    eq((await call("watch-channel", { channel: "1" })).watching.title, "Catalog Ch", "by number");
    eq(watched, "cat", "and the set actually turned");
    eq((await call("watch-channel", { channel: "rainy" })).watching.number, 0, "by title prefix");
    eq((await tools.get("watch-channel").execute({ channel: "42" })).content[0].text,
        "No such channel: 42", "an unknown channel is a message, not a throw");
    // Sharing: a tuned channel encodes, a catalog one has nothing to encode.
    const sh = await call("share-channel", { save: true });
    eq(sh.link.includes("#"), true, "the whole channel rides in the fragment");
    eq(unpackChan(sh.link.split("#")[1])?.title, "rainy noir", "and the link decodes back to the channel");
    eq(saved?.id, "ch:noir", "save:true keeps it");
    const shCat = JSON.parse((await tools.get("share-channel").execute({ channel: "1" })).content[0].text);
    eq(unpackRow(shCat.link.split("#")[1])?.id, "cat", "a catalog channel shares as the row it is");
    eq(shCat.tuned, false, "and says it is not a tuned one");
    // Tuning is one call: make it, turn to it, hand back the link.
    const tn = await call("tune-channel", { prompt: "rainy noir" });
    eq(tunedTo, "rainy noir", "tune-channel tunes");
    eq(tn.share.includes("#"), true, "and returns a link");
    eq(tn.made, "rainy noir", "the name survives the spread of onNow()'s own `tuned` flag");
    eq(tn.tuned, true, "which still means 'generated, not grouped'");
    eq((await call("channel-schedule", { channel: "0", hours: 1 })).slots.length > 0, true, "the schedule is computable ahead");

    // ── the viewer, and the two directions that need a page ─────────────────
    // No session: the tool says so instead of inventing a taste.
    eq((await tools.get("read-taste").execute({})).content[0].text.startsWith("No session"),
        true, "an empty session is reported, not fabricated");
    state = { speed: 0.4, q: [1, 0, 0, 0], neg: [0, 1, 0, 0], taste: { "kind:video": 1.5, "top:0xA/Kids": -0.8 } };
    head = { terms: "nature documentary", moving: true, items: [files[2]] };
    const t = await call("read-taste", {});
    eq(t.heading, "nature documentary", "the heading comes back in words");
    eq(t.drawnTo[0].tag, "kind:video", "positive taste is listed");
    eq(t.avoiding[0].tag, "top:0xA/Kids", "and so is what they are steering away from");
    eq(t.headingToward[0].name, "reel.mp4", "with what is next along it");

    // await-viewer-signal is a SUBSCRIPTION: parked before the event, woken by it.
    const at = mark();
    const parked = call("await-viewer-signal", { seconds: 5, after: at });
    emit("skip", { item: "S01E02", seconds: 4 });
    const got = await parked;
    eq(got.kind, "skip", "the page wakes a parked agent");
    eq(got.item, "S01E02", "with what actually happened");
    // Quiet is an answer. An agent that read this as an error would spin forever.
    eq((await call("await-viewer-signal", { seconds: 1 })).signal, null, "a quiet window is null, not a failure");

    // propose blocks until a human presses something, and silence is never yes.
    let shown = [];
    const offw = watch((rows) => { shown = rows; });
    const asking = call("propose", { question: "Pull toward nature docs?", options: ["Do it", "No"], seconds: 30 });
    eq(shown[0].question, "Pull toward nature docs?", "the question reaches the page");
    answer(shown[0].id, "Do it");
    eq((await asking).answer, "Do it", "and the answer reaches the agent");
    eq((await call("propose", { question: "?", seconds: 1 })).answer, null, "an unanswered proposal is a no");
    offw();

    // Evidence-tuning: blend with no session must refuse rather than invent one.
    state = null;
    eq((await tools.get("tune-channel").execute({ blend: 1 })).content[0].text.includes("no heading"),
        true, "blending a session that does not exist is refused");
    eq((await call("player-state", {})).currentTime, 12, "the playhead is reported");
    eq((await call("control-player", { action: "play" })).paused, false, "play un-pauses the open element");
    eq((await call("control-player", { action: "seek", seconds: 45 })).currentTime, 45, "seek moves the playhead");
    eq((await tools.get("control-player").execute({ action: "seek" })).content[0].text, "seek needs `seconds`.", "a seek with no target says so");
    // videoWidth is absent on the stub, which is exactly the audio/nothing-open case.
    eq((await tools.get("capture-frame").execute({})).content[0].text.startsWith("No video frame"), true, "nothing to capture is a message, not a throw");
    // ── annotate: what gets drawn, and what refuses to be ──
    const drawn = await call("annotate", { marks: [{ at: 90, label: "surfacing" }, { at: 12, label: "opening" }], boxes: [{ at: 5, x: 0.1, y: 0.2, w: 2, h: 0.3, label: "hull" }] });
    eq(drawn.drawn.marks, 2, "both marks land");
    eq(notesFor(files[0]).marks[0].label, "opening", "and they are sorted by time");
    eq(notesFor(files[0]).boxes[0].w, 1, "a box wider than the frame is clamped, not dropped");
    eq(notesFor(files[0]).boxes[0].until, 8, "an open-ended box gets a 3s window");
    // Marks belong to ONE file: film A's bookmarks must not draw on film B.
    eq(notesFor(files[1]).marks.length, 0, "another file has none of them");
    const nan = await tools.get("annotate").execute({ marks: [{ at: "twelve", label: "x" }] });
    eq(nan.content[0].text, "Not a number: at of #0. Nothing was drawn.", "a non-number is named, not drawn");
    eq(notesFor(files[0]).marks.length, 2, "and the previous marks survive it");

    // ── the archive's frame strip, over a stubbed network ──
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const named = (n) => ({ name: `Item.thumbs/film_${String(n).padStart(6, "0")}.jpg` });
    strips.clear();
    globalThis.btoa ??= (b) => Buffer.from(b, "binary").toString("base64");
    // An item holding TWO files' strips — the shape that made scan-film answer
    // with a frame from the wrong episode.
    const other = (n) => ({ name: `Item.thumbs/otherfilm_${String(n).padStart(6, "0")}.jpg` });
    globalThis.fetch = async (u) => (String(u).includes("/metadata/")
        ? { json: async () => ({ files: [{ name: "film.mp4" },
            ...[60, 120, 180, 240].map((n) => named(n)),
            ...[30, 90, 150].map((n) => other(n))] }) }
        : { ok: true, arrayBuffer: async () => jpeg.buffer });
    const seconds = "https://archive.org/download/Item/film.mp4";
    eq((await archiveFrame(seconds, 118, 300)).seconds, 120, "picks the strip frame nearest the playhead");
    eq((await archiveFrame(seconds, 5, 300)).seconds, 60, "before the first sample, the first sample");
    eq(Buffer.from((await archiveFrame(seconds, 60, 300)).data, "base64")[0], 0xff, "the jpeg comes back as base64");
    // A 4-frame strip numbered 60..240 against a 4-hour film is an INDEX, not
    // seconds: reported time has to be rescaled or it lies by hours.
    eq((await archiveFrame(seconds, 7200, 14400)).seconds, 7200, "an index-numbered strip is rescaled to real time");
    eq(await archiveFrame("https://example.com/film.mp4", 10, 300), null, "a non-archive url has no strip");
    // 30 and 90 are nearer to 35 than 60 is — but they belong to the other file
    // in the same item, so they must not be reachable from this one.
    eq((await archiveFrame(seconds, 35, 300)).seconds, 60, "another file's frames in the same item are not ours");
    eq(await archiveFrame("https://archive.org/download/Item/nothing-here.mp4", 60, 300), null, "a file with no strip of its own gets none");

    // scan-film over the same stubbed strip: 4 samples numbered 60..240.
    const scan = await tools.get("scan-film").execute({ id: idOf(files[2]), to: 300, count: 4 });
    // No canvas in node, so scan-film falls back to one image per frame. The
    // sheet itself is browser-only and verified there; what has to hold here is
    // that the fallback is complete rather than silently short.
    eq(scan.content.filter((c) => c.type === "image").length, 4, "with no canvas, four frames come back as four images");
    eq(scan.content[1].text, "at 1:00", "and each one is still labelled with its time");
    eq(await contactSheet([{ data: "x", mimeType: "image/jpeg", seconds: 0 }]), null, "no canvas is a fallback, not a throw");
    // The grid the sheet lays out on. Four across reads as a filmstrip, and the
    // last row is allowed to be short — a 12-frame scan must not silently drop
    // frames to fill a rectangle.
    eq(JSON.stringify(gridFor(12)), '{"cols":4,"rows":3}', "twelve frames tile four across");
    eq(JSON.stringify(gridFor(3)), '{"cols":3,"rows":1}', "fewer than four stay on one row");
    eq(JSON.stringify(gridFor(7)), '{"cols":4,"rows":2}', "seven leaves the last row short rather than dropping one");
    eq(gridFor(12).cols * gridFor(12).rows >= 12, true, "the grid always has room for every frame");
    eq((await tools.get("scan-film").execute({ id: idOf(files[2]), to: 300, count: 99 })).content.filter((c) => c.type === "image").length, 4, "a strip of four cannot answer twelve — duplicates collapse");
    // No `to`: the running time comes from the catalog, which carries it for
    // nearly every row — so a film that is not open can still be scanned. Taking
    // it from the PLAYER instead was the bug: that duration belongs to the film
    // in the player and to no other, so scanning reel.mp4 while ep1.mp4 was open
    // scaled reel's strip to ep1's 90 seconds and labelled every frame with a
    // second that is not in it — which describe-scenes then wrote to the catalog.
    const scanText = async (id) => (await tools.get("scan-film").execute({ id })).content[0].text;
    eq((await scanText(idOf(files[2]))).includes("between 0:00 and 5:00"), true, "a film that is not open is scanned on its catalog duration");
    w.open = { node: files[2] };
    eq((await scanText(idOf(files[2]))).includes("between 0:00 and 1:30"), true, "the open film's player duration wins — it read the real file");
    media.current.duration = 0;
    eq((await scanText(idOf(files[2]))).includes("between 0:00 and 5:00"), true, "and a player with no duration yet falls back to the catalog");
    media.current.duration = 90;
    w.open = { node: files[0] };
    eq((await scanText(idOf(files[1]))).startsWith("No running time"), true, "a row with no duration anywhere says so rather than guessing");

    // ── describe-scenes: the write direction ──
    // localStorage is the draft store's backing; the tab has one, node does not.
    const store = {};
    globalThis.localStorage ??= { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
    const describe = (args) => tools.get("describe-scenes").execute(args);
    // The draft store keys by nodeKey, not by the agent-facing id.
    const filmId = idOf(files[2]);
    const filmKey = nodeKey(files[2]);

    const bad = await describe({ id: filmId, scenes: [{ start: -1, text: "before the film" }] });
    eq(bad.content[0].text.startsWith("Nothing staged"), true, "a malformed scene is refused in the tab, not at publish time");
    eq(draftFor(filmKey), null, "a refused call must stage nothing");

    await describe({ id: filmId, scenes: [{ start: 60, end: 64, text: "a man lights a cigarette in the rain" }], summary: "noir" });
    eq(draftFor(filmKey).scenes.length, 1, "a described scene is staged");
    eq(draftFor(filmKey).desc, "noir", "the film-level summary rides along");
    eq(draftFor(filmKey).url, files[2].url, "the draft keeps the source url — an annotation nobody can play is worth nothing");
    eq(notesFor(files[2]).marks[0].label, "a man lights a cigarette in the rain", "scenes are drawn on the timeline the person is watching");

    // A second, closer pass: adds what is new, replaces what it re-describes.
    await describe({ id: filmId, scenes: [{ start: 61, text: "he cups the match against the wind" }, { start: 5, text: "rain on a window" }] });
    eq(draftFor(filmKey).scenes.length, 2, "a closer pass must not duplicate the moment it re-describes");
    eq(draftFor(filmKey).scenes[0].start, 5, "the timeline stays in order");
    eq(notesFor(files[2]).marks.length, 2, "and what is drawn tracks the draft");

    eq((await describe({ scenes: [] })).content[0].text.includes("no scenes given"), true, "an empty list stages nothing and says so");
    eq((await describe({ id: "no-such-film", scenes: [{ start: 1, text: "t" }] })).content[0].text.startsWith("No film named"), true, "an unknown id is an error, not a draft under a made-up key");
    dropScene(filmKey);

    // ── montage: the edit list that leaves the tab ──
    const cut = (args) => tools.get("montage").execute(args);
    w.open = { node: files[2] }; // reel.mp4 open, so the timeline drawing is exercised
    const list = await call("montage", { shots: [
        { id: idOf(files[2]), start: 60, dur: 12, note: "the robot" },
        { id: idOf(files[2]), start: 10 },
    ] });
    eq(list.edits.length, 2, "both shots make the list");
    eq(list.edits[0].url, files[2].url, "a shot carries the url its bytes live at, not the display id");
    eq(list.edits[1].dur, 5, "an unstated duration gets a default");
    eq(list.runtime, "0:17", "the runtime is the sum of the cuts");
    // Order is the edit, not a detail: the list must play in the order given even
    // though the marks drawn on the timeline are sorted by time.
    eq(list.edits.map((e) => e.start).join(), "60,10", "shots stay in the order given");
    eq(notesFor(files[2]).marks[0].label, "5s", "and what is drawn is sorted by time");
    // files[0] is a minted resource with no url — its bytes are not fetchable by
    // anything outside this tab, so it cannot be in an edit list at all.
    const paid = (await cut({ shots: [{ id: idOf(files[0]), start: 0, dur: 3 }] })).content[0].text;
    eq(paid.includes("is paid — no public URL"), true, "a paid file cannot be cut from outside the tab");
    // One bad shot voids the list: a supercut silently missing its third shot is
    // worse than one that refuses, because nobody re-checks a file that rendered.
    const mixed = (await cut({ shots: [{ id: idOf(files[2]), start: 1, dur: 2 }, { id: "nope", start: 1 }] })).content[0].text;
    eq(mixed.startsWith("Nothing staged — 1 shot unusable"), true, "one unusable shot voids the whole list");
    eq((await cut({ shots: [{ id: idOf(files[2]), start: 1, dur: 0 }] })).content[0].text.includes("dur must be more than zero"), true, "a zero-length cut is named, not emitted");
    eq((await cut({ shots: [] })).content[0].text.includes("none given"), true, "an empty list is a message, not a throw");
    // The open film runs 90s. A shot past the end of it is caught; the same start
    // in another film is not, because its running time is unknown from here.
    eq((await cut({ shots: [{ start: 200, dur: 3 }] })).content[0].text.includes("ends at 1:30"), true, "a shot past the end of the open film is refused");
    w.open = { node: files[0] };
    eq((await cut({ shots: [{ id: idOf(files[2]), start: 400, dur: 3 }] })).content[0].text.includes("ends at 5:00"), true, "a shot past the end of a film nobody opened is refused too");
    eq((await cut({ shots: [{ id: idOf(files[2]), start: 298, dur: 5 }] })).content[0].text.includes("runs off the end"), true, "a shot that starts inside but runs past the end is refused");
    eq((await call("montage", { shots: [{ id: idOf(files[1]), start: 9e5, dur: 3 }] })).edits.length, 1, "and a row with no duration is passed through rather than guessed at");

    off();
    eq(tools.size, 0, "abort unregisters every tool");
    eq(notesFor(files[0]).marks.length, 0, "unregistering wipes what was drawn");
    console.log("webmcp.js self-check ok — tool registry, pricing, filters, id round-trip, spoken-line scan, channel listing/resolution/share round trip, taste, subscription, consent, transport, capture refusal, annotations scoped to one file, archive frame strip, film scan, scene contribution, edit list");
}
