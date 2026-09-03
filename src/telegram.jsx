// The Telegram Mini App entry: log in with Telegram, get the embedded wallet.
//
// This is the whole zero-custody premise in one screen. The bot's server holds
// no key and never will — the wallet is created and held by Privy, unlocked by
// the Telegram account the person is already logged into, and every signature
// happens in this webview. The server's job shrinks to catalog, search and
// delivery.
//
// The point to verify here is IDENTITY, not signing: the wallet this prints must
// be the same wallet the web app shows for the same person. One Privy user
// reached two ways — sond3r.com and the bot — or the whole "telegram acct ==
// privy acct" idea doesn't hold and the bot is a second, separate account.
//
// Zero-click on purpose. Telegram already knows who this is and Privy reads that
// context, so a "Sign in" button here would be asking a question whose answer is
// already on screen. The button only appears if the automatic attempt fails.
//
// With `?buy=<resourceId>` it also buys that one file. The bot ranks and hands
// over a resourceId; the person signs here. Nothing new is implemented for it —
// watchEpisode() (src/pay/purchase.js) is the same call the web app's Watch tab
// makes, and walletFromProvider() takes Privy's provider the same way it takes
// MetaMask's. Buyers need no gas: only a signMessage and an EIP-3009
// authorization, both submitted by the facilitator.
//
// ponytail: no router, no state library, no design system — one component that
// prints four facts. This is a spike whose job is to answer a question.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePrivy, useLoginWithTelegram, useWallets, useSigners } from "@privy-io/react-auth";
import { PrivyRoot, privyEnabled } from "./ui/privy.jsx";
import { publicClient, walletFromProvider, signIn } from "./pay/wallet.js";
import { watchEpisode } from "./pay/purchase.js";
import { mimeFor } from "./catalog/browse.js";
import { api as relay, UnauthorizedError } from "./catalog/api.js";
import { parseAbi } from "viem";

/** Only the read. A publisher who wants to move money does it in the web app. */
const USDC_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const usdc = (v) => `${Number(v ?? 0) / 1e6} USDC`;

/** Telegram's own webview object. Absent when this page is opened in a normal
 *  browser tab, which is a useful thing to say out loud rather than crash on. */
const tg = () => window.Telegram?.WebApp;

/** What the bot asked for, if anything. Absent → this is just the wallet screen. */
const wanted = new URLSearchParams(location.search).get("buy");

/**
 * The key quorum the bot signs with — the dashboard's authorization key, whose
 * private half is PRIVY_AUTHORIZATION_KEY in the bot's env. An id, not a secret.
 *
 * Written as a literal so vite inlines it; see requireInlinedEnv in vite.config.js.
 */
const SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID ?? "";

/**
 * Nothing behind a spinner may wait forever.
 *
 * The first version of this screen called delegateWallet(), which on this app
 * hangs rather than throws: `mode: user-controlled-server-wallets-only` has no
 * on-device wallet proxy for it to talk to, so the await never settled and the
 * button spun until the app was closed. A stall now has to name itself.
 */
const within = (ms, promise, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} didn't answer within ${ms / 1000}s — close the app fully and reopen it from the bot. If it keeps happening, Privy is not reachable from here.`)), ms)),
]);

/** The bot's own API, authenticated by the initData Telegram signed. Named apart
 *  from the relay client imported above, which speaks to a different server. */
async function botApi(path, body) {
    const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "X-Init-Data": tg()?.initData ?? "", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
}

/**
 * Buy one file and show it.
 *
 * The purchase runs ONCE per mount — `ran` rather than a state flag, because two
 * StrictMode renders would otherwise mean two register calls, and the second
 * reverts as AlreadyRegistered halfway through someone's payment.
 */
