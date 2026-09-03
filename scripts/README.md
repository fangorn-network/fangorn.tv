The wide crawl:

    QB=~/fangorn/embeddings/venv/bin/python
    $QB scripts/ingest/publish_archive.py \
      --crawl television --crawl movies --crawl animationandcartoons \
      --max-depth 2 --max-collections 40 --per-collection 3000 \
      --min-downloads 10000 --max-items 100000 --max-bytes 100000000 \
      --max-episodes 30 --no-transcripts --namespace videos --publish

Add `--dry-run` first. It crawls, judges, prints the reason histogram and writes
nothing — which is the only way to find out whether a threshold is wrong before
spending an on-chain commit on it.

TWO GATES, AND THEY ARE NOT THE SAME KIND OF THING
--------------------------------------------------
`ingest/content_policy.py` is the BLOCK: adult and explicit material, refused
whatever else it has going for it. It is a legal boundary, it runs before every
other judgement, it has no override flag, and it has its own tests. English and
Spanish, with accents folded — which is what lets one list cover both, and which
is also why several obvious-looking terms are deliberately absent (`año` folds to
`ano`, `coño` to `cono`). The file says which and why; read that comment before
adding anything.

If you add a term, run `python3 scripts/ingest/test_content_policy.py` — the half
of that file worth reading is the list of real works that must NOT be blocked.

`ingest/archive_source.py`'s `judge()` is the QUALITY gate, and it is the dial you
actually turn:

    --min-signals N      how many marks of a complete published work (creator,
                         year, subject, description, episodes, runtime, audience)
                         an item must carry. 2 is a wide net, 3 the default, 4
                         admits only what somebody plainly catalogued.
    --max-per-creator N  items kept per creator across the whole crawl. This is
                         what stops one prolific uploader becoming the catalog.
                         A series counts once, however many episodes it has.
    --min-downloads N    a floor applied in the SEARCH QUERY, so rejections are
                         free. Drop it to 0 when seeding a --query for something
                         genuinely obscure.

IDENTIFICATION (`ingest/wikidata.py`)
-------------------------------------
On by default; `--no-wikidata` turns it off. One lookup per distinct WORK, not per
file, cached to `--wikidata-cache` including the misses.

Wikidata and not Wikipedia because Wikidata is **CC0** — labels, genres, cast,
dates and the IMDb id go into a vertex with no attribution to carry. Wikipedia has
far more prose (a matched work's lede runs ~1,800 chars against the 232 an IA
description carries) but it is CC BY-SA, and that provenance has to be mapped
before any of it is redistributed in a shard. That is a real piece of work, and
this is the half that needs none of it.

It does two jobs. It ENRICHES: on a live crawl the median embed text for an
identified row is 1,051 characters against 250 for an unidentified one. And it
IDENTIFIES: a title that resolves to nothing is usually not a title, so a match is
also `legitimacy()`'s `identified` signal — the only mark in that set that
archive.org does not supply about itself.

A wrong match is worse than no match, so `pick()` refuses on ambiguity. Two works
of one name and no year to separate them is a refusal, not a guess.

All three suites are pure — no network, no quickbeam:

    python3 scripts/ingest/test_content_policy.py
    python3 scripts/ingest/test_archive_source.py
    python3 scripts/ingest/test_wikidata.py
