#!/usr/bin/env node
// Serve a quickbeam embeddings EXPORT (.ndjson) as a quickbeam view.
//
//   node scripts/serve-embeddings.js archive-videos-test-1.embeddings.ndjson
//   → QUICKBEAM_URL=http://localhost:8090
//
// Same four routes as scripts/mock-quickbeam.js and the same wire shape, but the
// rows are the real ones a live `cdn bake` produced — the export is what you get
// instead of a server. Separate file because the mock's content is fixtures it
// builds itself, and this one owns nothing but a file path.
//
// A domain is one (owner, meta.namespace), which is what quickbeam watches; the
// export's `embedding` is already the plain float array toRow() reads.

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { FangornConfig } from "@fangorn-network/sdk";

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const FILE = process.argv[2]?.startsWith("--") ? "archive-videos-test-1.embeddings.ndjson" : (process.argv[2] ?? "archive-videos-test-1.embeddings.ndjson");
// `--out <dir>`: write the same four routes as FILES, for a static host.
const OUT = arg("--out");
// Where the site will live, if not the host's root — GitHub Pages project sites
// serve from /<repo>/. Config points at an absolute path, so a permalink route
// (/c/0x…) resolves the catalog the same as the front page does.
const BASE = (arg("--base") ?? "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 8090);
const PER_SHARD = 2000; // so a big catalog paints as it streams instead of in one lump

if (!existsSync(FILE)) {
    console.error(`no such export: ${FILE}\nusage: node scripts/serve-embeddings.js <bundle.embeddings.ndjson>`);
    process.exit(1);
}

/** name → { rows, shards: [{file, count}], gz: Map<file, Buffer> } */
const domains = new Map();
let dim = 0;
for await (const line of createInterface({ input: createReadStream(FILE) })) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const name = `${r.owner}/${r.meta?.namespace ?? "default"}`;
    if (!domains.has(name)) domains.set(name, { rows: [], gz: new Map() });
    domains.get(name).rows.push(line);
    dim ||= r.embedding?.length ?? 0;
}
for (const [name, d] of domains) {
    d.shards = [];
    for (let i = 0; i < d.rows.length; i += PER_SHARD) {
        d.shards.push({ file: `shard-${String(d.shards.length).padStart(4, "0")}.ndjson.gz`, count: Math.min(PER_SHARD, d.rows.length - i) });
    }
}

const MODEL = "nomic-ai/nomic-embed-text-v1.5";
/** The two JSON documents, built once so the server and the static export can't
 *  drift. `nameOf` exists because a static host can't be trusted with the `/` in
 *  an `owner/namespace` domain name — see the export below. */
const catalogBody = (nameOf = (n) => n) => ({
    generated_at: Math.floor(Date.now() / 1000),
    embedding_model: MODEL,
    // ponytail: no coverage centroids — rankDomains scores an export's single
    // domain against itself. Bake them here if an export ever carries several.
    domains: [...domains].map(([name, d]) => ({ name: nameOf(name), count: d.rows.length, dim, manifest: `${nameOf(name)}/manifest.json` })),
});
const manifestBody = (name, d, nameOf = (n) => n) => ({ name: nameOf(name), model: MODEL, dim, shards: d.shards, tombstones: [] });

const cors = { "access-control-allow-origin": "*" };
const json = (res, body) => {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify(body));
};

/** Gzip with NO Content-Encoding, exactly like `cdn serve` — the client sniffs the
 *  magic bytes. Compressed once per shard and kept: the whole export is already in
 *  memory, and re-gzipping tens of MB per request is the only slow thing here. */
const shard = (res, d, i) => {
    const key = d.shards[i].file;
    if (!d.gz.has(key)) d.gz.set(key, gzipSync(Buffer.from(d.rows.slice(i * PER_SHARD, (i + 1) * PER_SHARD).join("\n"))));
    res.writeHead(200, { "content-type": "application/gzip", ...cors });
    res.end(d.gz.get(key));
};