function Buy({ resourceId, wallet, onBack }) {
    const [stage, setStage] = useState("fetching the pointer…");
    const [item, setItem] = useState(null);
    const [media, setMedia] = useState(null);
    const [error, setError] = useState(null);
    const ran = useRef(false);

    useEffect(() => {
        if (!wallet || ran.current) return;
        ran.current = true;
        (async () => {
            try {
                const pointer = await botApi(`/api/item?id=${encodeURIComponent(resourceId)}`);
                setItem(pointer);
                setStage("opening your wallet…");
                const { walletClient } = await walletFromProvider(await wallet.getEthereumProvider(), wallet.address);
                const { url } = await watchEpisode({ walletClient, publicClient, episode: pointer, onStage: setStage });
                setMedia({ url, mime: mimeFor(pointer) });
                setStage("");
                tg()?.HapticFeedback?.notificationOccurred("success");
                // Taste, for the next ranking. Best-effort: the file is already
                // decrypted and on screen, and a failed log is not a failed buy.
                botApi("/api/delivered", { resourceId }).catch(() => {});
            } catch (e) {
                setError(e.message);
                tg()?.HapticFeedback?.notificationOccurred("error");
            }
        })();
    }, [wallet]);

    // Nothing is revoked on unmount: closing a Telegram webview tears the whole
    // page down, and revoking early is how you get a video that stops mid-play.

    return (
        <main style={S.main}>
            <h1 style={S.h1}>{item?.name ?? "buying"}</h1>
            {onBack && <button style={{ ...S.button, ...S.ghost, marginTop: 0, marginBottom: 14 }} onClick={onBack}>← back</button>}
            {item && <Row label="price" value={`${Number(item.price) / 1e6} USDC`} />}
            {error ? <Note title="didn't go through">{error}</Note>
                : media ? <Media {...media} name={item?.name} />
                    : <p style={S.foot}>{stage}</p>}
            {media && <p style={S.foot}>Paid once, yours forever — reopening this file costs nothing.</p>}
        </main>
    );
}

/** Whatever it turned out to be. An unknown type is a download, not a failure. */
const Media = ({ url, mime, name }) => {
    const style = { width: "100%", marginTop: 14, borderRadius: 10 };
    if (mime.startsWith("image/")) return <img src={url} alt={name} style={style} />;
    if (mime.startsWith("video/")) return <video src={url} controls autoPlay playsInline style={style} />;
    if (mime.startsWith("audio/")) return <audio src={url} controls style={{ ...style, borderRadius: 0 }} />;
    return <a href={url} download={name} style={{ ...S.button, display: "block", textAlign: "center", textDecoration: "none" }}>save {name}</a>;
};

/**
 * What this Telegram account has bought.
 *
 * Ownership is read from the bot's own record (the KV taste log, written by
 * /api/delivered), not from the chain. It is therefore the list of what was
 * bought THROUGH here — a file bought from some other client with the same
 * wallet is still decryptable, it just doesn't show up on this shelf.
 * ponytail: chain-derived ownership is a MemberRegistered scan per stealth
 * identity; add it when the shelf being incomplete actually bites someone.
 */
function Library({ wallet }) {
    const [state, setState] = useState(null);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(null);

    useEffect(() => { botApi("/api/state").then(setState).catch((e) => setError(e.message)); }, []);

    if (open) return <Buy resourceId={open} wallet={wallet} onBack={() => setOpen(null)} />;
    if (error) return <Note title="couldn't read your library">{error}</Note>;
    if (!state) return <p style={S.foot}>loading…</p>;

    const owned = new Set(state.owned ?? []);
    const mine = (state.items ?? []).filter((i) => owned.has(i.path));
    if (!mine.length) {
        return (
            <>
                <p style={S.foot}>Nothing here yet. Ask the bot for something in the chat — "movies", "something spacey" — and what you buy lands here.</p>
                <p style={S.foot}>{state.items?.length ?? 0} file(s) for sale right now.</p>
            </>
        );
    }
    return (
        <>
            {mine.map((i) => (
                <button key={i.resourceId} style={S.item} onClick={() => setOpen(i.resourceId)}>
                    <span style={{ ...S.grow, textAlign: "left" }}>{i.path}</span>
                    <span style={{ opacity: .5 }}>{i.mime ?? ""}</span>
                </button>
            ))}
            <p style={S.foot}>Paid once, yours forever — opening these again costs nothing.</p>
        </>
    );
}

/**
 * Balance and earnings.
 *
 * Earnings come from the relay, which needs a wallet signature for a session —
 * one tap, no gas. Not automatic: it is a signature prompt, and firing one at
 * someone who opened a tab to look at their balance is how an app teaches people
 * to approve things without reading them.
 */
