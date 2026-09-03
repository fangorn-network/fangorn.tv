// Thin client for the relay (publisher-side tree + publish). Buyer flow does NOT
// go through here — it talks to the facilitator/worker directly (src/pay/purchase.js).
//
// Every staging route is session-scoped: the relay derives the publisher from
// the bearer token, never from a parameter we send. So there is deliberately no
// `owner` argument anywhere below — the token IS the identity.

/** Session token from signIn(). Kept in sessionStorage so a page reload doesn't
 *  cost another wallet signature, but a closed tab does end the session.
 *  ponytail: NOT localStorage — a staging token shouldn't outlive the tab. */
const DEFAULT_PRICE = "1000";

const TOKEN_KEY = "sond3r:session";
let token = sessionStorage.getItem(TOKEN_KEY);

const setToken = (t) => {
    token = t;
    if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY);
};

/** Thrown on 401 so the UI can prompt for re-signin instead of showing a raw error. */
export class UnauthorizedError extends Error {
    constructor(message) { super(message); this.name = "UnauthorizedError"; }
}

/**
 * Telegram's signature over who opened the Mini App. Undefined in an ordinary
 * browser tab, where it is simply left off — the web app has never needed it.
 * The Mini App is served by a Worker that requires it on every /api/ call, and
 * putting it here means the relay routes it proxies get it too, rather than each
 * caller remembering.
 */
const initDataHeaders = () => {
    const initData = window.Telegram?.WebApp?.initData;
    return initData ? { "X-Init-Data": initData } : {};
};

const authHeaders = (extra = {}) => ({ ...extra, ...initDataHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) });


async function j(res) {
    if (res.status === 401) { setToken(null); throw new UnauthorizedError("Session expired — sign in with your wallet again."); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json();
}
const get = (url) => fetch(url, { headers: authHeaders() }).then(j);
const post = (url, body) => fetch(url, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }).then(j);


// ── the publisher's library, client-side ─────────────────────────────────────
//
// This used to be the relay's filesystem. It is now a manifest in the publisher's
// OWN R2 bucket plus, for this tab only, the File handles they just picked.
//
// Why the split: bytes go browser → the publisher's own worker and never touch
// the relay, so the relay has no disk to read a tree off. What it still does is
// the part that needs Node — minting resourceIds, building the graph commit,
// pinning the CAR — and that runs off the library POSTed to /api/publish/prepare.
//
// The consequence worth knowing: a file picked but not yet published lives only
// in this tab. A reload loses the File handle (the browser gives no durable
// reference to a picked file), so it has to be picked again. Anything PUBLISHED
// is safe — it is in the manifest, in R2, and on-chain.
// ponytail: no File System Access API and no IndexedDB blob cache. Both would
// buy resumable staging across reloads; neither is needed to publish, and the
// second means holding a copy of the video in the browser's storage quota.

import { nest } from "../../server/graph.js";
import { flatten } from "./browse.js";
import { deleteResource, resourceIdFor } from "../pay/envelope.js";
import { encryptAndUpload, manifestFromTree, readManifest as readR2Manifest, writeManifest as writeR2Manifest } from "../pay/encrypt.js";

/** In-tab state: the manifest as last read/written, plus File handles by path. */
let lib = null;              // { owner, workerUrl, uploadToken, manifest }
const staged = new Map();    // relpath → File, this tab only

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Same containment rule the relay applies (server/index.js safeRel): strip a
 *  leading `../`, refuse an interior one. Applied here too so the UI never shows
 *  a path the commit would silently rewrite. */
function safeRel(p) {
    const rel = String(p ?? "").replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
    if (rel === "." || rel === "") return "";
    if (rel.split("/").includes("..")) throw new Error("bad path");
    return rel;
}

/**
 * Load the library for `owner`, reading the manifest out of the shared bucket.
 *
 * There is nothing cached in localStorage and nothing to connect: the relay names
 * the worker and derives this publisher's upload token from their address, so the
 * same wallet gets the same answer in a browser that has never seen it — and now
 * for any wallet, registered or not. The worker caps what an unregistered one can
 * cost the operator (FREE_BYTES), so registration only gates publishing.
 */
async function load(owner) {
    if (lib?.owner === owner) return lib;
    const { workerUrl, uploadToken } = await get("/api/worker");
    lib = { owner, workerUrl, uploadToken, manifest: { files: {} } };
    if (lib.workerUrl) lib.manifest = await readR2Manifest(lib);
    // Nothing in the bucket: rebuild from what this publisher already put
    // on-chain, rather than showing them an empty portal.
    if (!Object.keys(lib.manifest.files).length) await recoverFromChain();
    return lib;
}

