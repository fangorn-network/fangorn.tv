// SOND3R relay. Multi-publisher, no wallet key: it holds a SERVICE key only
// to construct the Fangorn engine (graph build/commit + IPFS pinning) and never
// signs a user's on-chain tx. The publisher's browser wallet signs the two kinds
// of tx a publish needs — createResource(price) per new video and one
// commitStateRoot for the whole library graph. Buyers only READ the published
// tree here; their pay+decrypt runs in the browser against facilitator/worker.
//
// Each publisher's working library is an open-ended folder/file tree under
// media/<0xaddress>/ — the filesystem IS the structure, and the address prefix
// IS the tenant boundary. Every staging path is resolved from the SESSION's
// address (see server/auth.js), never from a request parameter, so one
// publisher cannot read, rename or delete another's unreleased footage. A
// `.flix.json` manifest per publisher, keyed by relpath, holds the per-video
// price + published pointer (and a stable uid so a video keeps its paid
// resourceId across renames).
//
// Every /api route is authenticated by default; PUBLIC_ROUTES is the explicit
// opt-out list (sign-in, plus the read-only viewer/catalog endpoints, which
// serve data that is already public on-chain).
//
// Flow (mirrors fangorn-md's prepare → sign → settle split):
//   POST /api/publish/prepare  mint resourceIds for what the BROWSER uploaded, return
//     the createResource txs AND the text to embed.  (browser signs the creates)
//   POST /api/publish/commit   browser posts back the vectors it produced; the
//     graph is built WITH them and the commitStateRoot tx returned.
//   POST /api/settle           record the published pointers in the manifest.
//
// Prepare and commit are separate because the embedding model runs in the
// PUBLISHER's browser, not here — this process has no model, and the commit
// can't be sealed until the vectors come back. That's also what keeps search
// decentralized: every publisher embeds their own files, and any relay can bake
// them into one shard without running a model or asking anyone for anything.

// FIRST, and it has to stay first: it turns blank .env lines back into "unset"
// before any other module reads process.env at import time. See server/env.js.
import "./env.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { DATA_REGISTRY_ABI, Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { concat, createPublicClient, fallback, http, encodeFunctionData, encodePacked, keccak256, numberToHex, stringToBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { buildTreeGraph, inGraph, isCatalogEntry, nest, treeFromGraph } from "./graph.js";
// The envelope geometry a published pointer records. The relay never encrypts
// anything now — this is only the default it fills in when a browser omits it.
import { CHUNK_SIZE, resourceIdFor, uidHashFor } from "../src/pay/envelope.js";
import { aggregateRows, fileText, toPassages, writeShard } from "./shard.js";
import { normalizeCues } from "./subtitles.js";
import { enrichText } from "./enrich.js";
import { injectOg, ogPng } from "./og.js";
import { DelegatedStorage, SIGNED_URL_WORKER, storageAuthError } from "./storage-auth.js";
import { acceptTerms, addressForRequest, attestationLog, destroySession, hasAcceptedTerms, issueNonce, termsMessage, verifyAndCreateSession } from "./auth.js";
// Constants only. The transformers.js runtime behind them is a dynamic import
// inside the embedder, so this costs the server nothing.
import { EMBED_DIM, EMBED_MODEL } from "../src/llm/embed.js";

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const PUBLIC_DIR = join(ROOT, "public"); // vite serves this at / in dev; copied into dist/ on build
// The app namespace SOND3R owns on-chain (registerApp), and the subspace every
// publisher's library lives in under it. Keys are app:publisher:subspace, so one
// getLogs on the app id is the whole cross-publisher catalog — see appNamespaces.
//
// APP is env-overridable so a test app (registered separately, owned by a
// different wallet) gets a catalog of its own without a code change. It must
// already be registerApp'd on-chain or boot fails — see assertAppRegistered.
// Changing it does NOT change resourceIds: those are keccak256("sond3r:"+uid)
// regardless, so a video published under one app keeps its settlement id.
const APP = process.env.APP ?? "sond3r";
const NAMESPACE = "media";

// The quickbeam view the storefront's search streams shards from: the registry
// worker's `/q/<viewId>` base (the `/stream` or `/cdn` URL it prints is accepted
// too — src/catalog/search.js trims it). Handed to the browser by /api/config rather than
// baked into dist/ as a VITE_ value: a view id embeds its requester and name, so
// pointing a relay at a different view must not need an image rebuild. Unset,
// search and shard-backed browsing are off and the viewer falls back to
// /api/catalog — a chain scan plus an IPFS walk per publisher.
const QUICKBEAM_URL = (process.env.QUICKBEAM_URL ?? "").replace(/\/+$/, "");
// Which of the view's domains the browser should actually download. A view fuses
// every watched (owner, namespace), and an old test corpus left watched alongside
// the current one doubles the bytes, the parse and the clustering in every
// viewer's tab. Comma-separated; unset = pull them all, which is the old
// behaviour. Matched by full name, namespace half, or prefix — see setDomains().
//
//   QUICKBEAM_DOMAINS=archive.videos.test.2
//
// A runtime setting and not a VITE_ one, for the same reason QUICKBEAM_URL is:
// repointing a storefront must not need an image rebuild.
const QUICKBEAM_DOMAINS = (process.env.QUICKBEAM_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// The view that bakes the `apps` namespace: one row per registered app
// (`apps:<0xwallet>:<appName>`), each carrying that app's manifest and, crucially,
// the URL of its own view.
//
// NOT the app registry. The registry is AppRegistry on-chain, and it holds
// (appId -> owner, termsHash, termsUri, fee) with nowhere to put a view URL, a
// description, or an icon — so the manifest lives off-chain in a namespace and this
// is where it is served from. The contract is what makes (appId, owner)
// authoritative; the manifest is self-asserted until something checks it against
// the contract (see src/catalog/apps.js). Unset, the viewer just shows QUICKBEAM_URL's
// catalog, as before.
const APPS_VIEW_URL = (process.env.APPS_VIEW_URL ?? "").replace(/\/+$/, "");

/** Ciphertext format on the worker. 1 = raw bytes, 2 = pack()'d (flag||maybe-gzip).
 *  A published video stamped with anything older is re-encrypted and re-uploaded
 *  on the next publish — the bytes in R2 are unreadable to the current buyer. */
const ENC_VERSION = 2;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Reject path traversal / absolute paths; return a clean relative path under the
// publisher's own media/<address>/ root.
function safeRel(p) {
    const rel = normalize(String(p ?? "")).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    if (rel === "." || rel === "") return "";
    if (rel.split(/[/\\]/).includes("..")) throw new HttpError(400, "bad path");
    return rel.replaceAll("\\", "/");
}

// uidHashFor / resourceIdFor come from src/pay/envelope.js: the browser derives the
// same ids when it names the R2 key it uploads to, and a second copy here that
// drifted would put the ciphertext and the resource at different ids.

// Defined above the env guard so it can be checked without a configured .env:
//   node server/index.js --selfcheck
//
// safeRel is the function standing between one publisher's library and everyone
// else's — every staging path goes through it before it is joined to
// media/<owner>/. It's the only local logic here worth a check now that reads
// and caching live in the SDK.
if (process.argv.includes("--selfcheck")) {
    const { strict: assert } = await import("node:assert");
    assert.equal(safeRel("a/b.mp4"), "a/b.mp4");
    assert.equal(safeRel("./x"), "x");
    assert.equal(safeRel(undefined), "");
    assert.equal(safeRel("a/.."), "");
    assert.equal(safeRel("a\\b.mp4"), "a/b.mp4", "backslashes normalize to /");
    // Traversal either collapses to a contained path or is rejected outright —
    // never escapes. normalize() folds posix-style `..`; a backslash segment it
    // can't fold is caught by the `..` check.
    assert.equal(safeRel("../../etc/passwd"), "etc/passwd");
    assert.equal(safeRel("/etc/passwd"), "etc/passwd");
    assert.equal(safeRel("a/../../b"), "b");
    assert.throws(() => safeRel("a\\..\\b"), /bad path/, "windows-style traversal must be rejected");
    // The other half of a cross-repo contract: the access worker recomputes this
    // exact MAC (webworker/fangorn-access-worker, `macFor`) and its test suite
    // builds the token independently. If one side drifts, one of the two test
    // suites goes red instead of every upload silently 401ing.
    assert.equal(
        uploadTokenWith(`0x${"5e".repeat(32)}`, "0x1111111111111111111111111111111111111111"),
        "0x1111111111111111111111111111111111111111.0x7908a77e560b9353c8bfc501f7654a7c3ba31939f0b83d123edac190f797c7fd",
    );
    // The address half is what the worker reads the owner OUT of, so casing has
    // to be pinned: a checksummed address there would attribute one publisher's
    // objects to two different owners depending on how they signed in.
    assert.equal(
        uploadTokenWith(`0x${"5e".repeat(32)}`, "0x1111111111111111111111111111111111111111"),
        uploadTokenWith(`0x${"5e".repeat(32)}`, "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x")),
    );
    // The third cross-repo contract, and the quietest one to get wrong: this
    // vector came from the deployed registry's own view —
    //   cast call <registry> "resourceIdFor(address,bytes32)(bytes32)" \
    //     0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6 $(cast keccak "sond3r:demo-uid")
    // A mismatch means every publish writes ciphertext under an id that no
    // resource on-chain refers to, and every buyer's /access 404s.
    assert.equal(
        resourceIdFor("0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6", "demo-uid"),
        "0x4ff3fe3eca09f49421cae5f6c444e61f17db98d1af8d6d4a0aa670bead70ebe4",
    );
    console.log("index.js self-check ok — safeRel: traversal, absolute, backslash, empty; upload token format; resourceId matches the registry");
    process.exit(0);
}

