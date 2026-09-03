#!/usr/bin/env python
"""
Add semantic density to a catalog that is ALREADY on-chain: transcribe the video,
summarize it in windows, optionally describe what is on screen, and commit the
result as new `subtitles` vertices. Nothing already published is rewritten.

    QB=~/fangorn/embeddings/venv/bin/python

    $QB scripts/ingest/enrich.py --limit 2                 # transcribe 2, write .vtt, no chain write
    $QB scripts/ingest/enrich.py --limit 50 --publish      # settle them, 10 videos per commit
    $QB scripts/ingest/enrich.py --publish                 # run until the catalog is done

WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG ON publish_archive.py
------------------------------------------------------------------
The crawl ran `--no-transcripts` and the graph is 21k video vertices deep. Re-running
the crawl to attach cues would re-resolve every item over the network to rebuild rows
that already exist. `fangorn commit` without `--replace` MERGES, so the cheap path is
to read the published graph once, work out what is missing, and commit only the new
vertices. A video vertex is never in the batch, so it is never touched.

A SCENE DESCRIPTION IS A SUBTITLE CUE
-------------------------------------
Same reasoning as src/catalog/scenes.js: `{start, end, text}` is already what the
search pipeline embeds and seeks to, so an ASR line, an LLM window summary and a VLM
frame caption are all the same vertex shape and cost no client changes. `role` says
which is which for anyone who later wants to weight them differently.

WHAT RUNS WHERE (measured on this box: RTX 2070S 8GB, 7GB WSL RAM)
   ffmpeg   pulls audio by range request  — 5 min of a 600MB mp4 in ~7s, no download
   whisper  distil-large-v3 fp16 on cuda  — ~16x realtime (300s audio in 18s)
   ollama   qwen3.5:0.8b for the summaries — the 4b needs more RAM than WSL has free
GPU memory is the ceiling, and whisper, the VLM and the summarizer run strictly one after
the other — never assume two of them fit at once on a 4GB card.

SEEING THE FILM, NOT JUST HEARING IT (--vision, UNMEASURED)
------------------------------------------------------------
`--vision qwen3-vl:4b` samples a frame every --vision-every seconds, captions each one
with the line that was being spoken over it, and feeds those captions to the window
summarizer alongside the dialogue. Everything above is measured on this box; the vision
leg is NOT — it was written for the 4GB laptop and has never been run. Try one film with
`--limit 1 --max-seconds 600` and read the captions before turning it loose on 21k.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from archive_source import parse_cues, to_passages  # noqa: E402

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
SUMMARY_PROMPT = (
    "Below is a transcript excerpt from a film or TV episode. In two sentences, say what "
    "happens in it, naming the concrete people, places, objects and actions. No preamble, "
    "no 'this excerpt', just the summary.\n\n"
)
VISION_PROMPT = (
    "Describe this frame from a film in one sentence: who or what is on screen, where, "
    "and what is happening. No preamble."
)


# ── the published graph ──────────────────────────────────────────────────────
def read_graph(cache: Path, repo_dir: Path, namespace: str, fangorn_bin: str, refresh: bool) -> dict:
    """`fangorn read <ns>` is ~65MB and ~3 minutes for this catalog, so it is cached on
    disk. Refresh when another publisher may have committed since."""
    if cache.exists() and not refresh:
        print(f"graph: {cache} ({cache.stat().st_size // 1_000_000} MB, cached — --refresh to re-read)")
        return json.loads(cache.read_text())
    cache.parent.mkdir(parents=True, exist_ok=True)
    print(f"graph: reading namespace {namespace} on-chain (minutes, not seconds)…")
    t = time.time()
    with cache.open("wb") as f:
        r = subprocess.run([*shlex.split(fangorn_bin), "read", namespace], cwd=repo_dir, stdout=f)
    if r.returncode != 0:
        cache.unlink(missing_ok=True)
        raise SystemExit(f"fangorn read failed (exit {r.returncode}) in {repo_dir}")
    print(f"       {cache.stat().st_size // 1_000_000} MB in {time.time() - t:.0f}s")
    return json.loads(cache.read_text())


def pending(graph: dict, done: set[str]) -> list[dict]:
    """Video payloads with no cues attached yet. `fangorn read` returns vertices as
    {cid, schemaId, payload} — the commit-time id is NOT in the output, which is why
    nothing here tries to match on it and everything keys on `path`."""
    have = set(done)
    vids = []
    for v in graph.get("vertices", []):
        p = v.get("payload") or {}
        if v.get("schemaId") == "subtitles" or p.get("entityType") == "subtitles":
            have.add(p.get("videoPath"))
        elif p.get("entityType") == "video" and p.get("url"):
            vids.append(p)
    return [v for v in vids if v.get("path") not in have]


# ── ASR ──────────────────────────────────────────────────────────────────────
def vtt_path(out_dir: Path, path: str) -> Path:
    return out_dir / (re.sub(r"[^A-Za-z0-9]+", "_", path)[:150] + ".vtt")


def stamp(s: float) -> str:
    h, rem = divmod(max(0.0, s), 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h):02}:{int(m):02}:{sec:06.3f}"


def write_vtt(cues: list[dict], dest: Path) -> None:
    dest.write_text("WEBVTT\n\n" + "".join(
        f"{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text'].strip()}\n\n" for c in cues))


def audio_of(url: str, dest: Path, seconds: int | None) -> bool:
    """Remote mp4 → 16k mono wav, by HTTP range request. ffmpeg reads only the bytes it
    needs, so this never downloads the video."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", url]
    if seconds:
        cmd += ["-t", str(seconds)]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(dest)]
    return subprocess.run(cmd, timeout=3600).returncode == 0