// ── `--out <dir>`: the same view, as files ───────────────────────────────────
// A static host is the whole quickbeam server here: /api/config names the view,
// and the view is four documents that never change. `readOnly` drops the
// publisher tab, so the demo is browse + search + play free content and nothing
// that needs a relay, a wallet or a worker.
if (OUT) {
    // A domain's name IS its URL segment (search.js encodeURIComponent's it), and
    // `owner/namespace` puts a %2F in the path — which hosts variously decode,
    // reject, or 404 on. Nothing downstream parses the name, so the static export
    // flattens it. ponytail: rename here, not everywhere.
    const flat = (n) => n.replace(/\//g, "_");
    const put = (rel, body) => {
        const at = join(OUT, rel);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, body);
    };
    // Under /qb rather than at the root: search.js strips a trailing `/cdn` off
    // the configured URL to get the view base, and a bare `/cdn` strips down to
    // "" — which it reads as "no view configured".
    // The SAME document the relay's `GET /api/config` prints, from the same env,
    // because it is the bootstrap an unattended buyer reads before it will talk to
    // anything — registry, USDC, facilitator, RPC. A static host that publishes
    // only `quickbeam` is browsable by a human and invisible to an agent.
    // PUBLIC_FACILITATOR_URL over FACILITATOR_URL for the reason the relay does it:
    // the browser has a /facilitator proxy to dodge CORS and an agent has none.
    put("api/config", JSON.stringify({
        quickbeam: `${BASE}/qb`,
        readOnly: true,
        chainId: FangornConfig.chain.id,
        registry: process.env.SETTLEMENT_REGISTRY_ADDR,
        usdc: process.env.USDC_CONTRACT_ADDR,
        usdcDomainName: process.env.USDC_DOMAIN_NAME ?? "USD Coin",
        facilitator: (process.env.PUBLIC_FACILITATOR_URL ?? process.env.FACILITATOR_URL ?? "").replace(/\/$/, ""),
        rpc: process.env.CHAIN_RPC_URL ?? process.env.VITE_CHAIN_RPC_URL ?? FangornConfig.rpcUrl,
    }));
    put("qb/cdn/catalog", JSON.stringify(catalogBody(flat)));
    let bytes = 0;
    for (const [name, d] of domains) {
        put(`qb/cdn/domains/${flat(name)}/manifest`, JSON.stringify(manifestBody(name, d, flat)));
        d.shards.forEach((s, i) => {
            const gz = gzipSync(Buffer.from(d.rows.slice(i * PER_SHARD, (i + 1) * PER_SHARD).join("\n")));
            bytes += gz.length;
            put(`qb/cdn/domains/${flat(name)}/shards/${s.file}`, gz);
        });
        console.log(`[static] ${flat(name)}  ${d.rows.length} rows  ${d.shards.length} shards`);
    }
    console.log(`[static] ${OUT} — ${(bytes / 1e6).toFixed(1)} MB of shards, served from ${BASE}/qb/cdn`);

    // /api/catalog, baked from the shards just written by the CLIENT'S OWN reader
    // run against them on disk — so the tree an agent GETs and the tree the browser
    // derives cannot disagree, and a broken shard fails the build instead of the
    // first visitor. The relay computes this from the chain; a static host has no
    // chain access and no relay, and without the file `sond3r-buy` 404s on
    // discovery before it ever reaches a wallet.
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
        const rel = decodeURIComponent(new URL(String(u), "http://x").pathname).slice(BASE.length + 1);
        const at = join(OUT, rel);
        return existsSync(at) ? new Response(readFileSync(at)) : real(u, o);
    };
    const { catalogFromShard } = await import("../src/catalog/search.js");
    const catalog = await catalogFromShard({ url: `${BASE}/qb` });
    globalThis.fetch = real;
    // Cloudflare Pages rejects any file over 25 MiB, and `desc` is 16 of this
    // document's 30 MB — full archive.org blurbs, repeated per leaf. The agent
    // reading /api/catalog is deciding what to buy, not reading the essay; the
    // untruncated text is still in the shards.
    // ponytail: a per-item cap bounds the row, not the file — shard /api/catalog
    // when the corpus outgrows 25 MiB again.
    const clip = (n) => {
        if (n.desc?.length > 280) n.desc = n.desc.slice(0, 280) + "…";
        n.children?.forEach(clip);
    };
    catalog.tree.forEach(clip);
    const body = JSON.stringify(catalog);
    if (body.length > 25 * 1024 * 1024) throw new Error(`api/catalog is ${(body.length / 1048576).toFixed(1)} MiB — over the 25 MiB Pages limit; shard it`);
    put("api/catalog", body);
    console.log(`[static] api/catalog — ${catalog.tree.length} root(s) from ${catalog.publishers.length} publisher(s)`);
    process.exit(0);
}