const SETTLEMENT_REGISTRY_ADDR = process.env.SETTLEMENT_REGISTRY_ADDR;
const DEFAULT_PRICE = process.env.RESOURCE_PRICE ?? "1000";

// Storage is for registered Fangorn publishers. ON unless explicitly disabled —
// the gate is the product rule, and a relay that forgets to set a flag should
// enforce it, not skip it.
//
// `0` exists for tests and for bringing a relay up against a chain where nobody
// is registered yet. It does NOT weaken tenant isolation: sessions, per-wallet
// media roots and bucket claims are all unaffected. It only decides whether an
// unregistered wallet may connect storage at all.
const REQUIRE_REGISTRATION = !/^(0|false|no)$/i.test(process.env.REQUIRE_PUBLISHER_REGISTRATION ?? "1");

// READ_ONLY=1 turns this process into a pure storefront: the buyer/agent half,
// with no staging area at all. Set it on anything public.
//
// Without it, a hosted relay is an open upload endpoint — auth.js hands a session
// to ANY wallet that signs the nonce (there is no publisher allowlist), so a
// stranger can stage files on your disk.
//
// Sign-in is blocked too, not just writes. A session that can't reach a single
// write route only produces a confusing 401 three clicks later, and the SPA reads
// `readOnly` off /api/config to hide the Publisher tab instead.
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY ?? "");

// Never signs anything anyone else can see. prepareCommit hands the browser an
// UNSIGNED tx, pins go out under the PUBLISHER's signature (see publisherFangorn),
// and the DataRegistry reads need a walletClient only because the SDK wants one.
//
// But it is ALSO the seed for every publisher's upload token (see RELAY_SECRET),
// and that token is the only thing standing between a publisher and their own R2
// bucket. A throwaway is therefore fine on a read relay and NOT fine on one that
// publishes: a fresh key per boot re-derives every token, and each publisher's
// own worker then rejects them from a bucket they own, permanently — the worker
// cannot tell an owner from a stranger over HTTP.
//
// So: optional where nothing uploads, required where something does. Rotating it
// deliberately has the same effect and is recoverable the same way — reconnect,
// which re-claims with one wallet signature.
const SERVICE_KEY = process.env.ETH_PRIVATE_KEY ?? generatePrivateKey();

/**
 * The access worker every publisher on this relay uploads to.
 *
 * One worker, one R2 bucket, one Cloudflare bill — ours. Publishers used to bring
 * their own (a scoped API token, a bucket provisioned into their account), and
 * that will come back as an option; it is not the default any more because the
 * first thing it asked a publisher to do was understand what R2 is.
 *
 * It is NOT read for buying. Every workerUrl a buyer needs rides on the file's
 * own pointer (the shard row / the on-chain vertex), so files published to a
 * worker keep working after this value changes — which is also what lets
 * yesterday's publisher-owned workers keep serving what they already hold.
 * Required only where something uploads.
 */
const WORKER_URL = (process.env.WORKER_URL ?? "").replace(/\/+$/, "");

const REQUIRED_ENV = [
    ["SETTLEMENT_REGISTRY_ADDR", process.env.SETTLEMENT_REGISTRY_ADDR],
    // See SERVICE_KEY above: without a stable one, every restart re-derives every
    // publisher's upload token and the shared worker stops recognising them.
    // Failing at boot is the only honest place to catch it — the damage otherwise
    // shows up as a 401 from the worker, days later, with nothing pointing back here.
    ...(READ_ONLY ? [] : [["ETH_PRIVATE_KEY", process.env.ETH_PRIVATE_KEY], ["WORKER_URL", WORKER_URL]]),
];
for (const [key, val] of REQUIRED_ENV) {
    if (!val) { console.error(`Missing ${key} — copy .env.example to .env and fill it in.`); process.exit(1); }
}

const IPFS_GATEWAY = process.env.PINATA_GATEWAY ?? FangornConfig.ipfsGateway;

/**
 * Pin straight to Pinata with the operator's own JWT, skipping the storage gate.
 *
 * The gate (see server/storage-auth.js) is the right default: it meters bytes per
 * publisher wallet, so nobody's library lands on the operator's quota. But it is
 * a third-party service on the critical path of every publish, and when it is
 * down — or you are working against a chain/wallet it has never heard of — there
 * is no way to get a byte stored and no way to tell a gate outage apart from a
 * signing bug.
 *
 * Set PINATA_JWT and that whole leg is bypassed: pins go directly to Pinata, paid
 * for by whoever owns the JWT (you), and the browser is told there is no gate to
 * sign a challenge for. Leave it unset in any deploy where publishers are not
 * you — it is a debugging and single-tenant switch, not a hosting model.
 */
const PINATA_JWT = process.env.PINATA_JWT;
const STORAGE = PINATA_JWT
    ? { pinata: { jwt: PINATA_JWT, gateway: IPFS_GATEWAY } }
    : { signedUrl: { workerUrl: SIGNED_URL_WORKER, gateway: IPFS_GATEWAY } };
if (PINATA_JWT) console.log("storage: pinning directly to Pinata (PINATA_JWT set) — the storage gate is bypassed");

/**
 * FangornConfig with the operator's RPC substituted in.
 *
 * The SDK reads `config.rpcUrl` to build its own client, so the default put every
 * chain read on `sepolia-rollup.arbitrum.io` no matter what CHAIN_RPC_URL said —
 * and the public endpoint answers `-32000 internal server errror` to the SDK's
 * `fromBlock: 0n → latest` StateCommitted scan, which is how namespaces, the
 * catalog and every remote library are read. Under load that scan is the first
 * thing to fail, and it takes the whole storefront with it.
 *
 * CHAIN_RPC_URL is the server-side name; VITE_CHAIN_RPC_URL is the browser's and
 * is accepted as a fallback so a single-host deploy can set one value.
 *
 * DATA_REGISTRY_ADDR overrides the DataRegistry the SDK reads apps, namespaces
 * and commits from. The pinned SDK carries whichever deployment was current when
 * it was published, and the contract HAS been redeployed — the `fangorn` CLI
 * registers apps against a newer address than this copy reads. When they differ,
 * an app the CLI reports as "already registered to you" reads back as owner 0x0
 * here, and the catalog is empty because every publisher's commits are on the
 * other contract. Set this to whatever the CLI uses (`fangorn` lib/config.js) to
 * put both on the same registry.
 */