def transcribe(model, url: str, wav: Path, language: str | None, seconds: int | None) -> list[dict] | None:
    if not audio_of(url, wav, seconds):
        return None
    segs, _info = model.transcribe(str(wav), vad_filter=True, language=language)
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segs if s.text.strip()]


# ── ollama: window summaries, and optionally what is on screen ───────────────
def ollama(model: str, prompt: str, images: list[str] | None = None, timeout: int = 300) -> str:
    body = {"model": model, "prompt": prompt, "stream": False, "think": False,
            "keep_alive": "120s", "options": {"num_ctx": 8192, "temperature": 0.2}}
    if images:
        body["images"] = images
    req = urllib.request.Request(f"{OLLAMA}/api/generate", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.load(r)
    except Exception as e:  # noqa: BLE001 — a summary is an extra, never a reason to lose a transcript
        print(f"    ollama: {e}", file=sys.stderr)
        return ""
    if out.get("error"):
        print(f"    ollama: {out['error']}", file=sys.stderr)
        return ""
    return (out.get("response") or "").strip()


def summarize(passages: list[dict], model: str, window: int) -> list[dict]:
    """One cue per `window` seconds. The summary is what a searcher's sentence actually
    looks like ("the scene where they argue about the bar") — the verbatim lines rarely
    contain those words, which is the whole point of doing this.

    `passages` is dialogue AND frame captions, merged and sorted by start: the text model
    is summarizing what was said together with what was on screen, so it can write "Klonsky
    at the lectern as the crowd chants" from two sources neither of which says it. For a
    silent film the dialogue half is simply empty and the summaries are built from frames
    alone, which is the only signal such an item has ever had."""
    out, bucket = [], []
    for p in sorted(passages, key=lambda c: c["start"]) + [None]:
        if bucket and (p is None or p["start"] - bucket[0]["start"] > window):
            text = " ".join(b["text"] for b in bucket)[:6000]
            s = ollama(model, SUMMARY_PROMPT + text)
            if s:
                out.append({"start": bucket[0]["start"], "end": bucket[-1]["end"], "text": s})
            bucket = []
        if p:
            bucket.append(p)
    return out


def probe_duration(url: str) -> float:
    """Seconds, from the container header. Most video payloads carry duration 0 because
    the IA metadata didn't, and the vision pass needs to know where to stop."""
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", url], capture_output=True, text=True, timeout=300)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def look(url: str, model: str, every: int, duration: float, tmp: Path,
         dialogue: list[dict] | None = None) -> list[dict]:
    """A frame every `every` seconds through a vision model, each captioned in one line.
    Off unless --vision names a model (`ollama pull qwen3-vl:4b`, or qwen2.5vl:3b on a
    4GB card) — nothing vision-capable is pulled by default.

    ponytail: SAMPLED at a fixed interval, not cut on shot boundaries. ffmpeg's
    `select='gt(scene,…)'` is the better feature extractor and it is one flag, but it
    decodes the whole file — which for a remote 4GB mp4 means downloading a remote 4GB
    mp4, times 21k. `-ss` BEFORE `-i` seeks by range request, so a frame costs a frame.
    Upgrade path if the corpus ever lands on local disk: swap this loop for one
    scene-detect pass and keep everything below it unchanged.

    The caption is CONDITIONED on whatever was being said at that moment. A VLM shown a
    lone frame writes "a man at a microphone"; the same frame with the line under it gets
    the name, and a name is what makes the row findable."""
    cues = []
    lines = dialogue or []
    for t in range(every // 2, int(duration or 0), every):
        jpg = tmp / "frame.jpg"
        # -ss before -i: seek first, then open — the whole reason this is affordable.
        if subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(t), "-i", url,
                           "-frames:v", "1", "-vf", "scale=640:-1", str(jpg)],
                          timeout=300).returncode != 0 or not jpg.exists():
            continue
        said = next((c["text"] for c in lines if c["start"] <= t <= c["end"]), "")
        prompt = VISION_PROMPT + (f"\n\nThe audio at this moment says: {said[:600]}" if said else "")
        desc = ollama(model, prompt, images=[base64.b64encode(jpg.read_bytes()).decode()])
        if desc:
            cues.append({"start": float(t), "end": float(t), "text": desc})
    return cues


