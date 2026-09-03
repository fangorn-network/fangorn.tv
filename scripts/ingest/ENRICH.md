# enrich.py — quickstart

Transcribes published videos locally and commits the cues back as new `subtitles`
vertices. Existing vertices are never rewritten.

## Setup (once per machine)

```bash
export QB=~/fangorn/embeddings/venv/bin/python
$QB -m pip install faster-whisper          # pulls ctranslate2 + CUDA libs
$QB -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"   # want >= 1
ollama pull qwen3.5:0.8b                   # summaries
ollama pull qwen3-vl:4b                    # optional: --vision (qwen2.5vl:3b on 4GB)
ffmpeg -version && ffprobe -version
```

## Run

```bash
cd ~/fangorn/sond3r

$QB scripts/ingest/enrich.py --self-check                    # no network, ~1s
$QB scripts/ingest/enrich.py --limit 2                       # 2 videos, .vtt only, no chain write
$QB scripts/ingest/enrich.py --limit 2 --max-seconds 300     # first 5 min of each — fastest look
$QB scripts/ingest/enrich.py --limit 50 --publish            # ON-CHAIN, commits every 10 videos
$QB scripts/ingest/enrich.py --publish --order shuffle       # leave running; resumes where it stopped
```

Every command reads and publishes under the app `fangorn set-app` stored. Override it
per run — graph cache, repo pointer and ledger are all scoped to it, so two apps never
mix:

```bash
$QB scripts/ingest/enrich.py --app sond3r.test --limit 2
FANGORN_APP_ID=sond3r.test $QB scripts/ingest/enrich.py --limit 2      # same thing
fangorn set-app                                                        # what is stored now
```

First run spends ~3 min on `fangorn read videos` (65 MB) and ~50 s loading the ASR
model. Both are cached after that.

```bash
$QB scripts/ingest/enrich.py --refresh --limit 0             # re-read the on-chain graph
```

## With vision (the RTX 3050 box)

```bash
$QB scripts/ingest/enrich.py --limit 1 --max-seconds 600 --vision qwen3-vl:4b
cat stage_volumes/.fangorn-repos/videos/enrich_batch.json   # <scope> dir if --app was passed | jq -r '.vertices[].payload | "\(.role) \(.start) \(.text)"'
```

Read those captions before running it on the whole catalog — the vision leg has never
been measured.

```bash
$QB scripts/ingest/enrich.py --publish --vision qwen3-vl:4b --vision-every 180
```

## Flags worth knowing

```
--limit N            stop after N videos (0 = whole catalog)
--order asc|desc|shuffle   by file size. asc = most videos per hour, desc = features first
--max-seconds N      only transcribe the first N seconds of each
--batch-size N       videos per fangorn commit (default 10)
--model NAME         faster-whisper model (default distil-large-v3)
--device cpu         no GPU; pair with --compute-type int8
--language ""        let whisper detect instead of assuming English
--summary-model      ollama model for window summaries (default qwen3.5:0.8b)
--summary-window N   seconds of content per summary cue (default 480)
--no-summary         cues only
--vision MODEL       ollama vision model for frame captions (off unless set)
--vision-every N     seconds between sampled frames (default 300)
--app NAME-OR-ID     app (global namespace) to read and publish under
--publish            commit + push each batch on-chain
```

## Where things land

```
stage_volumes/graph_<scope>.json                   cached `fangorn read` output
stage_volumes/vtt/<path>.vtt                       one WebVTT per video — app-agnostic, reused on re-runs
stage_volumes/vtt/published_<scope>.jsonl          paths already committed
stage_volumes/.fangorn-repos/<scope>/              the repo dir; enrich_batch.json is the last batch
```

`<scope>` is the namespace, or `<app>_<namespace>` when --app is passed.

Delete a `.vtt` to redo that video. Delete `published_<scope>.jsonl` lines to re-commit them.

## Numbers (RTX 2070S, 8GB, WSL)

| step | cost |
| --- | --- |
| `fangorn read videos` | 65 MB, ~3 min (cached) |
| ASR model load | ~50 s, once per process |
| whisper distil-large-v3 fp16 | ~16x realtime |
| ffmpeg audio pull, 600 MB source | ~7 s per 5 min |
| ffmpeg audio pull, 4 GB source | ~5 min per 5 min ← the real bottleneck |
| summary window | ~2 s |

`--order asc` avoids the big-file case. Vision: unmeasured.

## Troubleshooting

```
model requires more system memory     → smaller --summary-model, or raise WSL memory in .wslconfig
no audio or nothing said — skipped    → silent or broken source; add --vision to index it anyway
fangorn read failed                   → wrong --app, or no `fangorn set-app` / FANGORN_APP_ID
pending: 0 videos                     → --app points at an app with no catalog under it
CUDA/cuDNN load errors                → --device cpu --compute-type int8, or reinstall nvidia-cudnn-cu12
```

Whisper, the VLM and the summarizer each want the GPU; they run one after another. Do not
run two copies of this script on one card.