const CONFIG = {
    ...FangornConfig,
    rpcUrl: process.env.CHAIN_RPC_URL ?? process.env.VITE_CHAIN_RPC_URL ?? FangornConfig.rpcUrl,
    dataRegistryContractAddress: process.env.DATA_REGISTRY_ADDR ?? FangornConfig.dataRegistryContractAddress,
    // Overridable for the same reason as the data registry, and it must be moved
    // in step with it: commitStateRoot asks ITS data registry which app registry
    // to check, so a pair from two different deployments fails as
    // `NotRegisteredForApp` against a wallet that did register.
    appRegistryContractAddress: process.env.APP_REGISTRY_ADDR ?? FangornConfig.appRegistryContractAddress,
};

// Reads only: namespaces, the catalog, base commits. Storage is still configured
// because the engine demands a backend, but only its READ half is ever used —
// fetching a Fangorn block is a public gateway GET by CID with no gate at all.
// Every write goes through publisherFangorn, signed by the publisher.
const fangorn = Fangorn.create({
    privateKey: SERVICE_KEY,
    storage: STORAGE,
    domain: "localhost",
    config: CONFIG,
    appId: APP,
});

/**
 * A Fangorn that pins as `owner`, using the gate challenge their browser signed.
 *
 * Per call, never cached: the authorization belongs to one wallet and expires in
 * minutes, so two publishers committing at once must not share an instance.
 */
async function publisherFangorn(owner, auth) {
    // Direct mode pays for the pin itself, so there is no per-publisher quota to
    // attribute and no challenge to replay — demanding a signature the browser
    // was told not to collect would just fail every publish.
    if (PINATA_JWT) return Fangorn.create({ privateKey: SERVICE_KEY, domain: "localhost", config: CONFIG, appId: APP, storage: STORAGE });
    const bad = await storageAuthError(owner, auth);
    if (bad) throw new HttpError(bad.startsWith("missing") ? 400 : 403, bad);
    const pub = Fangorn.create({ privateKey: SERVICE_KEY, domain: "localhost", config: CONFIG, appId: APP });
    pub.ctx.metadataStorage = new DelegatedStorage(owner, auth, IPFS_GATEWAY);
    return pub;
}

