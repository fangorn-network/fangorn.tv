// Tenant isolation, end to end over real HTTP. `node --env-file=.env server/tenancy.test.js`
//
// auth.js's self-check proves the signature math; this proves what is left of the
// trust boundary now that the relay stages nothing.
//
// The old version of this file guarded a shared disk: two wallets, one media/
// directory, and the bug was one publisher seeing another's staged uploads. That
// disk is gone — publishers encrypt in the browser and upload to a Cloudflare
// worker, and their manifest lives in the bucket behind it. So the isolation
// questions changed shape:
//
//   - an anonymous caller still reaches nothing
//   - a session cannot mint a resourceId under someone else's address
//   - a browser-supplied library cannot smuggle a path out of its namespace
//   - the derived upload token is per wallet and stable across restarts
//   - READ_ONLY, registration and the terms gate still seal the write half
//
// The upload token carries the most weight of any of these now. One worker and
// one bucket serve every publisher, so that token is the ONLY thing telling the
// worker which publisher is writing — see uploadTokenFor in index.js and
// `uploadOwner` in webworker/fangorn-access-worker.
//
// The last one matters more than it used to: the library now ARRIVES in the
// request, so normalizeLibrary is the boundary that used to be the filesystem.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const PORT = 18790 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

/** The one access worker every publisher on a relay uploads to. */
const SHARED_WORKER = "https://shared.example";

const alice = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"b0".repeat(32)}`);

const fail = (msg) => { throw new Error(msg); };
const jsonOf = async (res) => { try { return await res.json(); } catch { return {}; } };

/** Full sign-in handshake for `account`; returns its bearer token. */
async function signIn(account) {
    const nonceRes = await fetch(`${BASE}/api/session/nonce`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address }),
    });
    if (!nonceRes.ok) fail(`/api/session/nonce: ${nonceRes.status} ${JSON.stringify(await jsonOf(nonceRes))}`);
    const { nonce, message } = await nonceRes.json();

    const sessionRes = await fetch(`${BASE}/api/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, signature: await account.signMessage({ message }) }),
    });
    if (!sessionRes.ok) fail(`/api/session: ${sessionRes.status} ${JSON.stringify(await jsonOf(sessionRes))}`);
    return (await sessionRes.json()).token;
}

const asUser = (token) => ({
    token,
    worker: () => fetch(`${BASE}/api/worker`, { headers: { Authorization: `Bearer ${token}` } }).then(jsonOf),
    post: (path, body) => fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }),
});

/** A minimal library node of the shape the browser now POSTs to /publish/prepare. */
const node = (path, extra = {}) => ({ path, type: "video", uid: `uid-${path}`, price: "1000", mime: "video/mp4", ...extra });

/** A `published` pointer, as the browser reports it after uploading ciphertext to
 *  the publisher's own worker. */
const pointer = (extra = {}) => ({ plaintextHash: `0x${"11".repeat(32)}`, workerUrl: "https://w.example", chunks: 1, size: 10, ...extra });

