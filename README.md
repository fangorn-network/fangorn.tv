# fangorn.tv

A public television station built out of an open data marketplace. Anyone can
publish files, price them, and sell them; anyone can search the whole corpus by
what films *say* and *show*, and watch scene-level channels built from it.

Live at **<https://tv.fangorn.network>**.

## Quickstart — drive it with an agent

The page publishes its own tools on `document.modelContext`
([WebMCP](https://github.com/webmachinelearning/webmcp)), so an agent drives the
tab you already have open. The corpus, the search vectors and your taste never
leave the browser.

**1. Install the plugin** in Claude Code, from a clone of this repo:

```
/plugin marketplace add ./plugin
/plugin install sond3r-tv
```

**2. Open <https://tv.fangorn.network>** in the Chrome the plugin launches
(Chrome 150+ — it needs `--enable-features=WebMCP`).

**3. Ask for something.** No setup, no keys, no wallet:

```
what's in this catalog?
find every scene with a firetruck and put them on a channel
make me a 30-second supercut of the best explosions
/tv-watch cold war submarines
```

`/tv-watch` parks on the tab and retunes the channel off what you skip — the
skip signal names the *moment*, so the correction is per scene, not per file.

Supercuts and gifs additionally need `ffmpeg` and `ffprobe` on PATH. They cut
straight out of remote video: a minute out of a 700MB feature moves ~6MB.

Nothing the agent can call spends money. `open-item` walks to the buy button; a
person presses it.

**On WSL**, there's usually no Linux Chrome. Run `plugin/scripts/webmcp-chrome.sh`
first and follow what it prints. Details in [plugin/README.md](./plugin/README.md).

## Run it locally

```sh
pnpm install
cp .env.example .env   # ETH_PRIVATE_KEY (service key, reads only) + PINATA_JWT/GATEWAY
pnpm dev               # server :8787 + vite :5173
pnpm test
```

You also need an [x402f facilitator](https://github.com/fangorn-network/x402f)
(`FACILITATOR_URL`) and one access worker (`WORKER_URL`) on your own Cloudflare
account — publishers on your relay upload to it and need nothing of their own.

## Publish and sell

1. **Publish**: connect a wallet → *Sign in to publish* (one signature, no gas)
   → build a folder tree, upload into it, set each file's price in USDC base
   units → *Publish to Fangorn*. Any file type sells: video, audio, images,
   PDFs, archives.
2. **Buy**: open an item. The first click pays and settles; re-opening never
   pays twice. Media plays in-page, anything else offers a save button.
3. **Sell directly**: every file gets a permalink at `/c/<resourceId>` and every
   publisher a storefront at `/s/<0xaddr>`. *Embed* copies an `<iframe>` of
   either to paste into another site.

Files are AES-256-GCM encrypted in the browser and uploaded straight to the
access worker — bytes never touch the relay. Payment is x402f (ERC-3009
`transferWithAuth` + a paymaster), and settlement is a Semaphore membership
proof, so the address that reads a file is never linked on-chain to the wallet
that paid for it.

## Docs

- [internals.md](./internals.md) — how this repo works: the graph, encryption,
  publishing, search, the WebMCP verbs.
- [architecture.md](./architecture.md) — how it fits with the contracts, x402f,
  quickbeam and the access worker.
- [plugin/README.md](./plugin/README.md) — the agent plugin on its own.

Built on [Fangorn](https://github.com/fangorn-network/fangorn) and settled with
[x402f](https://github.com/fangorn-network/x402f).