// Where a stranger reaches this storefront, for the /c/<resourceId> links the
// publisher copies out of the UI. Separate from wherever the process is running:
// publishing is usually local while reads are hosted. Bare hosts get https://.
const SHARE_ORIGIN = process.env.DOMAIN
    ? (/^https?:\/\//.test(process.env.DOMAIN) ? process.env.DOMAIN : `https://${process.env.DOMAIN}`).replace(/\/$/, "")
    : null;

const APP_ID = fangorn.getDataRegistry().getAppId();
const CHAIN = CONFIG.chain;
// Same split as the browser's client (src/pay/wallet.js): the configured RPC first,
// the public Arbitrum endpoint behind it. /api/sales and /api/registration scan
// MemberRegistered/ResourceCreated from block 0, and a metered provider refuses a
// range that wide (Alchemy's free tier caps eth_getLogs at 10 blocks) — so those
// two routes fall through to the endpoint that answers them. The SDK still gets
// CONFIG.rpcUrl on its own: it takes a URL, not a transport.
const RPCS = [...new Set([CONFIG.rpcUrl, FangornConfig.rpcUrl])];
const publicClient = createPublicClient({
    chain: CHAIN,
    transport: RPCS.length > 1 ? fallback(RPCS.map((u) => http(u))) : http(RPCS[0]),
});

// Nothing can be published until the app namespace exists — commit_state_root
// reverts with AppNotFound. Fail at boot with the fix rather than at the end of
// a publish, after the encrypt+upload has already been paid for.
async function assertAppRegistered() {
    const apps = fangorn.getAppRegistry();
    const owner = await apps.getAppOwner();
    if (owner === `0x${"0".repeat(40)}`) {
        console.error(
            `App "${APP}" (${APP_ID}) is not registered on-chain — publishing will fail.\n` +
            `Claim it once from any funded wallet:\n` +
            `  cast send ${CONFIG.appRegistryContractAddress} "registerApp(bytes32,bytes32,string,uint256)" \\\n` +
            `    ${APP_ID} 0x${termsDigest()} "<terms url>" 0 \\\n` +
            `    --rpc-url ${CONFIG.rpcUrl} --private-key <key>`,
        );
        process.exit(1);
    }
    // registerForApp() reverts on an app with no terms, so an app claimed with a
    // zero digest is one nobody but its owner can ever publish under. That is a
    // one-line fix at the contract and an unexplainable failure at publish time,
    // so it is worth the same boot check as an unclaimed app.
    if (await apps.appTerms() === `0x${"0".repeat(64)}`) {
        console.error(
            `App "${APP}" (${APP_ID}) is claimed but has published no terms — nobody can join it.\n` +
            `Set them from the owner wallet (${owner}):\n` +
            `  cast send ${CONFIG.appRegistryContractAddress} "setAppTerms(bytes32,bytes32,string)" \\\n` +
            `    ${APP_ID} 0x${termsDigest()} "<terms url>" \\\n` +
            `    --rpc-url ${CONFIG.rpcUrl} --private-key <key>`,
        );
        process.exit(1);
    }
    return owner;
}

// The registry takes the publisher's own `uid` and DERIVES the resourceId as
// keccak(publisher ++ uid) — see resourceIdFor. It used to take the id itself,
// which meant anyone watching the mempool could claim a publisher's id, price it
// themselves, and collect the payments.
const CREATE_RESOURCE_ABI = [
    { type: "function", name: "createResource", stateMutability: "nonpayable", inputs: [{ name: "uid", type: "bytes32" }, { name: "price", type: "uint256" }, { name: "uri", type: "string" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "getOwner", stateMutability: "view", inputs: [{ name: "resource_id", type: "bytes32" }], outputs: [{ type: "address" }] },
];

/**
 * Is this resource already on-chain? Zero address means no.
 *
 * The manifest only learns a file is published at POST /api/settle, which runs
 * AFTER the createResource txs are mined. Anything that dies in between — a
 * failed commit, a storage gate that isn't there, a closed laptop — leaves the
 * resource created on-chain and the manifest still saying it isn't, and every
 * retry then reverts on a resource that already exists ("execution reverted for
 * an unknown reason", with nothing to say which tx). The chain is the authority
 * on what exists; the manifest is a cache of it.
 *
 * A read failure is treated as "not created": that is the pre-existing behaviour
 * and it fails the same way it always did, rather than blocking a first publish
 * because an RPC blipped.
 */
const resourceExists = async (resourceId) => publicClient
    .readContract({ address: SETTLEMENT_REGISTRY_ADDR, abi: CREATE_RESOURCE_ABI, functionName: "getOwner", args: [resourceId] })
    .then((owner) => /[1-9a-f]/i.test(owner.slice(2)))
    .catch(() => false);

// register() — the call that moves the USDC. One log per PAYING buyer, so this
// is the revenue line, and since each resource has its own Semaphore group these
// are ALL buyers: create_resource no longer seeds a fake leaf. No sales database.
const MEMBER_REGISTERED_EVENT = {
    name: "MemberRegistered", type: "event",
    inputs: [
        { name: "resourceId", type: "bytes32", indexed: true },
        { name: "identityCommitment", type: "uint256", indexed: false },
    ],
};

// Everyone who has ever published to sond3r's sond3r subspace. The registry
// indexes app_id and subspace, so ONE getLogs is the whole index — no publisher
// roster to sweep, no per-publisher status fan-out, and only publishers with
// actual content show up. A suspended publisher's existing library stays
// readable (the contract only blocks their next commit), which is what we want:
// buyers who paid for it can still find it.
const listPublishers = async () =>
    (await fangorn.appNamespaces({ namespace: NAMESPACE })).map((n) => n.owner.toLowerCase());

const packUri = (workerUrl, plaintextHash) => `${workerUrl}#${plaintextHash}`;
const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// A published file's Content-Type: the buyer's browser needs it to know whether
// the bytes are a film, a track, a PDF or something it can only offer to save.
// ponytail: a small table, not the `mime` package — an unknown extension is
// application/octet-stream, which downloads, which is the right fallback anyway.
const MIME_TYPES = {
    html: "text/html", js: "text/javascript", css: "text/css", ico: "image/x-icon",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
    pdf: "application/pdf", epub: "application/epub+zip", txt: "text/plain", md: "text/markdown",
    json: "application/json", csv: "text/csv", zip: "application/zip",
};
const mimeOf = (name) => MIME_TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
const isAV = (mime) => mime.startsWith("video/") || mime.startsWith("audio/");

// ─── the publisher's credential ──────────────────────────────────────────────
// Every value below is derived from `owner`, which only ever comes from a
// verified session. There is no code path that lets a request name someone
// else's tenant, and nothing here is stored — which is what lets a publisher's
// library live in their own bucket and follow them between machines.
/**
 * This publisher's upload token — the credential the shared access worker gates
 * `POST /upload/` on.
 *
 *     <owner>.<keccak256(RELAY_SECRET ++ owner)>
 *
 * The token NAMES ITS BEARER, and that is the whole design. One worker and one
 * bucket now serve every publisher, so "do you hold the bucket's token" stopped
 * being a useful question — the worker has to know WHICH publisher is writing, or
 * it cannot stop one of them overwriting another's ciphertext. It recomputes the
 * MAC from the same secret (`macFor` in webworker/fangorn-access-worker) and gets
 * the address for free: no bucket state, no round trip, no claim to perform, so a
 * publisher who has never touched the worker can upload immediately.
 *
 * Lowercased, because the address half is read back out as an identity. A
 * checksummed address here would attribute the same publisher's objects to two
 * different owners depending on how their wallet spelled itself.
 *
 * DERIVED, never stored: the same relay and the same wallet always produce the
 * same token, on a machine that has never seen this publisher. That is what lets
 * their manifest live in the bucket instead of on this disk.
 *
 * There is no env override, and adding one would be a footgun: a relay-wide
 * token would collapse every publisher onto one identity, which is exactly the
 * isolation the worker leans on. Covered by tenancy.test.js.
 *
 * ponytail: keccak of the service key, not the key itself — RELAY_SECRET is
 * installed on the worker as `wrangler secret put UPLOAD_HMAC_SECRET`, and the
 * two must be equal or every upload 401s.
 */
// SERVICE_KEY, not process.env.ETH_PRIVATE_KEY: they're the same value on a
// publisher relay, but on a READ_ONLY relay with no key configured the env var is
// undefined — and hashing "" would make every publisher's token publicly
// derivable. A read relay reaches no upload path today; this keeps that a design
// choice rather than the only thing standing between a known token and the bucket.
const RELAY_SECRET = keccak256(stringToBytes(`sond3r:upload-token:${SERVICE_KEY}`));
// A declaration, not a const: the --selfcheck block near the top of this file
// runs before this line and relies on hoisting to pin the format. Split out from
// uploadTokenFor so it can be checked against a FIXED secret rather than one
// derived from whatever key happens to be in the environment.
function uploadTokenWith(secret, owner) {
    return `${owner.toLowerCase()}.${keccak256(encodePacked(["bytes32", "address"], [secret, owner]))}`;
}
const uploadTokenFor = (owner) => uploadTokenWith(RELAY_SECRET, owner);

/** May this wallet PUBLISH? Storage no longer asks — commitStateRoot does. */
const isRegistered = async (owner) =>
    !REQUIRE_REGISTRATION || await fangorn.getDataRegistry().isRegistered(owner);

// ─── HTTP plumbing ────────────────────────────────────────────────────────────
const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const sendJson = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body, bigintReplacer)); };
const readJson = (req) => new Promise((resolve, reject) => {
    let data = ""; req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
});
function serveStatic(res, pathname) {
    if (!existsSync(DIST)) return sendJson(res, 404, { error: "no dist/ — run `vite build` (dev uses the vite server)" });
    // /flix/<id> belongs to the streaming service worker. Falling back to
    // index.html here hands a media element a 200 of HTML, which reads as "no
    // video with supported format" (and a broken <img>) instead of naming the
    // real problem: the worker never took control of the page.
    if (pathname.startsWith("/flix/")) return sendJson(res, 404, { error: "/flix/ is served by the streaming service worker, not the relay" });
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (!file.startsWith(DIST) || !existsSync(file) || pathname === "/") file = join(DIST, "index.html");
    // The streaming service worker ships from /assets but claims scope "/" so it
    // can answer /flix/<id>. Without this header the browser refuses the
    // registration and playback silently degrades to decrypting the whole file —
    // fine for a 5MB track, ruinous for a 1.8GB film. vite's dev server sets it;
    // in production this is the only thing that does.
    res.writeHead(200, { "Content-Type": mimeOf(file), "Service-Worker-Allowed": "/" });
    res.end(readFileSync(file));
}

// ─── link previews for /c/<resourceId> ────────────────────────────────────────
// X and Substack fetch the permalink and read meta tags; they run no JS, so the
// SPA shell previews as nothing. Resolve the file here and render the tags into
// index.html. Everything below degrades to the generic SOND3R card rather than
// erroring — a slow RPC must not turn a shared link into a 500 for a human.
const findInTree = (tree, resourceId) => {
    const stack = [...(tree ?? [])];
    while (stack.length) {
        const n = stack.pop();
        if (n.resourceId?.toLowerCase() === resourceId) return n;
        if (n.children) stack.push(...n.children);
    }
    return null;
};

const OG_LOOKUP_MS = Number(process.env.OG_LOOKUP_MS ?? 4000);

/**
 * This server's own public origin, from the deployment's DOMAIN or the proxy's
 * forwarding headers.
 *
 * NOT req.headers.origin: browsers omit Origin on same-origin GETs and send it
 * on same-origin POSTs, so reading it made GET /api/terms and POST
 * /api/terms/accept build two DIFFERENT messages (http:// vs https://) — the
 * signature was over the first and verified against the second, and every
 * acceptance failed with "signature does not match the claimed address".
 */