const mediaRoot = mkdtempSync(join(tmpdir(), "flix-tenancy-"));
const child = spawn(process.execPath, [join(import.meta.dirname, "index.js")], {
    // Alice and Bob are throwaway keys and will never be registered publishers.
    // The registration gate is exercised on its own server below; this one is
    // about tenant isolation, which the gate does not affect.
    // A fixed service key: the upload tokens this file asserts on are derived
    // from it, and boot now refuses a publisher relay without one. WORKER_URL is
    // required for the same reason — a relay that can publish must know where the
    // bytes go — and is never actually fetched by anything under test here.
    env: { ...process.env, PORT: String(PORT), REQUIRE_PUBLISHER_REGISTRATION: "0", ETH_PRIVATE_KEY: `0x${"11".repeat(32)}`, WORKER_URL: SHARED_WORKER },
    cwd: mediaRoot, // server resolves media/ from cwd
    stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
    // 30s, not 10: boot does a chain read for the app namespace, and a cold RPC
    // regularly takes longer than 10s — which showed up as "server never came up".
    for (let i = 0; i < 300; i++) {
        if (child.exitCode !== null) fail(`server exited early (${child.exitCode}):\n${serverLog}`);
        try { if ((await fetch(`${BASE}/api/session`)).status === 401) return; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    fail(`server never came up:\n${serverLog}`);
}

try {
    await waitForServer();

    // ── 1. anonymous callers get nothing ──────────────────────────────────────
    for (const [method, path] of [["POST", "/api/settle"], ["POST", "/api/sales"],
        ["GET", "/api/worker"],
        ["POST", "/api/publish/prepare"], ["POST", "/api/publish/commit"]]) {
        const res = await fetch(`${BASE}${path}`, {
            method, headers: { "Content-Type": "application/json" },
            ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (res.status !== 401) fail(`${method} ${path} without a session: got ${res.status}, want 401`);
    }
    // /api/upload is gone on purpose. It used to be the one endpoint that could
    // fill the relay's disk; there is no disk now, and a 404 is the proof.
    const goneUpload = await fetch(`${BASE}/api/upload?dir=&name=evil.mp4`, { method: "POST", body: "x" });
    if (goneUpload.status !== 404) fail(`/api/upload should no longer exist: got ${goneUpload.status}, want 404`);
    if (existsSync(join(mediaRoot, "media"))) fail("the relay created a media/ directory — it must stage nothing");

    // A bogus token is no better than none.
    if ((await asUser("not-a-real-token").worker()).error === undefined) fail("forged bearer token was accepted");

    // ── 2. sign in as two publishers ──────────────────────────────────────────
    const A = asUser(await signIn(alice));
    const B = asUser(await signIn(bob));

    // The terms gate fires before anything else in prepare, which is the right
    // order and is proved on its own server further down. Get past it here so the
    // sections below are testing what they say they are.
    // The Origin header differs between these two calls exactly as a browser
    // sends them — omitted on the same-origin GET, present on the POST. The
    // message must not depend on it, or the signature is over one document and
    // verified against another.
    for (const [who, acct] of [[A, alice], [B, bob]]) {
        const t = await fetch(`${BASE}/api/terms`, { headers: { Authorization: `Bearer ${who.token}` } }).then(jsonOf);
        const res = await fetch(`${BASE}/api/terms/accept`, {
            method: "POST",
            headers: { "content-type": "application/json", Authorization: `Bearer ${who.token}`, Origin: "https://app.example.com" },
            body: JSON.stringify({ signature: await acct.signMessage({ message: t.message }) }),
        });
        if (!res.ok) fail(`could not accept terms: ${JSON.stringify(await jsonOf(res))}`);
    }

    // ── 3. the library is a REQUEST field now, so validate it like one ────────
    // preparePublish used to read the relay's disk. It reads the request instead,
    // which is safe only because every path is re-checked here and every
    // resourceId folds in the session's own address. These are the assertions
    // that replaced the filesystem.
    // safeRel CONTAINS rather than rejects: a leading `../` is stripped, an
    // interior `..` throws. That contract predates this change and is what the
    // rest of the server relies on, so what matters here is that nothing escapes
    // into the committed tree — a path that reached the graph as `../x` would put
    // a vertex outside the publisher's own namespace.
    for (const bad of ["../escape.mp4", "/etc/passwd", "a/../../b.mp4", "....//x.mp4"]) {
        const res = await A.post("/api/publish/prepare", { library: [node(bad, { published: pointer() })] });
        if (!res.ok) continue; // rejected outright is also fine
        const got = Object.keys((await jsonOf(res)).published ?? {});
        for (const g of got) {
            if (g.startsWith("/") || g.split("/").includes("..")) fail(`library path ${JSON.stringify(bad)} escaped as ${JSON.stringify(g)}`);
        }
    }
    // An empty or missing path has nowhere to go in the tree at all.
    for (const bad of ["", null, undefined, "."]) {
        const res = await A.post("/api/publish/prepare", { library: [node(bad)] });
        if (res.status !== 400) fail(`library path ${JSON.stringify(bad)}: got ${res.status}, want 400`);
    }
    if ((await A.post("/api/publish/prepare", { library: "not-an-array" })).status !== 400) fail("a non-array library was accepted");
    // A uid is what keeps a paid file's identity stable. Minting one here would
    // silently orphan every existing buyer, so a missing uid must be refused.
    const noUid = await A.post("/api/publish/prepare", { library: [{ path: "a.mp4", type: "video" }] });
    if (noUid.status !== 400) fail(`library node with no uid: got ${noUid.status}, want 400`);
    // Duplicate paths would put two vertices at one place in the committed tree.
    const dupe = await A.post("/api/publish/prepare", { library: [node("a.mp4"), node("a.mp4")] });
    if (dupe.status !== 400) fail(`duplicate library path: got ${dupe.status}, want 400`);

    // ── 4. a resourceId is bound to the session, not to the request ───────────
    // The library is caller-supplied, so the only thing stopping Bob from minting
    // over Alice's resource is that resourceIdFor folds in the SESSION address.
    // Same uid, two publishers, two different resources.
    const prepOf = async (who) => {
        const res = await who.post("/api/publish/prepare", { library: [node("same.mp4", { uid: "collide", published: pointer() })] });
        return jsonOf(res);
    };
    const [aPrep, bPrep] = [await prepOf(A), await prepOf(B)];
    const aRid = aPrep.published?.["same.mp4"]?.resourceId;
    const bRid = bPrep.published?.["same.mp4"]?.resourceId;
    if (!aRid || !bRid) fail(`prepare returned no resourceId: ${JSON.stringify({ aPrep, bPrep })}`);
    if (aRid === bRid) fail("two publishers with the same uid got the SAME resourceId — one could overwrite the other's resource");

    // ── 5. a caller cannot pin someone else's resourceId onto their own file ──
    // Quoting Alice's resourceId in Bob's library must not make it Bob's: the
    // pointer is echoed back, but the createResource it would sign is derived
    // from Bob's address, so Alice's resource is never touched.
    const stolen = await jsonOf(await B.post("/api/publish/prepare", {
        library: [node("theirs.mp4", { uid: "collide", published: pointer({ resourceId: aRid }) })],
    }));
    const create = (stolen.creates ?? []).find((c) => c.path === "theirs.mp4");
    if (create && !create.data.toLowerCase().includes(bRid.slice(2, 10).toLowerCase()) && create.data === aRid) {
        fail("a createResource was built against another publisher's resourceId");
    }

    // ── 6. the upload token is per wallet, derived, stable, and names its bearer ─
    // On a shared bucket this token IS the tenant boundary: the worker reads the
    // owner address out of it and refuses any object belonging to someone else. It
    // must not depend on state this relay keeps, or a restart stops the worker
    // recognising every publisher at once.
    const aWorker = await A.worker();
    const bWorker = await B.worker();
    const aTok = aWorker.uploadToken;
    const bTok = bWorker.uploadToken;
    if (!aTok || !bTok) fail("GET /api/worker returned no upload token");
    if (aTok === bTok) fail("two publishers derived the SAME upload token — either could overwrite the other's objects");
    if ((await asUser(await signIn(alice)).worker()).uploadToken !== aTok) fail("the derived token changed across sessions");

    // Every publisher is pointed at the SAME worker — that is the whole change —
    // and it is the configured one, not something a request can name.
    if (aWorker.workerUrl !== SHARED_WORKER || bWorker.workerUrl !== SHARED_WORKER) {
        fail(`/api/worker must hand out the configured worker: ${aWorker.workerUrl} / ${bWorker.workerUrl}`);
    }

    // The address half is what the worker attributes objects to, so it has to be
    // this session's wallet, lowercased. A checksummed address there would
    // attribute the same publisher's files to two different owners.
    for (const [account, tok] of [[alice, aTok], [bob, bTok]]) {
        const [owner, mac] = tok.split(".");
        if (owner !== account.address.toLowerCase()) fail(`upload token names ${owner}, want ${account.address.toLowerCase()}`);
        if (!/^0x[0-9a-f]{64}$/.test(mac ?? "")) fail(`upload token carries no MAC: ${tok}`);
    }
    // And the MAC must be bound to the address, not merely appended to it —
    // otherwise anyone could relabel their own token with someone else's address.
    if (aTok.split(".")[1] === bTok.split(".")[1]) fail("two publishers share one MAC — either could write as the other");

    // ── 6d. there is nothing left to connect ─────────────────────────────────
    // POST /api/worker and /api/worker/provision are gone with bring-your-own
    // storage. They were the endpoints that verified a pasted worker, claimed its
    // bucket and spent a publisher's Cloudflare token, and a relay that still
    // answered them would be accepting a workerUrl from the request — which is
    // exactly the thing the shared worker replaced.
    for (const path of ["/api/worker", "/api/worker/provision"]) {
        const res = await A.post(path, { workerUrl: "https://evil.example", apiToken: "x" });
        if (res.status !== 404) fail(`${path} should no longer exist: got ${res.status}, want 404`);
    }

    // ── 7. public viewer routes still work with no session ────────────────────
    const remote = await fetch(`${BASE}/api/remote?owner=${alice.address.toLowerCase()}`);
    if (!remote.ok) fail(`/api/remote should stay public: ${remote.status}`);

    // ── 8. sign-out revokes ───────────────────────────────────────────────────
    await A.post("/api/session/end", {});
    if ((await A.worker()).error === undefined) fail("signed-out token still reaches a session route");

    // ── 9. READ_ONLY=1 is a real boundary, not a UI hint ──────────────────────
    // A second server, same code, one env var. The point is that NOTHING can
    // reach disk — including /api/upload and /api/publish/prepare, which are
    // handled inline before the routes table and would slip past a guard placed
    // at dispatch.
    const roRoot = mkdtempSync(join(tmpdir(), "flix-readonly-"));
    const roPort = PORT + 1;
    const roBase = `http://127.0.0.1:${roPort}`;
    const ro = spawn(process.execPath, [join(import.meta.dirname, "index.js")], {
        env: { ...process.env, PORT: String(roPort), READ_ONLY: "1" },
        cwd: roRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    try {
        let roLog = "";
        ro.stdout.on("data", (d) => (roLog += d));
        ro.stderr.on("data", (d) => (roLog += d));
        for (let i = 0; i < 100; i++) {
            if (ro.exitCode !== null) fail(`read-only server exited early (${ro.exitCode}):\n${roLog}`);
            try { if ((await fetch(`${roBase}/api/config`)).ok) break; } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 100));
        }

        // Sign-in itself is refused, so no token can even be minted.
        const nonce = await fetch(`${roBase}/api/session/nonce`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: alice.address }),
        });
        if (nonce.status !== 403) fail(`read-only /api/session/nonce: got ${nonce.status}, want 403`);

        // Every write route, including the two inline disk-writing handlers.
        for (const [method, path] of [["GET", "/api/tree"], ["POST", "/api/folder"], ["POST", "/api/delete"],
            ["POST", "/api/rename"], ["POST", "/api/price"], ["POST", "/api/desc"], ["POST", "/api/listing"], ["POST", "/api/settle"], ["GET", "/api/sales"],
            ["GET", "/api/worker"],
            ["POST", "/api/publish/commit"],
            ["POST", "/api/shard"], ["POST", "/api/publish/prepare"]]) {
            const res = await fetch(`${roBase}${path}`, {
                method, headers: { "Content-Type": "application/json" },
                ...(method === "POST" ? { body: "{}" } : {}),
            });
            if (res.status !== 403) fail(`read-only ${method} ${path}: got ${res.status}, want 403`);
        }
        const roUpload = await fetch(`${roBase}/api/upload?dir=&name=evil.mp4`, { method: "POST", body: "x" });
        if (roUpload.status !== 403) fail(`read-only upload: got ${roUpload.status}, want 403`);
        if (existsSync(join(roRoot, "media"))) fail("read-only relay created a staging directory");

        // …and the buyer half is untouched, or the flag would be useless.
        const cfg = await fetch(`${roBase}/api/config`);
        if (!cfg.ok) fail(`read-only /api/config: ${cfg.status}`);
        if ((await cfg.json()).readOnly !== true) fail("/api/config must advertise readOnly so the SPA can hide publishing");
        const roRemote = await fetch(`${roBase}/api/remote?owner=${alice.address.toLowerCase()}`);
        if (!roRemote.ok) fail(`read-only /api/remote should still serve buyers: ${roRemote.status}`);
    } finally {
        ro.kill();
        rmSync(roRoot, { recursive: true, force: true });
    }

    // ── 10. storage is for registered Fangorn publishers ─────────────────────
    // The modal that explains this rule is a courtesy; /api/worker is a public
    // endpoint behind a session ANY wallet can open, so the gate has to hold at
    // the relay. Default-on: this server sets no flag at all.
    const regRoot = mkdtempSync(join(tmpdir(), "flix-reg-"));
    const regPort = PORT + 2;
    const regBase = `http://127.0.0.1:${regPort}`;
    const gated = spawn(process.execPath, [join(import.meta.dirname, "index.js")], {
        env: { ...process.env, PORT: String(regPort), ETH_PRIVATE_KEY: `0x${"22".repeat(32)}`, WORKER_URL: SHARED_WORKER },
        cwd: regRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    try {
        let gLog = "";
        gated.stdout.on("data", (d) => (gLog += d));
        gated.stderr.on("data", (d) => (gLog += d));
        for (let i = 0; i < 100; i++) {
            if (gated.exitCode !== null) fail(`gated server exited early (${gated.exitCode}):\n${gLog}`);
            try { if ((await fetch(`${regBase}/api/config`)).ok) break; } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 100));
        }

        // Alice signs in fine — she is a valid session, just not a publisher.
        const nonceRes = await fetch(`${regBase}/api/session/nonce`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: alice.address }),
        });
        const { nonce, message } = await nonceRes.json();
        const token = (await (await fetch(`${regBase}/api/session`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nonce, signature: await alice.signMessage({ message }) }),
        })).json()).token;

        // An unregistered wallet DOES get storage: the free tier is per address, not
        // per publisher, and the cap that keeps it from costing the operator is the
        // worker's FREE_BYTES. Registration is enforced at publish, below, which is
        // the step that needs the chain.
        const ungated = await (await fetch(`${regBase}/api/worker`, {
            headers: { Authorization: `Bearer ${token}` },
        })).json();
        if (!ungated.uploadToken) fail("an unregistered wallet was denied its free storage");
        if (!ungated.workerUrl) fail("an unregistered wallet was not told where the bucket is");

        // Publishing is where the refusal has to be legible, and it has to name
        // where to go or the gate is a dead end.
        const unreg = await fetch(`${regBase}/api/publish/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: "{}",
        });
        if (unreg.status !== 403) fail(`unregistered publish: got ${unreg.status}, want 403`);

        // ── the terms gate ────────────────────────────────────────────────────
        const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
        const terms = await (await fetch(`${regBase}/api/terms`, { headers: auth })).json();
        if (!/^[0-9a-f]{64}$/.test(terms.hash ?? "")) fail(`/api/terms gave no sha256: ${JSON.stringify(terms)}`);
        if (terms.accepted) fail("a fresh publisher must not already have accepted");
        if (!terms.message?.includes(terms.hash)) fail("the message to sign must pin the terms digest");

        // Publishing is refused before it is accepted…
        const before = await fetch(`${regBase}/api/publish/prepare`, { method: "POST", headers: auth, body: "{}" });
        if (before.status !== 403) fail(`publish without accepted terms: got ${before.status}, want 403`);
        if (!/Terms/i.test((await jsonOf(before)).error ?? "")) fail("the refusal must say it is about the terms");

        // …and someone else's signature over the same text must not accept FOR her.
        const forged = await fetch(`${regBase}/api/terms/accept`, {
            method: "POST", headers: auth, body: JSON.stringify({ signature: await bob.signMessage({ message: terms.message }) }),
        });
        if (forged.ok) fail("Bob's signature accepted the terms on Alice's behalf");

        const accepted = await fetch(`${regBase}/api/terms/accept`, {
            method: "POST", headers: auth, body: JSON.stringify({ signature: await alice.signMessage({ message: terms.message }) }),
        });
        if (!accepted.ok) fail(`accepting the terms failed: ${JSON.stringify(await jsonOf(accepted))}`);
        if (!(await (await fetch(`${regBase}/api/terms`, { headers: auth })).json()).accepted) fail("acceptance did not stick");

        // The gate is now open: publishing fails for the NEXT reason (she still
        // isn't a registered publisher), not for the terms. Same status, so the
        // message is what proves the gate moved rather than stayed shut.
        const after = await fetch(`${regBase}/api/publish/prepare`, { method: "POST", headers: auth, body: "{}" });
        if (/Terms/i.test((await jsonOf(after)).error ?? "")) fail("terms still blocking after acceptance");
    } finally {
        gated.kill();
        rmSync(regRoot, { recursive: true, force: true });
    }

    console.log("tenancy.test.js ok — anon denied, /api/upload gone and no media/ created, library paths validated (traversal, dupes, missing uid), resourceId bound to the session not the request, upload tokens per-wallet + derived + owner-bound, connect/provision routes gone, sign-out revokes, READ_ONLY seals writes, storage free for any wallet while publish stays gated on Fangorn registration, terms gate blocks publish until signed");
} finally {
    child.kill();
    rmSync(mediaRoot, { recursive: true, force: true });
}
