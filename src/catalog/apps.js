// The index of apps.
//
// A publisher registers their app's manifest into a system namespace `apps`, keyed
// `apps:<0xwallet>:<appName>` — so the registry of apps IS a quickbeam namespace
// like any other, baked into a view like any other, and reading it needs exactly
// one primitive the consumer already has: fetch a view's rows.
//
// That is the whole seam. The publisher half needs fangorn (commit, pin, bake);
// the consumer half needs quickbeam and nothing else. This file is the top of the
// consumer's navigation: apps → domains → rows, each level one HTTP GET against a
// worker, no relay on the read path except to learn WHICH registry to read.
//
// ponytail: one flat list, no pagination and no ranking. Two apps today. When the
// registry is big enough to hurt, rank it the way search.js ranks domains — the
// registry is a baked domain, so it has coverage centroids too.

import { loadShard } from "./search.js";

/** `apps:0xWallet:appName` — the key the publisher registers under. */
const APP_ID = /^apps:(0x[0-9a-fA-F]{40}):(.+)$/i;

/**
 * A registry row is a POINTER SOMEONE ELSE WROTE, and following it is the one
 * place this app navigates to a URL it did not configure. So: http(s) only.
 * `javascript:` / `data:` never reach a fetch or an EventSource from here.
 */
function safeView(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        return u.toString().replace(/\/+$/, "").replace(/\/(stream|cdn)$/, "");
    } catch { return null; }
}

/**
 * One registry row → an app entry, or null if it isn't one.
 *
 * The manifest the publisher writes is the source of truth ({appId, owner,
 * termsHash, termsUri, description, view, …}); the key is the fallback, since it
 * carries the same (owner, appId) and the registry guarantees its shape. A row with
 * no usable view URL is dropped rather than listed — an app you cannot open is not
 * an app, it's a dead card.
 *
 * `terms*` is passed through, not enforced. Whether a consumer must accept terms
 * before browsing is a product decision nobody has made yet; carrying the pointer
 * costs nothing and inventing a gate here would be inventing policy.
 */
export function toApp(row = {}) {
    const view = safeView(row.view ?? row.quickbeam ?? row.url);
    if (!view) return null;
    const [, keyOwner, keyApp] = APP_ID.exec(String(row.id ?? "")) ?? [];
    const appId = row.appId ?? keyApp ?? row.app ?? row.name;
    if (!appId) return null;
    return {
        id: row.id ?? `apps:${row.owner ?? ""}:${appId}`, view, appId,
        owner: String(row.owner ?? keyOwner ?? "").toLowerCase(),
        name: row.name ?? appId,
        desc: row.description ?? row.desc ?? "",
        termsHash: row.termsHash ?? null,
        termsUri: row.termsUri ?? null,
    };
}

/** Every app in the registry view, by name. `url` is the registry's own view base —
 *  trimmed through the same gate as an app's, since it arrives from relay config and
 *  the registry prints /stream and /cdn URLs rather than the base. */
export async function listApps(url) {
    const at = safeView(url);
    if (!at) throw new Error(`apps: not a usable registry URL: ${url}`);
    const apps = [];
    for (const row of await loadShard(at)) {
        const a = toApp(row);
        if (a) apps.push(a);
    }
    // Same (owner, appId) registered twice is a re-registration — loadShard already
    // resolved deltas by track_id, so this only dedupes an app that changed key.
    const by = new Map(apps.map((a) => [`${a.owner}\n${a.appId}`, a]));
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── self-check: `node src/catalog/apps.js` ───────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const A = "0x" + "a".repeat(40);
    const row = (extra) => ({ id: `apps:${A}:video-game-archive`, ...extra });

    // The manifest as the publisher writes it.
    let a = toApp(row({
        view: "https://reg.test/q/qb_1/stream", appId: "video-game-archive", owner: A,
        description: "roms", termsHash: "0xabc", termsUri: "ipfs://terms",
    }));
    if (a.owner !== A.toLowerCase() || a.appId !== "video-game-archive") throw new Error("identity lost");
    if (a.view !== "https://reg.test/q/qb_1") throw new Error(`view must trim to the base, got ${a.view}`);
    if (a.desc !== "roms") throw new Error("description lost");
    if (a.termsHash !== "0xabc" || a.termsUri !== "ipfs://terms") throw new Error("terms pointer lost");

    // A manifest with only a view falls back to the key for (owner, appId) — the key
    // is the one part of a registration the registry itself guarantees.
    a = toApp(row({ view: "https://reg.test/q/qb_1" }));
    if (a.owner !== A.toLowerCase() || a.appId !== "video-game-archive") throw new Error("identity must fall back to the key");
    if (a.termsHash !== null) throw new Error("absent terms must be null, not undefined");

    // The trust boundary: a registry row is written by a stranger.
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "", null, "not a url"]) {
        if (toApp(row({ view: bad }))) throw new Error(`must refuse view ${JSON.stringify(bad)}`);
    }
    // An ordinary catalog row is not an app.
    if (toApp({ id: "0xaaa:music/x.mp3", name: "x.mp3" })) throw new Error("a media row must not list as an app");
    // A key that doesn't parse can still be an app if it names itself — the
    // registry is young and the key format is the convention, not a schema.
    if (toApp({ id: "weird", view: "https://reg.test/q/qb_2", name: "loose" })?.appId !== "loose") {
        throw new Error("a row that names itself must still list");
    }

    console.log("apps.js self-check ok — key identity, view trimming, non-http refused, non-app rows dropped");
}
