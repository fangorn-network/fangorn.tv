import React, { useEffect, useRef, useState } from "react";
import { encodeFunctionData, parseAbi } from "viem";
import { connectWallet, publicClient, sendTx, signIn } from "../pay/wallet.js";
import { api, UnauthorizedError } from "../catalog/api.js";
import { CFG, watchEpisode } from "../pay/purchase.js";
import { closeStream } from "../pay/stream.js";
// `setActiveView` here, not `setView` — Viewer already has a `view` state that means
// shelves-vs-collections. Two different things called view is how you get a one-line
// bug that takes an afternoon.
import { catalogFromShard, countFiles, fileVectors, findNode, findStudioNode, groupByFile, loadShard, searchSubtitles, setView as setActiveView, watchShard } from "../catalog/search.js";
import { listApps } from "../catalog/apps.js";
import { flatten, foldItems, foldSeries, kindForQuery, kinds, levelAt, mimeFor, nodeKey, rate, ratingOf, recall, remember, seriesIndex, seriesKey, seriesShelves, shelves } from "../catalog/browse.js";
import { heading, rank, session, topics, unit } from "../geometry/kernel.js";
import { embedQuery, warmEmbedder } from "../llm/embed.js";
import { centroid, concepts, mirror } from "../catalog/wiki.js";
import { Concepts, ListPage, WikiIndex } from "./wiki.jsx";
import Guide from "./guide.jsx";
import Tv from "./tv.jsx";
import { emit, mark, next, propose, since } from "./intent.js";
// The two derivations the IA refactor added but never wired: an aisle per file
// (genres) and a ring per aisle (channels). Both are pure functions of the
// catalog, so they cost nothing until a view asks for them.
import { useGenres } from "../catalog/genres.js";
import { BLOCK, dropChan, lineup, linkFor, moments, program, saveChan, savedChans, tuned, unpackChan, unpackRow } from "../catalog/channels.js";
import { useBack, backLabel } from "./nav.js";
import { useModelContext, useAnnotations } from "./webmcp.js";
import { SceneDeck } from "./scenes.jsx";
import { PrivyLogin } from "./privy.jsx";

const usdc = (base) => `${(Number(base) / 1e6).toFixed(3)} USDC`;
// A price of 0 is a real, mintable resource — bytes on the worker, a row on
// chain — that anyone can fetch without paying. Only the price label changes.
const isFree = (node) => !!node.resourceId && Number(node.price) === 0;
const priceLabel = (node) => (isFree(node) ? "Free" : usdc(node.price));
// What a row costs, in one word, for any row: minted and priced, minted and free,
// public elsewhere, or a catalog entry with nothing to sell at all.
const priceOf = (node) => (node.resourceId ? priceLabel(node) : node.url ? "Free" : "Free entry");
const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// Anything is sellable, so the tree can't just say 🎞️ any more.
const iconFor = (mime = "video/mp4") =>
    (mime.startsWith("video/") ? "🎞️" : mime.startsWith("audio/") ? "🎵" : mime.startsWith("image/") ? "🖼️" : "📄");

// Cover art, in two cases.
//
// A row that carries `thumb` has a real picture and we show it: an open catalog
// (archive.org derives one per identifier, CORS-open like the bytes) hands one out
// for free, and a grid of real covers is a different object from a grid of
// gradients — it is the difference between a catalog and a spreadsheet.
//
// Everything else falls back to generated art, because for a SOLD file the bytes
// are encrypted and nobody has paid yet, so there is no frame to grab. What we do
// know before a sale is the file's name and its kind, and that's what the art is
// seeded from: same name, same picture, every time, and two files never look alike.
// A thumb that 404s falls back to the same place — a broken image icon in a grid
// looks like the page is broken, not like the picture is missing.
// ponytail: no publisher-chosen cover for sold files. That means grabbing a frame
// in the publisher's browser at publish time (it holds the plaintext there) and
// carrying it on the node — do that when publishers ask to choose the image.
const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const HUE = { video: 212, audio: 268, image: 142, text: 32, application: 18 };

function CardArt({ node }) {
    const [broken, setBroken] = useState(false);
    const key = node.path || node.name || "";
    const kind = (mimeFor(node) || "").split("/")[0];
    useEffect(() => setBroken(false), [node.thumb]);
    // No glyph over a real picture. The glyph exists to say what kind of thing a
    // generated gradient is; stamped on a photograph it is just a sticker.
    if (node.thumb && !broken) {
        return (
            <span className="card-art" aria-hidden="true">
                <img src={node.thumb} alt="" loading="lazy" onError={() => setBroken(true)} />
            </span>
        );
    }
    const h = hashOf(key);
    const hue = ((HUE[kind] ?? 200) + (h % 46) - 23 + 360) % 360;
    const blobs = [0, 1, 2].map((i) => {
        const b = hashOf(`${key}#${i}`);
        return { cx: 8 + (b % 84), cy: 8 + ((b >> 7) % 84), r: 18 + ((b >> 14) % 28), o: 0.22 + ((b >> 21) % 30) / 100 };
    });
    return (
        <span className="card-art" aria-hidden="true">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <rect width="100" height="100" fill={`hsl(${hue} 42% 11%)`} />
                {blobs.map((b, i) => (
                    <circle key={i} cx={b.cx} cy={b.cy} r={b.r} opacity={b.o} fill={`hsl(${(hue + i * 34) % 360} 72% 58%)`} />
                ))}
            </svg>
            <span className="art-glyph">{iconFor(node.mime)}</span>
        </span>
    );
}

/**
 * 👍 / 👎, the only thing a viewer ever tells the kernel out loud.
 *
 * Everything else it knows is inferred from an open, which is an ambiguous signal:
 * you clicked it, so you were curious, so it decides you want more of that. There
 * was no way at all to say "not this". Pressing the lit button clears it, so the
 * control is a three-state toggle and not a one-way door.
 *
 * The page moves as you press — `rate()` bumps the same counter an open does, so
 * every shelf, the compass, the rail and the field all recompute on the click.
 * That is the feature; a button that changes nothing visible is worse than none.
 */
function Rate({ node, w, small }) {
    const r = ratingOf(node, w.history);
    const set = (sign) => (e) => { e.stopPropagation(); w.rate(node, r === sign ? 0 : sign); };
    return (
        <span className={`rate${small ? " mini" : ""}`}>
            <button className={r > 0 ? "on" : ""} onClick={set(1)}
                title={r > 0 ? "You liked this — click to clear" : "More like this"}
                aria-pressed={r > 0} aria-label="More like this">👍</button>
            <button className={r < 0 ? "on" : ""} onClick={set(-1)}
                title={r < 0 ? "You hid this — click to clear" : "Less like this"}
                aria-pressed={r < 0} aria-label="Less like this">👎</button>
        </span>
    );
}

/** Public purchase page for one published file. The resourceId is the identity
 *  (it's what the chain keys the sale on); `owner` is only a hint that lets the
 *  page read one namespace instead of the whole catalog. */
// The origin share links are built against — the relay's DOMAIN when it sets one
// (publishing is often local while buyers read a hosted copy), else this page's.
// ponytail: a plain mutable, set by the config fetch in App's first effect. Every
// ShareLink mounts from a tab the publisher clicks into, long after that lands.
let shareOrigin = location.origin;

const pathFor = (resourceId, owner) => `/c/${resourceId}${owner ? `?owner=${owner}` : ""}`;

export default function App() {
    // ponytail: two regexes over location.pathname, not a router — there are three
    // pages. Both the vite dev server and serveStatic() already fall back to
    // index.html for unknown paths, so a deep link loads the app.
    const permalink = /^\/c\/(0x[0-9a-fA-F]{64})$/.exec(location.pathname)?.[1];
    // One publisher's whole storefront. This is the page a publisher embeds in
    // their own site — it must stay on THIS origin, because the buyer flow needs
    // the same-origin /facilitator proxy (the facilitator sends no CORS headers)
    // and the streaming service worker's scope. Hence an iframe of this page
    // rather than a script that runs on their domain.
    const storefront = /^\/s\/(0x[0-9a-fA-F]{40})$/.exec(location.pathname)?.[1];
    // Embedded: drop our chrome so it reads as part of their page. The wallet
    // controls stay — without them nobody can buy.
    const embedded = new URLSearchParams(location.search).has("embed");
    const [wallet, setWallet] = useState(null);
    const [session, setSession] = useState(null); // signed-in address, or null
    const [tab, setTab] = useState("publish");
    const [err, setErr] = useState(null);
    // A hosted read relay refuses every publishing route (READ_ONLY=1). Ask once
    // and drop the Publisher tab entirely rather than letting someone sign in and
    // collect a 403 three clicks later.
    const [readOnly, setReadOnly] = useState(false);
    useEffect(() => {
        api.getConfig().then((c) => {
            if (c.shareOrigin) shareOrigin = c.shareOrigin;
            if (c.readOnly) { setReadOnly(true); setTab("watch"); }
        }).catch(() => { });
    }, []);

    const connect = async () => { try { setErr(null); setWallet(await connectWallet()); } catch (e) { setErr(e.message); } };

    // A token in sessionStorage survives a reload; ask the relay whether it's
    // still good rather than trusting it, so an expired one doesn't show a
    // signed-in UI that 401s on the first click.
    useEffect(() => {
        if (api.hasToken()) api.whoami().then((r) => setSession(r.address), () => setSession(null));
    }, []);

    const doSignIn = async () => {
        try {
            setErr(null);
            await signIn(wallet.walletClient, wallet.address);
            setSession(wallet.address.toLowerCase());
        } catch (e) { setErr(e.message); }
    };
    const doSignOut = () => { api.signOut().catch(() => { }); setSession(null); };

    // Switching accounts in MetaMask must not leave the previous publisher's
    // staging session attached to the new address.
    const signedIn = session && wallet && session === wallet.address.toLowerCase();
    useEffect(() => {
        if (session && wallet && session !== wallet.address.toLowerCase()) doSignOut();
    }, [wallet?.address]);

    return (
        <div className={embedded ? "app embed" : "app"}>
            <header>
                {!embedded && <h1>Fangorn.tv</h1>}
                <nav>
                    {permalink || storefront || embedded
                        ? !embedded && <a className="ghost" href="/">← Browse everything</a>
                        : <>
                            {!readOnly && <button className={tab === "publish" ? "on" : ""} onClick={() => setTab("publish")}>Publisher</button>}
                            <button className={tab === "watch" ? "on" : ""} onClick={() => setTab("watch")}>Watch</button>
                        </>}
                </nav>
                <div className="spacer" />
                {/* TODO: WALLET FUNC is OFF */}
                {/* {signedIn && <button className="ghost" onClick={doSignOut}>Sign out</button>}
                {wallet && <span className="addr" title={wallet.address}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>}
                {!wallet && <button className="primary" onClick={connect}>Connect wallet</button>}
                <PrivyLogin wallet={wallet} onWallet={setWallet} onLogout={() => { setWallet(null); doSignOut(); }} onError={setErr} /> */}
            </header>
            {err && <div className="err" onClick={() => setErr(null)}>{err} ✕</div>}
            {permalink
                ? <ContentPage resourceId={permalink} wallet={wallet} onError={setErr} />
                : storefront
                    ? <Viewer wallet={wallet} onError={setErr} pin={storefront} />
                    : tab === "publish" && !readOnly
                        ? <Publisher wallet={wallet} signedIn={signedIn} onSignIn={doSignIn} onSignOut={doSignOut} onError={setErr} />
                        : <Viewer wallet={wallet} onError={setErr} />}
        </div>
    );
}

// ─── Publisher: open-ended file explorer ──────────────────────────────────────
// Where this publisher's encrypted bytes land: the relay's own access worker and
// R2 bucket, shared by every publisher on it. There is nothing for a publisher to
// set up, nothing to pay for, and no URL to hold in their head.
//
// This replaced bring-your-own-storage, which replaced a Deploy to Cloudflare
// button. BYOS was one paste — a scoped API token the relay spent once to create
// a bucket and worker in the publisher's own account — and it was still the
// single largest thing this app asked of someone before they could sell anything,
// because step one was understanding what R2 is. It comes back as an OPTION.
//
// Where an unregistered address becomes a publisher. Registration is an identity
// on the Fangorn network, not a setting in this app, so it happens there.
const FANGORN_SIGNUP = "https://fangorn.network";

/** A worker URL without the scheme, for display. Total on purpose: `workerUrl` is
 *  absent on anything unpublished, and this used to be called but never defined —
 *  a ReferenceError that only surfaced once the Storage pane stopped hiding
 *  behind the registration branch. */
const host = (u) => { try { return new URL(u).host; } catch { return u || "—"; } };


const DEPLOY_URL =
    "https://deploy.workers.cloudflare.com/?url=https://github.com/fangorn-network/webworker/tree/main/fangorn-access-worker";
// Plain ERC-20 transfer, not the EIP-3009 authorization the buyer flow signs.
// That one exists so a buyer with no gas can pay; a publisher already sends gas
// txs (createResource, commitStateRoot), and a direct transfer needs no
// facilitator, no approve, and leaves no standing allowance on the operator.
const USDC_ABI = parseAbi([
    "function transfer(address to, uint256 value) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
]);

/** Bytes → "1.2 GB". Money uses usdc() above — one formatter for the app. */
const gb = (b) => `${(Number(b ?? 0) / 1024 ** 3).toFixed(1)} GB`;


// The takedown lever. `setDisabled` is the only one that actually holds: the
// access worker refuses to release the DEK for a disabled resource even to a
// buyer who already paid, and it is the ONLY place that can — the registry keeps
// isSettled true forever, because the payment is a historical fact. Deleting the
// staged file (act.remove) does not do this; it drops the listing at the next
// publish and leaves the resource enabled on-chain pointing at bytes that are
// gone. Owner or registry admin only; anyone else's tx reverts.
const TAKEDOWN_ABI = parseAbi([
    "function setDisabled(bytes32 resource_id, bool disabled)",
    "function isDisabled(bytes32 resource_id) view returns (bool)",
]);

