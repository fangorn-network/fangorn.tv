#!/usr/bin/env python
"""
Drive the archive.org ingest into Fangorn, one namespace per collection,
with automated copyright status verification and filtering.

    QB=~/fangorn/embeddings/venv/bin/python

    # Dry run check with strict public domain enforcement
    $QB scripts/ingest/publish_archive.py --collection computerchronicles --dry-run --strict-pd

    # Stage volumes to disk
    $QB scripts/ingest/publish_archive.py --collection computerchronicles

    # On-chain settlement write
    $QB scripts/ingest/publish_archive.py --collection computerchronicles --publish

ONE NAMESPACE PER COLLECTION
----------------------------
A namespace is what quickbeam bakes into one CDN domain, which is the unit
`rankDomains()` in src/catalog/search.js scores and the unit a reader can decline to
download. A collection is the natural boundary — it is how archive.org already
groups these, and it is what the mock faked with `domainsOf()`. Paths stay
`<Collection>/<Title>.mp4` so the browse tree still nests underneath.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, Tuple

sys.path.insert(0, str(Path(__file__).parent))
from archive_source import MIN_SIGNALS, SIGNAL_NAMES, ArchiveVideoSource  # noqa: E402

# Constants
FANGORN_CONFIG = Path.home() / ".fangorn" / "config.json"
YEAR_RE = re.compile(r"\b(18\d{2}|19\d{2}|20\d{2})\b")
PUBLIC_DOMAIN_YEAR_CUTOFF = 1930
KNOWN_PD_COLLECTIONS = {
    "prelinger",
    "fedlink",
    "usnationalarchives",
    "nasa",
    "commons",
}
US_GOV_PUBLISHERS_TUPLE = (
    "national aeronautics and space administration",
    "united states army",
    "u.s. department of agriculture",
    "national archives",
)


def check_copyright_status(raw_item: dict) -> Tuple[str, str]:
    meta = raw_item.get("metadata", {})
    if not isinstance(meta, dict):
        meta = {}

    # 1. Check Internet Archive Explicit License URLs
    license_url = str(meta.get("licenseurl", "")).lower()
    if "publicdomain" in license_url or "cc0" in license_url:
        return "PUBLIC_DOMAIN", "Explicit CC0/PD license URL"
    if "creativecommons.org/licenses/" in license_url:
        return "PUBLIC_DOMAIN", f"Open CC License: {license_url}"

    # 2. Check Explicit Rights / Possible Copyright Status Fields
    rights = str(meta.get("rights", "")).lower()
    possible_status = str(meta.get("possible-copyright-status", "")).lower()
    if "public domain" in rights or "public domain" in possible_status:
        return "PUBLIC_DOMAIN", "Explicit PD rights text in metadata"

    # 3. Check Collection Origins
    collections = meta.get("collection", [])
    if isinstance(collections, str):
        collections = (collections,)
    for col in collections:
        if str(col).lower() in KNOWN_PD_COLLECTIONS:
            return "PUBLIC_DOMAIN", f"Item belongs to known PD collection: {col}"

    # 4. Check Creator / US Government Exemption (17 U.S.C. § 105)
    creator = str(meta.get("creator", "")).lower()
    publisher = str(meta.get("publisher", "")).lower()
    if any(gov in creator or gov in publisher for gov in US_GOV_PUBLISHERS_TUPLE):
        return "PUBLIC_DOMAIN", "US Federal Government work"

    # 5. Check Publication Year (95-Year Rule via Pre-compiled Regex)
    date_str = str(meta.get("date", meta.get("publicdate", "")))
    year_match = YEAR_RE.search(date_str)
    if year_match:
        pub_year = int(year_match.group(1))
        if pub_year <= PUBLIC_DOMAIN_YEAR_CUTOFF:
            return "PUBLIC_DOMAIN", f"Published in {pub_year} (<= {PUBLIC_DOMAIN_YEAR_CUTOFF})"

    # 6. Check Wikidata Entity Claims
    wikidata_claims = raw_item.get("wikidata_claims", {})
    p6216 = wikidata_claims.get("P6216")
    if p6216 == "Q19652":
        return "PUBLIC_DOMAIN", "Wikidata P6216 marks item as Public Domain"
    elif p6216 == "Q50423863":
        return "COPYRIGHTED", "Wikidata P6216 marks item as Copyrighted"

    return "UNKNOWN", "Insufficient metadata to confirm public domain status"


def filter_copyright_nodes(nodes: dict, stats: dict, strict_pd: bool = False, allow_unknown: bool = True) -> dict:
    """
    Applies the copyright verification logic across extracted video graph nodes.
    Drops copyrighted items and updates stats counters.
    """
    if "video" not in nodes:
        return nodes

    filtered_videos = []
    copyright_histogram: Dict[str, int] = {}

    for v in nodes["video"]:
        raw_item = v.get("raw", v.get("fields", {}))
        status, reason = check_copyright_status(raw_item)
        copyright_histogram[reason] = copyright_histogram.get(reason, 0) + 1

        if status == "COPYRIGHTED":
            stats["dropped_copyright"] = stats.get("dropped_copyright", 0) + 1
            continue
        elif status == "UNKNOWN" and strict_pd and not allow_unknown:
            stats["dropped_unverified_copyright"] = stats.get("dropped_unverified_copyright", 0) + 1
            continue
        
        # Attach status details to node fields for downstream indexing
        v["fields"]["copyright_status"] = status
        v["fields"]["copyright_reason"] = reason
        filtered_videos.append(v)

    nodes["video"] = filtered_videos
    stats["published"] = len(filtered_videos)
    return nodes


def whoami() -> dict:
    """Read configuration from ~/.fangorn/config.json."""
    try:
        cfg = json.loads(FANGORN_CONFIG.read_text())
    except Exception as e:
        raise SystemExit(f"cannot read {FANGORN_CONFIG}: {e}\nRun `fangorn init` first.")
    return {
        "appId": cfg.get("appId"),
        "chain": cfg.get("chainName"),
        "hasKey": bool(cfg.get("privateKey")),
    }


def namespace_for(collection: str) -> str:
    """Format on-chain namespace key segment."""
    return re.sub(r"[^a-z0-9]+", "-", collection.lower()).strip("-")


def report(
    stats: dict,
    nodes: dict,
    budget: dict,
    dropped_episodes: int = 0,
    blocked: dict | None = None,
    wikidata: dict | None = None,
    signals: dict | None = None,
) -> None:
    """Dry run report detailing admittance, gates, and wikidata matches."""
    total = sum(stats.values())
    kept = stats.get("published", 0)
    print(f"\n  gate: {kept}/{total} items admitted")
    for why, n in sorted(stats.items(), key=lambda kv: -kv[1]):
        if why != "published":
            print(f"    {n:5}  {why}")
            
    vids = nodes.get("video", [])
    identified = sum(1 for v in vids if v["fields"].get("qid"))
    pd_verified = sum(1 for v in vids if v["fields"].get("copyright_status") == "PUBLIC_DOMAIN")
    trs = nodes.get("subtitles", [])
    series = {v["fields"]["series"] for v in vids if v["fields"].get("series")}
    withtx = len({t["fields"]["videoPath"] for t in trs})

    if dropped_episodes:
        print(f"  episodes: {dropped_episodes} dropped as re-uploads of one already taken")
    if blocked:
        top = sorted(blocked.items(), key=lambda kv: -kv[1])[:8]
        print(
            f"  blocked: {sum(blocked.values())} on {len(blocked)} term(s) — "
            + ", ".join(f"{w} x{n}" for w, n in top)
            + (" ..." if len(blocked) > len(top) else "")
        )

    print(
        f"  graph: {len(vids)} video ({pd_verified} verified PD), {len(trs)} transcript passages, "
        f"{len(nodes.get('folder', []))} collection vertices"
    )
    print(
        f"         {len(series)} series, {len(vids) - sum(1 for v in vids if v['fields'].get('series'))} standalone, "
        f"{withtx} videos transcribed, {identified} identified"
    )

    if wikidata:
        hit = wikidata.get("matched", 0) + wikidata.get("cached hit", 0)
        tot = sum(wikidata.values())
        print(f"  wikidata: {hit}/{tot} identified" + (f" ({100 * hit // max(1, tot)}%)" if tot else ""))
        for why, n in sorted(wikidata.items(), key=lambda kv: -kv[1]):
            if not why.startswith(("matched", "cached")):
                print(f"    {n:5}  {why}")

    if signals:
        kept_count = max(1, stats.get("published", 0))
        rows = sorted(SIGNAL_NAMES, key=lambda m: -signals.get(m, 0))
        print("  signals earned by the admitted items:")
        for mark in rows:
            pct = 100 * signals.get(mark, 0) / kept_count
            note = "  ← never fires" if pct == 0 else "  ← free pass" if pct >= 90 else ""
            print(f"    {pct:5.1f}%  {signals.get(mark, 0):5}  {mark}{note}")
        free = sum(1 for m in rows if 100 * signals.get(m, 0) / kept_count >= 90)
        dead = sum(1 for m in rows if not signals.get(m))
        if free or dead:
            print(
                f"    → {len(rows) - free - dead} of {len(rows)} marks are actually "
                f"deciding anything; --min-signals is that much weaker than it reads"
            )
            
    if budget:
        print(
            f"  budget: ~{budget.get('estimated_bytes', 0) // 1000} KB estimated, "
            f"{budget.get('http_calls', 0)} archive.org requests"
        )

def fmt_dur(seconds: float) -> str:
    """Format duration in human-readable units."""
    if seconds < 1.0:
        return f"{seconds * 1000:.1f}ms"
    if seconds < 60.0:
        return f"{seconds:.2f}s"
    mins, secs = divmod(seconds, 60)
    return f"{int(mins)}m {secs:.1f}s"


def main() -> None:
    t_start = time.perf_counter()

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--collection", action="append", default=[], help="archive.org collection id; repeatable.")
    p.add_argument("--crawl", action="append", default=[], help="Walk the collection tree from this root.")
    p.add_argument("--query", action="append", default=[], help="Seed by search, e.g. --query digimon. Repeatable.")
    p.add_argument("--max-depth", type=int, default=2)
    p.add_argument("--max-collections", type=int, default=40)
    p.add_argument("--per-collection", type=int, default=500)
    p.add_argument("--sort", default="downloads desc")
    p.add_argument("--min-downloads", type=int, default=500)
    p.add_argument("--exclude-collection", action="append", default=None)
    p.add_argument("--min-collection-items", type=int, default=200)
    p.add_argument("--max-episodes", type=int, default=40)
    p.add_argument("--max-items", type=int, default=5000)
    p.add_argument("--max-bytes", type=int, default=64_000_000)
    p.add_argument("--min-signals", type=int, default=MIN_SIGNALS)
    p.add_argument("--max-per-creator", type=int, default=3)
    p.add_argument("--namespace", default="videos")
    p.add_argument("--require-transcript", action="store_true")
    p.add_argument("--no-transcripts", action="store_true")
    p.add_argument("--max-passages", type=int, default=40)
    p.add_argument("--no-wikidata", action="store_true")
    p.add_argument("--wikidata-cache", default="./stage_volumes/wikidata.jsonl")
    p.add_argument("--cache-file", default="./stage_volumes/resolved.jsonl")
    p.add_argument("--output-dir", default="./stage_volumes")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--publish", action="store_true")
    p.add_argument("--strict-pd", action="store_true", help="Reject items unless explicitly proven Public Domain.")
    p.add_argument("--disallow-unknown-copyright", action="store_true", help="Drop items marked as UNKNOWN copyright.")
    p.add_argument("--fangorn-bin", default=os.environ.get("FANGORN_BIN", "fangorn"))
    args = p.parse_args()

    if not (args.collection or args.crawl or args.query):
        raise SystemExit("nothing to crawl — pass --crawl <root>, --collection <id> or --query <text>.")

    who = whoami()
    ns = namespace_for(args.namespace)
    
    print("=" * 70)
    print(f"app       {who['appId']}   ({who['chain']})")
    print(f"mode      {'PUBLISH — this writes on-chain' if args.publish else 'stage only (no chain write)'}")
    print(f"namespace {ns}")
    print(f"copyright {'STRICT PUBLIC DOMAIN ONLY' if args.strict_pd else 'standard filter (blocks explicit infringement)'}")
    print(f"budget    ≤{args.max_items} videos, ≤{args.max_bytes // 1000} KB, ≤{args.max_episodes}/series, depth {args.max_depth}")
    print(f"cache     {args.cache_file}")
    print("=" * 70 + "\n")
    
    Path(args.cache_file).parent.mkdir(parents=True, exist_ok=True)

    if args.publish and not who["hasKey"]:
        raise SystemExit("no key in ~/.fangorn/config.json — run `fangorn init`.")

    src = ArchiveVideoSource()
    passthrough = dict(
        collection=args.collection,
        crawl=args.crawl,
        query=args.query,
        max_depth=args.max_depth,
        max_collections=args.max_collections,
        per_collection=args.per_collection,
        max_episodes=args.max_episodes,
        max_items=args.max_items,
        max_bytes=args.max_bytes,
        require_transcript=args.require_transcript,
        no_transcripts=args.no_transcripts,
        max_passages=args.max_passages,
        cache_file=args.cache_file,
        sort=args.sort,
        min_downloads=args.min_downloads,
        exclude_collection=args.exclude_collection,
        min_collection_items=args.min_collection_items,
        min_signals=args.min_signals,
        max_per_creator=args.max_per_creator,
        no_wikidata=args.no_wikidata,
        wikidata_cache=args.wikidata_cache,
    )

    # ── STAGE 1: Network Ingest (Source Read) ──────────────────────────────── Checkpoint
    print("⚡ Stage 1/4: Reading source items (Network/Disk IO)...")
    t_stage1 = time.perf_counter()
    records = src.read(0, argparse.Namespace(**passthrough))
    dur_stage1 = time.perf_counter() - t_stage1
    rec_count = len(records) if isinstance(records, (list, dict, set)) else 0
    t_rate1 = (rec_count / dur_stage1) if dur_stage1 > 0 else 0
    print(f"   ✓ Read {rec_count:,} items in {fmt_dur(dur_stage1)} ({t_rate1:.1f} items/sec)\n")

    # ── STAGE 2: Pure Graph Building & Quality Gate ───────────────────────── Checkpoint
    print("⚡ Stage 2/4: Building graph & applying quality gates...")
    t_stage2 = time.perf_counter()
    nodes, _edges = src.build_graph(records)
    dur_stage2 = time.perf_counter() - t_stage2
    raw_node_count = sum(len(v) for v in nodes.values()) if isinstance(nodes, dict) else 0
    print(f"   ✓ Built {raw_node_count:,} raw nodes in {fmt_dur(dur_stage2)}\n")

    # ── STAGE 3: Copyright Filtering ──────────────────────────────────────── Checkpoint
    print("⚡ Stage 3/4: Filtering nodes for copyright compliance...")
    t_stage3 = time.perf_counter()
    nodes = filter_copyright_nodes(
        nodes, 
        src.stats, 
        strict_pd=args.strict_pd, 
        allow_unknown=not args.disallow_unknown_copyright
    )
    dur_stage3 = time.perf_counter() - t_stage3
    survived_video_count = len(nodes.get("video", []))
    total_survived_nodes = sum(len(v) for v in nodes.values()) if isinstance(nodes, dict) else 0
    print(f"   ✓ Filtered to {total_survived_nodes:,} valid nodes ({survived_video_count:,} videos) in {fmt_dur(dur_stage3)}\n")

    # Audit Report Summary
    report(
        src.stats,
        nodes,
        src.budget,
        src.dropped_episodes,
        src.blocked,
        src.wikidata_stats,
        src.signal_counts,
    )

    if not survived_video_count:
        dur_total = time.perf_counter() - t_start
        raise SystemExit(f"\n❌ Nothing survived the gate — nothing to publish. [Total elapsed: {fmt_dur(dur_total)}]")

    if args.dry_run:
        print("\n  a few of what would publish:")
        for v in nodes["video"][:12]:
            status_tag = v['fields'].get('copyright_status', 'UNKNOWN')
            print(f"    [{status_tag}] {v['fields']['path']}")
        
        dur_total = time.perf_counter() - t_start
        print(f"\n✨ Dry run complete in {fmt_dur(dur_total)}. Nothing was written. Drop --dry-run to stage, add --publish to settle on-chain.")
        return

    # ── STAGE 4: Staging & Publishing ─────────────────────────────────────── Checkpoint
    print("\n⚡ Stage 4/4: Initializing Quickbeam Publisher & Staging payload...")
    t_stage4 = time.perf_counter()
    
    import quickbeam as qb

    pub = qb.Publisher(src, namespace=ns, output_dir=args.output_dir, fangorn_bin=args.fangorn_bin)
    pub.ingest(**passthrough)
    staged = sorted(Path(args.output_dir).glob(f"volume_{pub.volume}_*.json"))
    dur_stage4_ingest = time.perf_counter() - t_stage4
    print(f"   ✓ Staged {len(staged)} volume file(s) in {fmt_dur(dur_stage4_ingest)}: {', '.join(f.name for f in staged)}")

    if args.publish:
        t_pub = time.perf_counter()
        print(f"   🚀 Publishing → {ns} … (on-chain transaction in progress)")
        pub.publish(**passthrough)
        dur_pub = time.perf_counter() - t_pub
        print(f"   ✓ Committed and pushed to {ns} in {fmt_dur(dur_pub)}")
    else:
        print("\nℹ️  Nothing was written on-chain. Re-run with --publish to settle it.")

    # Total Telemetry Summary
    dur_total = time.perf_counter() - t_start
    print("-" * 70)
    print(f"⏱️  PERFORMANCE SUMMARY")
    print(f"   • Stage 1 (Ingest IO)    : {fmt_dur(dur_stage1)}")
    print(f"   • Stage 2 (Graph/Gate)   : {fmt_dur(dur_stage2)}")
    print(f"   • Stage 3 (Copyright)    : {fmt_dur(dur_stage3)}")
    print(f"   • Stage 4 (Staging/Pub)  : {fmt_dur(time.perf_counter() - t_stage4)}")
    print(f"   ----------------------------------------")
    print(f"   • Total Runtime          : {fmt_dur(dur_total)}")
    print("-" * 70)