function Publisher({ wallet }) {
    const [config, setConfig] = useState(null);
    const [balance, setBalance] = useState(null);
    const [sales, setSales] = useState(null);
    const [tree, setTree] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => { relay.getConfig().then(setConfig).catch((e) => setError(e.message)); }, []);

    // Straight from the chain, like the web app does it: it is the publisher's
    // own wallet, and a balance that lags a payout reads as a lost payout.
    useEffect(() => {
        const token = config?.usdc ?? import.meta.env.VITE_USDC_CONTRACT_ADDR;
        if (!token || !wallet) return;
        let live = true;
        publicClient.readContract({ address: token, abi: USDC_ABI, functionName: "balanceOf", args: [wallet.address] })
            .then((v) => live && setBalance(v))
            .catch(() => live && setBalance(null));
        return () => { live = false; };
    }, [config?.usdc, wallet?.address]);

    const load = async () => {
        setBusy(true);
        setError(null);
        try {
            const { walletClient } = await walletFromProvider(await wallet.getEthereumProvider(), wallet.address);
            await signIn(walletClient, wallet.address);
            const [{ sales: s }, { tree: t }] = await Promise.all([relay.getSales(), relay.getTree()]);
            setSales(s);
            setTree(t);
        } catch (e) {
            setError(e instanceof UnauthorizedError ? "that signature didn't open a session — try again" : e.message);
        } finally {
            setBusy(false);
        }
    };

    // Names for the resource ids /api/sales is keyed by. Without the tree the
    // numbers are right and unreadable — "0x8f3a… earned 2 USDC" tells nobody
    // which of their files is the one people want.
    const named = [];
    const walk = (nodes, prefix = "") => {
        for (const n of nodes ?? []) {
            const path = prefix ? `${prefix}/${n.name}` : n.name;
            const id = n.published?.resourceId?.toLowerCase();
            if (id && sales?.[id]) named.push({ path, ...sales[id] });
            walk(n.children, path);
        }
    };
    walk(tree);
    const earned = named.reduce((sum, r) => sum + BigInt(r.revenue ?? 0), 0n);

    return (
        <>
            <Row label="address" value={wallet?.address ?? "—"} mono />
            <Row label="balance" value={balance === null ? "—" : usdc(balance.toString())} />
            {sales && <Row label="earned" value={usdc(earned.toString())} />}
            {error && <Note title="couldn't load earnings">{error}</Note>}

            {config?.readOnly && !sales && (
                <Note title="this storefront is read-only">
                    {config ? "It serves the catalog but keeps no publisher library, so there are no earnings to show here. Point the bot at your own relay to sell." : ""}
                </Note>
            )}
            {!sales && !config?.readOnly && (
                <button style={S.button} disabled={busy || !wallet} onClick={load}>
                    {busy ? "…" : "Sign in to see earnings"}
                </button>
            )}
            {sales && !named.length && <p style={S.foot}>Nothing sold yet. Publish a file with a price and it shows up here the first time somebody pays for it.</p>}
            {named.map((r) => (
                <Row key={r.path} label={r.path} value={`${r.paid} sold · ${usdc(r.revenue)}`} />
            ))}
        </>
    );
}

