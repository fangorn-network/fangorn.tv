#!/usr/bin/env node
// Headless publisher. Everything src/ui/App.jsx's `publish()` does, with a local
// key where the browser has MetaMask — because that flow costs one file-picker
// click and one wallet confirmation PER FILE, which makes seeding a library of
// any size impossible and makes publishing from a chat message impossible for
// the same reason.
//
// It is a CLIENT, not a second implementation. Every step is an existing HTTP
// route (/api/upload, /api/publish/prepare, /api/publish/commit, /api/settle)
// and the vectors come from src/llm/embed.js — the same model, prefixes and
// matryoshka the browser uses. A second embedder would produce vectors that
// rank against the published corpus about as well as noise, and silently.
//
//   PUBLISHER_PRIVATE_KEY=0x… node scripts/publish.mjs <relay> <path…> [flags]
//
//   --dir=sub/folder   stage under this folder instead of the library root
//   --price=1000       USDC base units per file (default: the relay's)
//   --desc="…"         description for every file in this run
//   --catalog-only     publish as FREE catalog entries: committed to the graph,
//                      searchable, but never encrypted, uploaded or minted as a
//                      resource. One commitStateRoot covers a graph of any size,
//                      so this is what makes bulk ingest cost one transaction
//                      instead of one per file.
//   --no-embed         skip the local model and commit without vectors. Quickbeam
//                      tails the namespace and bakes the shard everyone actually
//                      searches, so vectors can be filled in after the fact —
//                      server/shard.js was written for exactly that. Use this for
//                      corpora too big to embed here.
//   --register         send the one-time, fee-paying register() tx if needed
//   --setup            onboard only — terms and registration. Storage needs no
//                      setup: it is the relay's worker and bucket, handed out to
//                      any registered publisher. Publishes nothing, and without
//                      --register sends nothing at all: it reports what is
//                      missing and what it would cost. Ends with one
//                      `SETUP <json>` line for a caller to parse.
//   --selfcheck        run the offline self-check and exit
//
// A description is the highest-signal thing a file carries — for an image it is
// the ONLY thing, since nothing in a JPEG's bytes says what it is. So per-file
// descriptions come from a `<file>.txt` sidecar when one exists (--desc is the
// fallback for the rest). No new manifest format: a caption written to a text
// file is something a shell loop or a Telegram handler can both produce.
//
// The key comes from the environment and never from argv — argv is visible in
// `ps` to every process on the box.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
// The same byte path the browser runs (src/pay/encrypt.js), on the Node side: the
// relay stages nothing for anyone, so this client encrypts and uploads to the
// publisher's own worker itself.
import { encryptAndUpload } from "../server/settle.js";
import { resourceIdFor } from "../src/pay/envelope.js";
import { readManifest, writeManifest } from "../src/pay/encrypt.js";

// ── argv ──────────────────────────────────────────────────────────────────────

const flags = {};
const args = [];
for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
    else args.push(a);
}

// ── file collection ───────────────────────────────────────────────────────────

/** Sidecars and dotfiles are not products. `.vtt` is rejected by /api/upload
 *  outright (it would collide with the subtitle sidecars walkTree hides), and
 *  `.txt` next to a file is that file's description, not a second file to sell. */
const skip = (name, isSidecar) => name.startsWith(".") || /\.vtt$/i.test(name) || isSidecar;

/**
 * Expand a path into { abs, rel } pairs. A directory keeps its inner structure
 * (base = the directory itself); a lone file lands at the root of --dir.
 * `descOf` decides sidecars, so a `notes.txt` with no media beside it still
 * publishes as a text file rather than vanishing.
 */
export function collect(p, descriptions = existsSync) {
    const st = statSync(p);
    const base = st.isDirectory() ? p : dirname(p);
    const out = [];
    const walk = (cur) => {
        for (const name of readdirSync(cur).sort()) {
            const abs = join(cur, name);
            if (statSync(abs).isDirectory()) { walk(abs); continue; }
            // A .txt is a sidecar only if the file it describes is here too.
            const isSidecar = name.endsWith(".txt") && descriptions(abs.slice(0, -4));
            if (skip(name, isSidecar)) continue;
            out.push({ abs, rel: relative(base, abs).split(sep).join("/") });
        }
    };
    if (st.isDirectory()) walk(p);
    else if (!skip(basename(p), false)) out.push({ abs: p, rel: basename(p) });
    return out;
}