/**
 * Rebuild the manifest from the publisher's own on-chain namespace.
 *
 * The manifest is a CACHE of something already public: the commit graph carries
 * every published file's path, price, description, and purchase pointer. So an
 * empty bucket is recoverable rather than fatal — which matters for a publisher
 * who published before the manifest moved into R2, and for anyone opening the
 * portal in a browser that has never seen this wallet.
 *
 * Two things it deliberately does NOT try to recover:
 *
 *  - `uid`. resourceId is keccak(owner ++ keccak("sond3r:"+uid)), which is
 *    one-way. It does not matter: identity is carried by `published.resourceId`,
 *    and every path that could re-derive an id prefers the recorded one. A fresh
 *    uid on a recovered entry never changes what a buyer already paid for.
 *  - Unpublished files. They were never on-chain and their bytes were never
 *    anywhere but the publisher's own disk.
 *
 * Each recovered file keeps the `workerUrl` its pointer records, which is what
 * keeps anything published to a publisher-owned worker readable after storage
 * moved to the shared one.
 */
async function recoverFromChain() {
    let tree;
    try {
        ({ tree } = await get(`/api/remote?owner=${lib.owner}`));
    } catch {
        return; // offline, or nothing published — an empty library is correct
    }
    const files = flatten(tree ?? []);
    if (!files.length) return;

    lib.manifest.files = manifestFromTree(files, { defaultPrice: DEFAULT_PRICE, newUid: uid });
    // Write the recovery back so this is a one-time cost, not a chain read on
    // every load. Best-effort: an unregistered wallet has no bucket to write to
    // and still gets its library on screen. Never fail the load over a cache write.
    try { await persist(); } catch { /* shown either way */ }
}

const persist = () => writeR2Manifest({ ...lib, manifest: lib.manifest });

/** manifest + staged files → the flat node list walkTree used to produce. */
function nodes() {
    const out = [];
    const dirs = new Set(lib.manifest.folders ?? []);
    for (const [path, f] of Object.entries(lib.manifest.files)) {
        for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i));
        const name = path.slice(path.lastIndexOf("/") + 1);
        out.push({
            path, name, parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
            type: "video", mime: f.mime ?? "application/octet-stream",
            price: f.price, published: f.published, uid: f.uid, desc: f.desc,
            forSale: f.forSale !== false, url: f.url,
            // What the UI needs to say "this one still has to go up".
            staged: staged.has(path), cues: f.cues,
        });
    }
    for (const d of dirs) out.push({ path: d, name: d.slice(d.lastIndexOf("/") + 1), parent: d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "", type: "folder" });
    return out;
}

const entry = (path) => (lib.manifest.files[path] ??= { uid: uid(), price: DEFAULT_PRICE });

/** The library in the shape /api/publish/prepare validates. */
const libraryForCommit = () => nodes().map((n) => (n.type === "folder"
    ? { path: n.path, type: "folder" }
    : { path: n.path, type: "video", uid: n.uid, price: n.price, mime: n.mime, desc: n.desc, forSale: n.forSale, cues: n.cues, url: n.url, published: n.published }));