const requestOrigin = (req) => SHARE_ORIGIN ?? `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;

async function serveContentPage(req, res, resourceId, url) {
    // Same origin the publisher's copied links use, so og:url and og:image are
    // absolute and point where the link actually lives.
    const origin = requestOrigin(req);
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    let node = null;
    try {
        // ?owner= reads one namespace; without it, every publisher's — the same
        // two reads the page itself makes, and readNamespace is tip-cached.
        //
        // Capped, because the no-owner path is a cold walk of every publisher's
        // namespace over IPFS and takes minutes on a cold container. A crawler
        // waits a few seconds and then shows nothing at all; the untitled card
        // is strictly better, and the human's browser renders the real page
        // regardless. This is why the publisher's copied links carry ?owner=.
        const tree = await Promise.race([
            (/^0x[0-9a-f]{40}$/.test(owner)
                ? routes["GET /api/remote"]({ query: url.searchParams })
                : routes["GET /api/catalog"]({})).then((r) => r.tree),
            new Promise((_, reject) => setTimeout(() => reject(new Error("lookup timed out")), OG_LOOKUP_MS).unref()),
        ]);
        node = findInTree(tree, resourceId);
    } catch (err) { console.error(`og: ${resourceId} unreadable: ${err.message}`); }

    const price = node?.price ? `${(Number(node.price) / 1e6).toFixed(3)} USDC` : null;
    const html = injectOg(readFileSync(join(DIST, "index.html"), "utf-8"), {
        title: node?.name ?? "SOND3R",
        description: [node?.desc, price && `${price} — pay once, own forever.`].filter(Boolean).join(" · ")
            || "Pay once, own forever. Encrypted files, settled on-chain.",
        url: `${origin}/c/${resourceId}${owner ? `?owner=${owner}` : ""}`,
        image: `${origin}/c/${resourceId}/og.png`,
    });
    // Short cache: a crawler re-fetches on every share, and the title only moves
    // when the publisher republishes.
    res.writeHead(200, { "Content-Type": "text/html", "Service-Worker-Allowed": "/", "Cache-Control": "public, max-age=300" });
    res.end(html);
}

// The facilitator sends NO CORS headers (verified: no Access-Control-Allow-Origin
// on an OPTIONS preflight), so a deployed browser build cannot call it
// cross-origin. vite proxies /facilitator in dev; this is that same proxy for
// production, which is what keeps VITE_FACILITATOR_URL=/facilitator correct in
// BOTH — a deployed build with an absolute facilitator URL just fails preflight.
// ponytail: buffers the body. These are small JSON payloads (a signature and a
// proof); stream it if /facilitator ever carries anything large.
async function proxyFacilitator(req, res, url) {
    // PUBLIC_FACILITATOR_URL is the fallback because a hosted read relay is
    // routinely deployed with only that one set (it's what /api/config prints) —
    // and then every purchase 502s here. Same upstream either way.
    const target = (process.env.FACILITATOR_URL ?? process.env.PUBLIC_FACILITATOR_URL)?.replace(/\/$/, "");
    if (!target) return sendJson(res, 502, { error: "FACILITATOR_URL is not set — this relay cannot proxy purchases" });
    const body = req.method === "POST" || req.method === "PUT" ? await new Promise((resolve, reject) => {
        let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); req.on("error", reject);
    }) : undefined;
    const upstream = await fetch(`${target}${url.pathname.replace(/^\/facilitator/, "")}${url.search}`, {
        method: req.method,
        headers: { "Content-Type": req.headers["content-type"] ?? "application/json" },
        body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
}

// ─── routes ───────────────────────────────────────────────────────────────────
// Handlers receive { query, body, owner }. `owner` is the verified session
// address — see PUBLIC_ROUTES below for the handful that run without one.
const routes = {
    // ── sign-in (public) ──────────────────────────────────────────────────────
    "POST /api/session/nonce": async ({ body, origin }) => {
        try { return issueNonce(body?.address, origin); }
        catch (e) { throw new HttpError(400, e.message); }
    },
    "POST /api/session": async ({ body }) => {
        try { return await verifyAndCreateSession(body?.nonce, body?.signature); }
        catch (e) { throw new HttpError(401, e.message); }
    },
    "POST /api/session/end": async ({ req }) => ({ ok: destroySession(req) }),

    // Who am I? Lets the browser tell "session still valid" from "token expired"
    // without mutating anything.
    "GET /api/session": async ({ owner }) => ({ address: owner }),

    // Where this publisher's bytes go, and the credential to put them there.
    // Storage is not something they set up any more — it is provisioned, paid for
    // and operated by whoever runs this relay, so there is nothing to connect and
    // no Cloudflare account to own.
    //
    // UNGATED: every signed-in wallet gets storage. It used to be gated on Fangorn
    // registration, on the reasoning that a wallet that cannot commitStateRoot has
    // no use for somewhere to put files — but that made "sign up on another site,
    // on-chain, and pay a fee" the first thing a publisher had to do before they
    // could even try the app. The cap is the worker's job now: it meters
    // FREE_BYTES per owner (50 MiB) so an unregistered wallet costs the operator a
    // bounded amount, and registration is enforced where it actually bites —
    // POST /api/publish/prepare, which is the step that needs the chain.
    //
    // DERIVED, never stored (see uploadTokenFor), so this answers the same value
    // on a machine that has never seen this publisher before. That is what lets
    // the manifest live in the bucket instead of on this disk.
    "GET /api/worker": async ({ owner }) => ({ workerUrl: WORKER_URL, uploadToken: uploadTokenFor(owner) }),

    // Set a video's price (USDC base units).
    "POST /api/sales": async ({ body }) => {
        // One getLogs, and no seed to subtract: create_resource used to add a
        // fake leaf to the shared group and emit a MemberRegistered for it, so
        // this had to discard every log that shared a transaction with a
        // ResourceCreated. Groups are per-resource now and hold only buyers.
        const registered = await publicClient.getLogs({
            address: SETTLEMENT_REGISTRY_ADDR, event: MEMBER_REGISTERED_EVENT, fromBlock: 0n,
        });
        const buyers = {};
        for (const l of registered) {
            const id = l.args.resourceId.toLowerCase();
            buyers[id] = (buyers[id] ?? 0) + 1;
        }

        // The publisher's own resourceIds, from their manifest, which lives in
        // their bucket rather than here. Counts come from chain logs either way,
        // so nothing about this is self-reported: quoting a resourceId you do not
        // own just reports that resource's real, public buyer count.
        const sales = {};
        for (const f of Object.values(body?.manifest?.files ?? {})) {
            const id = f.published?.resourceId?.toLowerCase();
            if (!id) continue;
            const paid = buyers[id] ?? 0;
            sales[id] = { paid, revenue: (BigInt(paid) * BigInt(f.price ?? DEFAULT_PRICE)).toString() };
        }
        return { sales };
    },

    // Everything a stranger's buyer needs to transact with this storefront, so it
    // never has to be handed a copy of our .env out of band. All public knowledge —
    // deployed addresses and an RPC — and the bootstrap an MCP server or a
    // /.well-known descriptor would read on startup.
    //
    // PUBLIC_FACILITATOR_URL is separate from FACILITATOR_URL on purpose: the
    // browser reaches the facilitator through vite's /facilitator proxy to dodge
    // CORS, and an agent has no proxy — it needs a real hostname.
    "GET /api/config": async () => ({
        readOnly: READ_ONLY, // the SPA hides the Publisher tab on a hosted relay
        // The storage gate the publisher's wallet must sign a challenge for. Sent
        // so the browser asks the SAME gate this relay pins through — and null
        // when PINATA_JWT puts the relay in direct mode, which is how the browser
        // knows to skip the signature instead of blocking publish on a gate that
        // is not in the path.
        storageGate: PINATA_JWT ? null : SIGNED_URL_WORKER,
        chainId: CHAIN.id,
        registry: SETTLEMENT_REGISTRY_ADDR,
        usdc: process.env.USDC_CONTRACT_ADDR,
        usdcDomainName: process.env.USDC_DOMAIN_NAME ?? "USD Coin",
        facilitator: (process.env.PUBLIC_FACILITATOR_URL ?? process.env.FACILITATOR_URL ?? "").replace(/\/$/, ""),
        rpc: process.env.VITE_CHAIN_RPC_URL ?? CONFIG.rpcUrl,
        // Where the browser streams search shards from (see QUICKBEAM_URL above).
        quickbeam: QUICKBEAM_URL,
        // Which of that view's domains to pull; [] = all of them.
        domains: QUICKBEAM_DOMAINS,
        // Where the browser lists apps from (see APPS_VIEW_URL above).
        apps: APPS_VIEW_URL,
        // Origin to prefix share/permalinks with; null = use the page's own.
        shareOrigin: SHARE_ORIGIN,
    }),

    // Is the session wallet a registered data publisher, and if not, the tx that
    // makes it one.
    //
    // commitStateRoot reverts with NotRegistered for an unregistered sender, and
    // the SDK reports EVERY estimateGas revert as "the head may have moved
    // on-chain, or the app is unregistered" — which sends you looking at the app
    // (registered) and the head (correct) while the actual cause is the wallet.
    // Registration is per-publisher and one-time, and it CANNOT be done for them:
    // the registry keys the publisher off msg_sender, so this relay's service key
    // registering itself does nothing for anyone else. Hence an unsigned tx for
    // the browser to send, exactly like the commit.
    "GET /api/registration": async ({ owner, origin }) => {
        const dr = fangorn.getDataRegistry();
        const apps = fangorn.getAppRegistry();
        const { hash, url } = terms(origin);
        const acceptedTerms = hasAcceptedTerms(owner, hash);

        // TWO registries, and both are required to publish: DataRegistry.register()
        // is global standing ("this wallet may publish at all"), AppRegistry
        // .registerForApp() is membership of THIS app. commitStateRoot cross-calls
        // the second, so a wallet with only the first reverts `NotRegisteredForApp`
        // at commit — after the encrypt and upload have already been paid for.
        // Hence both are reported here, and `registered` means BOTH — but each
        // flag is reported too, because a wallet with only the first was being
        // told it "isn't a registered Fangorn publisher" and sent to
        // fangorn.network, which is already done and cannot fix the missing half.
        const [inRegistry, joined] = await Promise.all([dr.isRegistered(owner), apps.isRegisteredForApp(owner)]);
        if (inRegistry && joined) return { registered: true, inRegistry, joined, app: APP, acceptedTerms, terms: { hash, url } };

        const fee = inRegistry ? 0n : await dr.registrationFee();
        const appFee = await apps.appFee();
        // WITHHELD until the terms are signed. Becoming a publisher is the moment
        // the obligations attach, so this relay does not hand over the transactions
        // that do it before it has the signature on file.
        //
        // Ordered, and sent in this order: registerForApp reverts for a wallet the
        // data registry has never seen, so a caller that sends them backwards pays
        // gas to fail.
        const txs = !acceptedTerms ? [] : [
            ...(inRegistry ? [] : [{
                what: "register",
                to: CONFIG.dataRegistryContractAddress,
                data: encodeFunctionData({ abi: DATA_REGISTRY_ABI, functionName: "register", args: [] }),
                value: numberToHex(fee),
            }]),
            // The app's terms hash is an ARGUMENT here, so this transaction IS the
            // acceptance — the on-chain half of the gate above, and the reason the
            // digest is read from the contract rather than sent by the caller.
            ...(joined ? [] : [await apps.prepareRegisterForApp(owner)]),
        ];
        return {
            registered: false,
            inRegistry,
            joined,
            app: APP,
            acceptedTerms,
            terms: { hash, url },
            fee: fee.toString(),
            appFee: appFee.toString(),
            txs,
        };
    },

    // The exact bytes to sign to accept the current terms, and their digest.
    "GET /api/terms": async ({ owner, origin }) => {
        const { hash, url } = terms(origin);
        return { hash, url, accepted: hasAcceptedTerms(owner, hash), message: termsMessage({ address: owner, termsHash: hash, termsUrl: url }) };
    },

    // Record that acceptance. The signature is verified against a message this
    // server rebuilds from the session's own address — never from the body — so
    // nobody can file an acceptance in someone else's name.
    "POST /api/terms/accept": async ({ owner, origin, body }) => {
        const { hash, url } = terms(origin);
        await acceptTerms({ address: owner, termsHash: hash, termsUrl: url, signature: body?.signature });
        return { ok: true, hash };
    },

    // Seal the publish commit with the vectors the browser just produced.
    // The browser has already encrypted and uploaded everything by the time this
    // is called, so there is no long-running work here and nothing to stream — it
    // mints resourceIds and builds the commit, which is milliseconds of CPU.
    "POST /api/publish/prepare": async ({ body, owner, origin }) => {
        assertAcceptedTerms(owner, origin);
        return preparePublish(owner, body?.library);
    },

    "POST /api/publish/commit": async ({ body, owner }) => commitPublish(owner, body?.vectors ?? {}, body?.storageAuth),

    // Rebake the shard on demand (after an out-of-band edit, or to pick up another
    // publisher's commit without republishing anything yourself).
    "POST /api/shard": async () => rebakeShard(),

    // The published library, read back FROM the on-chain graph, for the viewer.
    // readNamespace is tip-keyed: the walk is skipped unless the publisher's head
    // has actually moved, so there is nothing to invalidate and nothing stale.
    "GET /api/remote": async ({ query }) => {
        const owner = String(query.get("owner") ?? "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new HttpError(400, "?owner=0x… required");
        const { tip, contents } = await fangorn.readNamespace(owner, NAMESPACE);
        // Roots carry their owner, exactly as /api/catalog and the shard tag
        // theirs. It's redundant here — the caller named the address — but every
        // consumer scopes by node.owner, and a tree that only sometimes has it is
        // a null waiting to happen in whichever one forgot.
        return { tree: tip ? treeFromGraph(contents).map((t) => ({ ...t, owner })) : [] };
    },

    // Everything published by everyone, for a viewer with no address typed in.
    // Publishers come from the chain's own registration log, so a new publisher
    // shows up here the moment they commit — nothing to add them to.
    // One bad namespace must not sink the whole catalog — but swallowing the error
    // silently turns "every namespace failed" into an empty page with no reason,
    // which is exactly how a fresh container looks when it can't reach IPFS. Skip
    // the publisher, keep the rest, and SAY what went wrong.
    //
    // No TTL here any more: readNamespace caches each publisher's tree against
    // its on-chain tip, so a repeat hit costs one getLogs plus one cheap head
    // read per publisher and zero IPFS walks — always fresh, never a cold
    // container serving an empty page for a minute.
    "GET /api/catalog": async () => {
        const publishers = await listPublishers();
        const nodes = [];
        const errors = [];
        await Promise.all(publishers.map(async (owner) => {
            try {
                const { contents } = await fangorn.readNamespace(owner, NAMESPACE);
                for (const t of treeFromGraph(contents)) nodes.push({ ...t, owner });
            } catch (err) {
                console.error(`catalog: ${owner} unreadable: ${err.message}`);
                errors.push({ owner, error: err.message });
            }
        }));
        if (publishers.length && errors.length === publishers.length) throw new HttpError(502, `no namespace readable: ${errors[0].error}`);
        return { publishers, tree: nodes, ...(errors.length ? { errors } : {}) };
    },

    // After the browser confirms all txs, rebake the search shard. This runs
    // AFTER the commit is on-chain, which is the only point where the aggregator
    // can actually read what was published.
    //
    // Recording the pointers is the browser's job now — it writes them into the
    // manifest in the publisher's own bucket, which is also the only place they
    // are needed.
    "POST /api/settle": async () => {
        const shard = await rebakeShard().catch((e) => ({ error: e.message }));
        return { ok: true, shard };
    },
};

const PUBLIC_ROUTES = new Set([
    "POST /api/session/nonce",
    "POST /api/session",
    "POST /api/session/end",
    "GET /api/remote",
    "GET /api/catalog",
    "GET /api/config",
]);

// The routes a READ_ONLY relay still answers (see the flag near the top).
const READ_ONLY_ROUTES = new Set(["GET /api/remote", "GET /api/catalog", "GET /api/config"]);

// ── the terms gate ────────────────────────────────────────────────────────────
// Publishers accept a SPECIFIC version of public/terms.html, identified by its
// SHA-256. Hashing the served bytes rather than trusting a version string means
// nobody has to remember to bump anything: edit the page and every publisher is
// asked again, because the digest they accepted no longer matches.

/** The terms as actually served: the SHA-256 of the bytes, and where to read
 *  them. dist/ wins over public/ for the same reason rebakeShard writes both —
 *  in dev they are two different servers, and gating on a file nobody is being
 *  shown is worse than not gating at all. */
function termsDigest() {
    const file = [join(DIST, "terms.html"), join(PUBLIC_DIR, "terms.html"), join(import.meta.dirname, "..", "public", "terms.html")]
        .find((p) => existsSync(p));
    if (!file) throw new HttpError(500, "terms.html is not being served — refusing to gate on a document nobody can read");
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function terms(origin) {
    return { hash: termsDigest(), url: `${origin}/terms.html` };
}

/**
 * Refuse anything that makes someone a publisher until they've signed the terms.
 *
 * Gating BOTH registration and publish is deliberate. Registration is the moment
 * the user asked for, but it is one-time and already-registered publishers would
 * sail past a gate that only sat there — the hole would be every publisher who
 * exists today. Publish is the act that actually puts content on the network, so
 * it gets the same check.
 */
function assertAcceptedTerms(owner, origin) {
    const { hash } = terms(origin);
    if (hasAcceptedTerms(owner, hash)) return;
    throw new HttpError(403, "accept the Publisher Terms before publishing — reload the Publisher tab");
}

// Rebake the public search shard from every publisher's on-chain graph.
// Embeddings live in the shard, so an out-of-band embedding step has to re-run
// after this — a rebake ships text-only rows and search falls back to lexical.
async function rebakeShard() {
    // Write to BOTH, because in dev both are being served: vite serves public/ on
    // 5173 while this process serves dist/ on 8787, and `pnpm dev` runs the pair.
    // Picking one by existsSync(DIST) meant a stale dist/ from any earlier build
    // captured every rebake, and the browser — which loads the app from vite —
    // went on searching a months-old public/ shard with no vectors in it. There is
    // no signal here for "which server the human is actually looking at", so the
    // only safe answer is both.
    const outDirs = [PUBLIC_DIR, ...(existsSync(DIST) ? [DIST] : [])];
    for (const d of outDirs) mkdirSync(d, { recursive: true });
    const publishers = await listPublishers();
    const rows = await aggregateRows({
        listNamespace: async (ns, owner) => (await fangorn.readNamespace(owner, ns)).contents,
        namespace: NAMESPACE, publishers,
        // Publishers embed in their own browsers, so the shard can contain vectors
        // from whatever model each of them was running. Only this one is comparable.
        model: EMBED_MODEL, dim: EMBED_DIM,
        onProgress: (p) => {
            if (p.error) console.error(`shard: skipping ${p.owner}: ${p.error}`);
            if (p.dropped) console.warn(`shard: ${p.owner} has ${p.dropped} unusable vector set(s) — wrong model or stale cues; those rows stay lexical`);
        },
    });
    let n = 0, bytes = 0;
    for (const d of outDirs) ({ rows: n, bytes } = writeShard(rows, join(d, "subtitles.ndjson.gz")));
    const embedded = rows.filter((r) => r.vec).length;
    console.log(`search shard: ${n} rows (${embedded} embedded) from ${publishers.length} publisher(s), ${(bytes / 1024).toFixed(1)} KiB → ${outDirs.map((d) => d.split("/").pop()).join(", ")}`);
    return { passages: n, embedded, publishers: publishers.length };
}

/**
 * Turn the library the browser just finished uploading into a signable commit.
 *
 * The relay does not see a byte of it. The browser encrypted each new file and
 * pushed the ciphertext straight to the publisher's OWN access worker
 * (src/pay/encrypt.js), so what arrives here is the finished library: names, paths,
 * prices, descriptions, cues, and a `published` pointer for anything with bytes
 * behind it. All this function adds is the part that needs Node — mint the
 * resourceIds, build the tree→graph commit, and hand back unsigned txs.
 *
 * `owner` is the verified session address and NOT a request field, so the
 * namespace being committed to is always the caller's own.
 *
 * The library IS a request field, which is a deliberate change: it used to be
 * read from the relay's disk. That is safe because it only ever describes the
 * caller's own namespace and only their own wallet can sign the result — a
 * publisher redrawing their own library is the feature, not an attack. What a
 * caller still cannot do is mint a resourceId under someone else's address:
 * resourceIdFor folds in `owner`.
 */
async function preparePublish(owner, library) {
    // Before anything else. The browser checks this too, but it has already spent
    // the publisher's bandwidth by now, and an unregistered publisher can never
    // commit — commitStateRoot reverts.
    if (!await isRegistered(owner)) {
        throw new HttpError(403, `${owner} is not a registered Fangorn publisher. Sign up at https://fangorn.network.`);
    }

    const nodes = normalizeLibrary(library);

    // Anything the browser says has bytes on a worker gets a resource minted for
    // it, unless it already has one. Catalog entries (`forSale: false`) are
    // excluded and that is the entire saving: no AES, no upload, no
    // createResource. They ride along on the one shared commitStateRoot.
    const creates = [];
    const published = {};
    for (const n of nodes) {
        if (n.type !== "video" || isCatalogEntry(n) || !n.published) continue;
        const p = n.published;
        // An already-published file keeps the id it was published under. The
        // derivation folds in the publisher's address, so re-deriving here for a
        // file published under an older scheme would point new ciphertext at a key
        // no on-chain resource names — the file would go dark for everyone who
        // bought it.
        const resourceId = p.resourceId ?? resourceIdFor(owner, n.uid);
        if (!await resourceExists(resourceId)) {
            creates.push({
                path: n.path, to: SETTLEMENT_REGISTRY_ADDR,
                data: encodeFunctionData({ abi: CREATE_RESOURCE_ABI, functionName: "createResource", args: [uidHashFor(n.uid), BigInt(n.price), packUri(p.workerUrl, p.plaintextHash)] }),
            });
        }
        published[n.path] = { ...p, resourceId };
    }

    const merged = nodes.map((n) => (published[n.path] ? { ...n, published: published[n.path] } : n));

    // Hold the library here between prepare and commit. The embedding model runs
    // in the PUBLISHER's browser (there is none in this process), so the commit
    // can't be sealed until those vectors come back.
    pendingPublish.set(owner, { merged, published });
    return { creates, published, embed: embedTasks(merged) };
}

