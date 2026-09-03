# Internals

How fangorn.tv works underneath. For the cross-repo view — contracts, x402f,
quickbeam, the access worker — see [architecture.md](./architecture.md).

The on-chain namespace and the manifest name are still `sond3r` / `.flix.json`.
They're baked into published resourceIds and existing media dirs, so the rebrand
is UI-only; renaming them orphans everything already published.

## Shape

A registered publisher organizes arbitrary data into a folder/file tree of any
depth and publishes it as a Fangorn commit graph — one vertex per folder or
file, parent → child edges. Each file is AES-encrypted and stored in R2 behind
an access worker. Every published file gets its own storefront at
`/c/<resourceId>`.

```
   the publisher's browser                    the publisher's Cloudflare
┌─────────────────────────────┐            ┌──────────────────────────────┐
│ src/pay/encrypt.js              │  ciphertext│  access worker + R2          │
│  AES-256-GCM, 64MiB chunks  ├───────────►│   sealed DEKs                │
│ src/ui/App.jsx  portal + viewer│            │   their .flix.json manifest  │
└──────────┬──────────────────┘            └──────────────────────────────┘
           │ finished library (JSON only — no bytes)
           ▼
┌──────────────────── relay ──────────────────────┐
│ server/  Fangorn SDK: graph build + commit,     │
│          IPFS pin, unsigned txs — NO signing key│
│          NO disk, NO staging, NO per-publisher  │
│          state                                  │
└──────────┬──────────────────────────────────────┘
   browser wallet signs        facilitator + access worker
   (SIWE sign-in, createResource,  (regis ter / settle / gated decrypt)
    commit, payment, settlement)        │
              └────────► Arbitrum Sepolia (SettlementRegistry, DataRegistry)
```

**Bytes never touch the relay.** The browser encrypts each file and uploads the
ciphertext straight to the access worker; only the finished library description
reaches the server. That is what lets the same deployment serve
buyers and publishers at one public URL, on a host with no disk.

Staging is **per wallet**. Every `/api` route is authenticated by default; a
publisher signs a SIWE message (no gas) to open a session, and every resource id
the relay mints folds in *that* session's address — never a request parameter, so
one publisher can never mint over another's resource. That
same signature is the publisher's **rights attestation** — the message says they
own or are licensed to distribute what they publish and accept takedown on notice,
and it links `/terms.html` — and the relay appends it to `ATTESTATION_LOG` before
minting the session. Each line verifies on its own with `recoverMessageAddress`;
if the log can't be written, sign-in fails rather than proceeding unrecorded.

Becoming a publisher is gated on a second, explicit signature over the SHA-256 of
`public/terms.html`. The relay **withholds the unsigned `register()` transaction**
until that acceptance is on file, so the on-chain registration can't happen first,
and it refuses `/api/publish/prepare` on the same check — otherwise every wallet
registered before the gate existed would sail past it. Because the accepted
version is a digest of the served bytes, editing the terms asks everyone again. One
publisher cannot list, rename or delete another's unreleased footage. The only
unauthenticated routes are the sign-in handshake and the two read-only viewer
endpoints (`/api/remote`, `/api/catalog`), which serve data already public
on-chain.

The server holds **no wallet key** — its `ETH_PRIVATE_KEY` is a service key used
only to construct the Fangorn engine for chain reads. Even IPFS pins are
authorized by the publisher's own signature, against their own storage quota. Every on-chain action is
signed by the browser wallet (publisher: `createResource` + `commitStateRoot`;
buyer: EIP-3009 payment + Semaphore settlement).

## How it maps to the primitives

| Piece | Where | Job |
|---|---|---|
| Wallet sessions | `server/auth.js` | SIWE sign-in → bearer token; the tenant boundary; the signed rights attestation + its append-only log |
| Terms + DMCA | `public/terms.html` | What that signature binds a publisher to; served statically at `/terms.html` |
| Terms gate | `terms()` + `assertAcceptedTerms()` in `server/index.js` | Withholds the `register()` tx and refuses `/api/publish/prepare` until the wallet has signed the current terms **digest** |
| Takedown | `Takedown` in `src/ui/App.jsx` | Publisher signs `setDisabled` — the only takedown that also blocks buyers who already paid |
| Library structure | `server/graph.js` | fs tree ⇄ Fangorn vertices+edges (folders + videos); `isCatalogEntry`/`inGraph` decide what's published vs. what's also for sale |
| Headless publish | `scripts/publish.mjs` | what the browser's `publish()` does, with a local key — bulk seeding and publishing from a chat |
| Working tree | `.flix.json` in the **shared R2 bucket**, under a key derived from the publisher's address | per-file price, description, published pointer and the stable uid that keeps a file's PAID identity across a rename; read back via the worker's token-gated `GET /upload/:key`, so a library follows its publisher between machines |
| Encrypt + upload | `src/pay/encrypt.js` (browser), `server/settle.js` (Node clients) | AES-256-GCM each file in 64MiB chunks, seal DEK to worker, upload each ciphertext. Both sides share `src/pay/envelope.js` — the wire format and the resourceId derivation — because two copies that drifted would make a file unbuyable |
| Publish flow | `server/index.js` `/api/publish/prepare` + `/api/settle` | take the browser's finished library, mint resourceIds, `fangorn.commit`, hand back unsigned txs |
| Buyer flow | `src/pay/buy.js` + `src/pay/purchase.js` | derive stealth identity, pay owner, prove membership, decrypt |
| UI | `src/ui/App.jsx` | file-explorer Publisher + storefront/player + `/c/<resourceId>` purchase page |
| Storefront layout | `src/catalog/browse.js` | catalog → generated shelves + one-folder-at-a-time drill-down, ranked against what this browser has opened |

