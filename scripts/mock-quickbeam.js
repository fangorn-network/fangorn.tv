#!/usr/bin/env node
// Mock quickbeam: N views, one per port, serving the shape `cdn serve` serves.
//
//   node scripts/mock-quickbeam.js
//   → :8090 the apps index   :8091 film-archive   :8092 sound-archive
//
// Not a fixture generator and not a second implementation of the CDN — it exists so
// the consumer path (apps view → picker → app view → shards → search) can be walked
// end to end without qdrant, without a GPU, and without the registry worker. The
// moment a real `cdn serve` is up, point .env at it instead and delete nothing:
// this stays useful for the offline case.
//
// The routes are exactly the four src/catalog/search.js reads, because `cdn serve` mounts
// its app under BOTH / and /cdn and aliases /stream (quickbeam/cdn.py, "View shape,
// for a storefront with no registry worker").
//
// The CONTENT is real: public-domain film and public-domain audio from archive.org,
// with playable URLs and real byte ranges, fetched by fetch-corpus.js and embedded
// by bake-corpus.js. Two catalogs in two mediums that share no ids, no publisher and
// no collections — the only thing connecting them is the embedding space, which is
// the entire claim.
//
// ponytail: no coverage centroids, no deltas, no index artifacts, no edges. Add a
// fixture for those when something client-side actually reads them — rankDomains is
// already tested against synthetic coverage in src/catalog/search.js's own self-check.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const PORT = Number(process.env.MOCK_PORT ?? 8090);
const host = (p) => `http://localhost:${p}`;

const corpus = (name) => {
    try {
        return JSON.parse(readFileSync(new URL(`./corpus/${name}.rows.json`, import.meta.url), "utf8"));
    } catch {
        console.error(`[mock] missing scripts/corpus/${name}.rows.json — run:\n`
            + "  node scripts/fetch-corpus.js && node scripts/bake-corpus.js");
        process.exit(1);
    }
};

/** An app manifest row. The key is the registration; the fields are the manifest.
 *  `view` is the field that makes the app navigable and the one the contract has
 *  nowhere to put — see server/index.js's APPS_VIEW_URL. */
const app = (owner, appId, fields) => ({
    track_id: `apps:${owner}:${appId}`, owner,
    fields: { entityType: "app", appId, owner, ...fields },
});

/** Group a corpus into CDN domains the way a watcher would: one per (owner,
 *  namespace). The namespace here is the row's top-level folder — the collection it
 *  came out of — so a view with four collections serves four domains. */
