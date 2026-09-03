// Scene descriptions: what an agent saw in a film, held in the tab until the
// person publishes them.
//
// The point of the whole feature: the archive is searchable by TITLE and blind
// to its own contents. Nobody has indexed those hours because vision inference
// over them costs money and no one is paying it for public domain film. So the
// visitor's agent does it — it already has the frames (scan-film, capture-frame)
// and it is already looking at them — and what it saw is committed to Fangorn as
// a free catalog entry. The next person's search is cheaper because this one
// happened.
//
// A scene is `{ start, end, text }`, which is EXACTLY a subtitle cue, and that is
// deliberate rather than a coincidence noticed late. The publish path already
// carries cues into the graph, windows them into passages, embeds them in the
// publisher's browser and ranks them with a seek target attached. A scene
// description is a timestamped passage of text about a film; the pipeline that
// searches dialogue searches it unchanged. So there is no second pipeline here —
// only a draft that has not been signed yet.
//
// Drafts live in localStorage, not sessionStorage: twenty minutes of an agent
// scanning a feature is not something a reload should cost.

import { nodeKey } from "./browse.js";

const KEY = "sond3r:scenes";

/** nodeKey → { id, path, name, url, mime, desc, scenes: [{start,end,text}] }.
 *  Keyed by browse.js's nodeKey, the same identity the rest of the viewer uses —
 *  NOT by webmcp's agent-facing id, which is a display string. Two ids for one
 *  file is how a draft ends up staged under a key nothing can find it by. */
let drafts = load();
const listeners = new Set();

function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; }
    catch { return {}; } // corrupt or unavailable (private window) → start empty
}

function save() {
    // A full disk must not take the drafts already on screen down with it.
    try { localStorage.setItem(KEY, JSON.stringify(drafts)); } catch { /* in memory for this tab */ }
    for (const fn of listeners) fn(drafts);
}

/** Subscribe to draft changes. Returns an unsubscribe. */
export function onScenes(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export const allDrafts = () => Object.values(drafts);
export const draftFor = (id) => drafts[id] ?? null;
export const draftCount = () => Object.values(drafts).reduce((n, d) => n + d.scenes.length, 0);

/**
 * Merge scenes into a film's draft.
 *
 * Merge, not replace: an agent scans a film in passes — a coarse sweep, then a
 * tighter range around whatever looked promising — and the second call must not
 * throw away the first. Two scenes within `nearS` of each other are the same
 * moment described twice, and the LATER call wins, because a pass over a tighter
 * range saw more than the sweep that sent it there.
 */
export const NEAR_S = 2;

export function addScenes(node, scenes, { nearS = NEAR_S } = {}) {
    const id = nodeKey(node);
    const prev = drafts[id]?.scenes ?? [];
    const kept = prev.filter((p) => !scenes.some((s) => Math.abs(s.start - p.start) < nearS));
    drafts[id] = {
        id, path: node.path, name: node.name, url: node.url, mime: node.mime,
        desc: node.desc ?? drafts[id]?.desc,
        scenes: [...kept, ...scenes].sort((a, b) => a.start - b.start),
    };
    save();
    return drafts[id];
}

/** Drop one scene (the person disagreed with it) or, with no index, the film. */
export function dropScene(id, i) {
    if (!drafts[id]) return;
    if (i == null) delete drafts[id];
    else {
        drafts[id].scenes.splice(i, 1);
        if (!drafts[id].scenes.length) delete drafts[id];
    }
    save();
}

/** Edit one scene's text in place — the human correction path. */
export function editScene(id, i, text) {
    const s = drafts[id]?.scenes?.[i];
    if (!s) return;
    s.text = String(text).trim();
    if (!s.text) return dropScene(id, i);
    save();
}

/** Everything for this film is committed — stop offering to publish it again. */
export const clearDraft = (id) => dropScene(id, null);

// ── self-check: `node src/catalog/scenes.js` ─────────────────────────────────
// The merge rule is the only real logic here, and getting it wrong means an
// agent's second pass silently deletes its first.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const store = {};
    globalThis.localStorage = {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
    };
    drafts = {};
    const node = { owner: "0xA", path: "Films/film.mp4", name: "film.mp4", url: "https://archive.org/x.mp4" };
    const key = nodeKey(node);

    addScenes(node, [{ start: 60, end: 64, text: "a man lights a cigarette in the rain" }]);
    addScenes(node, [{ start: 10, end: 12, text: "close on her face" }]);
    let d = draftFor(key);
    if (d.scenes.length !== 2) throw new Error("a second pass must add to the first, not replace it");
    if (d.scenes[0].start !== 10) throw new Error("scenes must stay sorted — toPassages windows on the gap between them");

    // Same moment, described again by a tighter pass: one scene, the newer text.
    addScenes(node, [{ start: 61, end: 66, text: "he cups the match against the wind" }]);
    d = draftFor(key);
    if (d.scenes.length !== 2) throw new Error(`a re-description of the same moment must not duplicate it: got ${d.scenes.length}`);
    if (d.scenes[1].text !== "he cups the match against the wind") throw new Error("the later, closer pass must win");
    if (draftCount() !== 2) throw new Error("draftCount must total scenes across films");

    editScene(key, 0, "  a close-up of her face  ");
    if (draftFor(key).scenes[0].text !== "a close-up of her face") throw new Error("edit must trim");
    editScene(key, 0, "   ");
    if (draftFor(key).scenes.length !== 1) throw new Error("editing a scene to nothing must drop it");

    dropScene(key, 0);
    if (draftFor(key)) throw new Error("a film with no scenes left must leave no empty draft behind");

    // Survives a reload: the drafts came back out of storage, not out of memory.
    addScenes(node, [{ start: 5, end: 6, text: "a cat" }]);
    drafts = load();
    if (draftFor(key)?.scenes[0].text !== "a cat") throw new Error("drafts must survive a reload — an agent's scan is expensive");

    console.log("scenes.js self-check ok — merge, re-description wins, sort, edit, drop, persistence");
}
