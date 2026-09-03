---
name: sond3r-tv
description: Drive a live SOND3R storefront tab through its own WebMCP tools — semantic search over what films SAY and SHOW, channels built out of scenes rather than whole files, supercuts and gifs cut from remote video without downloading it, and a skip-driven loop that retunes a channel off what the viewer rejects. Use when the user wants to search or browse a SOND3R/tv corpus, build or tune a channel, make a supercut or gif from archive footage, find where a phrase is spoken across a corpus, or have an agent watch along and steer what is on. Also covers connecting Claude Code to the tab when the WebMCP server will not start.
---

# SOND3R TV

The corpus lives in a browser tab. This skill drives that tab through
[WebMCP](https://github.com/webmachinelearning/webmcp) — the page registers its
own tools on `document.modelContext`, and `list_webmcp_tools` /
`execute_webmcp_tool` call them.

That is the point, not an implementation detail. The catalog, the query vectors
and the viewer's taste are all *in the tab*. A server-side MCP would have to
re-download the corpus and would see every query. Nothing here leaves the browser.

---

## 0. Connect first

```
list_pages                      # find the SOND3R tab
list_webmcp_tools(pageId)       # ~20 verbs appear
```

If `list_pages` fails, read **Troubleshooting** at the bottom before anything
else. The most common failure has nothing to do with the page.

---

## 1. Discovery — what is in here

| tool | use it for |
|---|---|
| `search-catalog` | semantic search over titles, descriptions, and subtitle/scene rows. Also paints results on the page |
| `browse-catalog` | list without searching; filter by publisher or kind |
| `find-line` | **exact phrase**, across every subtitle in the view, with timestamps |
| `open-item` | open one file's page; free files start playing |

`search-catalog` and `find-line` are not two flavours of the same thing:

- `search-catalog` ranks by *topic*. It will never find a phrase said once.
- `find-line` matches words **intact and on word boundaries** and returns the
  cue timestamps to cut. This is the supercut tool.

**Corpus reality check.** Ask before promising. A corpus enriched by
`scripts/ingest/enrich.py` carries three kinds of subtitle row, and they are not
equivalent:

| role | what it is | typical span |
|---|---|---|
| `asr` | Whisper transcript, merged into passages | ~60s, sometimes 800s |
| `scene` | VLM caption of one sampled frame | zero-length, sampled every 300s by default |
| `summary` | LLM summary of a window | ~400s |

Consequences you must not paper over: there is **no speaker diarization**, so
"find where character X says Y" is not answerable. ASR on old public-domain
prints is frequently garbled. And with 300-second frame sampling, a visual thing
that happens between samples was never indexed.

---

## 2. Channels — a query that behaves like television

A channel is a **ring of items plus its total length**, and what is on at time
`t` is `t mod total`. Pure function of UTC: two browsers holding the same channel
are on the same frame with nothing to synchronise, no server, no room to join.

| tool | does |
|---|---|
| `list-channels` | every channel and what is on now/next |
| `tune-channel` | invent one from a sentence and turn the set to it |
| `watch-channel` | turn to an existing one, by number or name |
| `channel-schedule` | running order for the next N hours, from the clock |
| `share-channel` | the link; `save:true` keeps it in this browser |

`tune-channel` takes four kinds of evidence, mixable:

- `prompt` — a mood in words
- `blend` (0–1) — how far to pull toward where *this viewer* is already heading
  (from `read-taste`)
- `like[]` / `unlike[]` — item ids to steer toward and away from
- `scenes` — see below

**A channel built with `blend` or `like`/`unlike` cannot be reproduced anywhere
else.** That vector exists only in that tab.

### `scenes: true` — channels of moments

A "firetrucks" channel with `scenes:false` is every film that *mentions* a
firetruck. With `scenes:true` it is the ~45 seconds in each film where one is
*on screen*.

Each slot is a window (`in`/`out`) into a source file: the TV seeks to it, the
guide cell carries its timecode, and each moment has its own identity — so two
scenes from one film are two different things to rate and to skip.

Needs a corpus with subtitle/scene rows. If the channel comes back empty, say so
plainly rather than falling back silently to whole files.

**Expect imprecision, and plan for it.** Retrieval over short vectors of loose
captions returns *adjacent*, not *exact* — a firetruck query surfaces fireplaces,
burning buildings, a flame barrier. That is what the loop in §3 is for. It is not
a demo layered on top of the channel; it is how the channel becomes right.

Moment channels are **not shareable as links**: the share link carries the query
vector, and the ring came from a subtitle search over rows the receiver may not
hold. Say that instead of handing over a link that quietly reopens as whole films.

---

## 3. The loop — watching along

Two tools invert the usual direction:

| tool | does |
|---|---|
| `read-taste` | this session's heading, speed, what it avoids — derived in the browser, never sent anywhere |
| `await-viewer-signal` | **blocks until the person does something.** `skip` / `finished` / `like` / `dislike` / `channel` / `tuned` |
| `propose` | **puts a card on the page and waits for the button.** Silence resolves `null`, never consent |

The loop:

```
await-viewer-signal  →  read-taste  →  tune-channel(unlike:[the skipped id])  →  park again
```

The signal carries the skipped item's id. On a scene channel that id names the
**moment** (it ends in `#t=<seconds>`), so the retune steers off the scene the
person actually rejected, not merely the film it came from.

### A `skip` is not always a rejection

`skip` means "left the slot before it ended" — which conflates *I reject this*
with *I am done here*. Before treating one as a negative, check the payload:

- **`seconds`** — how long they sat there. A skip at 4 seconds is a rejection. A
  skip at 1179 seconds is someone who watched the whole thing and moved on.
- **A `like`/`finished` on the same id** earlier in the session. That overrides.
  MEASURED: a viewer thumbed an episode up, then five seconds later "skipped" it
  after 19.6 minutes to change channel. Feeding that id to `unlike[]` would have
  steered the channel away from something they had just told you they wanted.
- **`to`** — where they went. A skip whose `to.channel` differs from the current
  one is channel-surfing, not a verdict on the slot.

Treat as a real negative only a short skip with no positive signal on that id.
Otherwise record it and move on.

**Your own retune emits a spurious `skip`.** `tune-channel` rebuilds the ring,
which re-fires the player's slot effect: `kind: "skip"`, `seconds: 0`, and `to`
naming the *same* item it came from. It is not a viewer action. Feeding it back
into `unlike[]` makes every retune push the channel away from its own current
slot — a self-poisoning loop that reads as drift rather than as a bug. Discard
any signal whose `to.item` equals the item it reports on.

**And `finished` can be a false positive**, the mirror of the skip case: a slot
joined near its end "finishes" in a few seconds. On a scene channel a real
sit-through shows `seconds` equal to the whole window (e.g. 45); a `finished` at
4 seconds means they arrived at the tail. Check `seconds` before crediting it.

**A run of identical `finished` signals means nobody is there.** Every slot on a
scene channel is the same length, so an unattended channel auto-advances and
emits `finished` with `seconds` equal to the window, over and over. MEASURED: ten
in a row at exactly 45s. This is the most dangerous signal to misread, because
unlike the others it manufactures false POSITIVES at volume — credit them to
`like[]` and you train the channel on whatever was in the ring while the room was
empty. A single full-length `finished` is ambiguous; three or more in a row at
identical duration is an idle player. Stop crediting them and widen your polling
interval instead.

**When nothing is wrong, do not retune.** Consecutive full-length `finished`
signals mean the ring is working. Rebuilding it disturbs what they are watching
and emits the spurious skip above. Retune on evidence, not on a timer.

### Four things that will confuse you or the user

1. **There is no background watcher.** `await-viewer-signal` only listens while
   you are inside the call, and you are only inside it during a turn. If the user
   skips while you are idle, nobody is listening. Do not imply otherwise.
2. **Signals are buffered, not queued forever.** The page keeps the last ~40. A
   page reload clears them. Pass `after: <last seq>` to avoid gaps; `after: 0`
   replays what is still held.
3. **Your prose does not reach the user until your turn ends.** If you need to
   tell them something mid-loop — "I'm parked now, start skipping" — use
   `propose`. It is the only channel you have to them while running.
4. **A `null` return is not an error.** It means they are still watching. Call
   again.

To run unattended across turns, use `/loop` (self-paced re-arming) or a
`SessionStart` hook. Nothing else will do it: the trigger has to be the agent
being invoked. A filesystem watcher is the wrong rung — the page already emits
richer, better-timed signals than a file could.

---

## 4. Supercuts and gifs

Three steps. The expensive part is producing the edit list, and an agent with the
catalog open is what produces it.

**Find the shots.**
- A phrase said out loud → `find-line`
- A thing on screen → `search-catalog`, or `scan-film` to flip through a film as
  a contact sheet (a couple of KB per frame) before spending an hour on it

**Check them.** `montage` resolves each pick to the URL its bytes actually live
at and bounds-checks every one, so a bad cut fails in one call instead of after
three features have been fetched. It also draws the shots on the open film's
timeline so the person can see the cut before it renders.

**Render.** `montage` emits an edit list that the bundled cutter takes verbatim:

```sh
node ${CLAUDE_PLUGIN_ROOT}/scripts/cut.mjs edits.json out.mp4   # supercut
node ${CLAUDE_PLUGIN_ROOT}/scripts/cut.mjs edits.json out.gif   # gif, 12fps, 480w
```

`edits.json` is `[{ "url": "...", "start": 2000, "dur": 60 }, ...]`.

Needs `ffmpeg` and `ffprobe` on PATH. `-ss` before `-i` makes ffmpeg
range-request only the bytes it needs — a minute out of a 700MB feature moves
~6MB and takes a couple of seconds. Nothing is downloaded whole.

What the cutter handles for you, and why it is worth knowing:
- **Normalizes every clip** to one size and frame rate. The sources are whatever
  the archive held — 480p, 576p, 4:3, 24 and 30fps — and `concat` refuses
  mismatched streams.
- **Levels the audio** to −16 LUFS per source. Measured across three archive
  films, integrated loudness spanned 12 LU; nobody notices that in one clip and
  everybody notices it in a supercut.
- **Drops audio entirely if any source has none**, because `concat` with `a=1`
  errors out on a silent input — and a supercut that dies on the one silent reel
  is worse than a silent supercut. It tells you which happened.
- A single clip to mp4 is stream-copied: no re-encode, cut on the nearest keyframe.

### Writing a supercut that is actually good

Pick for **contrast or rhythm**, not just relevance — nine clips that all match
the query equally is a list, not a cut. Vary shot scale and pacing. Keep phrase
clips tight (the cue's own duration); give visual clips 3–7 seconds to read.

A dialogue supercut needs line-level cues. If the corpus only has merged ASR
passages, a "phrase" clip will be 60 seconds long — check `find-line`'s returned
durations before promising a snappy cut.

---

## 5. The player

| tool | does |
|---|---|
| `player-state` | what is playing, where the playhead is |
| `control-player` | play / pause / seek — the same element the human's transport drives |
| `capture-frame` | the frame at a timestamp, as an image |
| `scan-film` | up to 12 frames as one contact sheet, timestamps burnt in |
| `annotate` | clickable ticks on the timeline and boxes over the picture |
| `describe-scenes` | write what happens at timestamps into the catalog as searchable moments — **stages a draft**; publishing is the person's signature |

---

## 6. Hard limits — state these, do not work around them

- **No spending.** Nothing here touches the wallet. `open-item` walks to the buy
  button; a human presses it. An agent-callable `buy` would be an agent-callable
  wallet.
- **Most frames cannot be read off the canvas.** archive.org's `/download` 302s
  to a mirror with no CORS header, so the canvas is tainted for most of the
  corpus. `capture-frame` falls back to the archive's own frame strip. Forcing
  `crossOrigin="anonymous"` makes those files fail to load outright. Measured —
  do not retry it.
- **No exact frame from a strip.** The cadence is the archive's, typically one a
  minute. `scan-film` is a contact sheet, not a frame grab.
- **No cutting in the tab.** `montage` hands off to `cut.mjs`. ffmpeg.wasm would
  be ~30MB to replace a working renderer.
- **No speaker identity.** See §1.

---

## Troubleshooting

**`list_pages` fails: "Could not find Google Chrome executable"** — the MCP
server launches its own Chrome and there is none on this platform. Common in
WSL, where Chrome is installed on the Windows side.

```sh
${CLAUDE_PLUGIN_ROOT}/scripts/webmcp-chrome.sh [url]
```

That starts Windows Chrome with WebMCP enabled on a separate profile, plus a
relay, and prints a `browser-url`. Add it to the plugin's `.mcp.json` args:

```
"--browserUrl=http://<gateway-ip>:9223"
```

and drop `--chromeArg=--enable-features=WebMCP` (with `browserUrl` the server
connects rather than launches). Three things make this necessary and none is the
default: Chrome ignores `--remote-debugging-port` on the default profile; it
binds DevTools to `127.0.0.1` and ignores `--remote-debugging-address`, which
WSL2's NAT cannot reach; and **the gateway IP changes per boot**, so re-check it
with `ip route show default` when the server stops connecting.

Needs Chrome 150+.

**The server connects but tools are stale, or a fix does not take.** If the page
is served by a dev server, check what it is actually serving before debugging the
page: `curl localhost:5173/src/<file>` and look for your change. A build cache can
serve a pre-edit module through a hard reload; `touch` the file to invalidate it.

**A channel shows the same slot over and over.** Slot durations must be whole
seconds — the schedule walks by feeding one slot's end time back in, and a
fractional length lands it back inside the slot it just left. Tell-tale: cell
timestamps ending in fractional milliseconds rather than `.000`.