# ── vertices ─────────────────────────────────────────────────────────────────
def vertices_for(video: dict, cues: list[dict], role: str, tag: str) -> list[dict]:
    """One vertex per passage, exactly as archive_source.build_graph emits them: no
    `path` (so it stays out of the browse tree) and a `videoPath` the client resolves
    back to the file. Ids are derived from the video's path because `fangorn read` does
    not return the commit-time id of the video vertex — and they only have to be stable
    and unique, which `<path>#<role><i>` is."""
    path = video["path"]
    return [{"id": f"subs:{path}#{tag}{i}", "tag": "subtitles", "payload": {
        "entityType": "subtitles", "kind": "subtitles",
        "name": video.get("name") or path.split("/")[-1],
        "videoPath": path, "role": role,
        "cues": [c], "start": c["start"], "end": c["end"], "text": c["text"],
    }} for i, c in enumerate(cues)]


def commit(vertices: list[dict], repo_dir: Path, namespace: str, fangorn_bin: str, publish: bool) -> bool:
    """Merge semantics on purpose: no --replace, so this adds vertices to the tip and
    leaves the 21k video vertices exactly as they were committed."""
    from quickbeam.ingest.scrapers.harness import fangorn_commit_push, fangorn_repo_init
    batch = repo_dir / "enrich_batch.json"
    batch.write_text(json.dumps({"vertices": vertices, "edges": []}))
    if not publish:
        print(f"  staged {len(vertices)} vertices → {batch} (add --publish to settle)")
        return True
    return (fangorn_repo_init(namespace=namespace, fangorn_bin=fangorn_bin, cwd=str(repo_dir), tag="enrich")
            and fangorn_commit_push(batch_path=str(batch), fangorn_bin=fangorn_bin, cwd=str(repo_dir),
                                    tag="enrich",
                                    message=f"enrich: {len(vertices)} subtitle vertices"))