/** `<file>.txt` beside the file, else --desc, else nothing. */
const descFor = (abs) => {
    const side = `${abs}.txt`;
    if (existsSync(side)) return readFileSync(side, "utf8").trim().slice(0, 2000);
    return typeof flags.desc === "string" ? flags.desc : null;
};

// ── relay client ──────────────────────────────────────────────────────────────

/**
 * Parse an NDJSON stream of {progress}/{result}/{error} lines. Lifted in shape
 * from api.js's preparePublish — prepare answers 200 and reports failure as a
 * line in the body, so a non-2xx check alone would treat an error as success.
 */

function client(relay) {
    let token = null;
    // Origin is sent explicitly and identically on every request: the relay
    // derives both the SIWE message's domain and the terms URL from it, so a
    // nonce issued under one origin and a terms acceptance under another would
    // sign two different documents.
    const headers = (extra = {}) => ({ Origin: relay, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
    const j = async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        return body;
    };
    return {
        setToken: (t) => { token = t; },
        get: (path) => fetch(`${relay}${path}`, { headers: headers() }).then(j),
        post: (path, body) => fetch(`${relay}${path}`, {
            method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body),
        }).then(j),
        prepare: (library) => fetch(`${relay}/api/publish/prepare`, {
            method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ library }),
        }).then(j),
    };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const [relayArg, ...paths] = args;
    if (!relayArg) {
        console.error("usage: PUBLISHER_PRIVATE_KEY=0x… node scripts/publish.mjs <relay> <path…> [--dir=] [--price=] [--desc=] [--register] [--setup]");
        process.exit(2);
    }
    const relay = relayArg.replace(/\/$/, "");

    const key = process.env.PUBLISHER_PRIVATE_KEY;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PUBLISHER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (env only — never argv)");
    const account = privateKeyToAccount(key);
    const api = client(relay);

    const cfg = await api.get("/api/config");
    if (cfg.readOnly) throw new Error("this relay is read-only — publishing runs on the publisher's own machine");
    const chain = defineChain({
        id: cfg.chainId,
        name: `chain-${cfg.chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [cfg.rpc] } },
    });
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });
    const node = createPublicClient({ chain, transport: http(cfg.rpc) });
    const send = async (tx) => {
        const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, ...(tx.value ? { value: BigInt(tx.value) } : {}) });
        const rc = await node.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`tx reverted: ${hash}`);
        return hash;
    };

    // ── sign in ───────────────────────────────────────────────────────────────
    // This signature is also the rights attestation the relay appends to its log
    // before minting a session. Automating it does not make it mean less: the
    // key holder is asserting they are licensed to distribute what follows.
    const { nonce, message } = await api.post("/api/session/nonce", { address: account.address });
    const { token } = await api.post("/api/session", { nonce, signature: await account.signMessage({ message }) });
    api.setToken(token);
    console.log(`signed in as ${account.address}`);

    // ── terms + registration ──────────────────────────────────────────────────
    let reg = await api.get("/api/registration");
    if (!reg.acceptedTerms) {
        const t = await api.get("/api/terms");
        await api.post("/api/terms/accept", { signature: await account.signMessage({ message: t.message }) });
        console.log(`accepted publisher terms (${t.hash.slice(0, 12)}…) — ${t.url}`);
        reg = await api.get("/api/registration");
    }
    if (!reg.registered) {
        // Registration costs a fee in ETH and is irreversible, so it is never
        // sent implicitly. `reg.txs` is empty until the terms are on file, which
        // the block above has just handled.
        //
        // Two of them, in the order the relay gave: global standing in the data
        // registry, then membership of this app. Both are needed — commitStateRoot
        // cross-calls the app registry, so stopping after the first buys a revert
        // at the end of the publish instead of an error here.
        const total = BigInt(reg.fee ?? 0) + BigInt(reg.appFee ?? 0);
        if (!flags.register) {
            // `--setup` alone is a read: it reports what is missing and what it
            // would cost, and sends nothing. A UI asking "am I registered?" must
            // not have to catch an exception to find out that the answer is no.
            if (!flags.setup) throw new Error(`${account.address} is not a registered publisher. Re-run with --register to send ${reg.txs.length} registration tx(s) (fee: ${total} wei), or register at https://fangorn.network`);
        } else {
            console.log(`registering as a publisher (${reg.txs.length} tx, fee ${total} wei)…`);
            for (const tx of reg.txs) await send(tx);
            // Re-read rather than assume: the caller is told what the chain says,
            // not what we hoped two transactions would do.
            reg = await api.get("/api/registration");
        }
    }

    // ── setup mode ────────────────────────────────────────────────────────────
    // `--setup` stops here and reports, instead of publishing. It exists because
    // onboarding a publisher — terms, two registration txs, and a bucket to put
    // bytes in — used to be reachable only by attempting a publish and reading
    // the error. A UI that wants to ASK "am I set up?" had nothing to call.
    //
    // Without --register it is a dry run: it says what is missing and what the
    // fees would be, and sends nothing. That is the read half, and it is free.
    //
    // There is no storage step any more: the relay names the worker and derives
    // this wallet's upload token, so `--setup` only ever reports what it found.
    // Provisioning a bucket into the publisher's own Cloudflare account
    // (CLOUDFLARE_API_TOKEN) went with bring-your-own-storage; it is in git.
    //
    // The last line is `SETUP <json>` so a caller parses one line instead of
    // scraping prose. Everything above it stays human-readable.
    if (flags.setup) {
        const state = { address: account.address, registered: !!reg.registered, acceptedTerms: true };
        const w = await api.get("/api/worker").catch(() => null);
        // Null until this wallet is a registered publisher — the relay withholds
        // both, which is the only way storage can be "not ready" now.
        state.workerUrl = w?.workerUrl ?? null;
        state.storage = !!w?.workerUrl;
        if (!reg.registered) {
            state.fee = (BigInt(reg.fee ?? 0) + BigInt(reg.appFee ?? 0)).toString();
            state.txs = reg.txs?.length ?? 0;
        }

        console.log(`SETUP ${JSON.stringify(state)}`);
        return;
    }

    // ── stage ─────────────────────────────────────────────────────────────────
    const under = typeof flags.dir === "string" ? flags.dir.replace(/^\/+|\/+$/g, "") : "";
    const files = paths.flatMap((p) => collect(resolve(p)));
    if (paths.length && !files.length) throw new Error("nothing to upload — every path was a dotfile, a .vtt or a description sidecar");

    // The manifest lives in the bucket, not on the relay, so this client reads
    // it, edits it, and writes it back — exactly what the browser does. Both the
    // worker and this wallet's upload token come from the relay, which stores
    // neither: the URL is its own config and the token is derived from the address.
    const { workerUrl, uploadToken } = await api.get("/api/worker");
    if (!workerUrl) throw new Error(`${account.address} has no storage — it is not a registered Fangorn publisher yet (run with --setup --register, or sign up at https://fangorn.network)`);
    const store = { workerUrl, uploadToken, owner: account.address };
    const manifest = await readManifest(store);

    for (const f of files) {
        const rel = under ? `${under}/${f.rel}` : f.rel;
        const entry = (manifest.files[rel] ??= { uid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` });
        if (flags["catalog-only"]) entry.forSale = false;
        else if (flags.price) entry.price = String(flags.price);
        const desc = descFor(f.abs);
        if (desc) entry.desc = desc;

        // A free catalog entry is committed to the graph but never encrypted,
        // uploaded or minted — which is what makes bulk ingest cost one commit
        // instead of one createResource per file.
        if (entry.forSale === false) {
            console.log(`↑ ${rel} … ok (free entry)${desc ? " (described)" : ""}`);
            continue;
        }
        process.stdout.write(`↑ ${rel} … `);
        const out = await encryptAndUpload({
            file: f.abs, workerUrl, uploadToken,
            resourceId: entry.published?.resourceId ?? resourceIdFor(account.address, entry.uid),
        });
        entry.published = { ...out, resourceId: entry.published?.resourceId, workerUrl, mime: entry.mime };
        // Written per file: a run that dies partway must not lose the pointers
        // already paid for in bandwidth.
        await writeManifest({ ...store, manifest });
        console.log(`ok${desc ? " (described)" : ""}`);
    }

    // ── publish ───────────────────────────────────────────────────────────────
    const library = Object.entries(manifest.files).map(([path, f]) => ({
        path, type: "video", uid: f.uid, price: f.price, mime: f.mime,
        desc: f.desc, forSale: f.forSale, cues: f.cues, published: f.published,
    }));
    const prep = await api.prepare(library);

    for (const [i, c] of prep.creates.entries()) {
        console.log(`createResource ${i + 1}/${prep.creates.length} — ${c.path}`);
        await send(c);
    }

    // Embedded here rather than on the relay for the same reason the browser
    // does it: the relay runs no model, and putting one there would mean every
    // publisher trusting one machine to build the index everyone searches.
    // A model failure must not sink a publish — the files still commit, they
    // just rank lexically until something embeds them.
    const vectors = {};
    if (flags["no-embed"]) {
        console.log(`skipping ${prep.embed?.length ?? 0} embeddings — quickbeam bakes them from the committed graph`);
    } else if (prep.embed?.length) {
        try {
            const { embedDocuments, packVec } = await import("../src/llm/embed.js");
            console.log(`embedding ${prep.embed.length} passages…`);
            const vecs = await embedDocuments(prep.embed.map((t) => t.text));
            prep.embed.forEach((t, n) => { vectors[t.id] = packVec(vecs[n]); });
        } catch (e) {
            console.error(`embedding failed — publishing without vectors: ${e.message}`);
        }
    }

    // The pin is authorized by the publisher's own signature against their own
    // storage quota. The challenge carries an Issued-At the gate only honours
    // for a few minutes, so it is fetched here and not at the start of the run.
    //
    // `storageGate: null` is not a broken relay — it is one pinning directly on
    // its own account (PINATA_JWT), which ignores storageAuth entirely. Asking a
    // gate that isn't there for a challenge failed a publish the relay would
    // have accepted, and blamed a service that was never in the path. The web
    // client has always posted storageAuth: undefined for this case; this is the
    // same contract, read from the same /api/config.
    let storageAuth;
    if (cfg.storageGate) {
        const gate = await fetch(cfg.storageGate, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: account.address, size: 1 }),
        }).then((r) => r.json()).catch(() => ({}));
        if (!gate.challenge) throw new Error(`storage gate issued no challenge — ${cfg.storageGate} may be down`);
        storageAuth = { message: gate.challenge, signature: await account.signMessage({ message: gate.challenge }) };
    } else {
        console.log("relay pins on its own account — no storage gate to authorize against");
    }

    const sealed = await api.post("/api/publish/commit", { vectors, storageAuth });
    console.log("commitStateRoot…");
    await send(sealed.commitTx);
    for (const [path, ptr] of Object.entries(sealed.published)) {
        manifest.files[path].published = { ...(manifest.files[path].published ?? {}), ...ptr };
    }
    await writeManifest({ ...store, manifest });
    await api.post("/api/settle", {});

    const { vertices, edges, embedded } = sealed.staged;
    console.log(`published — ${vertices} vertices, ${edges} edges, ${embedded} embedded`);
    for (const [path, ptr] of Object.entries(sealed.published)) console.log(`  ${path}  ${ptr.resourceId}`);
}

// ── self-check: `node scripts/publish.mjs --selfcheck` (offline) ──────────────

if (flags.selfcheck) {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };


    // Collection: sidecars are descriptions, not products; a .txt with no file
    // beside it still sells; nested paths keep their shape.
    // collect() reads the fs, so exercise its decision rule directly rather than
    // mocking node:fs — what's under test is which names survive `skip`.
    const here = new Set(["/lib/a.jpg", "/lib/notes.txt", "/lib/sub/b.mp3"]);
    const survives = (name, abs) => !skip(name, name.endsWith(".txt") && here.has(abs.slice(0, -4)));
    assert(survives("a.jpg", "/lib/a.jpg"), "a real file was skipped");
    assert(!survives("a.jpg.txt", "/lib/a.jpg.txt"), "a description sidecar was published as a file");
    assert(survives("notes.txt", "/lib/notes.txt"), "an orphan .txt should publish as a text file");
    assert(!survives(".hidden", "/lib/.hidden"), "a dotfile was published");
    assert(!survives("c.mp4.vtt", "/lib/c.mp4.vtt"), "a .vtt was published — /api/upload rejects these");

    console.log("publish.mjs self-check ok");
} else {
    await main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