export const api = {
    setToken,
    hasToken: () => !!token,

    // ── sign-in handshake ─────────────────────────────────────────────────────
    sessionNonce: (address) => post("/api/session/nonce", { address }),
    session: (nonce, signature) => post("/api/session", { nonce, signature }),
    whoami: () => get("/api/session"),
    signOut: () => post("/api/session/end", {}).finally(() => setToken(null)),

    // ── staging (all session-scoped) ──────────────────────────────────────────
    // Local, not a fetch: the tree is the manifest plus whatever was picked in
    // this tab. `owner` comes from the session so the manifest read is scoped the
    // same way the relay used to scope the directory.
    getTree: async () => {
        const { address } = await get("/api/session");
        await load(address);
        return { tree: nest(nodes()), defaultPrice: DEFAULT_PRICE, owner: address };
    },
    getConfig: () => get("/api/config"),
    getSales: () => post("/api/sales", { manifest: lib?.manifest ?? { files: {} } }),
    // { registered, acceptedTerms, terms } — plus the unsigned register() tx when
    // it's false AND the terms are signed. `tx` is null until they are.
    getRegistration: () => get("/api/registration"),
    // { hash, url, accepted, message } — `message` is the exact bytes to sign.
    getTerms: () => get("/api/terms"),
    acceptTerms: (signature) => post("/api/terms/accept", { signature }),
    // { workerUrl, own } — where this publisher's bytes go. There is nothing to
    // set up: storage is the relay operator's Cloudflare account and their R2
    // bill, and every signed-in wallet gets the worker's free tier (50 MiB)
    // whether or not it is a registered publisher. `own: false` now only means
    // the relay has no worker configured at all.
    getWorker: async () => {
        const { address } = await get("/api/session");
        await load(address);
        return { workerUrl: lib.workerUrl, own: !!lib.workerUrl };
    },

    newFolder: async (path) => {
        const rel = safeRel(path);
        if (!rel) throw new Error("path required");
        lib.manifest.folders = [...new Set([...(lib.manifest.folders ?? []), rel])];
        await persist();
        return { ok: true, path: rel };
    },

    setPrice: async (path, price) => {
        entry(safeRel(path)).price = String(price ?? DEFAULT_PRICE);
        await persist();
        return { ok: true };
    },

    setDesc: async (path, desc) => {
        // Capped, not sanitized — it is the publisher's own library and only ever
        // renders as text. The cap stops one file bloating every buyer's shard.
        entry(safeRel(path)).desc = String(desc ?? "").slice(0, 2000);
        await persist();
        return { ok: true };
    },

    setListing: async (path, forSale) => {
        const e = entry(safeRel(path));
        // Something already sold cannot become a free catalog entry: people paid
        // for it, and dropping its pointer would take away access they bought.
        if (!forSale && e.published) throw new Error(`${path} is already published for sale — use takedown to withdraw it, not the listing flag`);
        e.forSale = forSale !== false;
        await persist();
        return { ok: true };
    },

    // Move/rename. Migrates the manifest key so the file keeps its uid, and thus
    // its paid resourceId, across the move.
    rename: async (from, to) => {
        const a = safeRel(from), b = safeRel(to);
        if (!a || !b) throw new Error("from/to required");
        if (b === a || b.startsWith(`${a}/`)) throw new Error("cannot move a folder into itself");
        if (lib.manifest.files[b]) throw new Error(`already exists: ${b}`);
        for (const key of Object.keys(lib.manifest.files)) {
            if (key !== a && !key.startsWith(`${a}/`)) continue;
            const moved = b + key.slice(a.length);
            lib.manifest.files[moved] = lib.manifest.files[key];
            delete lib.manifest.files[key];
            if (staged.has(key)) { staged.set(moved, staged.get(key)); staged.delete(key); }
        }
        lib.manifest.folders = (lib.manifest.folders ?? []).map((d) => (d === a || d.startsWith(`${a}/`) ? b + d.slice(a.length) : d));
        await persist();
        return { ok: true, path: b };
    },

    // Remove from the library AND from R2. Worker first: the manifest is the only
    // record of which objects exist, so dropping it first would leak them
    // permanently with no way to find them again. A refused delete therefore
    // leaves the file in the library — recoverable and retryable.
    //
    // NOT a takedown. Takedown is `setDisabled(resourceId, true)`, signed by the
    // publisher's wallet from the inspector — removing a file from your library is
    // not the same decision as pulling it out from under everyone who bought it.
    remove: async (path) => {
        const rel = safeRel(path);
        if (!rel) throw new Error("path required");
        const doomed = Object.keys(lib.manifest.files).filter((k) => k === rel || k.startsWith(`${rel}/`));
        for (const key of doomed) {
            const p = lib.manifest.files[key]?.published;
            if (!p?.resourceId) continue; // never published — nothing is in R2
            await deleteResource({
                // The worker it was PUBLISHED to, not the one they are on now.
                workerUrl: p.workerUrl ?? lib.workerUrl,
                uploadToken: lib.uploadToken,
                resourceId: p.resourceId, chunks: p.chunks ?? 1,
            }).catch((e) => { throw new Error(`Could not delete the stored copy of ${key}, so it is still in your library: ${e.message}`); });
        }
        for (const key of doomed) { delete lib.manifest.files[key]; staged.delete(key); }
        lib.manifest.folders = (lib.manifest.folders ?? []).filter((d) => d !== rel && !d.startsWith(`${rel}/`));
        await persist();
        return { ok: true };
    },
    // Picking a file no longer moves a byte anywhere. It records the manifest
    // entry and keeps the handle for this tab; the ciphertext goes up during
    // publish, browser → the publisher's own worker, never through the relay.
    //
    // Instant by construction, which is why there is no progress callback left to
    // drive — the bytes are reported during publish instead.
    upload: async (dir, name, file, onProgress) => {
        const rel = safeRel(dir ? `${dir}/${name}` : name);
        if (!rel || name.startsWith(".") || /\.vtt$/i.test(name)) throw new Error("bad file name");
        const e = entry(rel);
        e.mime = file.type || e.mime;
        delete e.published; // new bytes → the old pointer is stale
        staged.set(rel, file);
        await persist();
        onProgress?.(1);
        return { ok: true, path: rel };
    },

    /**
     * Stage an ANNOTATION: someone else's free film, described by scene, entered
     * into this publisher's own library as a catalog entry.
     *
     * `forSale: false` is what makes it cost nothing to publish — no ciphertext to
     * upload, no createResource, just a vertex in the commit that ships with
     * everything else. So contributing what an agent saw in a film is one
     * signature, not a purchase.
     *
     * The path is the source film's, so the annotation nests under the same tree
     * shape the ingest published it at, in this publisher's namespace rather than
     * the ingest's. ponytail: two publishers annotating the same film produce two
     * entries and the shard carries both — dedup when the corpus is big enough for
     * that to be noise.
     */
    saveAnnotation: async ({ path, mime, url, desc, cues }) => {
        const rel = safeRel(path);
        if (!rel) throw new Error(`bad path: ${path}`);
        if (!cues?.length) throw new Error("nothing to save — no scenes described yet");
        const e = entry(rel);
        e.forSale = false;
        e.mime = mime ?? e.mime;
        e.url = url ?? e.url;
        if (desc) e.desc = desc;
        e.cues = cues;
        await persist();
        return { path: rel, scenes: cues.length };
    },

    // Streams NDJSON progress lines while the server encrypts+uploads, then the result.
    // Encrypt and upload everything pending, then ask the relay to turn the
    // finished library into a signable commit.
    //
    // The order matters: bytes must be in R2 before the relay mints a
    // createResource pointing at them, or a buyer could pay for a pointer to
    // nothing. Nothing is written to the manifest until the upload for that file
    // has actually returned.
    preparePublish: async (onProgress) => {
        // The only way to have no worker now is a relay that was started without
        // one, which is an operator problem and not something the publisher can
        // fix from here.
        if (!lib?.workerUrl) throw new Error("This relay has no storage configured — its operator needs to set WORKER_URL.");

        const pending = nodes().filter((n) => n.type === "video" && n.forSale !== false && staged.has(n.path));
        const bytesTotal = pending.reduce((t, n) => t + (staged.get(n.path)?.size ?? 0), 0);
        let bytesBefore = 0;

        for (const n of pending) {
            const file = staged.get(n.path);
            const resourceId = n.published?.resourceId ?? resourceIdFor(lib.owner, n.uid);
            const out = await encryptAndUpload({
                file, resourceId, workerUrl: lib.workerUrl, uploadToken: lib.uploadToken,
                onProgress: (done, total) => onProgress?.({
                    phase: "Encrypting & uploading", name: n.name,
                    bytesDone: bytesBefore + (file.size * done) / total, bytesTotal,
                }),
            });
            bytesBefore += file.size;
            lib.manifest.files[n.path].published = {
                ...out, resourceId: n.published?.resourceId, workerUrl: lib.workerUrl, mime: n.mime,
            };
            // Persist per file, not once at the end: an upload that dies on file 7
            // of 10 must not lose the six pointers already paid for in bandwidth.
            await persist();
        }

        onProgress?.({ phase: "Staging library graph", staging: true });
        return post("/api/publish/prepare", { library: libraryForCommit() });
    },

    // Seals the commit with the vectors the browser produced from prepare's texts.
    commitPublish: (vectors, storageAuth) => post("/api/publish/commit", { vectors, storageAuth }),
    // The commit is on-chain: record the resourceIds the relay minted, then let it
    // rebake the public search shard.
    settlePublish: async (published = {}) => {
        for (const [path, ptr] of Object.entries(published)) {
            const e = lib.manifest.files[safeRel(path)];
            if (e) { e.published = { ...(e.published ?? {}), ...ptr }; staged.delete(safeRel(path)); }
        }
        await persist();
        return post("/api/settle", {});
    },
    rebakeShard: () => post("/api/shard", {}),

    // ── public: the viewer reads what's already public on-chain, no session ────
    getRemote: (owner) => fetch(`/api/remote?owner=${owner}`).then(j),
    getCatalog: () => fetch("/api/catalog").then(j), // every publisher, from the chain's registration log
};
