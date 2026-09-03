// Curated rows: a shelf that is a QUESTION, not a bucket.
//
// kernel.js `topics()` partitions the catalog — every file lands in exactly one
// cluster, named by the words that separate it. That's what the catalog is made
// of. This is the other half: a fixed set of probe phrases ("someone explaining
// how a thing works"), each embedded once, offline, and shipped as vectors. A
// file is on a probe's shelf when it sits close enough to that phrase — and it
// can be on four of them at once, which is the whole reason Netflix's rows read
// as curation and a cluster list reads as a filing cabinet.
//
// The probe vectors are baked by `pnpm probes` (scripts/bake-probes.js) into
// probe-vectors.js, so browsing costs NO model download. That constraint is the
// point: today the embedder only loads when someone actually types in the search
// box, and a front page that quietly pulls ~100 MB to draw headings would be a
// bad trade for everyone who was only browsing.
//
// The probe text is embedded as a QUERY (nomic is asymmetric — see embed.js), so
// probe-vs-file cosine is exactly the geometry search already ranks with.

import { EMBED_DIM, EMBED_MODEL, unpackVec } from "../llm/embed.js";
import { dotUnit, unit } from "./kernel.js";
// One definition of catalog identity, shared with browse.js and search.js.
import { nodeKey } from "../catalog/browse.js";
import BAKED from "./probe-vectors.js";

// Two rows of four, same as a shelf.
const TILES = 8;
// A shelf of three is a rounding error, not a category.
const MIN_ITEMS = 4;
// How many probe rows the front page will carry at most. They sit between the
// catalog's own topics and the type sections, and more than a few turns the page
// into a wall of near-duplicates.
const MAX_ROWS = 3;

// A file joins a probe's shelf when that probe is an OUTLIER among its own probe
// scores — not when the raw cosine clears some number.
//
// That is not a refinement, it's the thing that makes this work at all. Raw
// nomic-256 cosine is compressed and offset per document: measured over a set of
// realistic filenames, every file scored 0.4–0.65 against all sixteen probes, so
// any absolute floor either admitted everything or nothing. The same measurement
// in z: the right probe lands 1.8–2.7σ above a file's own mean, the plausible-
// but-wrong runner-up 1.0–1.6σ, and a file with no real affinity (a backup
// tarball, an untitled photo) never gets above 1.7σ for anything.
//
// ponytail: fixed Z, measured once against a dozen hand-written filenames — see
// the numbers above. If real catalogs disagree, move this one number; a per-probe
// threshold baked next to each vector is the next step up, not a cleverer formula.
const MIN_Z = 1.8;

// z is only meaningful across a spread of probes. Below this many baked vectors
// the mean and deviation are noise, so no rows at all.
const MIN_PROBES = 6;

// Two probes that pull the same eight files are one row with two names.
const MAX_OVERLAP = 0.6;

/**
 * The probe library. `text` is what gets embedded — write it as a description of
 * the thing, in the words a person would use, because that is what the model was
 * trained to match. `title` is what the viewer reads, and is allowed to have an
 * opinion, but it must never claim more than `text` asked for.
 *
 * These are deliberately about MEDIUM, SETTING and PURPOSE rather than genre:
 * genre words ("thriller", "house music") are already what `topics()` finds in
 * filenames, and a catalog of tarballs and PDFs has no genre at all.
 */