function Storage({ wallet, signedIn, reg, onRetryReg, onError }) {
    const [w, setW] = useState(null);
    const [mode, setMode] = useState(null); // null | "token" (provision) | "url" (paste) | "buy"
    const [key, setKey] = useState("");     // Cloudflare API token — provisioning only
    const [url, setUrl] = useState("");
    const [tok, setTok] = useState("");     // only for a worker that pins a token
    const [size, setSize] = useState("");   // GiB to buy
    const [stage, setStage] = useState(""); // which half of a purchase is running
    const [bal, setBal] = useState(null);   // wallet USDC, read from the chain
    const [busy, setBusy] = useState(false);
    const dlg = useRef(null);
    const load = () => api.getWorker().then(setW).catch(() => { });

    // Storage is PER PUBLISHER — their Cloudflare account, their bucket, the key
    // only their worker holds — so this must follow the signed-in wallet, not the
    // component's mount.
    //
    // It used to load once with `[]` deps. Switching wallets left the previous
    // publisher's answer on screen: the bar said "Storage: yours ✓" while the new
    // wallet had none configured, and the mismatch only surfaced as a quota error
    // at publish, naming storage the publisher believed they had already set up.
    // Clearing first matters as much as reloading — a stale ✓ is worse than a
    // blank while it fetches.
    useEffect(() => {
        setW(null); setMode(null);
        if (!signedIn) return; // the relay resolves the owner from the session
        load();
    }, [signedIn, wallet?.address]);

    // `mode` is the source of truth; the dialog follows it. Driving showModal()
    // from an effect rather than the click handler means every path that clears
    // mode — Escape, a finished setup, a wallet switch — closes it too.
    useEffect(() => {
        if (!dlg.current) return;
        if (mode && !dlg.current.open) dlg.current.showModal();
        if (!mode && dlg.current.open) dlg.current.close();
    }, [mode]);

    const open = () => setMode(w?.billing && !w.own ? "buy" : "token");

    // Only while the panel is open, and re-read after every purchase — a stale
    // balance next to a Buy button is worse than no balance at all. Read from the
    // chain rather than from the relay: it's the publisher's own wallet.
    useEffect(() => {
        if (mode !== "buy" || !wallet || !w?.billing) return;
        let live = true;
        publicClient
            .readContract({ address: w.billing.usdc, abi: USDC_ABI, functionName: "balanceOf", args: [wallet.address] })
            .then((v) => { if (live) setBal(v); })
            .catch(() => { if (live) setBal(null); });
        return () => { live = false; };
    }, [mode, wallet?.address, w?.billing?.usdc, w?.spend?.usdc]);

    const setup = async () => {
        if (!key.trim()) return;
        setBusy(true);
        try {
            // TELEMETRY (later): storage_provisioned / storage_provision_failed
            // with e.message. Unlike the old Deploy button, the whole funnel is
            // now observable from this process — no step happens in another tab.
            await finish(api.provisionWorker(key.trim()));
            setKey("");
        } catch (e) {
            onError(e.message);
        } finally {
            setBusy(false);
        }
    };

    /**
     * Carry a connect attempt to an actual, stored connection — or throw.
     *
     * Both entry points funnel through here, and that is not tidiness. The relay
     * answers `needsSignature` and `needsToken` with HTTP 200 and NO manifest
     * write: they mean "one more thing from the publisher", not "done". Setup
     * used to discard the response entirely and provisioning would report success
     * on a worker that was never connected — the pane closed, the button still
     * said Set up, and the next publish failed with a quota message about storage
     * the publisher thought they had just configured.
     *
     * So the rule here is: nothing counts as connected unless the relay says ok.
     */
    const finish = async (attempt) => {
        let res = await attempt;
        // The bucket is claimed by an older token — nearly always this publisher's
        // own, from before an ETH_PRIVATE_KEY rotation. The relay hands back the
        // message to sign; the worker takes the signing wallet as the bucket's
        // owner and rotates the claim. One popup, no wrangler.
        if (res.needsSignature) {
            if (!wallet) throw new Error("Connect your wallet to take back this storage bucket.");
            const signature = await wallet.walletClient.signMessage({ account: wallet.address, message: res.message });
            res = await api.connectWorker(res.workerUrl, tok.trim(), { signature, timestamp: res.timestamp });
            if (res.needsSignature) throw new Error("That bucket belongs to a different wallet.");
        }
        // A worker with a pinned UPLOAD_TOKEN secret. No signature can override it
        // — the value has to be pasted — so send them to the field that takes one
        // rather than failing with nowhere to go.
        if (res.needsToken) {
            setMode("url"); setUrl(res.workerUrl);
            throw new Error(`${res.workerUrl} pins an upload token. Paste that value in the Upload token field and connect again.`);
        }
        if (!res.ok) throw new Error("Storage did not connect — nothing was saved.");
        setMode(null);
        await load();
        return res;
    };

    // Buy allowance on the relay's shared storage: one USDC transfer to the
    // operator, then hand the relay the hash. The publisher's own wallet sends it
    // — no approve, no escrow, no allowance to revoke later — and the relay reads
    // the transfer out of the mined receipt rather than trusting anything here.
    //
    // Prepaid, so a publisher who stops publishing owes nothing and cancels
    // nothing. The bytes they bought stay bought.
    const topUp = async () => {
        const n = Number(size);
        if (!wallet) return onError("Connect your wallet to buy storage.");
        if (!(n > 0)) return;
        setBusy(true);
        try {
            const amount = BigInt(Math.round(n * Number(w.billing.pricePerGb)));
            const hash = await sendTx(wallet.walletClient, {
                account: wallet.address,
                to: w.billing.usdc,
                data: encodeFunctionData({ abi: USDC_ABI, functionName: "transfer", args: [w.billing.address, amount] }),
            });
            // The relay reads a RECEIPT, so it has to be mined before we submit
            // the hash — otherwise every purchase fails with "not on-chain yet"
            // and the publisher is left holding a hash they don't know what to do
            // with. This is the slow part, and it is the publisher's money in
            // flight, so it says so.
            setStage("confirming payment…");
            await publicClient.waitForTransactionReceipt({ hash });
            setStage("crediting…");
            await api.addCredit(hash);
            setSize(""); setMode(null);
            await load();
        } catch (e) {
            // If the transfer landed but crediting failed, the hash is the
            // receipt — it stays redeemable, so surface it rather than swallow it.
            onError(e.message);
        } finally {
            setBusy(false); setStage("");
        }
    };

    const connect = async (value) => {
        const trimmed = (value ?? "").trim();
        if (!trimmed) return;
        setBusy(true);
        try {
            // The relay verifies /pubkey and claims the bucket before storing this,
            // so a typo, a half-deployed worker, or someone else's worker fails HERE
            // rather than silently sealing DEKs to a key nobody holds.
            // TELEMETRY (later): storage_connected.
            await finish(api.connectWorker(trimmed, tok.trim()));
            setUrl(""); setTok("");
        } catch (e) {
            // TELEMETRY (later): storage_connect_failed, with e.message as the
            // reason. The relay's three failures — unreachable, not-an-access-worker,
            // already-claimed — are each a different support answer, so keep them
            // distinguishable rather than collapsing to "failed".
            onError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!w) return null;

    const left = Math.max(0, (w.quota?.limit ?? 0) - (w.quota?.used ?? 0));

    // What the toolbar shows when the modal is shut. Storage is a setup step and
    // a bill, not something a publisher watches — so it stays one button.
    const label = w.own
        ? "Storage: yours ✓"
        : w.quota?.limit ? `Storage: ${gb(w.quota.used)} / ${gb(w.quota.limit)}`
            : w.billing ? "Buy storage" : "Set up storage";

    // Only a registered Fangorn publisher can be given storage. Registration is
    // what makes an address a publisher at all — commitStateRoot reverts without
    // it — so provisioning a bucket for an unregistered wallet builds a place to
    // put files that can never be committed. Signup lives at fangorn.network, not
    // here: it is an identity on the network, not a setting in this app.
    const body = !reg
        ? <p className="dim">Checking your Fangorn registration…</p>
        : reg.error
            ? <>
                <p className="warn">Couldn't check your Fangorn registration: {reg.error}</p>
                <button onClick={onRetryReg}>Try again</button>
            </>
            : !reg.registered
                ? <>
                    <h3>You're not a registered publisher yet</h3>
                    <p className="dim">
                        Storage belongs to a publisher, and <code>{wallet?.address}</code> isn't
                        registered on Fangorn. Sign up there first — it's a one-time on-chain
                        registration — then come back and set up storage.
                    </p>
                    <a className="cta" href={FANGORN_SIGNUP} target="_blank" rel="noopener noreferrer">Sign up at fangorn.network ↗</a>
                </>
                : mode === "buy" && w.billing ? buyBody()
                    : mode === "url" ? urlBody()
                        : tokenBody();

    return (
        <>
            <button className={w.own ? "storage own" : "storage"} onClick={open} title={w.own ? `Your storage: ${w.workerUrl}` : "Set up where your published files are stored"}>
                {label}
            </button>
            {/* Native <dialog>: Escape, focus trapping and the backdrop come from
                the platform. onClose catches the Escape path too, so state can't
                drift out of sync with what's on screen. */}
            <dialog ref={dlg} className="storage-modal" onClose={() => setMode(null)}>
                <header>
                    <b>Storage</b>
                    <button className="ghost" onClick={() => setMode(null)} aria-label="Close">✕</button>
                </header>
                {body}
            </dialog>
        </>
    );

    // ── the three setup bodies ────────────────────────────────────────────────

    function buyBody() {
        const perGb = BigInt(w.billing.pricePerGb);
        const want = Number(size) > 0 ? Number(size) : 0;
        const cost = BigInt(Math.round(want * Number(perGb)));
        // Balance is read straight from the chain, not reported by the relay:
        // it's the publisher's own wallet and the relay has no business being the
        // source of truth for it.
        const short = bal !== null && cost > bal;
        return (
            <>
                <div className="row"><span>Used</span><b>{gb(w.quota?.used)} of {gb(w.quota?.limit)}</b></div>
                <div className="bar"><i style={{ width: `${Math.min(100, ((w.quota?.used ?? 0) / Math.max(1, w.quota?.limit ?? 1)) * 100)}%` }} /></div>
                <div className="row"><span>Remaining</span><b>{gb(left)}</b></div>
                {/* Free vs bought, because they behave differently: the free part
                    can be taken back by the operator, the bought part cannot. */}
                {w.quota?.free > 0 && <div className="row"><span>of which free</span><b>{gb(w.quota.free)}</b></div>}
                <hr />
                <div className="row"><span>Wallet</span><b>{bal === null ? "…" : usdc(bal)}</b></div>
                <div className="row"><span>Spent on storage</span><b>{usdc(w.spend?.usdc ?? 0)}</b></div>
                <hr />
                <label className="row buy">
                    <input
                        type="number" min="0" step="1"
                        value={size}
                        disabled={busy}
                        onChange={(e) => setSize(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") topUp(); }}
                        placeholder="GB"
                        aria-label="Gigabytes of storage to buy"
                    />
                    {/* Charged once, never renewed — so this is the whole cost of
                        those bytes, not a monthly rate. */}
                    <span className="dim">GB × {usdc(perGb)}/GB, one time</span>
                    <b>{want > 0 ? usdc(cost) : ""}</b>
                </label>
                {short && <div className="row warn">Not enough USDC — your wallet holds {usdc(bal)}.</div>}
                <button className="primary" disabled={busy || want <= 0 || short} onClick={topUp}>
                    {busy ? (stage || "Paying…") : "Buy storage"}
                </button>
                {w.spend?.payments?.length > 0 && (
                    <>
                        <hr />
                        {w.spend.payments.slice(0, 5).map((p) => (
                            <div className="row receipt" key={p.hash}>
                                <span>{p.at ? new Date(p.at).toLocaleDateString() : "—"}</span>
                                <span>{gb(p.bytes)}</span>
                                <b>{usdc(p.usdc)}</b>
                            </div>
                        ))}
                    </>
                )}
                <hr />
                <button onClick={() => setMode("token")}>Use my own Cloudflare instead</button>
            </>
        );
    }

    function tokenBody() {
        return (
            <>
                {w.own && <p className="dim">Connected: <code>{w.workerUrl}</code>. Setting up again only affects your NEXT publish — files already published keep the worker baked into their on-chain URI.</p>}
                <p className="dim">Your files go in your own Cloudflare account, on your own R2 bill, sealed to a key only your worker holds. Two steps:</p>
                <a href={w.tokenUrl} target="_blank" rel="noopener noreferrer">1. Create a Cloudflare token ↗</a>
                <input
                    type="password"
                    value={key}
                    disabled={busy}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") setup(); }}
                    placeholder="2. Paste it here"
                    aria-label="Cloudflare API token — used once to create your bucket, never stored"
                />
                <button className="primary" disabled={busy || !key.trim()} onClick={setup}>
                    {busy ? "Setting up…" : "Set up storage"}
                </button>
                <p className="dim">The token is used once and never stored. If you already have a worker it's found and connected — nothing is created twice.</p>
                {/* The escape hatch for an account that doesn't exist yet — see
                    DEPLOY_URL. Cloudflare's wizard signs them up, turns on R2 and
                    picks a subdomain, none of which an API token can do. They come
                    back to THIS field, not to a URL field: provision finds the
                    worker that wizard left behind and connects it, so nobody has to
                    go looking for a workers.dev address. */}
                <a href={DEPLOY_URL} target="_blank" rel="noopener noreferrer">No Cloudflare account? Start here ↗, then come back with a token</a>
                <button onClick={() => { setMode("url"); setUrl(w.own ? w.workerUrl : ""); }}>I already have a worker URL</button>
                {w.billing && <button onClick={() => setMode("buy")}>Or buy storage on this relay</button>}
            </>
        );
    }

    function urlBody() {
        return (
            <>
                <p className="dim">Paste a worker you deployed yourself. This is also the only way onto a worker that pins an UPLOAD_TOKEN, or onto <code>wrangler dev</code> on localhost.</p>
                <input
                    value={url}
                    disabled={busy}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") connect(url); }}
                    placeholder="https://…workers.dev"
                    aria-label="Your access worker URL"
                />
                {/* Blank for every worker this relay provisions. It exists for the
                    one case a signature cannot fix: a worker with an UPLOAD_TOKEN
                    secret, which is Cloudflare account state the bucket knows
                    nothing about — so the value has to be pasted, not derived. */}
                <input
                    value={tok}
                    disabled={busy}
                    onChange={(e) => setTok(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") connect(url); }}
                    placeholder="Upload token (only if your worker pins one)"
                    aria-label="Upload token — leave blank unless your worker pins one"
                />
                <button className="primary" disabled={busy || !url.trim()} onClick={() => connect(url)}>
                    {busy ? "Checking…" : "Connect"}
                </button>
                <button onClick={() => setMode("token")}>Set one up for me instead</button>
            </>
        );
    }
}

function Publisher({ wallet, signedIn, onSignIn, onSignOut, onError }) {
    const [tree, setTree] = useState([]);
    const [owner, setOwner] = useState(null); // for the per-file purchase links
    const [defaultPrice, setDefaultPrice] = useState("1000");
    const [sales, setSales] = useState({}); // resourceId → { paid, revenue }
    const [jobs, setJobs] = useState([]);
    // Fangorn publisher registration. null while in flight; { registered } or
    // { error }. Owned here rather than in Storage because BOTH the Publish
    // button and storage setup are gated on it, and it is an on-chain read worth
    // doing once per publisher instead of once per control.
    const [reg, setReg] = useState(null);
    // The storage gate this relay pins through, from /api/config. The publisher's
    // wallet signs its challenge so the pin bills THEIR fangorn.network quota.
    //
    // THREE states, and they are not interchangeable: `undefined` = /api/config
    // hasn't answered, so we don't know yet; a URL = sign its challenge; `null` =
    // the relay pins with its own Pinata JWT and wants no signature. Collapsing
    // the last two would make a gate-less relay indistinguishable from a failed
    // config fetch and block every publish on a dialog the wallet can't satisfy.
    const [storageGate, setStorageGate] = useState(undefined);
    const [busy, setBusy] = useState(false);
    // Selected path. Everything per-file — price, status, share link, actions —
    // lives in the inspector keyed off this, so a tree row stays one line no
    // matter how much metadata a file accumulates. That's what makes 1000 rows
    // survivable.
    const [sel, setSel] = useState(null);

    // One job per upload/publish, keyed by id. A phase change restarts the clock
    // so the ETA is per-phase (phases have wildly different rates).
    const setJob = (id, patch) => setJobs((js) => {
        const cur = js.find((j) => j.id === id) ?? { id, pct: 0, startedAt: Date.now() };
        const fresh = patch.phase && patch.phase !== cur.phase ? { startedAt: Date.now(), pct: 0 } : {};
        const next = { ...cur, ...fresh, ...patch };
        return js.some((j) => j.id === id) ? js.map((j) => (j.id === id ? next : j)) : [...js, next];
    });

    // A 401 anywhere means the session lapsed; drop back to the sign-in gate
    // rather than leaving a stale tree on screen.
    const fail = (e) => { if (e instanceof UnauthorizedError) onSignOut(); onError(e.message); };

    const load = async () => {
        if (!signedIn) return setTree([]);
        try { const r = await api.getTree(); setTree(r.tree); setOwner(r.owner); setDefaultPrice(r.defaultPrice); } catch (e) { fail(e); }
        // Sales are a getLogs scan and nothing else waits on them — a slow or
        // unreachable RPC leaves the counts blank, it doesn't hide the library.
        api.getSales().then((r) => setSales(r.sales)).catch(() => { });
    };
    // Staging is per-wallet, so the tree is reloaded whenever the session changes
    // — signing in as a different publisher must never show the previous one's.
    const loadReg = () => {
        setReg(null);
        api.getRegistration().then(setReg).catch((e) => setReg({ error: e.message }));
    };
    useEffect(() => { load(); if (signedIn) loadReg(); }, [signedIn]);
    useEffect(() => { api.getConfig().then((c) => setStorageGate(c.storageGate ?? null)).catch(() => { }); }, []);

    /**
     * Prove to the storage gate that this wallet is pinning, so the CAR + commit
     * block land on the publisher's own fangorn.network quota instead of the
     * relay operator's. The relay replays this pair; it never holds the key.
     *
     * The challenge comes from the gate rather than a template copied into this
     * file — it embeds an Issued-At the gate only accepts for ~5 minutes, so it
     * is fetched here, immediately before the commit, and not at publish start.
     */
    const storageAuth = async () => {
        // Direct-Pinata relay: nothing to sign, the relay pays for the pin.
        if (storageGate === null) return null;
        if (!storageGate) throw new Error("relay did not report its storage gate — reload and try again");
        const r = await fetch(storageGate, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: wallet.address, size: 1 }),
        });
        const { challenge } = await r.json().catch(() => ({}));
        if (!challenge) throw new Error("storage gate issued no challenge — it may be down");
        return { message: challenge, signature: await wallet.walletClient.signMessage({ account: wallet.address, message: challenge }) };
    };

    // Every action mutates the fs on the server, then reloads the tree.
    const run = (p) => p.then(load).catch(fail);
    const act = {
        // Select the folder we just made: "new folder, then put things in it" is
        // one gesture, and leaving `sel` on the parent sends the next upload to
        // the wrong place.
        newFolder: (dir) => {
            const name = prompt("Folder name?");
            if (!name) return;
            const path = join(dir, name.trim());
            run(api.newFolder(path).then((r) => { setSel(path); return r; }));
        },
        upload: (dir, file) => {
            const id = `up:${join(dir, file.name)}:${Date.now()}`;
            setJob(id, { name: file.name, phase: "Uploading" });
            api.upload(dir, file.name, file, (pct) => setJob(id, { pct }))
                .then(() => { setJob(id, { pct: 1, phase: "Ready to publish", done: true }); return load(); })
                .catch((e) => { setJob(id, { phase: "Upload failed", done: true, error: true }); fail(e); });
        },
        rename: (node) => { const name = prompt("New name?", node.name); if (name && name !== node.name) run(api.rename(node.path, join(parentOf(node.path), name.trim()))); },
        // An empty folder is just clutter — delete it without ceremony. A folder
        // with files in it names the count, because the server's rmSync is
        // recursive and there is no undo for the staged bytes.
        remove: (node) => {
            let msg = `Remove “${node.name}”?`;
            if (node.type === "folder") {
                const [all, published] = countFiles(node);
                if (all) {
                    msg = `Delete “${node.name}” and all ${all} file(s) in it?`;
                    // Published files keep selling off-chain until the next publish
                    // re-snapshots the library without them, so this is not the
                    // same as taking them off the market.
                    if (published) msg += `\n\n${published} of them are published. Deleting removes the staged copy here; buyers keep what they already paid for, and the listing disappears at your next publish.`;
                }
            }
            if (confirm(msg)) run(api.remove(node.path));
        },
        // Drop target handler. A move is a rename with a different parent, so the
        // server keeps the uid — and thus the resourceId a buyer already paid for.
        move: (from, dir) => {
            const name = from.split("/").pop();
            const to = join(dir, name);
            if (to === from || from === dir || dir.startsWith(`${from}/`)) return;
            if (confirm(`Move “${name}” into ${dir || "the library root"}?`)) run(api.rename(from, to));
        },
        setPrice: (node, price) => run(api.setPrice(node.path, price)),
        setDesc: (node, desc) => { if ((desc ?? "") !== (node.desc ?? "")) run(api.setDesc(node.path, desc)); },
    };

    const publish = async () => {
        if (!signedIn) return onError("Sign in with your wallet first.");
        const id = `publish:${Date.now()}`;
        setBusy(true);
        try {
            // Registration is checked by DISABLING the button, not here — see the
            // toolbar. An unregistered wallet makes commitStateRoot revert at the
            // very END of a publish, after every file has been transcribed,
            // encrypted and uploaded, and the SDK reports it as "the head may have
            // moved on-chain, or the app is unregistered", which points at
            // everything except the real cause. Registering happens at
            // fangorn.network, so there is nothing to do here but refuse.
            if (!reg?.registered) throw new Error("Register as a publisher at https://fangorn.network first.");

            setJob(id, { name: "Publish to Fangorn", phase: "Encrypting & uploading" });
            // No address argument: the relay publishes whatever the SESSION owns.
            const prep = await api.preparePublish((p) => setJob(id, {
                phase: p.phase ?? (p.staging ? "Staging library graph" : "Encrypting & uploading"),
                detail: p.name,
                pct: p.staging ? 1 : p.bytesDone / (p.bytesTotal || 1),
            }));
            let i = 0;
            for (const c of prep.creates) {
                setJob(id, { phase: "Confirming transactions", detail: c.path, pct: i / (prep.creates.length + 1) });
                const h = await sendTx(wallet.walletClient, { to: c.to, data: c.data });
                await publicClient.waitForTransactionReceipt({ hash: h });
                i++;
            }

            // Embed here, in the publisher's browser. The relay has no model, and
            // putting one there would mean every publisher trusting one machine to
            // build the index everyone searches. A model failure must not block a
            // publish — the files still commit, they just rank lexically until the
            // next publish embeds them.
            const vectors = {};
            if (prep.embed?.length) {
                try {
                    const { embedDocuments, packVec } = await import("../llm/embed.js");
                    setJob(id, { phase: "Embedding for search", detail: `0/${prep.embed.length}`, pct: 0 });
                    const vecs = await embedDocuments(prep.embed.map((t) => t.text), (done, total) =>
                        setJob(id, { detail: `${done}/${total}`, pct: done / total }));
                    prep.embed.forEach((t, n) => { vectors[t.id] = packVec(vecs[n]); });
                } catch (e) {
                    console.error("embedding failed — publishing without vectors:", e);
                    setJob(id, { detail: "search embeddings skipped" });
                }
            }

            setJob(id, { phase: "Confirming transactions", detail: "library graph", pct: 0.99 });
            const sealed = await api.commitPublish(vectors, await storageAuth());
            const h = await sendTx(wallet.walletClient, { to: sealed.commitTx.to, data: sealed.commitTx.data });
            await publicClient.waitForTransactionReceipt({ hash: h });
            await api.settlePublish(sealed.published);
            await load();
            const { vertices, edges, embedded } = sealed.staged;
            setJob(id, { phase: `Published — ${vertices} vertices, ${edges} edges, ${embedded} embedded`, detail: null, pct: 1, done: true });
        } catch (e) { fail(e); setJob(id, { phase: "Publish failed", done: true, error: true }); }
        finally { setBusy(false); }
    };

    // Staged uploads are private to the wallet that made them, so the portal is
    // gated on a signature — not on a connection. Connecting only proves which
    // address you'd LIKE to be; signing proves you hold its key.
    if (!wallet) {
        return (
            <main className="publisher">
                <p className="empty">Connect your wallet to stage and publish a library.</p>
            </main>
        );
    }
    if (!signedIn) {
        return (
            <main className="publisher">
                <p className="empty">
                    Your staged uploads are private to <code>{wallet.address}</code>.<br />
                    Sign a message to prove you hold this wallet — no gas, no transaction.
                </p>
                <div className="toolbar"><button className="primary" onClick={onSignIn}>Sign in to publish</button></div>
                {/* The signature IS the agreement — the message says so and the relay
                    keeps it. Saying it here too means nobody can claim the terms were
                    buried in a MetaMask popup they scrolled past. */}
                <p className="empty dim">
                    Signing confirms you own or are licensed to distribute what you publish,
                    and accept the <a href="/terms.html" target="_blank" rel="noreferrer">Publisher Terms</a>.
                </p>
            </main>
        );
    }

    // A rename or delete leaves `sel` pointing at a path that no longer exists;
    // resolve against the live tree every render so the inspector empties itself
    // instead of showing a ghost.
    //
    // NOT findNode(): that one only ever returns sellable files (a search hit or
    // a permalink must never resolve to a folder), so using it here made every
    // folder selection resolve to null — a blank inspector, and no reachable way
    // to upload into a folder at all.
    const selected = sel ? findStudioNode(tree, sel) : null;

    // Where the toolbar's "New folder" and "Upload" land. Selecting a folder
    // makes it the working directory; selecting a file means its folder, since
    // that's the folder you're looking at. Nothing selected → the root. Without
    // this, everything arrives at the top and has to be dragged home.
    const cwd = selected ? (selected.type === "folder" ? selected.path : parentOf(selected.path)) : "";

    return (
        <main className="publisher">
            <div className="toolbar">
                <button onClick={() => act.newFolder(cwd)}>New folder</button>
                <UploadButton label={cwd ? `Upload to ${cwd.split("/").pop()}` : "Upload"} onFile={(f) => act.upload(cwd, f)} />
                {/* Blocked, not failed-on-click. Publishing without registration
                    reverts at commitStateRoot — the very last step, after every
                    file has been transcribed, encrypted and uploaded — so the
                    button refuses up front and says where to fix it. */}
                <button className="primary" disabled={busy || !reg?.registered || !reg?.acceptedTerms} onClick={publish}
                    title={!reg?.acceptedTerms ? "Accept the Publisher Terms first"
                        : reg?.registered ? "" : "Register as a Fangorn publisher first"}>
                    Publish
                </button>
                <Storage wallet={wallet} signedIn={signedIn} reg={reg} onRetryReg={loadReg} onError={onError} />
                <Earnings sales={sales} />
            </div>
            {signedIn && reg && !reg.acceptedTerms && !reg.error && (
                <TermsGate wallet={wallet} terms={reg.terms} onAccepted={loadReg} onError={onError} />
            )}
            {signedIn && reg && reg.acceptedTerms && !reg.registered && !reg.error && (
                <RegisterGate wallet={wallet} reg={reg} owner={owner} onDone={loadReg} onError={onError} />
            )}
            <div className="workbench">
                {/* Click the empty space below the tree to deselect — the file-
                    manager gesture, and the way back to uploading at the root
                    once a folder is selected. The target check keeps a click on
                    a row (which bubbles to here) from clearing it again. */}
                <div className="pane files" {...dropZone("", act.move)}
                    onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
                    {tree.length === 0
                        ? <p className="empty pad">Empty library. Add a folder or upload a file.</p>
                        : <ul className="tree">
                            {tree.map((n) => <Node key={n.path} node={n} sel={sel} onSelect={setSel} onMove={act.move} />)}
                        </ul>}
                </div>
                <Inspector node={selected} act={act} owner={owner} defaultPrice={defaultPrice} sales={sales}
                    wallet={wallet} onError={onError} />
            </div>
            <TransferPanel jobs={jobs} onClose={() => setJobs([])} />
        </main>
    );
}

// Drive-style transfer widget: fixed bottom-right, collapsible, one row per job.
function TransferPanel({ jobs, onClose }) {
    const [open, setOpen] = useState(true);
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
    if (jobs.length === 0) return null;

    const active = jobs.filter((j) => !j.done);
    const title = active.length ? `${active.length} in progress` : `${jobs.length} complete`;
    return (
        <section className="transfers">
            <header onClick={() => setOpen(!open)}>
                <b>{title}</b>
                <div className="spacer" />
                <button className="twist">{open ? "▾" : "▸"}</button>
                <button className="twist" onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
            </header>
            {open && <ul>{jobs.map((j) => <TransferRow key={j.id} job={j} />)}</ul>}
        </section>
    );
}

function TransferRow({ job }) {
    const pct = Math.min(1, Math.max(0, job.pct ?? 0));
    const elapsed = (Date.now() - job.startedAt) / 1000;
    // ponytail: linear extrapolation from the current phase's rate. Good enough
    // for a progress hint; swap for a moving average if it reads too jumpy.
    const eta = !job.done && pct > 0.02 && elapsed > 1 ? (elapsed / pct) * (1 - pct) : null;
    return (
        <li className={job.error ? "error" : job.done ? "done" : ""}>
            <div className="line">
                <span className="tname" title={job.detail ?? job.name}>{job.error ? "⚠️" : job.done ? "✓" : "⬆️"} {job.name}</span>
                <span className="tmeta">{job.done ? job.phase : `${Math.round(pct * 100)}%${eta ? ` · ${fmtEta(eta)} left` : ""}`}</span>
            </div>
            {!job.done && <>
                <div className="bar"><div style={{ width: `${pct * 100}%` }} /></div>
                <div className="tphase">{job.phase}{job.detail ? ` · ${job.detail}` : ""}</div>
            </>}
        </li>
    );
}

const fmtEta = (s) => (s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.ceil(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

// Lifetime take across the whole library. Nothing here until something sells —
// a row of zeros on a brand-new library is just noise.
function Earnings({ sales }) {
    const rows = Object.values(sales);
    const paid = rows.reduce((n, s) => n + s.paid, 0);
    if (!paid) return null;
    const revenue = rows.reduce((n, s) => n + BigInt(s.revenue), 0n);
    return (
        <span className="earnings">
            <b>{usdc(revenue)}</b> earned · {paid} sale{paid === 1 ? "" : "s"}
        </span>
    );
}

// One line per node, and only ever one line — name, a status dot, nothing else.
// Everything actionable moved to the inspector, which is what keeps a deep tree
// scannable and a 1000-file library navigable.
function Node({ node, sel, onSelect, onMove }) {
    const [open, setOpen] = useState(true);
    const on = sel === node.path;
    // Dragging a node anywhere carries its path; the drop target supplies the
    // destination folder. Folders drag too — moving a subtree is one gesture.
    const drag = { draggable: true, onDragStart: (e) => { e.stopPropagation(); e.dataTransfer.setData("text/plain", node.path); e.dataTransfer.effectAllowed = "move"; } };

    if (node.type === "folder") {
        return (
            <li className="node folder" {...drag}>
                <div className={`row${on ? " on" : ""}`} onClick={() => onSelect(node.path)} {...dropZone(node.path, onMove)}>
                    <button className="twist" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
                        aria-label={open ? "collapse" : "expand"}>{open ? "▾" : "▸"}</button>
                    <span className="fname">{node.name}</span>
                    <span className="count">{node.children.length}</span>
                </div>
                {open && node.children.length > 0 && (
                    <ul className="tree">{node.children.map((c) => <Node key={c.path} node={c} sel={sel} onSelect={onSelect} onMove={onMove} />)}</ul>
                )}
            </li>
        );
    }
    return (
        <li className="node video" {...drag}>
            <div className={`row${on ? " on" : ""}`} onClick={() => onSelect(node.path)}>
                <span className="ficon">{iconFor(node.mime)}</span>
                <span className="vname">{node.name}</span>
                <span className={`dot ${node.published ? "pub" : "ready"}`}
                    title={node.published ? "published on-chain" : "staged, not yet published"} />
            </div>
        </li>
    );
}

// Drop props for a destination folder (`""` = library root). Highlights on hover
// via a plain class toggle — no state, so a deep tree doesn't re-render on drag.
function dropZone(dir, onMove) {
    const clear = (e) => e.currentTarget.classList.remove("over");
    return {
        onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("over"); },
        onDragLeave: clear,
        onDrop: (e) => {
            e.preventDefault(); e.stopPropagation(); clear(e);
            const from = e.dataTransfer.getData("text/plain");
            if (from) onMove(from, dir); // no path = an OS file drag, not ours
        },
    };
}

// ─── inspector: everything about ONE selected node ────────────────────────────
function Inspector({ node, act, owner, defaultPrice, sales, wallet, onError }) {
    // Nothing selected is where the whole-library links belong: the storefront
    // link and its embed are about the publisher, not about any one file.
    if (!node) {
        return (
            <aside className="pane inspector blank">
                {owner && <ShareLink label="Your storefront" path={`/s/${owner}`} />}
                <p className="empty">Select a file to see its price, sales and share link.</p>
            </aside>
        );
    }
    const isFolder = node.type === "folder";
    const sold = sales?.[node.published?.resourceId?.toLowerCase()];

    return (
        <aside className="pane inspector">
            <header className="ihead">
                <span className="iglyph">{isFolder ? "📁" : iconFor(node.mime)}</span>
                <div className="ititle">
                    <b title={node.name}>{node.name}</b>
                    <span className="ipath" title={node.path}>{node.path}</span>
                </div>
            </header>

            {isFolder ? (
                <>
                    <Facts rows={[["Items", node.children.length], ["Path", node.path || "/"]]} />
                    <div className="iacts">
                        <button className="mini" onClick={() => act.newFolder(node.path)}>New folder</button>
                        <UploadButton mini label="Upload here" onFile={(f) => act.upload(node.path, f)} />
                        <button className="mini" onClick={() => act.rename(node)}>Rename</button>
                        <button className="mini danger" onClick={() => act.remove(node)}>Delete</button>
                    </div>
                </>
            ) : (
                <>
                    <div className="istatus">
                        <span className={`badge ${node.published ? "pub" : "ready"}`}>{node.published ? "published" : "staged"}</span>
                        {sold?.paid > 0 && <span className="sold">{usdc(sold.revenue)} · {sold.paid} sale{sold.paid === 1 ? "" : "s"}</span>}
                    </div>

                    <label className="ifield">
                        <span>Price <em>USDC base units</em></span>
                        <input className="price" key={node.path} defaultValue={node.price ?? defaultPrice}
                            onBlur={(e) => act.setPrice(node, e.target.value)} />
                    </label>

                    {/* The only semantic content a file with no dialogue has. It's
                        embedded at publish time and is what makes a track findable
                        by what it sounds like rather than what it's named. */}
                    <label className="ifield">
                        <span>Description <em>what a buyer would search for</em></span>
                        <textarea className="desc" key={node.path} rows={3} defaultValue={node.desc ?? ""}
                            placeholder="Deep spanish house, live set, warm analog…"
                            onBlur={(e) => act.setDesc(node, e.target.value)} />
                    </label>

                    <Facts rows={[
                        ["Type", node.mime ?? "—"],
                        ["Size", node.size > 0 ? `${(Number(node.size) / 1e6).toFixed(1)} MB` : "—"],
                        ...(node.chunks > 1 ? [["Chunks", node.chunks]] : []),
                    ]} />

                    {node.published && <ShareLink label="This file" path={pathFor(node.published.resourceId, owner)} />}
                    {node.published && <Takedown resourceId={node.published.resourceId} name={node.name} wallet={wallet} onError={onError} />}

                    <div className="iacts">
                        <UploadButton mini label="Replace" onFile={(f) => act.upload(parentOf(node.path), f)} />
                        <button className="mini" onClick={() => act.rename(node)}>Rename</button>
                        <button className="mini danger" onClick={() => act.remove(node)}>Delete</button>
                    </div>
                </>
            )}
        </aside>
    );
}

const Facts = ({ rows }) => (
    <dl className="facts">
        {rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
    </dl>
);

// The shareable purchase link, and the iframe that carries the same page onto
// someone else's domain. The full URL is ~90 characters of hex and made the tree
// unreadable, so it's shown truncated — nobody reads a resourceId, they copy it.
// The buttons carry the real thing.
//
// The embed is an iframe of THIS origin on purpose, not a script for theirs: the
// purchase needs the same-origin /facilitator proxy (the facilitator sends no
// CORS headers) and the streaming worker's scope "/". Both only exist here.
// No sandbox attribute — it would block the wallet popup Privy logs in with.
function ShareLink({ label, path }) {
    const [copied, setCopied] = useState(null);
    const url = shareOrigin + path;
    // ponytail: fixed height, publishers edit the number. Add postMessage
    // auto-resize if someone actually complains about the scrollbar.
    const snippet = `<iframe src="${url}${path.includes("?") ? "&" : "?"}embed=1" width="100%" height="640" style="border:0" allow="clipboard-write; publickey-credentials-get"></iframe>`;
    const copy = (what, text) => navigator.clipboard.writeText(text).then(() => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1500);
    }, () => { });
    const shown = path.length > 30 ? `${path.slice(0, 11)}…${path.slice(-8)}` : path;
    return (
        <div className="ifield share">
            <span>{label}</span>
            <div className="sharerow">
                <code title={url}>{shown}</code>
                <button className="mini" onClick={() => copy("link", url)}>{copied === "link" ? "✓" : "Link"}</button>
                <button className="mini" onClick={() => copy("embed", snippet)} title="An <iframe> to paste into your own site">
                    {copied === "embed" ? "✓" : "Embed"}
                </button>
                <a className="mini" href={url} target="_blank" rel="noreferrer">Open</a>
            </div>
        </div>
    );
}

/**
 * Registration, sent from the publisher's own wallet.
 *
 * TWO on-chain facts, and the difference is the whole point of this component:
 * `inRegistry` is standing on Fangorn (DataRegistry.register), `joined` is
 * membership of THIS app (AppRegistry.registerForApp). A wallet can have the
 * first and not the second, and it is a common state — anyone registered before
 * this app existed is in it.
 *
 * That case used to render "isn't a registered Fangorn publisher" with a link to
 * fangorn.network: wrong on the facts, and a dead end, because signing up there
 * again does nothing for an app membership. The relay has always prepared the
 * exact transactions (`reg.txs`, withheld until the terms are signed) — nothing
 * sent them. This does.
 */
function RegisterGate({ wallet, reg, owner, onDone, onError }) {
    const [busy, setBusy] = useState(false);
    const txs = reg.txs ?? [];

    const send = async () => {
        setBusy(true);
        try {
            // In order, one receipt at a time: registerForApp reverts for a wallet
            // the data registry has not seen yet, so the second must not be signed
            // before the first has landed.
            for (const tx of txs) {
                const hash = await sendTx(wallet.walletClient, { to: tx.to, data: tx.data, ...(tx.value ? { value: BigInt(tx.value) } : {}) });
                await publicClient.waitForTransactionReceipt({ hash });
            }
            await onDone();
        } catch (e) {
            onError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <p className="notice">
            {reg.inRegistry
                ? <><b>{owner}</b> is a registered Fangorn publisher, but hasn't joined <b>{reg.app}</b> yet,
                    so publishing is unavailable. One transaction{reg.appFee && reg.appFee !== "0" ? ` plus the app fee` : ", gas only"}.</>
                : <><b>{owner}</b> isn't a registered Fangorn publisher yet, so publishing is
                    unavailable. Registration is one-time.</>}
            {" "}
            <button className="primary" disabled={busy || !txs.length} onClick={send}>
                {busy ? "confirming…" : reg.inRegistry ? `Join ${reg.app}` : "Register"}
            </button>{" "}
            <button className="ghost" onClick={onDone}>Re-check</button>
            {!reg.inRegistry && <><br /><span className="dim">
                Or register at <a href={FANGORN_SIGNUP} target="_blank" rel="noopener noreferrer">fangorn.network ↗</a>.
            </span></>}
        </p>
    );
}

/**
 * The terms gate. Stands in front of registration — the moment a wallet becomes
 * a publisher — and in front of publishing, because everyone who registered
 * before this existed would otherwise never be asked.
 *
 * The signature covers the SHA-256 of the terms page, so the record says which
 * version was accepted. The relay withholds the unsigned `register()` tx until
 * this lands, which is what makes it a gate rather than a notice.
 *
 * The checkbox is not the agreement — the signature is. It's here so nobody can
 * say the wallet popup was the first they heard of it.
 */
function TermsGate({ wallet, terms, onAccepted, onError }) {
    const [checked, setChecked] = useState(false);
    const [busy, setBusy] = useState(false);

    const accept = async () => {
        setBusy(true);
        try {
            // Fetched, not rebuilt here: the bytes must be the server's, or the
            // signature verifies against a message it never authored.
            const { message } = await api.getTerms();
            await api.acceptTerms(await wallet.walletClient.signMessage({ account: wallet.address, message }));
            await onAccepted();
        } catch (e) {
            onError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <p className="notice">
            Before publishing, accept the{" "}
            <a href={terms?.url ?? "/terms.html"} target="_blank" rel="noopener noreferrer">Publisher Terms ↗</a>.
            You confirm you own or are licensed to distribute what you publish, and accept takedown on notice.
            <br />
            <label>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{" "}
                I have read and accept the Publisher Terms.
            </label>{" "}
            <button className="primary" disabled={!checked || busy} onClick={accept}>
                {busy ? "signing…" : "Sign to accept"}
            </button>
            {terms?.hash && <><br /><span className="dim">Version {terms.hash.slice(0, 12)}… — one signature, no gas.</span></>}
        </p>
    );
}

/**
 * The kill switch for one published file — the takedown that survives a buyer
 * who already paid (see TAKEDOWN_ABI).
 *
 * Reversible on purpose: a disputed file comes down in one tx while the claim is
 * sorted out, and goes back up in one more. Neither direction touches
 * settlements, so nobody's payment is erased either way — which also means
 * taking something down does NOT refund anyone, and the confirm says so.
 *
 * The read is one eth_call per selection and the state lives here rather than in
 * the tree: the chain is the truth, and the manifest has no field for it.
 */
function Takedown({ resourceId, name, wallet, onError }) {
    const [down, setDown] = useState(null); // null = still reading, or unreadable
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let live = true;
        setDown(null);
        publicClient
            .readContract({ address: CFG.settlementRegistry, abi: TAKEDOWN_ABI, functionName: "isDisabled", args: [resourceId] })
            .then((d) => { if (live) setDown(d); }, () => { });
        return () => { live = false; };
    }, [resourceId]);

    const flip = async () => {
        if (!wallet) return onError("Connect the wallet that published this file.");
        const next = !down;
        if (next && !confirm(
            `Take “${name}” off the market?\n\n` +
            `Nobody can open it after this — including buyers who already paid, whose ` +
            `payments are NOT refunded. New purchases stop too. You can put it back later.`,
        )) return;
        setBusy(true);
        try {
            const hash = await sendTx(wallet.walletClient, {
                account: wallet.address,
                to: CFG.settlementRegistry,
                data: encodeFunctionData({ abi: TAKEDOWN_ABI, functionName: "setDisabled", args: [resourceId, next] }),
            });
            // viem RESOLVES a reverted tx rather than throwing, so an unchecked
            // receipt reports a revert as a successful takedown — the same trap
            // purchase.js documents for settle, and a worse one here: the file
            // would still be selling while the UI said it was down.
            const r = await publicClient.waitForTransactionReceipt({ hash });
            if (r.status !== "success") {
                throw new Error("the registry rejected it — only this resource's owner or the registry admin can change it");
            }
            setDown(next);
        } catch (e) {
            onError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="ifield">
            <span>On-chain status</span>
            <div className="sharerow">
                <code>{down === null ? "…" : down ? "taken down" : "on sale"}</code>
                <button className={down ? "mini" : "mini danger"} disabled={busy || down === null} onClick={flip}>
                    {busy ? "signing…" : down ? "Restore" : "Take down"}
                </button>
            </div>
            <p className="dim">
                {down
                    ? "The access gate is refusing this file to everyone. Restoring costs one signature."
                    : "Blocks every future read, including buyers who already paid. Deleting the file above only removes the listing."}
            </p>
        </div>
    );
}

function UploadButton({ label, onFile, mini }) {
    return (
        <label className={mini ? "mini file" : "file"}>
            {label}
            <input type="file" hidden onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ""; }} />
        </label>
    );
}

// ─── buying + playback, shared by the browse tab and the permalink page ───────
// Both pages do exactly the same thing to a node: pay if needed, decrypt, show
// it, release it. Only the way they *find* the node differs.
// `ctx` carries what the history entry needs beyond the node itself: the row's own
// vector (so the session survives switching apps — see browse.js remember) and which
// app it was opened in. Optional, because the permalink page has neither and a
// remembered open with no vector is still a remembered open.
function useWatch(wallet, onError, ctx = {}) {
    const [open, setOpen] = useState(null); // { node, url, streaming } once decrypted
    const [status, setStatus] = useState(null);
    const [seekTo, setSeekTo] = useState(null);
    // Every remembered open, priced or not. `open` is only ever set once something
    // has been decrypted, so on a catalog of free entries it never changes and the
    // shelves that depend on it never recompute — the session would move and the
    // page would sit still.
    const [opens, setOpens] = useState(0);
    // The history itself, not just a counter: the rating buttons have to render
    // their own state, and reading localStorage from inside every card's render
    // would be a synchronous parse per tile per keystroke.
    const [history, setHistory] = useState(recall);
    const media = React.useRef(null);

    // A streaming URL is served by the service worker and released by dropping the
    // DEK; a blob: URL has to be revoked or the bytes leak for the tab's lifetime.
    const close = () => {
        if (open) {
            if (open.streaming) closeStream(open.node.resourceId);
            else URL.revokeObjectURL(open.url);
        }
        setOpen(null); setSeekTo(null);
    };

    /** Record that this was opened, without starting anything.
     *
     *  Separate from play() because on a free catalog LOOKING at something is the
     *  signal — and routing that through play() meant opening an item page
     *  autoplayed a hundred-megabyte video, so browsing enough to build a session
     *  would start a dozen downloads. */
    // What note() has already recorded, so the effect below doesn't record it
    // twice. play() notes a free row itself and THEN sets `open`, and every one of
    // those double bumps costs a full front-page rebuild.
    const noted = useRef(null);
    const note = (node) => {
        noted.current = node.resourceId ?? nodeKey(node);
        const h = remember(node, ctx.vectors?.get(nodeKey(node)), ctx.app);
        setHistory(h); setOpens((n) => n + 1);
        return h;
    };

    /** The explicit signal. Same store as an open, same counter, so the page has
     *  already moved by the time the button finishes lighting up. */
    const rateNode = (node, sign) => {
        const h = rate(node, ctx.vectors?.get(nodeKey(node)), ctx.app, sign);
        setHistory(h); setOpens((n) => n + 1);
        // The loudest thing a viewer ever says. An agent parked in
        // await-viewer-signal wakes on this — see intent.js.
        emit(sign < 0 ? "dislike" : "like", { item: node.name, id: node.resourceId ?? nodeKey(node) });
        return h;
    };

    const play = async (node, at = null, owner = null) => {
        // A catalog entry is metadata only — the publisher committed its name,
        // description and vector to the graph but never minted a resource or
        // uploaded any ciphertext. There is nothing to pay for and nothing to
        // decrypt, so opening it is a no-op here; the details panel is the whole
        // experience. Remembered anyway, because browsing free entries is the
        // session kernel's only signal on a mostly-free catalog.
        if (!node.resourceId) {
            const h = note(node);
            // Free content whose bytes already have a public URL: there is no
            // resource minted, nothing to decrypt and no worker in the path, so the
            // player gets the URL directly. This is the whole reason an open corpus
            // is watchable without a wallet, a payment or any storage of ours.
            //
            // Only for things a <video>/<audio>/<img> can actually take. An article
            // is a page to read, not a stream — Detail links out to it instead of
            // handing the player a text/html URL it would render as "can't open".
            if (node.url && /^(video|audio|image)\//.test(mimeFor(node) || "")) {
                // `at` matters here as much as on the paid path: a channel joins
                // mid-slot, so a free row that ignored it always restarted from
                // zero no matter how little of the slot was left.
                if (open?.url === node.url) {
                    if (at != null && media.current) media.current.currentTime = at;
                } else {
                    setSeekTo(at);
                    setOpen({ node, url: node.url, streaming: false });
                }
            }
            return h;
        }
        // Free files need no wallet at all: watchEpisode signs /access with an
        // ephemeral key. `node.price` is the catalog's word for it — good enough
        // to decide whether to prompt, while the chain decides what's actually free.
        if (!wallet && !isFree(node)) return onError("Connect your wallet to buy/watch.");
        // Same file already decrypted: just move the playhead, don't re-download.
        if (open?.node.resourceId === node.resourceId) {
            if (at != null && media.current) media.current.currentTime = at;
            return;
        }
        close();
        try {
            setSeekTo(at);
            const r = await watchEpisode({ walletClient: wallet?.walletClient, publicClient, episode: node, onStage: setStatus });
            setOpen({ node, url: r.url, streaming: r.streaming });
            setStatus(null);
        } catch (e) { onError(e.message); setStatus(null); }
    };

    // Recorded HERE rather than in the click handler: `open` is only ever set
    // once the file has actually been paid for and decrypted, so the history
    // means "you own this", which is what the storefront then claims about it.
    // Both the storefront and the permalink page go through this hook, so both
    // feed the same signal.
    // Keyed on the node, not on resourceId: a free row has none, so every free
    // open shared one `undefined` key and only the first ever fired.
    const openKey = open ? (open.node.resourceId ?? nodeKey(open.node)) : null;
    useEffect(() => { if (open && noted.current !== openKey) note(open.node); }, [openKey]);

    return { open, status, play, note, rate: rateNode, history, close, media, seekTo, opens, clearSeek: () => setSeekTo(null) };
}

// One decrypted file, rendered as whatever it turned out to be. Video and audio
// play, an image shows; for a PDF or a zip the browser has nothing to play, so
// the honest answer is the save button — which the header carries either way.
/**
 * Cast to a screen, with no SDK and no proxy.
 *
 * Every row in this catalog is a plain public URL, which is exactly the condition
 * both native paths need — the receiver fetches it itself, so no CORS header is
 * required (and archive.org's mirrors send none; see webmcp.js capture-frame,
 * which is the one thing here that does need them). So casting is two browser
 * APIs and no Google Cast library:
 *
 *   · Remote Playback API — `video.remote.prompt()` opens Chrome/Edge's device
 *     picker and hands the URL to the Chromecast, which fetches it directly. The
 *     laptop stops being in the path at all.
 *   · AirPlay — Safari exposes `webkitShowPlaybackTargetPicker()` for the same
 *     thing, and honours `x-webkit-airplay="allow"` on the element.
 *
 * The button only appears once `watchAvailability()` has actually SEEN a device:
 * a cast button that opens an empty picker is worse than no cast button, and on a
 * machine with nothing to cast to that is what it would be every time.
 *
 * ponytail: no session state, no "now playing on the TV" UI, no volume control.
 * The browser's own picker owns the session. Add a receiver app when we need
 * custom artwork on the TV, which needs a registered Cast application id.
 */
function useCast(mediaRef, url) {
    const [where, setWhere] = useState(null); // null | "remote" | "airplay"
    const [on, setOn] = useState(false);

    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        if (window.WebKitPlaybackTargetAvailabilityEvent) {
            const seen = (e) => setWhere(e.availability === "available" ? "airplay" : null);
            el.addEventListener("webkitplaybacktargetavailabilitychanged", seen);
            return () => el.removeEventListener("webkitplaybacktargetavailabilitychanged", seen);
        }
        if (!el.remote) return;
        let cancel = () => { };
        // watchAvailability rejects when the page isn't allowed to use it (an
        // insecure origin, or disableRemotePlayback) — that is a "no button", not
        // an error worth surfacing.
        el.remote.watchAvailability((available) => setWhere(available ? "remote" : null))
            .then((id) => { cancel = () => el.remote.cancelWatchAvailability(id); }, () => { });
        const conn = () => setOn(el.remote.state === "connected");
        el.addEventListener("connect", conn);
        el.addEventListener("disconnect", conn);
        return () => { cancel(); el.removeEventListener("connect", conn); el.removeEventListener("disconnect", conn); };
    }, [mediaRef, url]);

    const cast = () => {
        const el = mediaRef.current;
        if (!el) return;
        // Both throw on a user-gesture check or a dismissed picker. Neither is a
        // failure worth a banner — the viewer closed a dialog.
        if (where === "airplay") el.webkitShowPlaybackTargetPicker();
        else el.remote?.prompt().catch(() => { });
    };
    return { can: !!where, on, cast, label: where === "airplay" ? "AirPlay" : "Cast" };
}