function Wallet() {
    const { ready, authenticated, user } = usePrivy();
    const { wallets } = useWallets();
    // `state` reports the flow; the login itself is fired once below.
    const { login, state } = useLoginWithTelegram();
    // Session signers, NOT useDelegatedActions(). This app runs Privy's
    // user-controlled-server-wallets stack, and delegateWallet() is on-device
    // only — the SDK says so itself in the error it throws for TEE wallets, and
    // on this stack it doesn't even get that far: it stalls on a wallet proxy
    // that isn't there. addSigners() is the headless equivalent and the one that
    // matches what the server already does, because a session signer IS what
    // PRIVY_AUTHORIZATION_KEY authorizes.
    //
    // Still never automatic: it is the one control here that hands a capability
    // to a server, so it costs a deliberate tap.
    const { addSigners, removeSigners } = useSigners();
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [tried, setTried] = useState(false);

    // Tell Telegram the page is up — without this the webview can sit on its
    // loading placeholder over a page that has already rendered.
    useEffect(() => { tg()?.ready(); tg()?.expand(); }, []);

    useEffect(() => {
        if (!ready || authenticated || tried) return;
        setTried(true);
        // Privy picks the Telegram context up from the webview itself; there is
        // no initData to pass in by hand.
        login().catch((e) => setError(e.message));
    }, [ready, authenticated, tried]);

    // The embedded wallet specifically — someone who linked an external wallet
    // to the same Privy account still signs here with the embedded one, because
    // an extension does not exist inside Telegram's browser.
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    const telegramAccount = user?.linkedAccounts?.find((a) => a.type === "telegram");
    // Straight off the Privy user, not off local state — the bot reads the same
    // flag server-side, and a screen that disagrees with what the bot can
    // actually do is worse than no screen.
    // `granted` starts from what Privy says and is corrected by what we just did:
    // addSigners resolves before the user object has caught up, and a row that
    // still says "off" after a successful grant reads as a failure.
    const delegated = user?.linkedAccounts?.some((a) => a.type === "wallet" && a.delegated);
    const [granted, setGranted] = useState(null);
    const [tab, setTab] = useState("library");
    const on = granted ?? !!delegated;

    const toggleDelegation = async () => {
        setBusy(true);
        setError(null);
        try {
            if (on) {
                await within(30_000, removeSigners({ address: embedded.address }), "revoking");
                setGranted(false);
            } else {
                await within(30_000, addSigners({ address: embedded.address, signers: [{ signerId: SIGNER_ID }] }), "granting access");
                setGranted(true);
            }
        } catch (e) {
            // A declined prompt is an answer, not a fault, and should not paint
            // the screen red.
            if (!/reject|cancel|decline|denied/i.test(e.message ?? "")) setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!privyEnabled) return <Note title="VITE_PRIVY_APP_ID is not set">This build has no Privy app id compiled in, so there is nothing to log into.</Note>;
    if (!ready) return <Note title="starting Privy…" />;
    // The login above is automatic, so this is a loading state, not a dead end —
    // the sign-in button below appears only if it actually failed.
    if (wanted && embedded) return <Buy resourceId={wanted} wallet={embedded} />;
    if (wanted && !error) return <main style={S.main}><h1 style={S.h1}>buying</h1><p style={S.foot}>{authenticated ? "creating your wallet…" : "signing in with Telegram…"}</p></main>;

    // The whole screen, when the bot didn't ask for one specific file. Three
    // things a person opens this for: what they own, what they can spend, what
    // they've earned. `tab` is a string, not a router — there are three of them.
    return (
        <main style={S.main}>
            <nav style={S.tabs}>
                {["library", "wallet", "publisher"].map((t) => (
                    <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabOn : null) }} onClick={() => setTab(t)}>{t}</button>
                ))}
            </nav>
            {tab === "library" && <Library wallet={embedded} />}
            {tab === "publisher" && <Publisher wallet={embedded} />}
            {tab === "wallet" && <WalletTab {...{ user, embedded, telegramAccount, state, on, busy, error, toggleDelegation, ready, authenticated, login, setError }} />}
        </main>
    );
}