export const PROBES = [
    { id: "explained", title: "Somebody explains it properly",
        text: "a person explaining how something works, a walkthrough, a tutorial, a lesson taught step by step" },
    { id: "live", title: "Recorded live, in a room",
        text: "a live performance in front of an audience, recorded in one take, a concert, a set played live on stage" },
    { id: "instrumental", title: "Nothing but instruments",
        text: "instrumental music with no singing, ambient, quiet playing, background music to work or read to" },
    { id: "talk", title: "Long conversations",
        text: "two people talking at length, an interview, a discussion, a conversation recorded as it happened" },
    { id: "paperwork", title: "The paperwork",
        text: "a contract, an agreement, a licence, terms, an invoice, a filing, a form, official documentation" },
    { id: "reference", title: "Made to be read, not watched",
        text: "a manual, a specification, a reference document, a handbook, documentation written to be looked things up in" },
    { id: "field", title: "Field recordings",
        text: "sound recorded outdoors, in a place, rain wind traffic birds, an environment captured as it was" },
    { id: "night", title: "Nights and cities",
        text: "night, city streets after dark, neon, rain on windows, late hours, an urban scene at night" },
    { id: "outdoors", title: "Weather and landscape",
        text: "mountains, forest, the sea, open landscape, wilderness, an expedition outdoors in the weather" },
    { id: "archive", title: "From the archive",
        text: "old footage, an archive recording, historical material, something recorded decades ago, restored from tape or film" },
    { id: "handmade", title: "Made by hand",
        text: "making something by hand, craft, building, repairing, cooking, woodwork, a workshop process from start to finish" },
    { id: "nerds", title: "For nerds, specifically",
        text: "deeply technical detail, engineering, mathematics, source code, protocols, hardware internals, for people who already know the basics" },
    { id: "data", title: "Numbers to work with",
        text: "a dataset, a spreadsheet, measurements, records, tabular data, exported statistics, a database dump" },
    { id: "art", title: "Pictures, mostly",
        text: "photographs, portraits, illustration, artwork, a set of images, design work, visual studies" },
    { id: "beginnings", title: "Start at the beginning",
        text: "an introduction for beginners, the first part, getting started, the basics explained from nothing" },
    { id: "slow", title: "Slow and long",
        text: "long and slow, unhurried, hours rather than minutes, meditative, something to leave running" },
];

const stamped = BAKED?.model === EMBED_MODEL && BAKED?.dim === EMBED_DIM;

/** Probe id → vector, unpacked once. Empty when nothing has been baked, or when
 *  the bake came from a different model — vectors from two models are not
 *  comparable, and silently so, which is exactly the bug that ruins an index. */
const probeVectors = new Map(
    stamped
        ? Object.entries(BAKED.vecs ?? {}).map(([id, b64]) => [id, unpackVec(b64)]).filter(([, v]) => v)
        : [],
);

const idsOf = (row) => new Set(row.items.map((f) => f.resourceId?.toLowerCase()));
const overlap = (a, b) => {
    let shared = 0;
    for (const id of a) if (b.has(id)) shared++;
    return shared / Math.min(a.size, b.size);
};

/**
 * Probe rows for this file set, best first.
 *
 * @param files    flatten(tree), already narrowed by whatever filter is on
 * @param vectors  Map<resourceId, vector> — the same map shelves() ranks with
 * @returns [{ id, title, why, items }] — [] when nothing is baked, nothing is
 *          embedded, or nothing clears the floor. A sparse catalog showing no
 *          curated rows is correct; showing rows of four unrelated files is not.
 */
export function probeShelves(files, vectors = new Map(), probes = PROBES, vecs = probeVectors) {
    const live = probes.filter((p) => vecs.get(p.id));
    if (live.length < MIN_PROBES) return [];

    // Each file picks its own shelves: score it against every probe, then keep the
    // ones that stand out from its own distribution. A file with nothing to say
    // ends up on no shelf, which is how a sparse catalog stays honest.
    const hits = new Map(live.map((p) => [p.id, []]));
    // The probe vectors are constant and the file vector is scored against every
    // one of them, so both sides are normalized ONCE and the inner loop is a plain
    // dot product. cosine() re-derived every probe's norm for all 20,402 files:
    // 1451ms, the single most expensive thing on the front page.
    const pv = live.map((p) => unit(vecs.get(p.id)));
    for (const f of files) {
        // nodeKey, NOT resourceId: a free catalog entry has no resource minted, and
        // fileVectors() keys those by owner+path. Keying on resourceId meant every
        // row of an open catalog missed, so probe shelves silently never appeared
        // on the one kind of catalog they were most useful for.
        const v = vectors.get(nodeKey(f));
        if (!v) continue;
        const u = unit(v);
        const scores = pv.map((p) => dotUnit(u, p));
        const mu = scores.reduce((a, x) => a + x, 0) / scores.length;
        const sd = Math.sqrt(scores.reduce((a, x) => a + (x - mu) ** 2, 0) / scores.length);
        if (sd < 1e-6) continue; // a file equidistant from every probe has no shelf
        live.forEach((p, i) => {
            const z = (scores[i] - mu) / sd;
            if (z >= MIN_Z) hits.get(p.id).push({ f, z });
        });
    }

    const rows = [];
    for (const p of live) {
        const scored = hits.get(p.id);
        if (scored.length < MIN_ITEMS) continue;
        scored.sort((a, b) => b.z - a.z);
        // Everything that cleared the z bar, not the first eight — the row's page
        // is where the rest of them live. The carousel draws TILES of it.
        const items = scored;
        rows.push({
            id: `probe:${p.id}`,
            title: p.title,
            why: "picked by what they're about",
            items: items.map((x) => x.f),
            // Row strength, not item strength: a row whose members are all strongly
            // and distinctively about this outranks one that squeaks past.
            score: items.reduce((sum, x) => sum + x.z, 0) / items.length,
        });
    }

    // Strongest first, then drop anything that is mostly a repeat of a row
    // already kept — two probes over a small catalog often land on the same eight
    // files, and the second one reads as the page stuttering.
    rows.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const r of rows) {
        const ids = idsOf(r);
        if (kept.some((k) => overlap(ids, idsOf(k)) > MAX_OVERLAP)) continue;
        kept.push(r);
        if (kept.length === MAX_ROWS) break;
    }
    return kept.map(({ score, ...row }) => row); // eslint-disable-line no-unused-vars
}