const domainsOf = (rows) => {
    const out = {};
    for (const r of rows) {
        const ns = String(r.fields.path).split("/")[0] || "misc";
        const name = `${r.owner}/${ns.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        (out[name] ??= []).push(r);
    }
    return out;
};

const FILMS = corpus("film-archive");
const SOUNDS = corpus("sound-archive");
const OWNER_A = FILMS[0].owner, OWNER_B = SOUNDS[0].owner;

export const VIEWS = {
    [PORT]: {
        apps: [
            app(OWNER_A, "film-archive", {
                name: "Film Archive", view: host(PORT + 1),
                description: `${FILMS.length} public-domain films — computing television, `
                    + "ephemeral industrials, cartoons and newsreels, straight off archive.org.",
                termsHash: "0x" + "ab".repeat(32), termsUri: "ipfs://bafyterms-film",
            }),
            app(OWNER_B, "sound-archive", {
                name: "Sound Archive", view: host(PORT + 2),
                description: `${SOUNDS.length} public-domain recordings — old-time radio, `
                    + "78rpm records, LibriVox readings and netlabel releases.",
                termsHash: "0x" + "cd".repeat(32), termsUri: "ipfs://bafyterms-sound",
            }),
        ],
    },
    [PORT + 1]: domainsOf(FILMS),
    [PORT + 2]: domainsOf(SOUNDS),
};

const json = (res, body) => {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
};

/** Shards go out as gzip with NO Content-Encoding, exactly like `cdn serve` — the
 *  client sniffs the magic bytes rather than trusting headers, and serving these
 *  plain would leave that path untested. */
const shard = (res, rows) => {
    res.writeHead(200, { "content-type": "application/gzip", "access-control-allow-origin": "*" });
    // Rows carry `embedding` as a plain float array, which is what a real `cdn bake`
    // writes — bake-corpus.js put it there.
    res.end(gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n"))));
};

function serve(port, domains) {
    const shardFile = (name) => `shard-0000-${Buffer.from(name).toString("hex").slice(0, 12)}.ndjson.gz`;
    const server = createServer((req, res) => {
        // Strip the /cdn prefix rather than registering every route twice: a real
        // `cdn serve` mounts one app under both / and /cdn.
        const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/cdn/, "") || "/";

        if (p === "/catalog") {
            return json(res, {
                generated_at: Math.floor(Date.now() / 1000),
                embedding_model: "nomic-ai/nomic-embed-text-v1.5",
                domains: Object.entries(domains).map(([name, rows]) => ({
                    name, count: rows.length, dim: 256, manifest: `${name}/manifest.json`,
                })),
            });
        }
        let m = p.match(/^\/domains\/(.+)\/manifest$/);
        if (m && domains[m[1]]) {
            return json(res, {
                name: m[1], model: "nomic-ai/nomic-embed-text-v1.5", dim: 256,
                shards: [{ file: shardFile(m[1]), count: domains[m[1]].length }], tombstones: [],
            });
        }
        m = p.match(/^\/domains\/(.+)\/shards\/(.+)$/);
        if (m && domains[m[1]] && m[2] === shardFile(m[1])) return shard(res, domains[m[1]]);

        if (p === "/stream") {
            // Held open and silent. `watchShard` only needs the connection to exist
            // and to not error — it reloads on `added`/`change`, and a mock that
            // never publishes has neither to send.
            res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-cache" });
            res.write(": mock-quickbeam\n\n");
            return; // deliberately never ends
        }
        res.writeHead(404, { "access-control-allow-origin": "*" });
        res.end(`no route ${p}`);
    }).listen(port, () => console.log(`[mock] ${host(port)}  ${Object.keys(domains).join(", ")}`));
    return server;
}

// Importing this file (bake-mock-vectors.js does) must not open three ports.
const RUN = typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`;
const servers = RUN ? Object.entries(VIEWS).map(([port, domains]) => serve(Number(port), domains)) : [];

// ── `node scripts/mock-quickbeam.js --check` ─────────────────────────────────
// Walks the whole consumer path against the servers above: apps view → pick an app
// → that app's catalog → its shards → search. The unit self-checks in apps.js and
// search.js both stub fetch, so this is the only thing that exercises real HTTP,
// real gzip, and — the part that actually broke — switching between two views.
if (RUN && process.argv.includes("--check")) {
    const { listApps } = await import("../src/catalog/apps.js");
    const { setView, catalogFromShard, searchSubtitles, fileVectors } = await import("../src/catalog/search.js");
    const { flatten, shelves, nodeKey } = await import("../src/catalog/browse.js");
    const { session, heading, rank } = await import("../src/geometry/kernel.js");
    const { packVec } = await import("../src/llm/embed.js");
    const lexical = { embed: async () => { throw new Error("no model in node") } };
    console.warn = () => {};

    const load = async (a) => {
        setView(a.view);
        return { files: flatten((await catalogFromShard({})).tree), vecs: await fileVectors() };
    };

    const apps = await listApps(host(PORT));
    if (apps.length !== 2) throw new Error(`expected 2 apps, got ${apps.length}`);
    const A = apps.find((x) => x.appId === "film-archive");
    const B = apps.find((x) => x.appId === "sound-archive");
    if (!A || !B) throw new Error(`apps missing: ${apps.map((x) => x.appId)}`);
    if (!A.termsUri || !B.owner.startsWith("0x")) throw new Error("manifest fields lost over the wire");
    if (!A.view.endsWith(String(PORT + 1))) throw new Error("app A points at the wrong view");

    const a = await load(A), b = await load(B);
    if (a.files.length < 50 || b.files.length < 50) {
        throw new Error(`a corpus came back short: ${a.files.length} films, ${b.files.length} recordings`);
    }
    // Real bytes on BOTH sides: every row must carry a URL the browser can fetch,
    // and a thumbnail, or the cards fall back to generated blobs.
    for (const [name, src] of [["film", a], ["sound", b]]) {
        const noUrl = src.files.filter((f) => !/^https:\/\/archive\.org\//.test(f.url ?? ""));
        if (noUrl.length) throw new Error(`${noUrl.length} ${name} rows have no playable URL`);
        const noThumb = src.files.filter((f) => !f.thumb);
        if (noThumb.length) throw new Error(`${noThumb.length} ${name} rows have no thumbnail`);
    }
    if (!b.files.some((f) => (f.mime ?? "").startsWith("audio/"))) throw new Error("the sound archive holds no audio");
    if (a.files.some((f) => b.files.some((g) => g.path === f.path))) throw new Error("two apps bled into each other");
    // THE bug the per-view cache fixes: one global shard slot served whichever app
    // was loaded first, forever.
    if ((await load(A)).files.length !== a.files.length) throw new Error("switching back served the wrong app's rows");

    setView(B.view);
    if (!(await searchSubtitles("radio", lexical)).length) throw new Error("search failed inside the sound archive");
    setView(A.view);
    if ((await searchSubtitles("radio", lexical)).some((h) => b.files.some((f) => f.path === h.path))) {
        throw new Error("the sound archive's rows are searchable from the film archive");
    }

    // ── the demo, asserted ───────────────────────────────────────────────────
    // Watch films from one collection, cross into a sound archive that shares no id,
    // no publisher and no collection with it, and its front page leads with the
    // recordings nearest what you were watching. The only thing crossing that
    // boundary is a 256-d vector.
    const historyIn = (src, frag, r = 0) => src.files
        .filter((f) => f.path.toLowerCase().startsWith(frag))
        .slice(0, 5)
        .map((f, i) => ({ resourceId: nodeKey(f), app: "Film Archive", v: packVec(src.vecs.get(nodeKey(f))), at: i, ...(r ? { r } : {}) }))
        .filter((h) => h.v);

    const cross = (frag) => {
        const h = historyIn(a, frag);
        if (h.length < 3) throw new Error(`not enough films under ${frag} to form a session`);
        const st = session(h, b.vecs);
        if (!st) throw new Error(`the session died crossing into the sound archive from ${frag}`);
        const near = shelves(b.files, h, b.vecs).find((r) => r.id === "near");
        if (!near) throw new Error(`no heading shelf in the sound archive after watching ${frag}`);
        return { terms: heading(st, b.files, b.vecs)?.terms, top: near.items.slice(0, 3).map((f) => f.name) };
    };

    const seen = new Set();
    const collections = [...new Set(a.files.map((f) => f.path.split("/")[0].toLowerCase()))].slice(0, 3);
    for (const c of collections) {
        const r = cross(`${c}/`);
        console.log(`\n  watched ${c}`);
        console.log(`    sound archive compass : ${r.terms}`);
        console.log(`    sound archive leads   : ${r.top.join(", ")}`);
        seen.add(r.top.join("|"));
    }
    // If every session produced the same page, the vector would not be doing
    // anything — that is the only assertion here worth making.
    if (seen.size < 2) throw new Error("three different film collections produced the same sound-archive page");

    // ── a dislike must actually push things away ─────────────────────────────
    // The kernel's negative half is only real if it changes an ordering. Take the
    // session's own top row, dislike it, and it must not still be first.
    {
        const h = historyIn(a, `${collections[0]}/`);
        const before = rank(b.files, session(h, b.vecs), b.vecs, 8);
        const hate = { resourceId: nodeKey(before[0]), app: "Sound Archive", v: packVec(b.vecs.get(nodeKey(before[0]))), r: -1 };
        const after = rank(b.files, session([hate, ...h], b.vecs), b.vecs, 8);
        if (after[0] === before[0]) throw new Error("a disliked row stayed at the top of the ranking");
    }
    setView(null);

    console.log("\nmock-quickbeam --check ok — real corpora, apps listed, catalogs isolated, playable URLs + thumbnails, search scoped, session carries across apps, dislike repels");
    for (const s of servers) s.close();
    process.exit(0);
}

if (RUN) console.log(`\nPoint the relay at it:\n  APPS_VIEW_URL=${host(PORT)}\n  QUICKBEAM_URL=${host(PORT + 1)}\n`);
