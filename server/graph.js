// Filesystem tree <-> Fangorn graph.
//
// The library is an open-ended tree of folders and mp4 files under media/ — the
// filesystem IS the structure, no fixed series/season/episode schema. Publishing
// snapshots the tree into a Fangorn commit graph: a vertex per folder and per
// (published) video, with parent→child `contains` edges. `replace: true` gives
// snapshot semantics, so the remote graph is always exactly the current library.
//
// A video vertex carries the x402f pointer (resourceId, price, workerUrl,
// plaintextHash) the viewer needs to pay + decrypt; the mp4 bytes live on the
// worker, not the graph. Vertices are keyed by relative path.

/** Nest a flat node list into a tree. Each node: { path, name, type:"folder"|
 *  "video", parent? , ...extra }. Parent is derived from the path when omitted.
 *  Returns root nodes; folders first, then alpha; children recursively sorted. */
export function nest(nodes) {
    const byPath = new Map();
    for (const n of nodes) byPath.set(n.path, { ...n, children: [] });
    const roots = [];
    for (const n of byPath.values()) {
        const parent = n.parent != null ? n.parent : n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
        if (parent && byPath.has(parent)) byPath.get(parent).children.push(n);
        else roots.push(n);
    }
    const sort = (arr) => {
        arr.sort((a, b) => (a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
        for (const x of arr) sort(x.children);
    };
    sort(roots);
    return roots;
}

/** Vertex id for a video's cue list. */
export const subtitlesId = (path) => `${path}#subtitles`;

/**
 * A file the publisher has marked NOT for sale. It still becomes a vertex —
 * named, described, embedded, searchable — but it carries no resourceId, and so
 * it costs no `createResource` transaction and gets no Semaphore group.
 *
 * This is what makes bulk ingest affordable. `commitStateRoot` is ONE tx for a
 * graph of any size, so a million catalog entries publish for the price of one
 * transaction; only the subset that's actually for sale pays per item. The two
 * used to be welded together here (a vertex required `published`, and
 * `published` required a create) — which is a staging-privacy policy, not a
 * chain constraint, and it doesn't apply to something the publisher explicitly
 * listed as a free entry.
 */
export const isCatalogEntry = (n) => n.forSale === false;

/** Does this fs node belong in the published graph at all? */
export const inGraph = (n) => n.type === "video" && (!!n.published || isCatalogEntry(n));

/** Flat fs nodes → { vertices:[{id,tag,payload}], edges:[{rel,from,to}] }.
 *  Published videos and catalog entries become vertices; folders are kept only
 *  if they contain (transitively) one, so the viewer never sees empty folders. */
export function buildTreeGraph(nodes) {
    const keep = new Set(); // paths to emit: graph-worthy files + their ancestors
    for (const n of nodes) {
        if (!inGraph(n)) continue;
        keep.add(n.path);
        let p = n.path;
        while (p.includes("/")) { p = p.slice(0, p.lastIndexOf("/")); keep.add(p); }
    }

    const vertices = [];
    const edges = [];
    const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    for (const n of nodes) {
        if (!keep.has(n.path)) continue;
        if (n.type === "folder") {
            vertices.push({ id: n.path, tag: "folder", payload: { kind: "folder", name: n.name, path: n.path } });
        } else {
            vertices.push({
                id: n.path, tag: "video",
                payload: {
                    // `kind: "video"` is historical — it means "a file for sale",
                    // and it stays because it's already committed on-chain. `mime`
                    // is what tells the buyer's browser what the bytes actually are;
                    // vertices published before it existed are all mp4s.
                    kind: "video", name: n.name, path: n.path, mime: n.mime ?? "video/mp4",
                    // Semantic content: the publisher's own description, and the
                    // vector for it. Both public by construction — the vector is
                    // derived from text that's already in the clear here, and it's
                    // what lets ANY aggregator bake a searchable shard without
                    // running a model or asking the publisher for anything more.
                    // A catalog entry has ONLY this half, which is the point.
                    ...(n.desc ? { desc: n.desc } : {}),
                    ...(n.embed ? { embed: n.embed } : {}),
                    // Free content the publisher doesn't host — an archive mirror,
                    // or a scene annotation pointing at the film it describes. The
                    // bytes are already public, so the pointer IS the url and
                    // there's no resource to mint. Carried here because a vertex
                    // that can be found but not played is worth very little.
                    ...(n.url ? { url: n.url } : {}),
                    // The purchase pointer, and the price that goes with it. Absent
                    // on a catalog entry — and its absence is the signal, checked
                    // everywhere downstream, so there is no second "forSale" field
                    // to contradict it. A price with nothing to buy is a lie, so
                    // neither is emitted without the other.
                    ...(n.published ? {
                        price: String(n.price),
                        resourceId: n.published.resourceId, workerUrl: n.published.workerUrl, plaintextHash: n.published.plaintextHash,
                        chunks: n.published.chunks ?? 1, // how many R2 objects the buyer reassembles
                        // Plaintext byte geometry — lets the player map a Range request
                        // onto a chunk and stream instead of downloading the whole file.
                        size: n.published.size, chunkSize: n.published.chunkSize,
                    } : {}),
                },
            });
        }
        // Subtitles are PUBLIC and live in the graph itself (not the worker): a
        // sibling vertex of timestamped cues, for embedding + semantic search
        // later. It deliberately carries `videoPath` and no `path`, which is what
        // keeps it out of treeFromGraph's viewer tree.
        if (n.type === "video" && n.cues?.length) {
            const id = subtitlesId(n.path);
            // `embed.vecs` is POSITIONAL against toPassages(cues) — nothing else
            // binds a vector to its passage. Committing cues and vectors in the
            // same vertex is what keeps them from drifting apart.
            vertices.push({ id, tag: "subtitles", payload: { kind: "subtitles", videoPath: n.path, name: n.name, cues: n.cues, ...(n.cueEmbed ? { embed: n.cueEmbed } : {}) } });
            edges.push({ rel: "subtitles", from: n.path, to: id });
        }

        const parent = parentOf(n.path);
        if (parent && keep.has(parent)) edges.push({ rel: "contains", from: parent, to: n.path });
    }
    return { vertices, edges };
}

/** Remote graph contents { vertices:[{cid?,payload}] } → nested tree for the
 *  viewer. Rebuilt from each vertex payload's `path` (authoritative), so it
 *  doesn't depend on how edges were serialized. */
export function treeFromGraph(contents) {
    const flat = (contents.vertices ?? [])
        .map((v) => v.payload)
        .filter((p) => p && p.path)
        .map((p) => ({ ...p, type: p.kind })); // kind → type for nest()
    return nest(flat);
}

// ── self-check: fs nodes → graph → tree round-trips structure ─────────────────
// `process` doesn't exist in the browser, and src/catalog/search.js imports nest() from
// here to build the viewer tree — so this guard has to survive being evaluated
// by a browser, same as the one in src/catalog/search.js.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const nodes = [
        { path: "Show", name: "Show", type: "folder" },
        { path: "Show/S1", name: "S1", type: "folder" },
        { path: "Show/S1/b.mp4", name: "b.mp4", type: "video", price: "1000", published: { resourceId: "0xbb", workerUrl: "w", plaintextHash: "0x02" }, cues: [{ start: 0, end: 2, text: "four to the floor" }] },
        { path: "Show/S1/a.mp4", name: "a.mp4", type: "video", price: "1000", published: { resourceId: "0xaa", workerUrl: "w", plaintextHash: "0x01" } },
        { path: "Show/empty", name: "empty", type: "folder" }, // no published video → pruned
        { path: "draft.mp4", name: "draft.mp4", type: "video", price: "1000" }, // unpublished → dropped
    ];
    const g = buildTreeGraph(nodes);
    if (g.vertices.some((v) => v.id === "Show/empty")) throw new Error("empty folder not pruned");
    if (g.vertices.some((v) => v.id === "draft.mp4")) throw new Error("unpublished video not dropped");

    // Catalog entries: in the graph, searchable, and carrying NO purchase pointer.
    // This is the bulk-ingest path — a vertex that costs no createResource — so the
    // thing to guard is that it never looks buyable to anything downstream.
    const withEntry = buildTreeGraph([
        ...nodes,
        { path: "Papers", name: "Papers", type: "folder" },
        { path: "Papers/abstract.txt", name: "abstract.txt", type: "video", mime: "text/plain", price: "1000", forSale: false, desc: "on umwelt", embed: { model: "m", dim: 256, vec: "AA==" }, url: "https://archive.org/download/x/y.pdf" },
    ]);
    const entry = withEntry.vertices.find((v) => v.id === "Papers/abstract.txt");
    if (!entry) throw new Error("catalog entry dropped from the graph");
    if (entry.payload.desc !== "on umwelt" || entry.payload.embed?.vec !== "AA==") throw new Error("a catalog entry must keep the semantic half — it is the only half it has");
    if ("resourceId" in entry.payload) throw new Error("a catalog entry must carry no resourceId — that is what makes it free to publish");
    if ("price" in entry.payload) throw new Error("a price with nothing to buy is a lie");
    if (entry.payload.url !== "https://archive.org/download/x/y.pdf") throw new Error("free content's url lost — the entry is findable but unplayable without it");
    if (!withEntry.vertices.some((v) => v.id === "Papers")) throw new Error("a folder holding only catalog entries was pruned");
    if (!withEntry.edges.some((e) => e.rel === "contains" && e.from === "Papers" && e.to === "Papers/abstract.txt")) throw new Error("catalog entry not linked to its folder");
    // Still unpublished-and-for-sale → still dropped. The flag is an opt-in, and
    // without it staging stays private, which is the property this file guards.
    if (withEntry.vertices.some((v) => v.id === "draft.mp4")) throw new Error("forSale defaulting changed — staged files must stay private");
    const contents = { vertices: g.vertices.map((v) => ({ payload: v.payload })) };
    const tree = treeFromGraph(contents);
    const s1 = tree[0].children.find((c) => c.name === "S1");
    if (tree[0].name !== "Show" || !s1) throw new Error("structure lost");
    if (s1.children.map((c) => c.name).join(",") !== "a.mp4,b.mp4") throw new Error("videos not sorted/nested");
    if (s1.children[0].resourceId !== "0xaa") throw new Error("video pointer lost");

    // Cues become their own vertex, reachable from the video, and must NOT show
    // up as a phantom entry in the viewer's folder tree.
    const subs = g.vertices.find((v) => v.id === subtitlesId("Show/S1/b.mp4"));
    if (!subs || subs.payload.cues[0].text !== "four to the floor") throw new Error("cues lost");
    if (!g.edges.some((e) => e.rel === "subtitles" && e.from === "Show/S1/b.mp4" && e.to === subs.id)) throw new Error("video→subtitles edge missing");
    if (s1.children.length !== 2) throw new Error("subtitles vertex leaked into the tree");

    // Semantic content rides into the graph: the description on the video vertex,
    // the vectors alongside the cues that produced them. Absent when not supplied
    // — an undefined `embed` key would serialize into every payload for nothing.
    const withMeta = buildTreeGraph(nodes.map((n) => (n.path === "Show/S1/b.mp4"
        ? { ...n, desc: "deep spanish house", embed: { model: "m", dim: 256, vec: "AA==" }, cueEmbed: { model: "m", dim: 256, vecs: ["AA=="] } }
        : n)));
    const b = withMeta.vertices.find((v) => v.id === "Show/S1/b.mp4").payload;
    if (b.desc !== "deep spanish house") throw new Error("description lost on the way to the graph");
    if (b.embed?.vec !== "AA==") throw new Error("file vector lost on the way to the graph");
    const bs = withMeta.vertices.find((v) => v.id === subtitlesId("Show/S1/b.mp4")).payload;
    if (bs.embed?.vecs?.[0] !== "AA==") throw new Error("passage vectors lost on the way to the graph");
    const a = withMeta.vertices.find((v) => v.id === "Show/S1/a.mp4").payload;
    if ("desc" in a || "embed" in a) throw new Error("empty semantic fields must be omitted, not serialized");

    console.log("graph.js self-check ok — subtitles vertex, edge, tree exclusion, semantic payload, catalog entries carry no pointer");
}