def self_check() -> None:
    cues = [{"start": 0.0, "end": 2.0, "text": "a"}, {"start": 2.0, "end": 4.0, "text": "b"},
            {"start": 900.0, "end": 902.0, "text": "c"}]
    assert parse_cues("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\na\n")[0]["text"] == "a"
    p = to_passages(cues)
    assert len(p) == 2 and p[0]["text"] == "a b", p          # gap breaks the passage
    v = vertices_for({"path": "x/y.mp4", "name": "y.mp4"}, p, "asr", "p")
    assert [x["id"] for x in v] == ["subs:x/y.mp4#p0", "subs:x/y.mp4#p1"]
    assert v[0]["payload"]["videoPath"] == "x/y.mp4" and "path" not in v[0]["payload"]
    g = {"vertices": [
        {"schemaId": "video", "payload": {"entityType": "video", "path": "a.mp4", "url": "u"}},
        {"schemaId": "video", "payload": {"entityType": "video", "path": "b.mp4", "url": "u"}},
        {"schemaId": "subtitles", "payload": {"entityType": "subtitles", "videoPath": "a.mp4"}}]}
    assert [x["path"] for x in pending(g, set())] == ["b.mp4"]           # already has cues
    assert pending(g, {"b.mp4"}) == []                                   # already in the ledger
    n = len(summarize(p, "no-such-model-xyz", 60))
    assert n == 0, "a dead ollama must lose summaries, not raise"
    # Frame captions arrive after the dialogue they belong between; summarize() must
    # interleave them by timestamp rather than tack them on the end.
    merged = sorted(p + [{"start": 1.0, "end": 1.0, "text": "a wide shot"}], key=lambda c: c["start"])
    assert [c["text"] for c in merged] == ["a b", "a wide shot", "c"]
    assert look("http://nowhere/x.mp4", "m", 300, 0, Path("/tmp")) == [], "no duration → no ffmpeg"
    assert probe_duration("/nonexistent.mp4") == 0.0
    assert stamp(3661.5) == "01:01:01.500"
    print("enrich.py self-check ok")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--namespace", default="videos")
    p.add_argument("--stage-dir", default="./stage_volumes", help="where the crawl staged its volumes")
    p.add_argument("--graph-cache", default=None, help="default <stage-dir>/graph_<namespace>.json")
    p.add_argument("--refresh", action="store_true", help="re-read the on-chain graph (~3 min)")
    p.add_argument("--limit", type=int, default=0, help="stop after N videos (0 = the whole catalog)")
    p.add_argument("--batch-size", type=int, default=10, help="videos per fangorn commit")
    p.add_argument("--order", choices=["asc", "desc", "shuffle"], default="desc",
                   help="by size: desc does the features first, shuffle spreads the sample")
    p.add_argument("--max-seconds", type=int, default=0, help="only transcribe the first N seconds of each")
    p.add_argument("--model", default="distil-large-v3")
    p.add_argument("--device", default="cuda")
    p.add_argument("--compute-type", default="float16")
    p.add_argument("--language", default="en", help="empty string to let whisper detect it")
    p.add_argument("--summary-model", default="qwen3.5:0.8b")
    p.add_argument("--summary-window", type=int, default=480)
    p.add_argument("--no-summary", action="store_true")
    p.add_argument("--vision", default="", help="ollama vision model for frame captions, "
                   "e.g. qwen3-vl:4b (qwen2.5vl:3b on a 4GB card) — must be pulled first")
    p.add_argument("--vision-every", type=int, default=300)
    p.add_argument("--publish", action="store_true", help="ON-CHAIN: commit + push each batch")
    p.add_argument("--app", default=os.environ.get("FANGORN_APP_ID", ""),
                   help="app (global namespace) to read and publish under — name or 32-byte id. "
                        "Default: whatever `fangorn set-app` stored.")
    p.add_argument("--fangorn-bin", default=os.environ.get("FANGORN_BIN", "fangorn"))
    p.add_argument("--self-check", action="store_true")
    args = p.parse_args()
    if args.self_check:
        return self_check()

    # `--app` is a GLOBAL option on the fangorn CLI, so it rides in the invocation prefix
    # rather than being threaded through every call site: `fangorn --app X read videos`.
    # It overrides `fangorn set-app` for this run and nothing else.
    stage = Path(args.stage_dir)
    fangorn_bin = f"{args.fangorn_bin} --app {shlex.quote(args.app)}" if args.app else args.fangorn_bin
    # A head is per app+owner+namespace on-chain, so two apps must not share one repo
    # pointer or a local HEAD from one is pushed against the tip of the other. Same
    # reason the ledger of what has been committed is scoped: one namespace enriched
    # under two apps is two separate jobs.
    scope = f"{re.sub(r'[^A-Za-z0-9]+', '-', args.app)}_{args.namespace}" if args.app else args.namespace
    repo_dir = stage / ".fangorn-repos" / scope       # `.fangorn-repos/videos` is the crawl's own dir
    repo_dir.mkdir(parents=True, exist_ok=True)
    out_dir = stage / "vtt"                           # the .vtt cache is app-agnostic: it is just the audio
    out_dir.mkdir(parents=True, exist_ok=True)
    ledger = out_dir / f"published_{scope}.jsonl"                # committed paths, so a re-run is free
    done = {json.loads(l)["path"] for l in ledger.read_text().splitlines()} if ledger.exists() else set()

    cache = Path(args.graph_cache) if args.graph_cache else stage / f"graph_{scope}.json"
    graph = read_graph(cache, repo_dir, args.namespace, fangorn_bin, args.refresh)
    todo = pending(graph, done)
    if args.order == "shuffle":
        import random
        random.shuffle(todo)
    else:
        todo.sort(key=lambda v: v.get("size") or 0, reverse=args.order == "desc")
    if args.limit:
        todo = todo[:args.limit]
    print(f"app: {args.app or '(stored — see `fangorn set-app`)'}  namespace: {args.namespace}")
    print(f"pending: {len(todo)} videos without cues"
          f" ({len(done)} already committed by an earlier run)")
    if not todo:
        return

    from faster_whisper import WhisperModel
    print(f"asr: loading {args.model} on {args.device}…")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    batch: list[dict] = []
    batch_paths: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for n, video in enumerate(todo, 1):
            path = video["path"]
            print(f"\n[{n}/{len(todo)}] {path}")
            dest = vtt_path(out_dir, path)
            t0 = time.time()
            if dest.exists():
                cues = parse_cues(dest.read_text())
                print(f"  vtt: {len(cues)} cues (cached)")
            else:
                cues = transcribe(model, video["url"], tmp / "a.wav", args.language or None,
                                  args.max_seconds or None)
                # A silent film has nothing to transcribe and is exactly the item the
                # catalog is most blind to. It is only a dead end when there are no eyes
                # on it either.
                if not cues and not args.vision:
                    print("  no audio or nothing said — skipped")
                    continue
                write_vtt(cues, dest)
                print(f"  vtt: {len(cues)} cues in {time.time() - t0:.0f}s → {dest.name}")

            passages = to_passages(cues)
            new = vertices_for(video, passages, "asr", "p")
            scenes = []
            if args.vision:
                # Before the summaries, so they can be written from both streams.
                dur = video.get("duration") or (cues[-1]["end"] if cues else 0) or probe_duration(video["url"])
                scenes = look(video["url"], args.vision, args.vision_every, dur, tmp, passages)
                new += vertices_for(video, scenes, "scene", "v")
                print(f"  scenes: {len(scenes)} frames over {dur:.0f}s")
            if not args.no_summary:
                s = summarize(passages + scenes, args.summary_model, args.summary_window)
                new += vertices_for(video, s, "summary", "s")
                print(f"  summary: {len(s)} windows")
            print(f"  → {len(new)} vertices ({len(passages)} passages)")
            batch += new
            batch_paths.append(path)

            if len(batch_paths) >= args.batch_size:
                if commit(batch, repo_dir, args.namespace, fangorn_bin, args.publish) and args.publish:
                    with ledger.open("a") as f:
                        for bp in batch_paths:
                            f.write(json.dumps({"path": bp}) + "\n")
                batch, batch_paths = [], []

    if batch and commit(batch, repo_dir, args.namespace, fangorn_bin, args.publish) and args.publish:
        with ledger.open("a") as f:
            for bp in batch_paths:
                f.write(json.dumps({"path": bp}) + "\n")
    print("\ndone." + ("" if args.publish else " Nothing was written on-chain — re-run with --publish."))


if __name__ == "__main__":
    main()