/**
 * Validate and normalize a browser-supplied library into the node shape the graph
 * builder expects.
 *
 * This is a trust boundary — the shapes below end up in a public on-chain graph —
 * so every field is taken deliberately rather than by spreading the request
 * object into a vertex. `safeRel` is what keeps a path from being `../` into
 * another publisher's namespace in the committed tree.
 */
function normalizeLibrary(library) {
    if (!Array.isArray(library)) throw new HttpError(400, "library must be an array of nodes");
    const seen = new Set();
    return library.map((n) => {
        const path = safeRel(n?.path);
        if (!path) throw new HttpError(400, `bad path: ${JSON.stringify(n?.path)}`);
        if (seen.has(path)) throw new HttpError(400, `duplicate path in library: ${path}`);
        seen.add(path);
        const name = basename(path);
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (n?.type === "folder") return { path, name, parent, type: "folder" };

        // uid is what keeps a file's PAID identity stable across a rename, so a
        // missing one is a bug in the caller, not something to paper over with a
        // fresh id that would orphan every existing buyer.
        if (!n?.uid) throw new HttpError(400, `${path} has no uid — the manifest is what mints those`);
        const out = {
            path, name, parent, type: "video",
            mime: n.mime ?? mimeOf(name),
            price: String(n.price ?? DEFAULT_PRICE),
            uid: String(n.uid),
            desc: typeof n.desc === "string" ? n.desc.slice(0, 2000) : undefined,
            forSale: n.forSale !== false,
        };
        // The only unbounded, non-derived field in the payload — see normalizeCues.
        if (n.cues) {
            try { out.cues = normalizeCues(n.cues); }
            catch (e) { throw new HttpError(400, `${path}: ${e.message}`); }
        }
        // Free content the publisher does not host: the bytes already have a
        // public URL, so the vertex carries it and there is nothing to mint or
        // decrypt. Without this a catalog entry is findable and unplayable.
        if (typeof n.url === "string" && /^https:\/\//.test(n.url)) out.url = n.url.slice(0, 2000);
        if (n.published?.plaintextHash && n.published?.workerUrl) {
            const p = n.published;
            out.published = {
                plaintextHash: p.plaintextHash, workerUrl: String(p.workerUrl).replace(/\/$/, ""),
                chunks: Number(p.chunks) || 1, size: Number(p.size) || 0,
                chunkSize: Number(p.chunkSize) || CHUNK_SIZE, mime: out.mime, enc: ENC_VERSION,
                ...(p.resourceId ? { resourceId: p.resourceId } : {}),
            };
        }
        return out;
    });
}

// One publisher's staged library, between prepare and commit. Deliberately in
// memory and never read from the request: the browser gets to supply vectors,
// not to redraw the library it's committing.
// ponytail: a restart mid-publish means re-running publish. Nothing is lost —
// the ciphertext is already uploaded and the uids are already on disk.
const pendingPublish = new Map();

/**
 * The text a buyer's query has to match, per published file. Ids are exactly the
 * shard's track_ids so the vectors land back on the right rows.
 *
 * enrichText, not fileText: the shard keeps storing fileText for display and
 * lexical fallback, so the on-chain payload doesn't grow.
 */
function embedTasks(merged) {
    const tasks = [];
    for (const n of merged) {
        // Catalog entries included: a free entry that nothing can find is worth
        // nothing, and the vector IS the product for an entry with no bytes to sell.
        if (!inGraph(n)) continue;
        // No `abs`: the file is on the publisher's machine and was never here, so
        // there is nothing to read a PDF title or an ID3 frame out of. enrichText
        // degrades to name+path+desc, which is why the description field carries
        // more weight than it used to — see scripts/publish.mjs on .txt sidecars.
        tasks.push({ id: `${n.path}#file`, text: enrichText({ name: n.name, path: n.path, desc: n.desc, mime: n.mime }) });
        for (const [i, p] of toPassages(n.cues ?? []).entries()) tasks.push({ id: `${n.path}#p${i}`, text: p.text });
    }
    return tasks;
}

/** Seal the commit. `vectors` is { track_id → base64 int8 } and `storageAuth` the
 *  wallet-signed gate challenge, both from the browser. */
async function commitPublish(owner, vectors = {}, storageAuth) {
    const pending = pendingPublish.get(owner);
    if (!pending) throw new HttpError(409, "nothing staged — run publish again");
    // After the staging check: "nothing staged" is the more useful answer when
    // both are wrong, and it costs nothing to reach.
    const pub = await publisherFangorn(owner, storageAuth);
    const { merged, published } = pending;

    const stamp = { model: EMBED_MODEL, dim: EMBED_DIM };
    const withVectors = merged.map((n) => {
        if (!inGraph(n)) return n;
        const out = { ...n };
        const fileVec = vectors[`${n.path}#file`];
        if (fileVec) out.embed = { ...stamp, vec: fileVec };
        const passages = toPassages(n.cues ?? []);
        const vecs = passages.map((_, i) => vectors[`${n.path}#p${i}`]);
        // All or nothing: a partial set would be committed as a positional array
        // with holes, which the shard reads as misalignment and drops anyway.
        if (passages.length && vecs.every(Boolean)) out.cueEmbed = { ...stamp, vecs };
        return out;
    });

    const { vertices, edges } = buildTreeGraph(withVectors);
    if (vertices.length === 0) throw new HttpError(400, "nothing to publish — upload a video first");

    // Self-custodial twice over: the pin is authorized by the publisher's own
    // signature (their storage quota, their subscription), and the tx comes back
    // UNSIGNED so only their browser wallet can move their head. `owner` is the
    // session address, so the staging dir and the on-chain timeline can't disagree.
    const { commitCid, tx } = await pub.prepareCommit({
        owner, namespace: NAMESPACE, vertices, edges, message: "publish library", replace: true,
    });

    pendingPublish.delete(owner);
    const embedded = Object.keys(vectors).length;
    return { commitCid, commitTx: tx, published, staged: { vertices: vertices.length, edges: edges.length, embedded } };
}

/** The verified session address, or a 401. The ONLY way a handler learns which
 *  publisher it is acting for — nothing reads an owner out of the request. */
function requireOwner(req) {
    const owner = addressForRequest(req);
    if (!owner) throw new HttpError(401, "sign in with your wallet first");
    return owner;
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
        // Before EVERYTHING under /api/, including the inline upload and publish
        // handlers below — those don't go through the routes table, so a guard
        // placed at dispatch would leave exactly the two disk-writing endpoints
        // open. Static files and the /facilitator proxy are unaffected: a read
        // relay still serves the app and still lets people buy.
        if (READ_ONLY && url.pathname.startsWith("/api/") && !READ_ONLY_ROUTES.has(`${req.method} ${url.pathname}`)) {
            return sendJson(res, 403, { error: "this relay is read-only — publishing runs on the publisher's own machine" });
        }

        if (url.pathname.startsWith("/facilitator/")) return proxyFacilitator(req, res, url);

        // Before the static fallback: both of these live under /c/, which
        // otherwise resolves to the SPA shell.
        if (req.method === "GET") {
            const card = /^\/c\/(0x[0-9a-fA-F]{64})\/og\.png$/.exec(url.pathname);
            if (card) {
                const png = ogPng(card[1].toLowerCase());
                res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
                return res.end(png);
            }
            const permalink = /^\/c\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
            if (permalink && existsSync(DIST)) return await serveContentPage(req, res, permalink[1].toLowerCase(), url);
        }

        if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

        const key = `${req.method} ${url.pathname}`;
        const handler = routes[key];
        if (!handler) return sendJson(res, 404, { error: `no route: ${key}` });

        // Default-deny: every /api route needs a session unless it's on the list.
        const params = { query: url.searchParams, req, origin: requestOrigin(req) };
        if (!PUBLIC_ROUTES.has(key)) params.owner = requireOwner(req);
        if (req.method === "POST" || req.method === "PUT") params.body = await readJson(req);
        sendJson(res, 200, await handler(params));
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        sendJson(res, status, { error: err.message });
    }
});

const appOwner = await assertAppRegistered();

server.listen(PORT, () => {
    console.log(`SOND3R relay on http://localhost:${PORT}`);
    console.log(`  app:     ${APP}:${NAMESPACE} — ${APP_ID} (owner ${appOwner})`);
    console.log(`  service: ${fangorn.getAddress()} (chain reads only — pins are signed by each publisher's wallet)`);
    console.log("  storage: none. Publishers encrypt in the browser and upload to their own worker.");
    // The one file this process writes, and the one that has to outlive the
    // container. A relative path resolves inside an ephemeral filesystem, where
    // it survives until the next cold start and then silently re-asks every
    // publisher to sign the terms they already signed — which reads as a UI bug,
    // days later, nowhere near the deploy that caused it. So it is named here.
    console.log(`  terms:   ${resolve(attestationLog())}${isAbsolute(attestationLog()) ? "" : "  ← EPHEMERAL: set ATTESTATION_LOG to a path on a mounted volume"}`);
});
