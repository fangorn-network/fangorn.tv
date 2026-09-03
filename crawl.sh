#!/usr/bin/env bash
#
# The wide archive.org crawl, one root per invocation of the ingest script.
#
#   ./crawl.sh              look only — crawl, judge, print the report, write nothing
#   ./crawl.sh --stage      write volumes to disk, still no chain write
#   ./crawl.sh --publish    ON-CHAIN: fangorn repo init + commit + push, per root
#
# Dry run is the default because --publish is a real, irreversible write into the
# wallet configured in ~/.fangorn/config.json, and "let me see what this would do"
# must never be the thing that does it.
#
# WHY ONE ROOT PER RUN, AND NOT ONE COMMAND WITH THREE --crawl FLAGS
# ------------------------------------------------------------------
# --max-items is a GLOBAL ceiling, checked at the top of the source loop, and
# sources are visited in order. Passing all three roots to one invocation means
# `television` spends the whole budget and `movies` and `animationandcartoons` are
# never reached — you get a catalog that is silently all TV and no error to say so.
# Splitting also makes each root separately resumable.
set -euo pipefail

QB=${QB:-$HOME/fangorn/embeddings/venv/bin/python}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STAGE=${STAGE:-$HERE/stage_volumes}
NAMESPACE=${NAMESPACE:-videos}
# ROOTS=${ROOTS:-"television movies animationandcartoons"}
ROOTS=${ROOTS:-"feature_films television animationandcartoons prelinger FedFlix nara nasa tvnews nationalfilmboardofcanada wellcomelibrary silent_films pennmuseum"}

# Per root, and MAX_BYTES is the one that actually binds — it is checked against
# an ESTIMATE of 2500 bytes per video vertex, so it is a video ceiling wearing a
# byte costume: 10 MB stopped all three roots at exactly 4,012 / 4,023 / 4,002
# videos, which is why a crawl of a 700k-item collection came back with 2.7k rows.
# Nothing about the keywords or the depth was wrong; the budget ran out on the
# first few collections of each root and the rest were never visited.
# 150 MB is ~60k video vertices per root. Sized ABOVE what the gate will pass on
# purpose: this number should stop a runaway, not shape the catalog.
MAX_ITEMS=${MAX_ITEMS:-50000}
MAX_BYTES=${MAX_BYTES:-1500000000}
# 2000, not 10000. This was a proxy for quality back when the gate was thin;
# --min-signals and --max-per-creator now do that job directly, and a high
# download floor mostly filters out OLD and OBSCURE, which is the opposite of what
# a broad catalog wants. Applied in the solr query, so rejections stay free.
MIN_DOWNLOADS=${MIN_DOWNLOADS:-1000}
MIN_SIGNALS=${MIN_SIGNALS:-5}

MODE=--dry-run
case "${1:-}" in
    --publish) MODE=--publish ;;
    --stage)   MODE= ;;
    --dry-run|"") ;;
    *) echo "usage: $0 [--dry-run|--stage|--publish]" >&2; exit 2 ;;
esac

[ -x "$QB" ] || { echo "no python at $QB — set QB=/path/to/python" >&2; exit 1; }
mkdir -p "$STAGE"

# The gate IS the product of this pipeline, and all three suites are pure — no
# network, no quickbeam, about a second. Running them here is the difference
# between a bad edit costing a second and costing an on-chain commit.
for suite in content_policy archive_source wikidata; do
    "$QB" "$HERE/scripts/ingest/test_$suite.py" >/dev/null \
        || { echo "!! scripts/ingest/test_$suite.py FAILED — refusing to crawl" >&2; exit 1; }
done
echo "gate self-checks pass"

failed=""
for root in $ROOTS; do
    echo
    echo "══ $root ══════════════════════════════════════════════════════════"
    # A root that yields nothing exits non-zero ("nothing survived the gate"), and
    # under `set -e` that would take the remaining roots down with it — losing two
    # good crawls to one bad one. Same rule the crawler applies to a dead branch of
    # the collection tree: report it and carry on. The script still exits non-zero
    # at the end, so this is visible to a caller and to CI.
    # Item caches are keyed by identifier and split per root; the Wikidata cache is
    # SHARED across all of them, because works repeat heavily between roots and the
    # titles that resolve to nothing are most of what it costs.
    "$QB" "$HERE/scripts/ingest/publish_archive.py" \
        --crawl "$root" \
        --max-depth 3 --max-collections 250 --per-collection 3000 \
        --min-downloads "$MIN_DOWNLOADS" \
        --max-items "$MAX_ITEMS" --max-bytes "$MAX_BYTES" \
        --max-episodes 60 \
        --min-signals "$MIN_SIGNALS" --max-per-creator 3 \
        --no-transcripts \
        --cache-file "$STAGE/$root.jsonl" \
        --wikidata-cache "$STAGE/wikidata.jsonl" \
        --output-dir "$STAGE" \
        --namespace "$NAMESPACE" \
        ${MODE:+"$MODE"} \
        "${@:2}" || { echo "!! $root failed or yielded nothing" >&2; failed="$failed $root"; }
done

echo
if [ -n "$failed" ]; then
    echo "!! no output from:$failed" >&2
fi
if [ "$MODE" = "--publish" ]; then
    echo "published${failed:+ (partially)} → namespace $NAMESPACE"
else
    echo "nothing was written on-chain. Re-run with --publish to settle it."
fi
[ -z "$failed" ]
