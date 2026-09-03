# sond3r-tv

A Claude Code plugin that drives a [SOND3R](https://github.com/fangorn-network)
storefront through the page's own [WebMCP](https://github.com/webmachinelearning/webmcp)
tools.

The corpus, the query vectors and the viewer's taste all live in the tab. A
server-side MCP would have to re-download the corpus and would see every query.
Nothing here leaves the browser.

## What it gives you

- **Search by what films say and show** — semantic search over subtitle, scene
  and summary rows, plus exact-phrase search with the timestamps to cut.
- **Channels out of scenes, not files.** A "firetrucks" channel is the ~45
  seconds in each film where one is on screen, not every film that mentions one.
  The schedule is a pure function of UTC, so two browsers holding the same
  channel are on the same frame with nothing to synchronise.
- **`/tv-watch`** — park on the tab and retune the channel off what the viewer
  skips. The skip signal names the *moment*, so the correction is per-scene.
- **Supercuts and gifs** from remote films without downloading them. `ffmpeg -ss`
  before `-i` range-requests only the frames in the cut: a minute out of a 700MB
  feature moves ~6MB.

## Install

```sh
/plugin marketplace add <this repo>
/plugin install sond3r-tv
```

Then open a SOND3R tab (e.g. <https://tv.fangorn.network>) and ask for
`list_webmcp_tools`.

Needs Chrome 150+. Supercuts additionally need `ffmpeg` and `ffprobe` on PATH.

## WSL

The bundled `.mcp.json` launches its own Chrome. On WSL there is usually no Linux
Chrome, so run the fallback first:

```sh
scripts/webmcp-chrome.sh
```

It starts Windows Chrome with WebMCP on a separate profile, plus a relay, and
prints a `browser-url`. Put that in `.mcp.json` as `--browserUrl=...` and drop
`--chromeArg=--enable-features=WebMCP`. The gateway IP changes per boot — re-check
with `ip route show default` when it stops connecting.

The skill's Troubleshooting section explains why each of those three steps is
necessary.

## Contents

```
.claude-plugin/     plugin + marketplace manifests
.mcp.json           the chrome-webmcp server
skills/sond3r-tv/   the verbs, the loop, the limits
commands/tv-watch   the skip-driven watching loop
scripts/cut.mjs     the renderer montage hands off to
scripts/webmcp-chrome.sh   WSL fallback
```

## What it will not do

Spend money. Nothing here touches the wallet — `open-item` walks to the buy
button and a human presses it. With no consent primitive in the WebMCP spec, an
agent-callable `buy` is an agent-callable wallet.

It also cannot tell you who is speaking: the corpus has no speaker diarization,
so "find where character X says Y" is not answerable. The skill is explicit about
this and several other measured limits rather than letting an agent discover them
mid-task.