function WalletTab({ user, embedded, telegramAccount, state, on, busy, error, toggleDelegation, ready, authenticated, login, setError }) {
    return (
        <>
            <Row label="telegram" value={tg()?.initDataUnsafe?.user?.username ? `@${tg().initDataUnsafe.user.username}` : tg()?.initDataUnsafe?.user?.id ?? "— not in a Telegram webview"} />
            <Row label="privy user" value={user?.id ?? "—"} />
            <Row label="linked telegram" value={telegramAccount ? (telegramAccount.username ?? telegramAccount.telegramUserId ?? "linked") : "—"} />
            <Row label="address" value={embedded?.address ?? (authenticated ? "creating…" : "—")} mono />
            <Row label="buying from the chat" value={on ? "on" : "off"} />
            <Row label="login state" value={state?.status ?? (authenticated ? "done" : "…")} />

            {error && <Note title="login failed">{error}</Note>}
            {/* Only when the automatic attempt didn't take. */}
            {ready && !authenticated && (
                <button style={S.button} onClick={() => login().catch((e) => setError(e.message))}>
                    Sign in with Telegram
                </button>
            )}
            {embedded && !SIGNER_ID && <Note title="one-tap buying is not configured">This build has no VITE_PRIVY_SIGNER_ID compiled in, so there is no key quorum to grant access to. Buying inside this app still works.</Note>}
            {embedded && SIGNER_ID && (
                <button style={on ? { ...S.button, ...S.ghost } : S.button} disabled={busy} onClick={toggleDelegation}>
                    {busy ? "…" : on ? "Stop letting the bot buy for me" : "Enable one-tap buying"}
                </button>
            )}
            {embedded && (
                <p style={S.foot}>
                    This address is held by Privy and unlocked by your Telegram account. The bot's
                    server never sees its key.{" "}
                    {on
                        ? "You've allowed it to sign purchases for you, so BUY buttons in the chat work. Revoking takes effect immediately."
                        : "Until you turn on one-tap buying, BUY buttons in the chat have nothing to sign with — you can still buy right here."}
                </p>
            )}
        </>
    );
}

const Row = ({ label, value, mono }) => (
    <div style={S.row}>
        <span style={S.label}>{label}</span>
        <span style={{ ...S.value, ...(mono ? S.mono : null) }}>{value}</span>
    </div>
);

const Note = ({ title, children }) => (
    <div style={S.note}>
        <strong>{title}</strong>
        {children ? <div style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
);

// Telegram's own theme variables, so the page is dark when the client is dark.
// A page shipping its own palette reads as a website someone loaded.
const S = {
    main: { font: "15px/1.5 -apple-system, system-ui, sans-serif", color: "var(--tg-theme-text-color, #e8eaed)", background: "var(--tg-theme-bg-color, #05070a)", minHeight: "100vh", padding: 20, margin: 0 },
    h1: { font: "600 13px/1 system-ui", textTransform: "uppercase", letterSpacing: ".12em", opacity: .5, margin: "0 0 18px" },
    row: { display: "flex", justifyContent: "space-between", gap: 14, padding: "11px 0", borderBottom: "1px solid var(--tg-theme-section-separator-color, #ffffff14)" },
    label: { opacity: .55, whiteSpace: "nowrap" },
    value: { textAlign: "right", wordBreak: "break-all" },
    mono: { font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace" },
    note: { marginTop: 18, padding: "12px 14px", borderRadius: 10, background: "var(--tg-theme-secondary-bg-color, #ffffff0d)" },
    button: { marginTop: 18, width: "100%", padding: "13px 16px", borderRadius: 10, border: 0, font: "600 15px system-ui", color: "var(--tg-theme-button-text-color, #fff)", background: "var(--tg-theme-button-color, #2f6fed)" },
    tabs: { display: "flex", gap: 6, margin: "0 0 18px" },
    tab: { flex: 1, padding: "9px 6px", borderRadius: 8, border: 0, font: "600 12px system-ui", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tg-theme-text-color, #e8eaed)", background: "var(--tg-theme-secondary-bg-color, #ffffff0d)", opacity: .5 },
    tabOn: { opacity: 1, background: "var(--tg-theme-button-color, #2f6fed)", color: "var(--tg-theme-button-text-color, #fff)" },
    item: { display: "flex", width: "100%", gap: 14, padding: "12px 0", border: 0, borderBottom: "1px solid var(--tg-theme-section-separator-color, #ffffff14)", background: "transparent", color: "inherit", font: "15px/1.4 -apple-system, system-ui, sans-serif", textAlign: "left" },
    grow: { flex: 1, wordBreak: "break-all" },
    ghost: { background: "transparent", color: "var(--tg-theme-text-color, #e8eaed)", boxShadow: "inset 0 0 0 1px var(--tg-theme-section-separator-color, #ffffff24)" },
    foot: { marginTop: 18, opacity: .5, fontSize: 13 },
};

createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        {/* Telegram's in-app browser supports only email, SMS and embedded
            wallets — "google" and "wallet" would render options that cannot work. */}
        <PrivyRoot loginMethods={["telegram", "email"]}>
            <Wallet />
        </PrivyRoot>
    </React.StrictMode>,
);