Each video = one settlement `resourceId`, referenced from its graph vertex. The
registry derives it as `keccak256(publisher ++ keccak256("sond3r:"+uid))`, where
the uid is stable across renames — folding in the publisher's address is what
makes an id impossible for anyone else to claim. Buying is `register`
(facilitator `/verify`, pays the owner + joins **that resource's** Semaphore
group) → `settle` (facilitator `/settle`, membership proof) → worker `/access`
releases the DEK for the buyer's stealth address. Re-watching is
settlement-gated by that stealth address, so it never pays twice; buying a
second file is a second payment, because each file is its own group.

Large videos are chunked. Cloudflare caps a Worker request body at 100MB, so a
video is split into 64MiB chunks, each AES-GCM'd separately under the *same* DEK
— one payment still unlocks the whole thing. Chunk 0 is stored under the
`resourceId` itself (where `/access` looks for the sealed DEK); chunk `i>0` under
`keccak256(resourceId ++ uint32 i)`. The chunk index is the GCM additional data,
so a reordered or dropped chunk fails to decrypt rather than scrambling the mp4.
Both sides read one chunk at a time, so a 3GB publish peaks at ~500MB RSS instead
of ~5x the file. `node server/settle.js` round-trips it against a stubbed worker.

Editing is filesystem-direct: new folder, upload into any folder, rename/move
(keeps the video's uid → same paid resource), and delete anything (the "undo").
Deleting a published video just drops it from the next snapshot commit — the
on-chain `createResource` can't be un-created, but the video stops being listed.

## Catalog entries — publishing without selling

`commitStateRoot` is **one transaction for a graph of any size**. `createResource`
is one transaction per *sellable* file, because it mints that file's Semaphore
group and the group is what a payment joins. Those two used to be welded
together: `buildTreeGraph` only emitted a vertex for a file that had been
published, so being in the catalog at all cost a transaction per item.

They're now separate. `POST /api/listing {path, forSale:false}` marks a file a
**catalog entry**: it's committed to the public graph, described, embedded and
searchable, but it is never encrypted, never uploaded, never given a resource,
and cannot be bought. So ingesting a million records costs *one* commit, and
only the subset actually for sale pays per item.

The absence of `resourceId` is the signal, everywhere — there's no second
`forSale` field in the payload to contradict it, and a price is never emitted
without something to buy. `forSale` defaults to true, so an ordinary upload
behaves exactly as before and staged files stay private until published.

A file that's **already published for sale cannot become an entry** (409): the
resource exists on-chain and people may have paid for it, so dropping the pointer
would revoke access that was bought outright. Takedown is how you withdraw that.

Catalog entries are remembered in open-history and keyed into `fileVectors` by
`owner:path` (`browse.js` `nodeKey`), so the session kernel ranks them like
anything else — on a mostly-free corpus, browsing them is the only signal it gets.

## What gets embedded

A published file's search vector is built at publish time, in the publisher's
own browser, from `server/enrich.js`. Historically that text was the filename
and its folders — and a vector built from a filename ranks about as well as one.
Measured against this storefront: "philosophy reading" put a metalcore mp3 above
a phenomenology PDF, and "movies" matched nothing at all, because the mime type
never reached the text.

So the file is read for what it actually says, while it's still on local disk:

| tier | what it adds | measured |
|---|---|---|
| name hygiene | extension, `_`/`-`, `[OFFICIAL VISUALIZER]` stripped; mime as plain words ("a movie you watch") | top-1 7/11 → 7/11 |
| content | PDF `/Title` + first text streams, mp3 ID3 title/artist/album/genre | top-1 7/11 → **9/11** |

Cleanup is nearly free; **content is what pays.**
`Jakob_von_Uexkull_Beyond_Bubbles_On_Umwe.pdf` is truncated mid-word, and the
document itself says "Beyond Bubbles: On Umwelt and Biophilosophy" — the two
concept words the filename lost. Extraction is stdlib-only (`node:zlib` for
both) and entirely best-effort: an unreadable file contributes nothing rather
than failing a publish.

Videos with dialogue were already covered — subtitle cues are embedded as their
own passage rows. **Images and silent video are the remaining gap**, and no
parser closes it: nothing in a JPEG's bytes says "scifi western". That needs a
captioning model, in the same browser that already runs the embedder.

Only the *vector* changes. The shard still stores `fileText()` for display and
lexical fallback, so nothing on-chain grows.

## Deployment notes

Subtitles come from hand-written `.vtt` sidecars. There is no server-side ASR:
the relay never receives a media file, so there is nothing here to transcribe.
(`server/subtitles.js` still parses `.vtt` into the cues that reach the graph
and the search shard.)

Deploy the access worker from `../webworker/fangorn-access-worker` with the two
secrets in its `DEPLOY.md`; the facilitator lives in
`../x402f/packages/facilitator`. Every published file carries its own
`workerUrl`, so files published to an older worker keep serving from it.

## WebMCP — the storefront as agent tools

The page registers its own verbs on `document.modelContext`
([WebMCP](https://github.com/webmachinelearning/webmcp)), so a browser-resident
agent drives the storefront that is already open: `search-catalog`,
`browse-catalog`, `open-item`, `player-state`, `control-player`, `capture-frame`,
`annotate`.
No server, no transport, no dependency — see `src/ui/webmcp.js`. Search stays
client-side, so an agent's query never leaves the tab either.

Nothing to install but Chrome — `.mcp.json` in this repo starts
`chrome-devtools-mcp` with `--categoryExperimentalWebmcp` and its own Chrome
launched with `--enable-features=WebMCP`, so `list_webmcp_tools` /
`execute_webmcp_tool` reach the page's verbs. No extension, no `claude-in-chrome`,
no CDP port. Open <https://tv.fangorn.network> in it and ask for the tools.
Chrome 150+.

```sh
node src/ui/webmcp.js             # the tools' self-check, no browser needed
scripts/webmcp-chrome.sh          # WSL fallback only: Windows Chrome + a CDP relay
```

In the tab's console (Chrome takes the arguments as a JSON **string**, and the
tool object, not its name):

```js
const mc = document.modelContext;
const t = (await mc.getTools()).find((x) => x.name === "search-catalog");
await mc.executeTool(t, JSON.stringify({ query: "cold war submarines", limit: 3 }));
```

Three things measured rather than assumed:

- **Nothing here spends money.** `open-item` walks the page to the item and its
  buy button; a person presses it. WebMCP has no consent primitive yet.
- **`annotate` draws on the player the person is watching** — ticks on a strip
  under the picture (click one to jump there) and boxes over the frame for a
  window of time, scoped to the open file so one film's marks never appear on
  another's. That is the whole argument for WebMCP over a backend MCP: the
  agent's finding is a thing you can click, not a paragraph in a chat window.
- **`capture-frame` needs no hosting.** Where the bytes are readable (a bought
  file is a `blob:`, a streamed one comes from our own service worker) it grabs
  the real frame off the canvas. Everywhere else — most of this catalog —
  archive.org's mirror sends no `access-control-allow-origin`, so it falls back
  to *the archive's own* frame strip through `archive.org/cors/{id}/{file}`,
  which does: one ~2KB JPEG per interval, nothing proxied or re-hosted. Forcing
  `crossOrigin="anonymous"` on the player instead makes those files fail to load
  outright — measured, don't retry it.

## End-to-end

1. **Publish** (Publisher tab): connect wallet → **Sign in to publish** (one
   signature, no gas — this is what scopes staging to your address) → build a
   tree with `+ Folder` and `Upload file` (into any folder), set each file's
   price (USDC base units, 6 decimals) → **Publish to Fangorn**. Your wallet
   signs one `createResource` per new file plus one `commitStateRoot`.
   Rename/delete freely before (or after) publishing. Sign in with a different
   wallet and you get a different, empty library. **Any file type sells** —
   video, audio, images, PDFs, archives; the extension picks the MIME type the
   buyer's browser gets, and only audio/video goes through ASR for subtitles.
2. **Watch** (Watch tab): connect a *second* wallet holding testnet USDC → paste
   the publisher address → **Load** → click an item. First click pays and
   settles; video/audio play in-page, images render, anything else offers a
   save button. Re-open → no second payment.
3. **Sell directly**: every published file shows a permalink
   (`/c/<resourceId>?owner=0x…`) under it in the Publisher tab, and the whole
   library has one at `/s/<0xaddr>`. Each is a standalone page — one file, or one
   publisher's storefront, with no search across everyone else. **Embed** next to
   either copies an `<iframe>` of that page with `?embed=1` (chrome dropped, wallet
   controls kept) to paste into any other site.

   The embed is an iframe of the relay, not a script that runs on the publisher's
   domain, and that is not laziness: the buyer flow needs the same-origin
   `/facilitator` proxy (the facilitator sends no CORS headers) and the streaming
   service worker's scope `/`. Both only exist on the relay's origin. Moving the
   buyer code to the publisher's domain means CORS on the facilitator *and*
   hosting `flix-sw.js` at their root — otherwise large files fall back to
   whole-file decrypt. Don't do it without a publisher who needs it.