// ── self-check: `node src/geometry/probes.js` ─────────────────────────────────────────
// Runs on synthetic vectors — no model, no baked file needed, so it stays honest
// even before `pnpm probes` has ever been run.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    // Eight mutually orthogonal probes, so a file's own probe scores have a real
    // distribution to be an outlier in — the same shape the baked set has, minus
    // the model. A file pointing straight at one probe lands ~2.6σ; a file split
    // evenly between two lands ~1.7σ for each, i.e. below the bar, on purpose.
    const D = 8;
    const axis = (i) => Array.from({ length: D }, (_, j) => (j === i ? 1 : 0));
    const blend = (i, j) => axis(i).map((x, k) => (x + axis(j)[k]) / Math.SQRT2);
    const probes = Array.from({ length: D }, (_, i) => ({ id: `p${i}`, title: `P${i}`, text: "" }));
    const vecs = new Map(probes.map((p, i) => [p.id, axis(i)]));

    const fv = new Map();
    const on = (n, i, mk = axis) => Array.from({ length: n }, (_, k) => {
        const id = `${i}-${k}`;
        fv.set(id, mk(i));
        return { resourceId: id, name: id };
    });
    const six = on(6, 0);                                   // squarely about p0
    const three = on(3, 1);                                 // about p1, but too few
    const split = Array.from({ length: 6 }, (_, k) => {     // between p2 and p3
        const id = `mix-${k}`;
        fv.set(id, blend(2, 3));
        return { resourceId: id, name: id };
    });

    const one = probeShelves(six, fv, probes, vecs);
    if (one.length !== 1) throw new Error(`six files on one probe must make exactly one row, got ${one.length}`);
    if (one[0].id !== "probe:p0") throw new Error("the row must be the probe the files are actually about");
    if (one[0].items.length !== 6) throw new Error("every qualifying file belongs on the row");

    // The bar is the whole safety property. A file that is vaguely near two
    // probes is not "about" either, and must not be dressed up as a curated pick.
    if (probeShelves(split, fv, probes, vecs).length) {
        throw new Error("files with no standout probe must produce NO row, not a weak one");
    }
    if (probeShelves(three, fv, probes, vecs).length) throw new Error("fewer than four matches is not a shelf");
    if (probeShelves(six, new Map(), probes, vecs).length) throw new Error("a lexical-only shard must produce no curated rows");
    if (probeShelves(six, fv, probes, new Map()).length) throw new Error("no baked vectors must mean no rows");
    // Too few probes to have a distribution at all — z would be noise, so silence.
    if (probeShelves(six, fv, probes.slice(0, 3), vecs).length) throw new Error("a handful of probes must not be z-scored");

    // Two probes pointing the same way are one row wearing two hats.
    const twinned = [...probes, { id: "twin", title: "Twin", text: "" }];
    const twinVecs = new Map([...vecs, ["twin", axis(0)]]);
    const dup = probeShelves(six, fv, twinned, twinVecs);
    if (dup.length !== 1) throw new Error(`two probes over the same files must collapse to one row, got ${dup.length}`);

    // …but probes over genuinely different files are separate rows, and a file
    // can be on more than one shelf — the reason this exists at all.
    const wide = probeShelves([...six, ...on(5, 4)], fv, probes, vecs);
    if (wide.length !== 2) throw new Error(`probes over disjoint sets must both survive, got ${wide.length}`);
    if (wide.some((r) => r.score !== undefined)) throw new Error("the internal score must not leak into the rendered row");

    console.log("probes.js self-check ok — outlier bar, silence on ambiguity, thin-probe guard, overlap collapse");
}