/**
 * What the agent drew, over and under the picture (webmcp.js `annotate`).
 *
 * The whole point of doing this in the page rather than in a chat window: a
 * scene the agent found is a tick you can click, and a thing it spotted is a box
 * around that thing while it is on screen. Both are read off the SAME element
 * the person is watching — there is no second copy of the video anywhere.
 *
 * ponytail: box coordinates are fractions of the ELEMENT, not of the decoded
 * frame, so a letterboxed file is off by the bars. Divide by the intrinsic
 * aspect when that starts to matter.
 */
function Annotations({ node, mediaRef }) {
    const notes = useAnnotations(node);
    const [t, setT] = useState(0);
    const [dur, setDur] = useState(0);
    useEffect(() => {
        const m = mediaRef.current;
        if (!m) return;
        // timeupdate is ~4Hz, which is the right rate for a playhead and cheap
        // enough that the boxes need no animation frame of their own.
        const tick = () => { setT(m.currentTime); setDur(m.duration || 0); };
        tick();
        m.addEventListener("timeupdate", tick);
        m.addEventListener("loadedmetadata", tick);
        return () => { m.removeEventListener("timeupdate", tick); m.removeEventListener("loadedmetadata", tick); };
    }, [mediaRef.current, notes.for]);

    if (!notes.marks.length && !notes.boxes.length) return null;
    const live = notes.boxes.filter((b) => t >= b.at && t <= b.until);
    const pct = (x) => `${(x * 100).toFixed(2)}%`;
    return (
        <>
            <div className="ann-boxes">
                {live.map((b, i) => (
                    <div key={i} className="ann-box" style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}>
                        {b.label && <span>{b.label}</span>}
                    </div>
                ))}
            </div>
            {!!notes.marks.length && (
                <div className="ann-strip">
                    {dur > 0 && notes.marks.map((m, i) => (
                        <button key={i} className="ann-mark" style={{ left: pct(Math.min(1, m.at / dur)) }}
                            title={`${mmss(m.at)} — ${m.label}`}
                            onClick={() => { mediaRef.current.currentTime = m.at; }}>
                            <span>{m.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

// `bare` is the TV: full-bleed picture, no title bar, no scene deck, because
// that surface draws its own chrome over the video. The cast chip survives —
// "put this on the actual television" is the one control a TV must not lose.
function Media({ node, url, onClose, mediaRef, seekTo, clearSeek, bare }) {
    // mimeFor, not node.mime: a pointer that shrugs (application/octet-stream on
    // an .mp4) would otherwise land in the "can't open this inline" branch and
    // nothing published before the mime table would ever play.
    const mime = mimeFor(node) || "video/mp4";
    // Seek only once the browser knows the duration; setting currentTime before
    // metadata lands is silently ignored.
    const onLoadedMetadata = () => { if (seekTo != null) { mediaRef.current.currentTime = seekTo; clearSeek(); } };
    // `x-webkit-airplay` is what makes the element eligible for AirPlay at all in
    // Safari; it is inert everywhere else.
    const av = {
        ref: mediaRef, src: url, controls: true, autoPlay: true,
        style: { width: "100%" }, onLoadedMetadata, "x-webkit-airplay": "allow",
    };
    const cast = useCast(mediaRef, url);
    const chip = cast.can && (
        <button className={`ghost cast${cast.on ? " on" : ""}`} onClick={cast.cast}
            title={cast.on ? `Playing on another screen — ${cast.label}` : `Play on a TV (${cast.label})`}>
            ⧉ {cast.on ? "casting" : cast.label.toLowerCase()}
        </button>
    );
    if (bare) return (
        <div className="player bare">
            {chip && <div className="bare-cast">{chip}</div>}
            {mime.startsWith("video/")
                ? <div className="ann-stage"><video {...av} /><Annotations node={node} mediaRef={mediaRef} /></div>
                : mime.startsWith("audio/") ? <div className="acover"><CardArt node={node} /><audio {...av} /></div>
                    : mime.startsWith("image/") ? <img src={url} alt={node.name} />
                        : <p className="empty">Decrypted ({mime}) — your browser can’t open this inline.</p>}
        </div>
    );
    return (
        <div className="player">
            <div className="player-head">
                <b>{node.name}</b>
                {/* Only once a device has actually been seen — see useCast. */}
                {chip}
                <a className="ghost" href={url} download={node.name}>⭳ save</a>
                <button className="ghost" onClick={onClose}>✕ close</button>
            </div>
            {mime.startsWith("video/")
                ? <div className="ann-stage"><video {...av} /><Annotations node={node} mediaRef={mediaRef} /></div>
                /* Audio has no picture, and a bare transport bar under a 700px
                   empty box reads as a broken video. The cover goes behind it. */
                : mime.startsWith("audio/") ? <div className="acover"><CardArt node={node} /><audio {...av} /></div>
                    : mime.startsWith("image/") ? <img src={url} alt={node.name} style={{ maxWidth: "100%" }} />
                        : <p className="empty">Decrypted ({mime}) — your browser can’t open this inline, use “save”.</p>}
            {/* What an agent said it saw in THIS film, waiting on the person who
                can publish it. Renders nothing until there is a draft. */}
            <SceneDeck node={node} mediaRef={mediaRef} />
        </div>
    );
}

// Settlement is a few seconds of on-chain nothing. Hold the player's slot with a
// status line and an indeterminate bar, so the wait reads as progress rather
// than as a hung button.
function Splash({ status }) {
    return (
        <div className="player splash" role="status" aria-live="polite">
            <p className="splash-stage">{status}</p>
            <div className="splash-bar" aria-hidden="true"><i /></div>
        </div>
    );
}

// ─── Viewer / storefront ──────────────────────────────────────────────────────
// Two surfaces, never both: a generated front page of shelves, or ONE folder at
// a time with a breadcrumb back. The old viewer drew the publisher's whole tree
// expanded — correct for the person who uploaded it, unusable for anyone else.
// See browse.js for how the shelves are picked.
// `pin` locks the whole page to one publisher — that's the /s/<addr> storefront
// a publisher embeds elsewhere. Everything below is unchanged; it just never
// gets the chance to widen back out to the full catalog.
/**
 * The catalog the expensive derivations run on: the FIRST partial that has
 * anything in it, so there is a page to look at, and then the finished one.
 * Nothing in between.
 *
 * This was a 2s throttle, which was tuned when the catalog was 4,545 files. On
 * the 20,402-file archive one derivation pass is ~4.4s (topics 1.9s + shelves
 * 1.6s + mirror 0.6s + concepts 0.25s), so a 2s window queued the next rebuild
 * before the last had let go of the thread. For the whole 66MB download the main
 * thread never came up for air: no hover, no cursor change, lazy thumbnails never
 * got a layout pass to decide they were visible, and a click sat in the queue for
 * five to ten seconds. Every one of those rebuilds was also thrown away by the
 * next one 250ms later.
 *
 * Once `done`, this tracks `value` again — the type filter has to re-derive.
 *
 * ponytail: two rebuilds per load, not N. If the shelves ever need to grow as the
 * stream arrives, the fix is to move topics()/shelves() to a worker, not to widen
 * a window — the work has to leave the main thread, not arrive at it less often.
 */
// A Map has .size and an array has .length, and `!o.length` on a Map is `!undefined`
// — true forever, so a Map would never actually settle and every partial would land.
const filled = (v) => (v instanceof Map ? v.size : v?.length) > 0;

function useSettled(value, done) {
    const [out, setOut] = useState(value);
    useEffect(() => {
        setOut((o) => (done || !filled(o) ? value : o));
    }, [value, done]);
    return out;
}

function Viewer({ wallet, onError, pin }) {
    const [owner, setOwner] = useState(pin ?? "");
    const [tree, setTree] = useState(null);
    const [loading, setLoading] = useState(null);
    // Whether the catalog on screen is the whole catalog. The front page is derived
    // once from the first partial and once from this — see useSettled.
    const [done, setDone] = useState(false);
    const [vectors, setVectors] = useState(() => new Map());
    const [at, setAt] = useState(null);   // { owner, dir } while drilled in, else the front page
    const [kind, setKind] = useState(null); // "software" | "music" | … — a category filter, not a search
    // "shelves" = the generated front page; "folders" = the publisher's own
    // collections, top level first. Same catalog, two ways of reading it, and the
    // breadcrumb below names whichever one you came in through.
    // "wiki" = the derived wiki, front page first; "folders" = the publisher's own
    // collections. Same catalog, two ways of reading it, and the breadcrumb below
    // names whichever one you came in through.
    // The guide, not the wiki. A schedule that is already running is a better
    // front door than an index you have to read — and the wiki is one menu away.
    const [view, setView] = useState("guide");
    // Which wiki page is open: null = the front page, else one concept or one
    // generated shelf. Two fields rather than a { kind } union because there are
    // two kinds and ListPage takes both.
    const [page, setPage] = useState(null); // { concept } | { shelf } | null
    // An embedded query vector, from typing in the search bar. It pulls the field's
    // attractor toward a coordinate the session has never visited — an impulse, not
    // a filter: nothing is removed from the page, things move.
    // ponytail: nothing reads this while the Field view is out of the nav — the
    // steer path is left wired so putting Field back is one line, not a rebuild.
    const [impulse, setImpulse] = useState(null);
    const [hits, setHits] = useState(null);
    // The item page. Clicking a card no longer spends money — it opens this, and
    // the buy button lives on it. `seek` carries a subtitle hit's timestamp so a
    // line of dialogue still lands on its cue once bought.
    const [detail, setDetail] = useState(null); // { node, seek } | null
    const [gen, setGen] = useState(0); // bumped when the view streams new shards
    // The level ABOVE publisher and folder: which app's view we're reading at all.
    // Each app is a row in the registry namespace pointing at its own quickbeam view
    // (src/apps.js); picking one repoints every reader below via setActiveView.
    // `null` = the relay's default view, which is exactly the old behaviour.
    const [apps, setApps] = useState([]);
    const [app, setApp] = useState(null);
    // `app?.name` and not the whole object: it is stored in localStorage and read
    // back purely as a label — "carried over from Film Archive" — so it wants to be
    // the short string a viewer actually saw in the picker, not the slug.
    const w = useWatch(wallet, onError, { vectors, app: app?.name });
    const status = w.status ?? loading;

    useEffect(() => { if (wallet && !owner && !pin) setOwner(wallet.address); }, [wallet]);

    // No registry configured → no picker, and the viewer is the single-storefront it
    // always was. A registry that won't load is the same: browsing the default view
    // still works, so this must not surface as an error banner over a working page.
    useEffect(() => {
        api.getConfig()
            .then((c) => (c.apps ? listApps(c.apps) : []))
            .then(setApps, () => setApps([]));
    }, []);

    // Switching apps invalidates everything on screen — the tree, the search hits,
    // the publisher filter (an address in app A means nothing in app B) and the item
    // page. `gen` re-runs the catalog and vector effects against the new view.
    const pickApp = (a) => {
        setActiveView(a?.view ?? null);
        setApp(a);
        setAt(null); setDetail(null); setHits(null); setKind(null);
        setOwner(pin ?? ""); scope.current = pin ?? "";
        setGen((n) => n + 1);
    };

    // Everything, from every publisher, with no address typed in. An explicit
    // owner narrows it to one library.
    //
    // The view's shards are the fast path and the default: they already carry every
    // publisher's payment pointers, so browsing costs a few cacheable CDN GETs
    // instead of a chain scan plus an IPFS walk per publisher. The relay is the
    // fallback for the two cases the shards can't cover — nothing baked for this
    // view yet, or the viewer wants live-off-chain state (the ⟳ button).
    //
    // `scope` is what the loaded tree actually covers, which is NOT always `owner`:
    // connecting a wallet sets owner without reloading, so a reload triggered by
    // anything other than a click has to reuse the scope on screen or it silently
    // narrows the page to your own library.
    const scope = useRef(pin ?? "");
    // Which load is current. A partial from a superseded one — the viewer switched
    // app or publisher while 34MB was still arriving — must not paint over the new
    // page, and a stream cannot be cancelled from here.
    const run = useRef(0);
    const load = async (only = owner, { live = false } = {}) => {
        scope.current = only;
        const mine = ++run.current;
        setDone(false);
        // Whatever happens below — a full read, a relay fallback, an empty app, a
        // thrown error — the streaming is over when this returns, and the front page
        // is owed its one real build. A superseded load must not claim that: the
        // newer one is still arriving.
        const loaded = () => { if (run.current === mine) setDone(true); };
        try {
            setLoading(live ? "reading the chain…" : "loading catalog…");
            if (!live) {
                // Paint per shard instead of after the last byte. The catalog is tens
                // of MB and every row carries a thumbnail and a title, so waiting for
                // the whole download meant a blank page for the length of it — with
                // the rows already parsed and sitting in memory. `onTree` hands back
                // the tree rebuilt from everything downloaded so far; search.js
                // throttles it, so this is a repaint every 250ms at worst.
                const { tree: t } = await catalogFromShard({
                    owner: only,
                    onTree: ({ tree: partial }) => {
                        if (run.current !== mine || !partial.length) return;
                        setTree(partial);
                        // The first shard is the end of "loading" as far as anyone
                        // looking at the screen is concerned — there is a page now.
                        setLoading(null);
                    },
                }).catch(() => ({ tree: [] }));
                if (t.length) { setTree(t); setLoading(null); loaded(); return; }
                // The relay fallback below reads THIS relay's own catalog, which has
                // nothing to do with the app you navigated into. Falling through
                // would quietly show app A's library while the picker says app B.
                if (app) { setTree([]); setLoading(null); loaded(); return; }
            }
            const r = only ? await api.getRemote(only) : await api.getCatalog();
            if (run.current !== mine) return; // superseded while the relay answered
            // Belt and braces against a relay older than the tag: we asked for one
            // address, so we know it. Everything below scopes by node.owner.
            setTree(only ? r.tree.map((t) => ({ ...t, owner: t.owner ?? only.toLowerCase() })) : r.tree);
            setLoading(null);
            loaded();
            // An empty catalog with unreadable namespaces isn't "nothing published",
            // it's a broken relay — usually one that can't reach IPFS. Say so.
            if (r.errors?.length) {
                onError(`${r.errors.length} publisher namespace(s) unreadable — ${r.errors[0].error}`);
            }
        } catch (e) { onError(e.message); setLoading(null); loaded(); }
    };
    useEffect(() => { load(scope.current); }, [gen]); // browse before connecting a wallet
    // Vectors are read from the same shards the catalog came from, so this is a
    // Map build over an already-cached download. Empty until something has been
    // embedded — the shelves handle that themselves.
    // Streams alongside the catalog on the same download — see fileVectors. The
    // guard is the same one the tree uses: a map from a superseded load must not
    // land on the current page.
    useEffect(() => {
        const mine = run.current;
        fileVectors(undefined, (m) => { if (run.current === mine) setVectors(m); })
            .then((m) => { if (run.current === mine) setVectors(m); }, () => { });
    }, [gen]);
    // Somebody's publish reaches the view as new shards. The catalog and the
    // shelves' vectors both go stale, and neither is worth making anyone reload the
    // page for — the two effects above re-run off `gen`.
    // Re-subscribes on an app switch: the SSE stream belongs to a view, so holding
    // app A's stream open while reading app B's shards means B never updates.
    useEffect(() => watchShard(() => setGen((n) => n + 1)), [app]);

    const show = (node, seek = null) => {
        // A folded show card is not a file: it carries the shelf it stands for and
        // has no resourceId, and everything below would read it as a free row and
        // start playing episode one. A show opens its own page.
        if (node.shelf) {
            w.close();
            setDetail(null);
            setPage({ shelf: node.shelf });
            window.scrollTo({ top: 0 });
            return;
        }
        w.close();
        setDetail({ node, seek });
        if (node.resourceId) return; // paid: nothing starts until the button is pressed
        // A catalog entry has no resource to mint, so nothing downstream will ever
        // record it. Opening its page IS the open — on a mostly-free catalog it is
        // the only signal the session kernel gets.
        //
        // Free content with a public URL plays on arrival, the way a video page has
        // worked everywhere for fifteen years: no wallet, no payment, no bytes of
        // ours, and the browser only fetches what it needs to start. play() records
        // the open itself, so this is still exactly one history entry.
        //
        // Only for free rows. A paid one must never start settling because you
        // clicked a card — that is somebody's money.
        if (node.url && /^(video|audio|image)\//.test(mimeFor(node) || "")) w.play(node, seek);
        else w.note(node);
    };

    // Typing steers instead of querying: the text is embedded once and handed to
    // the field as an impulse. Stale runs are dropped — the first call downloads the
    // model and would otherwise land on top of a newer one.
    const steerRef = useRef(0);
    const steer = (text) => {
        const gen = ++steerRef.current;
        if (!text.trim()) return setImpulse(null);
        embedQuery(text).then((v) => { if (steerRef.current === gen) setImpulse(v); }, () => { });
    };

    const all = React.useMemo(() => flatten(tree), [tree]);
    // The category filter narrows the file set and everything downstream
    // regenerates from it — shelves, folder counts, publisher counts. That's the
    // whole reason the layout is derived rather than drawn.
    const files = React.useMemo(() => (kind ? all.filter((f) => f.kind === kind) : all), [all, kind]);
    // The wiki: concepts once per catalog, the front page once per session move.
    // Both are pure derivations of what the shard already holds — no model, no
    // fetch, nothing published, and it never leaves this tab.
    // The six derivations below are the expensive ones — concept extraction and
    // k-means over the whole catalog, plus the shelves built on them. Measured on
    // the 20,402-file archive catalog: concepts 250ms, topics 1902ms, shelves
    // 1618ms, mirror 628ms — ~4.4s for one full pass, and `files` changes every
    // 250ms while the shard streams.
    //
    // This was useDeferredValue, which is the wrong tool for it: deferring does not
    // make the work cheaper or asynchronous, it only lowers its priority — and when
    // the input changes faster than the work completes, React keeps restarting the
    // low-priority render and the deferred value never lands. The wiki page held its
    // FIRST value (empty) for the entire download, which is worse than not deferring
    // at all.
    //
    // Coalescing is what was actually wanted: take the first partial immediately, so
    // there are tiles as soon as a shard is in, then at most one rebuild per window
    // — and always one on the last value, so the finished page is never a stale one.
    // 2000 was measured against a 4,545-file catalog. At 20k the pass below is
    // ~4.4s (topics 1.9s + shelves 1.6s + mirror 0.6s + concepts 0.3s), so a fixed
    // 2s window queues the next rebuild before the last has let go of the thread —
    // the main thread stays saturated for the whole 66MB download and every click
    // lands ~10s late. Feed the measured pass back in as the floor.
    // ponytail: a monotonic max, not a decay. The catalog only grows during a load,
    // which is the only time this window is used.
    // Which of the two expensive derivations the page on screen actually draws.
    // Both depend on `w.opens`, so both used to rebuild on every click and every
    // rating — including on an item page, a search result list, the Guide and the
    // Field, none of which render either one. That was ~2.2s per click spent on a
    // page nobody was looking at.
    const onPage = !at && !detail && !hits && !page;
    const wantRows = onPage && (view === "wiki" || view === "folders"); // shelves + Collections
    const wantWiki = onPage && view === "wiki";                        // the wiki index only
    const settled = useSettled(files, done);
    // The vectors, settled the same way the files are — and for a much sharper
    // reason. fileVectors() streams, calling setVectors with a NEW Map on each of
    // ~11 batches, and every derivation below keys off that identity: measured on
    // the 21k-row archive catalog, topics() 200-670ms + mirror() 650ms + the
    // shelves + heading, each rebuilt eleven times, is roughly fifteen seconds of
    // blocked main thread delivered in 1.3-second chunks while the page loads.
    //
    // Streaming still earns its keep — the first non-empty batch renders, so the
    // page is never dead — but the ten rebuilds between that and `done` buy
    // nothing anybody can see. Two computes, not eleven.
    const vecs = useSettled(vectors, done);
    // The session AS IT STOOD when the catalog settled. The front page used to be
    // keyed on the live `w.opens` counter, so every click and every 👍 re-ranked
    // and re-ordered every shelf — the page you were navigating was never the same
    // page twice, and it cost ~2.2s each time. The shelves are a map; a map that
    // redraws itself while you are reading it is not navigable.
    // ponytail: frozen per catalog load. If "the page moves as you walk" comes
    // back, it wants to be an explicit refresh (or a worker), not a dependency.
    const cs = React.useMemo(() => concepts(settled), [settled]);
    // Every show in the catalog, once. A shelf is built out of FILES, so a
    // 96-episode show is 96 of them — which is how a topic row ended up being
    // Johnny Bravo forty times. Rank first, then collapse, so the show keeps the
    // best episode's place in the row (see foldSeries in browse.js).
    const series = React.useMemo(() => seriesShelves(settled), [settled]);
    const sIndex = React.useMemo(() => seriesIndex(series), [series]);
    // "What show is this?", answered in one place. An episode is reached from four
    // different surfaces — a shelf, a search hit, the rail, a channel — and until
    // this existed the only way back UP to the show was to find it again. The
    // shelf is the series page, so climbing is a page change, not a new view.
    const seriesOf = (node) => (node ? sIndex.get(seriesKey(node)) ?? null : null);
    const openSeries = (sh) => {
        w.close(); setTv(null); setDetail(null); setHits(null); setAt(null);
        // The show page only renders under the browse view — the guide, the field
        // and a drilled-in folder each own the whole page. Climbing out of a
        // channel is a change of view as well as of page.
        setView("wiki");
        setPage({ shelf: sh });
        window.scrollTo({ top: 0 });
    };
    // k-means, memoized apart from the field: the drift slider re-runs field() on
    // every tick and must not re-cluster the catalog each time. Declared above the
    // shelves because they are handed this result rather than recomputing it.
    const groups = React.useMemo(() => topics(settled, vecs), [settled, vecs]);
    // The generated rows: the wiki's Browse table lists them, and each is a page.
    // Recomputed on every open so the page has already moved by the time you close
    // the player; `recall()` is a localStorage read of ≤40 rows.
    const rows = React.useMemo(
        // `groups` is handed IN. shelves() falls back to computing topics() itself,
        // and the Viewer already memoizes the same call for the field and the
        // compass — so leaving it out ran k-means over the whole catalog twice per
        // pass: 565ms of the 1.5s, thrown away, every time.
        () => (wantRows ? foldSeries(shelves(settled, recall(), vecs, { groups }), sIndex) : null),
        [settled, vecs, wantRows, sIndex, groups],
    );
    // What the kernel is pointing at next, in words. Same session state and same
    // ranking the shelves above are built from, so the readout cannot disagree with
    // the page it sits on.
    const frozen = React.useMemo(() => session(recall(), vecs), [settled, vecs]);
    // Live, unlike `frozen` — the rail beside the player and the compass are
    // both cheap (one O(n) pass, no clustering) and both exist to react to the
    // thing you just opened.
    const sess = React.useMemo(() => session(recall(), vecs), [vecs, w.opens]);
    const point = React.useMemo(() => heading(sess, settled, vecs), [sess, settled, vecs]);
    const wik = React.useMemo(() => (wantWiki ? mirror(settled, vecs, frozen, recall(), cs) : null), [wantWiki, settled, vecs, frozen, cs]);

    // Clicking a concept is a move, not a filter: the page changes AND the session
    // is steered toward that concept's centroid, so the field below re-forms around
    // where you just walked. This is the whole join between the two halves — the
    // wiki is how you navigate, the kernel is what the walking means.
    // A concept page is about a catalog; swap the catalog (app, publisher, type
    // filter) and the page under you is describing something that is no longer
    // there. Every one of those already clears `at`, so this rides along with it.
    useEffect(() => { setPage(null); }, [app, owner, kind]);

    const goConcept = (c) => {
        setPage({ concept: c });
        setImpulse(centroid(c, vecs));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };
    const level = at ? levelAt(files, at) : null;

    // Tuning: a channel that is a QUERY. lineup() can only ring up groups the
    // catalog already has, and "rainy cyberpunk" is not a folder — so the prompt
    // is embedded and walk.js generates the ring instead. embedQuery is already
    // warm for search, and the vectors are already in the tab for the field and
    // the compass, so the only new state here is the query vector itself.
    //
    // The channel being tuned right now, unsaved. A full spec, not a prompt —
    // it is the thing that gets packed into a link, and the ONE representation
    // avoids a second place where "what makes this channel" is written down.
    const [tune, setTune] = useState(null);
    // A moment channel is not a spec the way a tuned one is: its ring comes out of
    // an ASYNC subtitle search, so it cannot be rebuilt inside the channels memo
    // the way tuned() is. Held whole instead. ponytail: one live cut at a time —
    // give it the specs/saved treatment when a moment channel is worth keeping.
    const [cut, setCut] = useState(null);
    const [tuning, setTuning] = useState(false);
    // The kept ones. Read once; every mutation returns the new list.
    const [specs, setSpecs] = useState(savedChans);
    // Which channel the TV is on, or null for the guide. A channel id, not a
    // channel: the lineup is rebuilt whenever the labels or the vectors move,
    // and holding the object would pin a stale ring on screen.
    const [tv, setTv] = useState(null);
    // `clips` is the viewer's own switch between the two things a mood can mean:
    // every film ABOUT firetrucks, or the forty seconds in each where one is on
    // screen. It was only ever reachable by an agent passing scenes:true, which
    // made the box look like it could not do the thing it is best at.
    const onTune = async (prompt, { clips = false } = {}) => {
        const p = (prompt ?? "").trim();
        if (!p) return setTune(null);
        // tuneTo() clears `tuning` but never raises it — it was only ever called
        // by an agent, which has no spinner to drive. From the box it is the slow
        // path (embed, then a subtitle search over the corpus), so without this
        // the button sits there looking unpressed for several seconds.
        if (clips) {
            setTuning(true);
            try { return (await tuneTo(p, { scenes: true }))?.spec ?? null; }
            catch (e) { onError(e); return null; }
            finally { setTuning(false); }
        }
        setTuning(true);
        try {
            const spec = { id: `ch:${p}`, title: p, seed: p, q: await embedQuery(p) };
            setTune(spec);
            // Retuning from inside the TV switches the set to the new channel.
            // Typing a mood and then having to go find it in the deck is not what
            // the box promises.
            if (tv) setTv(spec.id);
            return spec;
        }
        catch (e) { onError(e); setTune(null); return null; }
        finally { setTuning(false); }
    };

    // A shared channel arrives whole in the fragment — vector, seed and knobs —
    // so this needs no network call and no embedder: someone opening the link
    // is watching the same frame as the person who sent it within the second.
    // See channels.js for why the vector travels packed rather than as a prompt.
    useEffect(() => {
        const spec = unpackChan(location.hash);
        if (spec) { setTune(spec); setView("guide"); setTv(spec.id); return; }
        // A catalog channel names a row in the lineup instead — and the lineup is
        // built from files and genre labels that stream in long after mount, so
        // it cannot be turned to here. Held until it exists; see below.
        const row = unpackRow(location.hash);
        if (row) { setView("guide"); setWant(row); }
    }, []);

    // The row a catalog link named, until the lineup has it — see below, where
    // `channels` exists.
    const [want, setWant] = useState(null);

    // The address bar always holds the channel you are on, so "copy the URL" and
    // "share this channel" are the same gesture. replaceState, not push — surfing
    // is not navigation, and a back button that walked channels backwards would
    // strand you twelve entries deep in your own remote.
    const onSpec = (spec) => { setSpecs(saveChan(spec)); };

    // An agentic browser can ask what is on at any moment, from any view — so
    // where a person only pays for the lineup on the Guide, a tab with an agent
    // in it keeps one built. That is the whole trade: this build is FOR the agent.
    const agent = React.useMemo(
        () => typeof document !== "undefined" && !!document.modelContext?.registerTool, []);

    // An aisle per file, and a ring per aisle. useGenres() is rules-first and only
    // reaches for the in-browser LLM on what the rules miss, so this is free until
    // the Guide is actually opened — and `lineup` is a pure function of the labels.
    // `settled`, not `files`: a ring is `items[now mod total]`, so a catalog that
    // grows by 250ms shards reshuffles what is "on" every time — the grid renders
    // fast and then the episodes churn under you for the whole download. Same two
    // builds the shelves get: the first partial, then the finished catalog.
    const { labels } = useGenres(view === "guide" || tv || agent ? settled : []);

    // A 👎 on the TV is a programming decision, not only a ranking one: the row
    // leaves every ring, so the channel skips past it within the second and keeps
    // going. ponytail: this is why a shared channel diverges from the sender's the
    // moment either of you dislikes something — same catalog, different rings.
    // ponytail: a 👎 lives in the 40-entry session history, so a very long session
    // can age one out and the row comes back. A separate never-air list if that bites.
    const nope = React.useMemo(
        () => new Set(w.history.filter((h) => h.r < 0).map((h) => h.resourceId)), [w.history]);
    const airable = React.useMemo(
        () => (nope.size ? settled.filter((f) => !nope.has(nodeKey(f))) : settled), [settled, nope]);

    const channels = React.useMemo(() => {
        if (view !== "guide" && !tv && !agent) return [];
        const rows = lineup(airable, labels);
        // The live tune first, then the saved ones, deduped — retuning to a mood
        // you have already kept should light up the row you kept, not add a twin.
        const mine = [tune, ...specs].filter(Boolean)
            .filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
        // A tuned channel over a catalog whose vectors have not streamed in yet is
        // an empty row and a dead hero. Ask the block the clock is actually in —
        // block 0 is the epoch's, not now's.
        const at = Math.floor(Date.now() / 1000 / BLOCK);
        const made = mine.map((sp) => tuned(sp, airable, vecs, { number: 0 }))
            .filter((ch) => ch.block(at).items.length);
        // Tuned channels take the low numbers: they are the ones somebody asked
        // for. Renumbered here rather than inside lineup(), which knows nothing
        // about them.
        return [cut, ...made, ...rows].filter(Boolean)
            .map((c, i) => (i === c.number ? c : { ...c, number: i }));
    }, [view, tv, agent, airable, labels, tune, specs, vecs, cut]);

    // The held row, resolved the moment the lineup has it. By id, or by title
    // when it does not — an `aisle:` id is this tab's genre work and the sender's
    // labels may have landed differently, while the name they saw did not.
    useEffect(() => {
        if (!want || !channels.length) return;
        const c = channels.find((x) => x.id === want.id)
            ?? channels.find((x) => x.title === want.title);
        if (c) { setTv(c.id); setWant(null); }
    }, [want, channels]);

    /** Make a channel out of a mood and turn the set to it, in one move.
     *  Returns the built channel so a caller can say what is on without waiting
     *  for React to re-render the lineup. */
    const tuneTo = async (prompt, { blend = 0, like = [], unlike = [], title, scenes = false } = {}) => {
        // A channel from WORDS is the easy half. The half that needs a page is a
        // channel from EVIDENCE: `blend` mixes in the session's own lookahead —
        // built from what this person actually opened, in this tab, and never
        // sent anywhere — and like/unlike pull it toward and away from specific
        // rows the agent watched them react to. That vector does not exist off
        // this machine, so no server MCP can produce this channel.
        //
        // A skipped MOMENT arrives as `owner:path#t=146` — nodeKey's suffix, which
        // is what makes two scenes from one film two things to skip. `vecs` is
        // keyed by file, so that id matches nothing and the unlike silently did
        // nothing at all: the skip loop looked wired and steered by zero. Strip it.
        //
        // ponytail: this steers away from the FILM the moment came from, because a
        // film is the only thing there is a vector for here — fileVectors() keeps
        // file rows only. Skipping one scene therefore pushes away from the whole
        // reel. Build a moment-vector map off the subtitle rows when that is too
        // blunt to be useful.
        const vecOf = (id) => {
            const bare = String(id).split("#t=")[0];
            return vecs.get(id) ?? vecs.get(bare) ?? (() => {
                const f = files.find((x) => (x.resourceId ?? nodeKey(x)) === bare || nodeKey(x) === bare);
                return f ? vecs.get(nodeKey(f)) : null;
            })();
        };
        const pull = (ids, sign) => ids.map(vecOf).filter(Boolean)
            .forEach((v) => v.forEach((x, i) => { acc[i] = (acc[i] ?? 0) + sign * x / ids.length; }));

        let acc = null;
        const base = prompt ? await embedQuery(prompt) : null;
        const look = blend > 0 ? sess?.q : null;
        if (blend > 0 && !look) return null;      // asked to blend a session that has no heading
        if (!base && !look && !like.length) return null;
        const dim = (base ?? look ?? vecOf(like[0]))?.length;
        if (!dim) return null;
        acc = new Array(dim).fill(0);
        if (base) base.forEach((x, i) => { acc[i] += (1 - blend) * x; });
        if (look) look.forEach((x, i) => { acc[i] += blend * x; });
        pull(like, 0.5); pull(unlike, -0.5);
        const q = Float32Array.from(unit(acc));
        const name = title ?? prompt ?? "your drift";

        // A channel of SCENES rather than files. Same vector — blend, like and
        // unlike all still apply, because searchSubtitles takes the embedder as an
        // argument and this hands it the one we just built. So a moment channel is
        // steerable by the session's own heading exactly as a tuned one is, and
        // just as unreproducible off this machine.
        if (scenes) {
            const hits = (await searchSubtitles(prompt ?? name, { limit: 120, embed: async () => q }))
                .filter((h) => h.entityType === "subtitles");
            const spec = { id: `ch:scenes:${name}`, title: name, seed: name, q, scenes: true };
            const chan = moments(hits, { id: spec.id, title: name, seed: name });
            if (!chan.items.length) { setTuning(false); return null; }
            setCut(chan); setTuning(false);
            w.close(); setView("guide"); setTv(spec.id);
            emit("tuned", { title: name, from: "scenes" });
            return { spec, chan };
        }

        const spec = { id: `ch:${name}`, title: name, seed: name, q };
        setTune(spec); setTuning(false);
        w.close(); setView("guide"); setTv(spec.id);
        emit("tuned", { title: name, from: prompt ? "prompt" : "behaviour" });
        return { spec, chan: tuned(spec, files, vecs, { number: 0 }) };
    };

    /** Put an authored run of clips on the set, in the order it was written.
     *
     *  Same seat as a scene channel — `cut` is the one hand-made ring the lineup
     *  carries — but the shots came from somebody's judgment instead of a
     *  subtitle search, so program() keeps their order where moments() shuffles.
     *  Synchronous: the shots arrive already resolved, so there is nothing to
     *  embed and nothing to await. */
    const programTo = (shots, title) => {
        const chan = program(shots, { id: `ch:prog:${title}`, title });
        if (!chan.items.length) return null;
        setCut(chan);
        w.close(); setView("guide"); setTv(chan.id);
        emit("tuned", { title, from: "program" });
        return chan;
    };

    // Search, browse, the live player AND the channels, offered to a
    // browser-resident agent as WebMCP tools. Registered here because this is
    // where the loaded catalog, the wallet and the page's own navigation all
    // live — see webmcp.js. Declared after `channels` because the channel tools
    // read the same lineup the grid draws, not a second copy of it.
    useModelContext({
        files, show, setHits, onError, w, channels, tv, tuneTo, programTo, vectors: vecs,
        // The session kernel itself. This is the thing a server MCP cannot have:
        // it is computed from this person's opens and ratings, in this tab, and
        // read-taste is the tool that hands an agent their heading.
        state: sess, heading: point,
        onWatch: (id) => { w.close(); setView("guide"); setTv(id); emit("channel", { id }); },
        onSave: onSpec, onDrop: (id) => setSpecs(dropChan(id)),
    });

    // Keep the fragment pointing at whatever is on. Everything a channel is
    // lives in it, so the address bar IS the share button.
    useEffect(() => {
        const ch = tv && channels.find((c) => c.id === tv);
        if (ch) history.replaceState(null, "", linkFor(ch));
    }, [tv, channels]);

    // One tile, defined once. wiki.jsx's shelves and guide.jsx's grid both take a
    // `card` render-prop rather than each knowing how a file is drawn — which is
    // why FileCard can carry the rating pair and the price without either of them
    // importing anything from this file.
    const card = (f) => <FileCard key={`${f.owner}/${f.path}`} node={f} onOpen={show} w={w} />;

    // One back button for every page in the viewer. A page IS the combination of
    // view/folder/wiki-page/item/search, so the previous combination is the
    // previous page — see nav.js. Wiring it per call site is what left half of
    // them without one.
    const nav = useBack({ view, at, page, detail, hits }, (s) => {
        setView(s.view); setAt(s.at); setPage(s.page); setDetail(s.detail); setHits(s.hits);
        if (!s.detail) w.close();
    });

    // One publisher per entry, biggest library first. This is the filter people
    // actually want — pasting a 0x address is not browsing, so it lives behind
    // the ⋯ toggle instead of being the first thing on the page.
    const publishers = React.useMemo(() => {
        const n = new Map();
        for (const f of files) n.set(f.owner, (n.get(f.owner) ?? 0) + 1);
        return [...n.entries()].sort((a, b) => b[1] - a[1]);
    }, [files]);

    return (
        <main className="viewer">
            {/* Above search, and outside every branch below: switching apps is the
                one move that is available from wherever you are, and it is the top
                of navigation rather than one more filter. */}
            <AppBar apps={apps} app={app} onApp={pickApp} count={all.length} />

            {/* Typing a category word is a filter, not a query — it resolves
                against the mime table, so it works with no shard baked and no
                embeddings committed. Anything else goes to real search. */}
            <SearchBar hits={hits} setHits={setHits} onError={onError} onSteer={steer}
                onKind={(k) => { setKind(k); setAt(null); setDetail(null); }} />

            {/* Says where it goes. A back button that doesn't is a guess the
                reader has to make twice. */}
            {nav.to && (
                <button className="ghost navback" onClick={nav.back}>← {backLabel(nav.to)}</button>
            )}

            {tv && channels.length ? (
                /* Linear playback owns the whole surface. Everything else here is
                   a browse chrome, and a browse chrome over a running channel is
                   the youtube page we are deliberately not being. */
                <Tv channels={channels} id={tv} w={w}
                    hero={w.open
                        ? <Media {...w.open} bare onClose={w.close} mediaRef={w.media} seekTo={w.seekTo} clearSeek={w.clearSeek} />
                        : w.status ? <Splash status={w.status} /> : null}
                    onChan={(id) => { w.close(); setTv(id); }}
                    onExit={() => { w.close(); setTv(null); }}
                    onDetail={(n) => { setTv(null); show(n); }}
                    seriesOf={seriesOf} onSeries={openSeries}
                    saved={specs} onSave={onSpec} onDrop={(id) => setSpecs(dropChan(id))}
                    onTune={onTune} tuning={tuning} tuned={tune?.title ?? null} />
            ) : detail ? <div className="withrail">
                <div>
                    {/* The player is passed IN as the hero rather than rendered
                        after: it belongs at the top of the item page, above the
                        title, and the alternative was two components both trying
                        to own the first screenful. */}
                    <Detail node={detail.node} w={w} wallet={wallet}
                        show={seriesOf(detail.node)} onShow={openSeries}
                        concepts={cs} onConcept={(c) => { setDetail(null); goConcept(c); }}
                        onBuy={() => w.play(detail.node, detail.seek, detail.node.owner ?? owner)}
                        onBack={() => { w.close(); setDetail(null); }}
                        hero={w.open
                            ? <Media {...w.open} onClose={w.close} mediaRef={w.media} seekTo={w.seekTo} clearSeek={w.clearSeek} />
                            : w.status ? <Splash status={w.status} /> : null} />
                </div>
                {/* Stays put while the player runs — the one place recommendations
                    belong and the one place there was nothing. */}
                <Rail files={files} vectors={vecs} state={sess} point={point} w={w}
                    fold={(items) => foldItems(items, sIndex)} exclude={detail.node} onOpen={(n) => { show(n); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
            </div> : hits ? <Hits hits={hits} tree={tree} onOpen={show} /> : <>
                <Chips
                    view={view} setView={(v) => { setView(v); setAt(null); setPage(null); }}
                    publishers={publishers} owner={owner} setOwner={setOwner} pin={pin}
                    onPick={(a) => { setOwner(a); setAt(null); load(a); }}
                    kinds={kinds(all)} kind={kind} onKind={(k) => { setKind(k); setAt(null); }}
                    onReload={(live) => load(owner, { live })} status={status}
                />
                {at
                    ? <><Compass point={point} app={app} />
                        <Level at={at} level={level} root={ROOT[view] ?? "Home"}
                            onGo={setAt} onOpen={show} w={w} /></>
                    : view === "folders"
                        ? <><Compass point={point} app={app} />
                            <Collections folders={rows?.find((r) => r.id === "folders")?.folders ?? []} onGo={setAt} /></>
                        : view === "guide"
                            ? <><Compass point={point} app={app} />
                                {/* Every cell is computed from Date.now() and the rings,
                                    so the grid needs no schedule fetched and no clock
                                    kept in sync — see channels.js. */}
                                <Guide channels={channels} card={card} onPlay={show}
                                    onTv={(c) => { w.close(); setTv(c.id); }}
                                    onTune={onTune} tuning={tuning} tuned={tune?.title ?? null}
                                    focus={tune && channels.some((c) => c.id === tune.id) ? tune.id : null}
                                    empty="Not enough episodic content here to build channels yet." /></>
                            : page
                                ? <ListPage {...page} concepts={cs} vectors={vecs} price={priceOf}
                                    rate={(n) => <Rate node={n} w={w} small />}
                                    fold={(items) => foldItems(items, sIndex)}
                                    share={page.shelf?.dir ? <ShareLink path={pathFor(page.shelf.dir)} /> : null}
                                    onPlayAll={(items, from = 0) => show(items[from])}
                                    root="Index"
                                    onOpen={show} onConcept={goConcept} onBack={() => setPage(null)} />
                                : <WikiIndex w={wik} files={files} price={priceOf} card={card}
                                    fold={(items) => foldItems(items, sIndex)}
                                    publishers={publishers.length}
                                    point={<Compass point={point} app={app} />}
                                    shelves={(rows ?? []).filter((r) => r.items?.length)}
                                    onOpen={show} onPlay={show} onConcept={goConcept}
                                    onShelf={(sh) => { setPage({ shelf: sh }); window.scrollTo({ top: 0 }); }}
                                    onCollections={() => setView("folders")} />}
                {tree?.length === 0 && <p className="empty">Nothing published here yet.</p>}
            </>}
        </main>
    );
}

const ROOT = { folders: "Collections", guide: "Guide", wiki: "My Account" };

const mb = (n) => `${(Number(n) / 1e6).toFixed(Number(n) < 1e8 ? 1 : 0)} MB`;
// An untagged node is a bug upstream, not a reason to white-screen the whole
// storefront — it shows up as one "unknown" entry instead.
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "unknown");

// The context rail: what you're looking at, who made it, and the escape hatches.
// Everything here changes what the page below is made of, which is why it sits
// above it.
//
// Not pills. Each group is a labelled column of an index — the label says what
// the group changes ("View", "Type", "Publisher"), the words under it are the
// choices, and the accent underline marks the one in force. Pills gave fifteen
// identical capsules with no hint which question each answered.
/** One destination. Closing the menu is done on the element rather than in
 *  state, which is the whole reason there is no state. */
const Nav = ({ to, view, go, children }) => (
    <button className={`menu-go${view === to ? " on" : ""}`}
        onClick={(e) => { e.currentTarget.closest("details").open = false; go(to); }}>
        {children}
    </button>
);

const Pick = ({ on, n, children, ...rest }) => (
    <button className={`fpick${on ? " on" : ""}`} aria-pressed={on} {...rest}>
        {children}{n != null && <sup>{n}</sup>}
    </button>
);
const Group = ({ label, children }) => (
    <div className="fgroup"><span className="flabel">{label}</span>{children}</div>
);

/**
 * Which app you are in — the top of navigation, and its own row.
 *
 * It used to be one group inside the filter bar, next to Type and Publisher, which
 * said the wrong thing: those narrow one catalog and this one REPLACES it, along
 * with the publishers, the collections, the vocabulary and every id on the page.
 * It also disappeared the moment you opened an item, so the one control that says
 * where you are was missing from every page except the front one.
 *
 * Absent when no registry is configured — one app needs no picker.
 */
function AppBar({ apps, app, onApp, count }) {
    if (!apps.length) return null;
    return (
        <nav className="appbar">
            <span className="flabel">App</span>
            <button className={`atab${app ? "" : " on"}`} aria-pressed={!app} onClick={() => onApp(null)}>Home</button>
            {apps.map((a) => (
                <button key={a.id} className={`atab${app?.id === a.id ? " on" : ""}`} aria-pressed={app?.id === a.id}
                    title={a.desc || a.owner} onClick={() => onApp(a)}>
                    {a.name}
                </button>
            ))}
            {/* The count is of what is loaded, so it is also the honest signal that
                a switch actually landed rather than silently serving the old view. */}
            {app && count > 0 && <span className="acount">{count} items</span>}
        </nav>
    );
}

function Chips({ view, setView, publishers, owner, setOwner, onPick, kinds, kind, onKind, onReload, status, pin }) {
    const [adv, setAdv] = useState(false);
    return (
        <div className="filters">
            {/* What it is, before who made it — a buyer knows they want music
                long before they know whose. One entry per category actually
                present; a category nobody published is a dead end, not a filter. */}
            {kinds.length > 1 && (
                <Group label="Type">
                    <Pick on={!kind} onClick={() => onKind(null)}>All</Pick>
                    {kinds.map(([k, n]) => (
                        <Pick key={k} on={kind === k} n={n} onClick={() => onKind(kind === k ? null : k)}>{k}</Pick>
                    ))}
                </Group>
            )}
            {/* A pinned storefront is one publisher by definition — "Everyone" and
                the address box would both walk the buyer off the page they were
                embedded on. */}
            {!pin && (
                <Group label="Publisher">
                    <Pick on={!owner} onClick={() => onPick("")}>Everyone</Pick>
                    {publishers.map(([addr, n]) => (
                        <Pick key={addr} on={owner.toLowerCase() === addr} n={n} title={addr}
                            onClick={() => onPick(addr)}>{short(addr)}</Pick>
                    ))}
                </Group>
            )}
            <div className="spacer" />
            {status && <span className="status">{status}</span>}
            {!pin && <button className="fpick more" onClick={() => setAdv(!adv)} title="Address filter and a live chain read">⋯</button>}
            {/* Where you are is not a filter, so it does not belong in a row of
                them — the guide is the front door and the other two are places
                you go. ponytail: <details> IS the dropdown. No open state, no
                outside-click listener, no portal; Esc closes it because the
                element does that itself. */}
            <details className="menu">
                <summary title="Go somewhere else">☰</summary>
                <div className="menu-pop">
                    <Nav to="guide" view={view} go={setView}>TV Guide</Nav>
                    <Nav to="folders" view={view} go={setView}>Collections</Nav>
                    <Nav to="wiki" view={view} go={setView}>My Account</Nav>
                </div>
            </details>
            {adv && (
                <div className="adv">
                    <input className="owner" placeholder="publisher 0x… not listed above" value={owner}
                        onChange={(e) => setOwner(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") onPick(owner); }} />
                    <button className="mini" disabled={!!owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)} onClick={() => onPick(owner)}>Load</button>
                    <button className="mini" disabled={!!status} onClick={() => onReload(true)}
                        title="Re-read the catalog from the chain instead of the shard — slow, but shows a commit the shard hasn't been rebaked for yet">⟳ live</button>
                </div>
            )}
        </div>
    );
}

/**
 * Where the session is pointing, said out loud.
 *
 * The kernel reorders this page around a 256-d vector nobody can see. Left unsaid
 * that is unsettling rather than useful — the page moves and you cannot tell whether
 * it read you correctly or wandered off. So the direction gets named, in the words
 * the catalog itself uses, and the words come out of the same ranking that reorders
 * the shelves below rather than a separate description of them.
 *
 * Silent until there IS a direction: no opens yet, or a lexical-only view with no
 * vectors, means nothing to report and no row rather than an empty one.
 */
/**
 * The recommendation rail: what the kernel points at, beside what you're doing.
 *
 * It lives on the item page and stays there while the player runs, because that is
 * where a viewer has time to look at something else and where, until now, there was
 * nothing at all — the ranking existed only on the front page and vanished the
 * moment you opened anything.
 *
 * Its header is `heading().terms` — the SAME string the compass shows, generated
 * from the same ranking these rows come from, so the rail cannot claim one thing
 * while listing another. Rows carry their own 👍/👎, so the cheapest place to
 * correct the kernel is the place it is showing you its work.
 */
// `nextup`, not `rail`: `.rail` is already the four-across shelf grid on the front
// page, and an <aside> that picked it up laid its own heading, caption and list out
// as three columns of a grid.
function Rail({ files, vectors, state, point, w, onOpen, exclude, fold = (x) => x }) {
    // Ranked over FILES, so without the fold a rail beside one episode is eleven
    // more of the same show. Rank first, then collapse — same order as the
    // shelves, for the same reason.
    const items = React.useMemo(
        () => fold(rank(files.filter((f) => nodeKey(f) !== nodeKey(exclude ?? {})), state, vectors, 24)).slice(0, 12),
        [files, vectors, state, exclude, fold],
    );
    if (!items.length) return null;
    // Where the vector was BUILT, when that is not where it is being spent. A rail
    // reordered by what you did in another app is the whole point of the thing and
    // also the moment it reads as mind-reading — so name the app out loud.
    const from = [...new Set(w.history.filter((h) => h.v && h.app).map((h) => h.app))];
    return (
        <aside className="nextup">
            <h3>{point?.terms ? `More like ${point.terms}` : "Next"}</h3>
            {from.length > 0 && <p className="rwhy">from what you opened in {from.join(", ")}</p>}
            <ul>
                {items.map((f) => (
                    <li key={nodeKey(f)}>
                        <button className="rrow" onClick={() => onOpen(f)} title={f.path}>
                            <CardArt node={f} />
                            <span className="rtext">
                                <span className="rname">{f.name}</span>
                                <span className="rmeta">{f.path.split("/")[0]}</span>
                            </span>
                        </button>
                        <Rate node={f} w={w} small />
                    </li>
                ))}
            </ul>
        </aside>
    );
}

function Compass({ point, app }) {
    if (!point?.terms) return null;
    return (
        <div className="compass">
            <span className="clabel">{point.moving ? "Heading toward" : "Circling"}</span>
            <span className="cterms">{point.terms}</span>
            {/* Speed is the one number here that is honestly a number: how far the
                recent half of the session sits from the earlier half. */}
            <span className="cdrift" title={`session drift ${point.speed.toFixed(3)}`}
                aria-hidden="true">{"·".repeat(Math.min(5, 1 + Math.round(point.speed * 12)))}</span>
            {app && <span className="cin">in {app.name}</span>}
        </div>
    );
}

// ── every collection, as a grid ───────────────────────────────────────────────
// The folder shelf promoted to a view of its own: the publisher's top-level
// collections, ordered the way the shelf ordered them (what you've opened most,
// then size). Drilling in from here lands in Level, whose first crumb says
// "Collections" — so the way back is the way you came.
function Collections({ folders, onGo }) {
    return (
        <section className="level">
            <nav className="crumbs"><button className="crumb" disabled>Collections</button></nav>
            <div className="grid">
                {folders.map((f) => <FolderCard key={f.key} folder={f} onGo={onGo} />)}
            </div>
            {!folders.length && <p className="empty">No collections here — every file sits at the top level.</p>}
        </section>
    );
}

// ── one folder, and only one ──────────────────────────────────────────────────
function Level({ at, level, root = "Home", onGo, onOpen, w }) {
    const parts = at.dir ? at.dir.split("/") : [];
    return (
        <section className="level">
            <nav className="crumbs">
                <button className="crumb" onClick={() => onGo(null)}>{root}</button>
                {parts.map((p, i) => (
                    <button key={p + i} className="crumb" disabled={i === parts.length - 1}
                        onClick={() => onGo({ owner: at.owner, dir: parts.slice(0, i + 1).join("/") })}>{p}</button>
                ))}
                <span className="crumb-owner" title={at.owner}>{short(at.owner)}</span>
            </nav>
            <div className="grid">
                {level.folders.map((f) => <FolderCard key={f.path} folder={{ ...f, owner: at.owner }} onGo={onGo} />)}
                {level.files.map((n) => <FileCard key={n.path} node={{ ...n, owner: n.owner ?? at.owner }} onOpen={onOpen} w={w} />)}
            </div>
            {!level.folders.length && !level.files.length && <p className="empty">This folder is empty.</p>}
        </section>
    );
}

function FolderCard({ folder, onGo }) {
    return (
        <button className="card folder" onClick={() => onGo({ owner: folder.owner, dir: folder.path })} title={folder.path}>
            <span className="card-art" aria-hidden="true" />
            <span className="card-name">{folder.name}</span>
            <span className="card-meta">{folder.count} file{folder.count === 1 ? "" : "s"}</span>
        </button>
    );
}

// The card is a button, so the rating pair sits OUTSIDE it — a button inside a
// button is invalid HTML and browsers resolve it by dropping one of them.
function FileCard({ node, onOpen, w }) {
    const kind = (node.mime ?? "video/mp4").split("/")[0];
    return (
        <div className="cardwrap">
            <button className="card" data-kind={kind} onClick={() => onOpen(node)} title={node.path}>
                <CardArt node={node} />
                <span className="card-name">{node.name}</span>
                {/* A folded show stands for many files and has no price of its own —
                    "Free entry" on Johnny Bravo is a lie about 40 episodes.
                    No resourceId and no shelf → a catalog entry, which has no price
                    because there is nothing to buy. `usdc(undefined)` renders "NaN USDC". */}
                <span className="card-meta">{node.shelf ? node.why : node.resourceId ? priceLabel(node) : "Free entry"}{node.size > 0 && <em>{mb(node.size)}</em>}</span>
            </button>
            {w && <Rate node={node} w={w} small />}
        </div>
    );
}

// Search the view's shards. Two kinds of hit: a Passage (a line of dialogue —
// plays the file AND drops the playhead on it, the whole point of keeping cue
// timestamps) and a File (name, folders and the publisher's description — the
// only way a track with no dialogue is findable at all).
function SearchBar({ hits, setHits, onError, onKind, onSteer }) {
    const [q, setQ] = useState("");
    const [searching, setSearching] = useState(false);

    // The shards are public and cacheable, so pull them as soon as the viewer
    // opens — the whole front page is built out of them.
    //
    // The EMBEDDER is not warmed here, and that is the point. It is a 131MB ONNX
    // download plus a WASM init, and warming it on page load bought an instant
    // first query at the price of a minute or two of an app that looks broken. It
    // is warmed on focus instead: nothing on first paint needs it, and the gap
    // between reaching for the box and finishing a phrase is the download's to
    // use.
    useEffect(() => {
        loadShard().catch(() => { }); // nothing baked yet → search just stays empty
    }, []);

    const run = async (query, live) => {
        if (!query.trim()) return setHits(null);
        // "software", "music", "photos" — these are categories, and the mime
        // table answers them exactly. Ranking a filename against them with an
        // encoder would be slower and only probably right.
        const k = kindForQuery(query);
        if (k) { setHits(null); setQ(""); return onKind(k); }
        setSearching(true);
        try {
            const hits = await searchSubtitles(query);
            if (!live?.cancelled) setHits(hits);
        }
        catch (err) { onError(`subtitle search: ${err.message}`); }
        finally { setSearching(false); }
    };

    // Typing does not run a search — it steers. Half a second after the last
    // keystroke the text is embedded and handed to the field as an impulse, which
    // pulls the whole layout toward that coordinate instead of replacing the page
    // with a result list. Enter still runs the real search, which is a different
    // question ("find me this line") and deserves the hard cut it gets.
    useEffect(() => {
        const t = setTimeout(() => onSteer?.(q), 500);
        return () => clearTimeout(t);
    }, [q]);

    return (
        <form className="searchbar" onSubmit={(e) => { e.preventDefault(); run(q); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={warmEmbedder}
                placeholder="where do you want to go?" aria-label="Steer, or press enter to search" />
            <button className="primary" type="submit" disabled={searching || !q.trim()}>{searching ? "…" : "Search"}</button>
            {(hits || q) && <button className="ghost" type="button" onClick={() => { setQ(""); setHits(null); }}>✕</button>}
        </form>
    );
}

/**
 * Search results, as a wall of covers rather than a list of lines.
 *
 * Search returns SUBTITLE CUES, so one episode that says the word nine times is
 * nine results — the old list drew all nine as identical rows, and forty of them
 * filled the screen with the same show. The unit a person is looking for is the
 * FILE; the cues are why it matched, and where to start it.
 *
 * So results group by file, and each card carries the moments underneath it:
 * click the cover to open from the top, click a timestamp to land on that line.
 * Nothing is thrown away — the count in the bar is still every cue matched.
 *
 * ponytail: no pagination. searchSubtitles already caps what it returns, and the
 * grid is the same virtualization-free grid the front page uses at 4,545 items.
 */
function Hits({ hits, tree, onOpen }) {
    // The shard row carries its own payment pointer, so a hit is playable with no
    // catalog loaded at all; the catalog lookup is only a fallback for a row baked
    // without one. Grouping itself lives in search.js beside groupHits — it is
    // result shaping, and it has a self-check there.
    const files = React.useMemo(
        () => groupByFile(hits, (h) => h.episode ?? findNode(tree, (n) => n.path === h.videoPath)),
        [hits, tree],
    );

    if (!hits.length) return <p className="empty">Nothing matches that.</p>;

    const cues = hits.filter((h) => h.entityType === "subtitles").length;
    const first = files.find((f) => f.node);

    return (
        <div className="results">
            <div className="hitbar">
                <span className="uplabel">
                    {files.length.toLocaleString()} file{files.length === 1 ? "" : "s"}
                    {cues > 0 && ` · ${cues.toLocaleString()} moment${cues === 1 ? "" : "s"}`}
                </span>
                <div className="spacer" />
                {/* A query is a channel, and this is its play head — the top result
                    from its best moment, which is what "just show me" means. */}
                {first && (
                    <button className="ghost" onClick={() => onOpen(first.node, first.moments[0]?.start ?? 0)}>
                        ▶ Play top result
                    </button>
                )}
            </div>

            <div className="hitgrid">
                {files.map((f) => (
                    <div className="cardwrap hitcard" key={f.key}>
                        <button className="card" data-kind={(mimeFor(f.node ?? {}) || "").split("/")[0]}
                            disabled={!f.node} onClick={() => onOpen(f.node, f.moments[0]?.start ?? 0)}
                            title={f.node ? "Open" : "No payment pointer in this row — it was embedded before the file was published"}>
                            <CardArt node={f.node ?? { name: f.name }} />
                            {/* Why it matched, over the corner of the cover: ≈ is the
                                embedding, ≡ is the literal string. Two symbols beat a
                                legend nobody reads. */}
                            <span className="hitscore" title={f.mode === "semantic" ? "semantic match" : "literal match"}>
                                {f.mode === "semantic" ? "≈" : "≡"} {f.score.toFixed(2)}
                            </span>
                            <span className="card-name">{f.name}</span>
                            {/* The best line, in the card. This is the answer to "why is
                                this here", and it is the reason a cue search beats a
                                filename search — so it should not be a hover title. */}
                            {(f.moments[0]?.text || f.text) && (
                                <span className="hitquote">{f.moments[0] ? `“${f.moments[0].text}”` : f.text}</span>
                            )}
                            <span className="card-meta">
                                {f.node?.resourceId ? priceLabel(f.node) : "Free entry"}
                                {f.node?.size > 0 && <em>{mb(f.node.size)}</em>}
                            </span>
                        </button>

                        {/* Every other place the phrase lands, as a row of play heads.
                            The cover opens from the top; these open from the line. */}
                        {f.moments.length > 1 && (
                            <div className="moments">
                                {f.moments.slice(0, MOMENTS).map((m) => (
                                    <button key={m.id} className="moment" title={`“${m.text}”`}
                                        onClick={() => onOpen(f.node, m.start)} disabled={!f.node}>
                                        {mmss(m.start)}
                                    </button>
                                ))}
                                {f.moments.length > MOMENTS && (
                                    <span className="moment more">+{f.moments.length - MOMENTS}</span>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

// How many timestamps fit under a card before the row wraps into a paragraph.
const MOMENTS = 6;

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ─── the item page ────────────────────────────────────────────────────────────
// Everything the catalog knows about ONE file, and the only buy button in the
// app. Clicking a card used to spend money on the first click; now it lands
// here, so the price, the publisher and what you're actually getting are on
// screen BEFORE a wallet popup appears.
//
// The shard row is the whole source of truth (see search.js) — name, desc,
// price, owner, mime, size, chunk geometry, resourceId, the worker that holds
// the bytes. No extra fetch: the storefront already has all of it in hand, and
// the permalink page resolved it before rendering.
//
// One component, both entry points, so a permalink and a card show the same page.
function Detail({ node, w, wallet, onBuy, onBack, concepts, onConcept, hero, show, onShow }) {
    // nodeKey, NOT resourceId: a free row has none, so `undefined === undefined`
    // said every free item was already open — including before anything was.
    const bought = !!w.open && nodeKey(w.open.node) === nodeKey(node);
    const hex = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
    // A catalog entry: in the graph and in search, but never minted as a resource,
    // so there is no price, no ciphertext and no permalink to a purchase page.
    // Everything below that would describe a purchase is dropped rather than
    // rendered as "—", which would read as "we lost it" instead of "there isn't one".
    const buyable = !!node.resourceId;
    // Free content with a public URL. `open` is the verb, not "buy": nothing is
    // being sold, and a button that says Buy over a public-domain newsreel is a lie
    // about what just happened.
    const openable = !buyable && !!node.url;
    const playable = /^(video|audio|image)\//.test(mimeFor(node) || "");
    // No button over a running player. Free content is already playing by the time
    // this renders, so "Play" beneath it is a control for something that already
    // happened; the player has its own transport.
    const action = buyable
        ? (w.status ?? (bought ? "Opened below" : isFree(node) ? "Download" : wallet ? "Buy & open" : "Connect your wallet to buy"))
        : openable && playable && !bought ? (w.status ?? "Play") : null;

    return (
        <div className="epdetail">
            {onBack && <button className="ghost back" onClick={onBack}>← Back</button>}

            {/* THE PAGE IS THE PLAYER. Everything that used to sit above it — art,
                title, price, publisher — is metadata about the thing you came here
                to watch, and putting metadata first pushed the video below the fold
                on a laptop. Free content is already playing by the time this renders
                (see show() in Viewer): the hero IS the video, not a picture of it.
                A poster with a ▶ over it stands in for the cases that can't be:
                something still settling, something not yet paid for. */}
            {hero ?? (playable && (
                <button className="poster" onClick={onBuy} disabled={!!w.status}
                    aria-label={action ?? "Play"}>
                    <CardArt node={node} />
                    <span className="pplay" aria-hidden="true">▶</span>
                </button>
            ))}

            <div className="dhead">
                {/* Non-playable things (an article, a PDF) keep the old thumbnail
                    beside the title: there is no player for them to be a hero of. */}
                {!playable && <CardArt node={node} />}
                <div>
                    {/* The way up. An episode page that only points sideways (the
                        rail) and backwards (history) makes "the rest of this show"
                        a search — and the show page already exists. */}
                    {show && onShow && (
                        <button className="ghost dup" onClick={() => onShow(show)}>
                            ↑ {show.title} · {show.why}
                        </button>
                    )}
                    <h2>{node.name}</h2>
                    <p className="epprice">
                        {buyable ? priceLabel(node) : "Free"}
                        {node.size > 0 ? ` · ${mb(node.size)}` : ""}
                        {node.year ? ` · ${node.year}` : ""}
                        {node.creator ? ` · ${node.creator}` : ""}
                    </p>
                    <div className="dactions">
                        {action && <button className="primary" onClick={onBuy} disabled={!!w.status || bought}>{action}</button>}
                        {openable && !playable && (
                            <a className="primary" href={node.url} target="_blank" rel="noreferrer noopener">Read →</a>
                        )}
                        {/* The kernel's one explicit input, in the action row rather
                            than a section of its own — this is a control, not a
                            feature to introduce. */}
                        <Rate node={node} w={w} />
                    </div>
                    <p className="empty">
                        {buyable
                            ? (isFree(node) ? "Free — no wallet, no payment." : "Pay once, keep it forever.")
                            : openable
                                ? `Public${node.source ? ` — ${node.source}` : ""}. Streamed straight from the source: `
                                + "no wallet, no payment, and nothing of ours in the path."
                                : "A free catalog entry — listed and searchable, with no file for sale."}
                    </p>
                </div>
            </div>

            {node.desc && <p className="ddesc">{node.desc}</p>}
            {/* The wikilinks out. This is what stops an item page from being the
                end of the walk: every concept on it is a page listing everything
                else that mentions it. Absent on the permalink page, which has no
                catalog loaded to have concepts in. */}
            {concepts && onConcept && <Concepts of={node} concepts={concepts} onConcept={onConcept} />}
            <Facts rows={[
                ["Publisher", <span title={node.owner}>{short(node.owner)}</span>],
                ["Type", mimeFor(node) || "—"],
                ["Folder", parentOf(node.path) || "/"],
                ...(node.creator ? [["Creator", node.creator]] : []),
                ...(openable ? [
                    ["Source", <a href={node.url} target="_blank" rel="noreferrer noopener">{host(node.url)}</a>],
                    ...(node.size > 0 ? [["Size", mb(node.size)]] : []),
                ] : []),
                ...(buyable ? [
                    ["Price", priceLabel(node)],
                    ["Size", node.size > 0 ? mb(node.size) : "—"],
                    ...(node.chunks > 1 ? [["Chunks", `${node.chunks} × ${mb(node.chunkSize)}`]] : []),
                    ["Resource", <span title={node.resourceId}>{hex(node.resourceId)}</span>],
                    ["Storage", <span title={node.workerUrl}>{host(node.workerUrl)}</span>],
                ] : []),
            ]} />
            {buyable && <ShareLink label="Permalink" path={pathFor(node.resourceId, node.owner)} />}
        </div>
    );
}

// ─── /c/<resourceId> — one file, straight to the buy button ───────────────────
// The permalink the publisher hands out. Same purchase as the storefront, minus
// search and browsing: someone arriving here already knows what they want.
function ContentPage({ resourceId, wallet, onError }) {
    const owner = new URLSearchParams(location.search).get("owner");
    const [node, setNode] = useState(undefined); // undefined = still looking, null = no such thing
    const w = useWatch(wallet, onError);

    // The view's shards answer this without a chain read, same as browsing does.
    // The relay stays the fallback for a link to something published since the last
    // bake: ?owner= reads one namespace, without it the whole catalog.
    useEffect(() => {
        catalogFromShard({ owner: owner ?? "" })
            .then((r) => findNode(r.tree, (n) => n.resourceId === resourceId))
            .catch(() => null)
            .then((n) => n ?? (owner ? api.getRemote(owner) : api.getCatalog())
                .then((r) => findNode(r.tree, (x) => x.resourceId === resourceId) ?? null))
            .then(setNode)
            .catch((e) => { onError(e.message); setNode(null); });
    }, [resourceId, owner]);

    if (node === undefined) return <main className="viewer"><p className="empty">Looking this up on-chain…</p></main>;
    if (node === null) {
        return (
            <main className="viewer">
                <p className="empty">
                    Nothing published under this link{owner ? ` by ${owner}` : ""}.<br />
                    It may have been removed from the publisher’s latest commit.
                </p>
            </main>
        );
    }

    return (
        <main className="viewer">
            <Detail node={node} w={w} wallet={wallet} onBuy={() => w.play(node, null, node.owner ?? owner)}
                hero={w.open
                    ? <Media {...w.open} onClose={w.close} mediaRef={w.media} seekTo={w.seekTo} clearSeek={w.clearSeek} />
                    : w.status ? <Splash status={w.status} /> : null} />
        </main>
    );
}