createServer((req, res) => {
    // A real `cdn serve` mounts one app under both / and /cdn.
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/cdn/, "") || "/";

    if (p === "/catalog") return json(res, catalogBody());
    let m = p.match(/^\/domains\/(.+)\/manifest$/);
    if (m && domains.has(m[1])) return json(res, manifestBody(m[1], domains.get(m[1])));
    m = p.match(/^\/domains\/(.+)\/shards\/(.+)$/);
    if (m && domains.has(m[1])) {
        const d = domains.get(m[1]);
        const i = d.shards.findIndex((s) => s.file === m[2]);
        if (i >= 0) return shard(res, d, i);
    }
    if (p === "/stream") {
        // Held open and silent: an export never gains shards, and watchShard only
        // needs the connection to exist and not error.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
        return void res.write(": serve-embeddings\n\n");
    }
    res.writeHead(404, cors);
    res.end(`no route ${p}`);
}).listen(PORT, () => {
    for (const [name, d] of domains) console.log(`[export] ${name}  ${d.rows.length} rows  ${d.shards.length} shards`);
    console.log(`\n[export] http://localhost:${PORT}\nPoint the relay at it:\n  QUICKBEAM_URL=http://localhost:${PORT}\n`);
    if (process.argv.includes("--check")) check();
});

// ── `node scripts/serve-embeddings.js <file> --check` ────────────────────────
// The client's own reader against this server: catalog → manifests → every shard
// → tree → vectors → a search that must return the row whose vector it was given.
// Not in `pnpm test` — it needs the multi-hundred-MB export on disk.
async function check() {
    const { default: assert } = await import("node:assert");
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => (String(u) === "/api/config"
        ? new Response(JSON.stringify({ quickbeam: `http://localhost:${PORT}/stream` }))
        : real(u, o));
    const { loadShard, catalogFromShard, fileVectors, searchSubtitles } = await import("../src/catalog/search.js");

    const total = [...domains.values()].reduce((n, d) => n + d.rows.length, 0);
    const shards = [...domains.values()].reduce((n, d) => n + d.shards.length, 0);
    let paints = 0;
    const rows = await loadShard(undefined, () => paints++);
    assert.equal(rows.length, total, "every row reaches the client");
    // At least one per shard: a shard boundary always paints, and a shard that
    // takes longer than EMIT_MS to arrive paints partway through as well.
    assert(paints >= shards, `expected at least one paint per shard, got ${paints} for ${shards}`);
    assert(rows.every((r) => r.vector?.length === dim && r.norm > 0), "vectors survive the wire");
    assert((await catalogFromShard()).tree.length, "the shards build a tree");
    assert((await fileVectors()).size > 0, "files are keyed for the kernel");

    // A row's own vector as the query must rank that row first — the end-to-end
    // proof that the bytes served here are the vectors search actually scores.
    const probe = rows.find((r) => r.vector);
    const hits = await searchSubtitles(probe.name, { limit: 3, embed: async () => probe.vector });
    assert.equal(hits[0]?.videoPath, probe.path, `top hit ${hits[0]?.videoPath}`);

    console.log(`[check] ok — ${rows.length} rows, ${paints} paints, top hit ${hits[0].name}`);
    process.exit(0);
}
