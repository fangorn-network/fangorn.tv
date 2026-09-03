import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The SDK needs Node (fs, LMDB, service key), so graph build/commit + catalog
// reads live in server/. The browser signs txs and runs the buyer flow itself
// (viem + Semaphore), talking to the facilitator/worker directly. /api is the
// only thing proxied to the local server.
//
// The facilitator sends no CORS headers, so it's proxied too — same-origin
// /facilitator/* in the browser, no preflight. server/index.js proxies the same
// path in production, so VITE_FACILITATOR_URL=/facilitator is correct in BOTH —
// don't "fix" a deployed build by pointing it at the facilitator directly, it
// sends no Access-Control-Allow-Origin and every purchase dies on preflight.
// Vite inlines only the literal text `import.meta.env.VITE_FOO`. Aliasing the env
// object leaves a runtime lookup that resolves to undefined in a built bundle, so
// a purchase dies as "invalid opcode: DATASIZE" (an eth_call with no `to`) — and
// only in production, never in dev. Fail the build instead.
const requireInlinedEnv = (keys) => ({
    name: "require-inlined-env",
    enforce: "post",
    generateBundle(_, bundle) {
        const js = Object.values(bundle).filter((c) => c.type === "chunk").map((c) => c.code).join("");
        // A surviving lookup is a property access (`x.VITE_FOO` / `x["VITE_FOO"]`).
        // The bare name is fine — it's how a build-config error names itself.
        const missing = keys.filter((k) => new RegExp(`\\.\\s*${k}\\b|\\[\\s*["'\`]${k}["'\`]`).test(js));
        if (missing.length) this.error(`${missing.join(", ")} survived as a runtime lookup — write it as a literal import.meta.env.VITE_… so vite can inline it`);
    },
});

// server.proxy does NOT apply to `vite preview` — it needs preview.proxy, and
// without it a previewed build POSTs /facilitator/verify at the SPA fallback and
// every purchase dies on index.html. Same object, both servers.
const proxy = (mode) => ({
    "/api": { target: "http://localhost:8787", changeOrigin: true },
    "/facilitator": {
        target: loadEnv(mode, process.cwd(), "").FACILITATOR_URL ?? "http://localhost:30333",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/facilitator/, ""),
    },
});

export default defineConfig(({ mode }) => ({
    plugins: [react(), requireInlinedEnv(["VITE_SETTLEMENT_REGISTRY_ADDR", "VITE_USDC_CONTRACT_ADDR", "VITE_FACILITATOR_URL"])],
    build: {
        // The service worker must be its OWN rollup entry. `new URL("./flix-sw.js",
        // import.meta.url)` only makes vite COPY the file as an asset — untransformed,
        // so its `import ... from "./stream.js"` survives into dist/assets/ where no
        // such file exists and the worker dies with "ServiceWorker cannot be started".
        // Dev never showed it: vite transforms /src/flix-sw.js on the fly.
        // Emitted unhashed at the root so it registers scope "/" without relying on a
        // Service-Worker-Allowed header, and so its URL is stable to hardcode.
        rollupOptions: {
            input: { index: "index.html", telegram: "telegram.html", "flix-sw": "src/flix-sw.js" },
            output: { entryFileNames: (c) => (c.name === "flix-sw" ? "[name].js" : "assets/[name]-[hash].js") },
        },
    },
    server: {
        // ponytail: WSL2 — default `localhost` bind resolves to ::1 only, which
        // neither the Windows localhost relay nor a WSLg browser reaches.
        host: true,
        // The streaming SW is served from /src (dev) or /assets (build) but claims
        // scope "/" so it can answer /flix/<id>. Without this header the browser
        // rejects the registration and playback silently falls back to decrypting
        // the whole file. A deployed build needs the same header from its host.
        headers: { "Service-Worker-Allowed": "/" },
        proxy: proxy(mode),
    },
    preview: { headers: { "Service-Worker-Allowed": "/" }, proxy: proxy(mode) },
}));
