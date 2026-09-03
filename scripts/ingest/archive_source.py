"""
Crawl the Internet Archive's video structure into a Fangorn graph.

A quickbeam `Source`: `read()` does every network call, `build_graph()` is pure and
makes every judgement. That split is deliberate — the quality gate is the actual
product here, and a gate you can only exercise by hitting archive.org is a gate
nobody runs.

FOUR LEVELS, NOT TWO
--------------------
The first version of this file published one node per IA item, taking one video
derivative from each. That is wrong for most of the good content, because **one IA
item is often an entire series**: `digimon-digital-monsters-the-complete-collection`
is 587 files — 104 episodes as `.mkv`/`.mp4` pairs named
`Digimon Digital Monsters - 1x01 - And So It Begins....mp4`. Taking one derivative
published one arbitrary episode and hid the other 103.

    collection   television → classic_tv → classic_tv_1990s   (walked)
      └── series   one IA item holding many video files
            └── episode   one video FILE inside it
      └── film     an IA item holding a single video

`collection` vertices are tagged **`folder`**, which is in sond3r's STRUCTURAL set,
so quickbeam gets real tree edges to traverse while sond3r ignores them and keeps
synthesizing its browse tree from `path` the way it already does. Episodes and films
are both tagged `video` — sond3r has no reason to tell them apart, and the hierarchy
rides in the path.

THE FIELD NAMES ARE A CONTRACT
------------------------------
`_publish_to_fangorn` turns a node's `fields` into the vertex payload verbatim, and
quickbeam's CDN bake carries that into the shard row `pointer()` reads in
src/catalog/search.js. Rename a key here and the storefront silently loses a column.

Worse, quickbeam's `_project()` ENDS with `fields["entityType"] = root_type`, so the
entity key a node is emitted under — not the entityType we write — is what sond3r
sees. Hence the lowercase `video` / `subtitles` / `folder` keys below.

WHAT IS ALLOWED IN AT ALL
-------------------------
Two gates, and they are not the same kind of thing.

`content_policy.py` is the BLOCK: adult and explicit material, refused whatever
else it has going for it. That is a legal boundary rather than a taste, so it runs
before every other judgement, at four levels (the solr query, the search row, the
resolved item, the individual file), and it has no override flag. See that file.

`judge()` below is the QUALITY gate, and it is allowed to be wrong in both
directions. It answers one question — *is this a complete, catalogued work
somebody would be glad to find?* — and it is deliberately picky, because the
catalog is aiming at a broad audience with a varied shelf rather than at
completeness of the archive. Three ideas do the work:

  * a DEFECT is a rejection: no video, no cover, a filename for a description,
    boilerplate shared with four hundred siblings, a clip.
  * a FEED is not a work. `feed_shape()` — the Alex Jones problem: hundreds of
    dated three-hour broadcasts, every one of which passes every quality signal
    there is. What makes them one object rather than hundreds is that they are
    dated rather than titled, and that they are all one uploader's. Both are
    measurable, and neither needs a blocklist of names. This is "not now", not
    "never": a full talk-show catalog may well be worth indexing one day.
  * COMPLETENESS is positive. `legitimacy()` counts independent marks of a work
    somebody published — a credited creator, a plausible year, real subjects, a
    written description, a full run of distinctly titled episodes, feature
    runtime, an audience. `--min-signals` is the single dial that widens or
    tightens the whole crawl, and it is what leaves room for enrichment later:
    rows that carry a title, a year and a creator are rows Wikipedia can be
    matched against, where a bare filename is not.

BUDGETS
-------
IA has 739,282 items under `television` alone. Every limit in `add_source_args` is
there so a crawl cannot run away with quickbeam's index while it is being tested.
The defaults crawl WIDE (depth 2, 40 collections, 500 items each, 5,000 videos)
because the gate above is what keeps the catalog small, not the budget.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from content_policy import episode_block, record_block, solr_exclusions, text_block
    from wikidata import Wikidata, embed_text as wd_text
except ImportError:  # imported as a package rather than from its own directory
    from .content_policy import episode_block, record_block, solr_exclusions, text_block  # type: ignore
    from .wikidata import Wikidata, embed_text as wd_text  # type: ignore

try:
    from quickbeam import SourceBase
except ImportError:  # tests run without quickbeam installed
    class SourceBase:  # type: ignore[no-redef]
        name = ""
        snapshot_stems: set = set()
        role_map: dict = {}
        presentation: dict = {}
        stems: dict = {}
        edges_stem = "edges"
        default_volume = 1


# precompiled regex
WS_RE = re.compile(r"\s+")
TAGS_RE = re.compile(r"<[^>]+>")
ENTITY_RE = re.compile(r"&[a-z#0-9]+;")
PATH_SLASH_RE = re.compile(r"[/\\]+")
STEM_EXT_RE = re.compile(r"\.[A-Za-z0-9]{2,4}$")
STRIP_SEPS_RE = re.compile(r"^[ -–—._]+|[ -–—_]+$")

# ── thresholds, in one place ─────────────────────────────────────────────────
# Chosen against measured archive.org data. The comments say what goes wrong when
# each is relaxed.

MIN_DESC = 150       # below this a row is a filename; it embeds to noise
MIN_TOKENS = 25      # distinct content words across title+creator+subject+desc
MIN_SECONDS = 60     # a 20-second clip has nothing to say and clutters a shelf
# A STANDALONE item has to look like a work, and five minutes is the floor for
# that: a two-minute upload is a trailer, a title card, a test, or somebody's clip
# of something else. Episodes inside a series are still judged at MIN_SECONDS —
# the series is the work there, and a short cartoon episode is a real one.
MIN_FILM_SECONDS = 300
MAX_DESC = 4000
PASSAGE_CHARS = 800
PASSAGE_GAP = 30.0
# Rough on-chain cost of one vertex, for the --max-bytes budget. Deliberately an
# estimate — the point is a stop condition, not an invoice.
#
# 700 was measured before Wikidata enrichment, and enrichment changed it by 3.5x:
# 629 staged rows now serialize to 2,484 bytes each, because an identified row
# carries a description, genres, cast and a network where it used to carry a
# filename. Left at 700, `--max-bytes` was silently four times looser than it
# claimed and could never be the binding limit — which makes it a setting that
# lies, the same failure `--max-episodes` had.
BYTES_PER_VIDEO = 2500
BYTES_PER_PASSAGE = 1500

UA = {"user-agent": "sond3r-ingest/0.2 (semantic browser research; https://github.com/sond3r)",
      "accept-encoding": "gzip"}

# Words that describe nothing. Deliberately a SEPARATE list from src/geometry/kernel.js's:
# that one stops a topic being NAMED after a filler word, this one decides whether
# a description says anything at all. They overlap; they are not the same job.
STOP = set((
    "the a an and or of to in on for with at by from is it this that as be are was were "
    "his her its their they them then than there here when where which who what how why "
    "all any both each few more most other some such only own same so not but "
    "one two three first second also into out over under after before during while "
    "video film movie audio archive org collection item items public domain copyright "
    "rights reserved presented courtesy available online www http https download free "
    "uploaded digitized scanned please see also more information about"
).split())

TOKEN = re.compile(r"[a-z0-9']+")
TAGS = re.compile(r"<[^>]+>")
ENTITY = re.compile(r"&[a-z#0-9]+;")
WS = re.compile(r"\s+")


def clean(d) -> str:
    s = " ".join(d) if isinstance(d, list) else str(d or "")
    return WS_RE.sub(" ", ENTITY_RE.sub(" ", TAGS_RE.sub(" ", s))).strip()


def tokens(text: str) -> set[str]:
    return {t for t in TOKEN.findall(text.lower()) if len(t) > 2 and t not in STOP and not t.isdigit()}


def seg(s: str, limit: int = 80) -> str:
    """Filesystem-shaped. A slash inside a title would invent a folder that isn't
    there, and the tree in src/catalog/browse.js is synthesized from paths."""
    return WS.sub(" ", re.sub(r"[/\\]+", "-", str(s))).strip()[:limit].strip()


def fingerprint(desc: str) -> str:
    """Identity of a description for duplicate detection: content words, unordered,
    so a trivial edit ("Episode 4" → "Episode 5") still collides when the other 200
    words are identical boilerplate."""
    return hashlib.sha1(" ".join(sorted(tokens(desc))).encode()).hexdigest()


# ── episodes ─────────────────────────────────────────────────────────────────
# Every pattern here was seen in a real IA series item. A filename is the only place
# season/episode lives — IA has no episode metadata — so this is what turns 104
# loose files into an ordered season.

EPISODE_PATTERNS = (
    re.compile(r"\bS(?P<s>\d{1,2})\s*E(?P<e>\d{1,3})\b", re.I),          # S01E01
    re.compile(r"\b(?P<s>\d{1,2})\s*x\s*(?P<e>\d{1,3})\b", re.I),        # 1x01
    re.compile(r"\bseason\s*(?P<s>\d{1,2})\D{1,10}episode\s*(?P<e>\d{1,3})\b", re.I),
    re.compile(r"\bep(?:isode)?\.?\s*(?P<e>\d{1,3})\b", re.I),           # Episode 12
    re.compile(r"^\s*(?P<e>\d{1,3})\s*[-–—.]\s+"),                       # "01 - Title"
)
# Browser-playable only. Every episode in these collections ships an .mkv twin that
# no <video> element will play; publishing it gives a catalog of rows that load and
# then never start.
PLAYABLE = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg"}

# archive.org's own transcodes, appended to the source filename. `021931.mp4` and
# `021931_512kb.mp4` are ONE video; keyed on the raw stem they looked like two
# episodes called "021931" and "021931_512kb", which both inflated the catalog and
# meant a thin-description series looked like it had distinct episode titles.
DERIVATIVE_SUFFIX = re.compile(r"(_(?:\d{2,4}kb|512kb|edit|ia|archive|text))+$", re.I)


def base_stem(filename: str) -> str:
    """A video's identity within its item, with archive.org's transcode suffix
    removed. Two files that differ only by derivative collapse onto one row."""
    stem = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", filename.split("/")[-1])
    return DERIVATIVE_SUFFIX.sub("", stem).strip()


def episode_of(filename: str) -> tuple[int | None, int | None, str]:
    """(season, episode, title) from a video filename.

    Season defaults to 1 when only a bare episode number is found — `01 - Guilmon
    Comes Alive.mp4` is season one of something, and leaving it null would scatter a
    complete series across "no season".
    """
    stem = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", filename).strip()
    for pat in EPISODE_PATTERNS:
        m = pat.search(stem)
        if not m:
            continue
        g = m.groupdict()
        s = int(g["s"]) if g.get("s") else 1
        e = int(g["e"])
        # Whatever follows the marker is the episode title. Separators left behind
        # by "- 1x01 - " are stripped from the LEFT; the right keeps its dots,
        # because "And So It Begins..." ends in an ellipsis that is part of the
        # title and not punctuation we introduced.
        title = stem[m.end():].lstrip(" -–—._").rstrip(" -–—_")
        if not title:
            title = stem[:m.start()].lstrip(" -–—._").rstrip(" -–—_")
        return s, e, WS.sub(" ", title).strip()
    return None, None, WS.sub(" ", stem).strip()


# What an uploader appends to a series title. These are edition notes, not part of
# the show's name, and left in they become the folder you browse: "Digimon: Digital
# Monsters - The Complete Collection (Saban Entertainment - Engli" — truncated
# mid-word, because the raw title is 96 characters of provenance.
EDITION = re.compile(
    r"\s*[-–—(\[]?\s*\b("
    r"the\s+)?(complete|full)\s+(\w+\s+){0,2}(collection|series|seasons?|set)\b.*$|"
    r"\s*\((?:[^()]*\b(dub|sub|edition|version|remaster\w*|restored|uncut|"
    r"english|japanese|entertainment|dvd|blu-?ray|\d{4}\s*[-–]\s*\d{4})\b[^()]*)\)\s*$",
    re.I)


def series_name(title: str) -> str:
    """A show's name, without the uploader's edition notes.

    `Digimon: Digital Monsters - The Complete Collection (Saban Entertainment -
    English dub)` is one series called `Digimon: Digital Monsters`. The rest is
    provenance, and keeping it means the folder you browse is truncated mid-word
    and two uploads of one show never collapse onto the same name.
    """
    out = title
    for _ in range(3):  # a title can carry several: "(1999-2003, Saban…) (English dub)"
        stripped = EDITION.sub("", out).strip(" -–—,:")
        if stripped == out or not stripped:
            break
        out = stripped
    return WS.sub(" ", out).strip() or title


# The episode marker as it appears in an ITEM TITLE rather than a filename.
# Deliberately looser than EPISODE_PATTERNS about spacing — an uploader types
# "SOUTH PARK S 14 E 06 201( END UNCUT)" — because here we are not reading the
# numbers, only finding where the show's name stops.
TITLE_MARKER = re.compile(
    r"\b(s\s*\d{1,2}\s*[ex]\s*\d{1,3}|\d{1,2}\s*x\s*\d{1,3}"
    r"|season\s*\d{1,2}\D{1,10}episode\s*\d{1,3}|ep(?:isode)?\.?\s*\d{1,3})\b", re.I)

# Below this, a "show name" is an artifact rather than a name: `Ep 3` gives "", a
# two-letter prefix gives noise, and both would collect unrelated uploads into one
# folder — the exact failure this is meant to prevent.
MIN_SHOW_NAME = 3


# A bare season suffix, which EDITION above does not strip because it only knows
# the "Complete Series/Collection" forms. `South Park Season 13` and a scattered
# `SOUTH PARK S14E06` are the same show and must key alike, or the vouch below
# never fires and the episode never finds its folder.
SEASON_SUFFIX = re.compile(
    r"\s*[-–—(\[,]?\s*\b(season|series|saison|temporada|staffel|vol(?:ume)?|part|book)"
    r"\s*\.?\s*\d{1,2}\s*[)\]]?\s*$", re.I)


def show_key(name: str) -> str:
    """The identity two uploads of one show must share to be recognised as one.

    Lowercased on purpose: an uploader shouting `SOUTH PARK` and one writing
    `South Park` are not two shows. Used for the run index and the scattered-upload
    vouch; NOT for placing multi-video series, which keep their own titles.
    """
    out = series_name(name or "")
    for _ in range(2):  # "Doctor Who - Series 3 Part 2"
        stripped = SEASON_SUFFIX.sub("", out).strip(" -–—,:")
        if stripped == out or len(stripped) < MIN_SHOW_NAME:
            break
        out = stripped
    return WS.sub(" ", out).strip().lower()


def show_of(rec: dict) -> str | None:
    """The SERIES a scattered one-off upload belongs to, or None.

    archive.org holds a great deal of television as single-episode items — a
    banned episode, a lost pilot, one tape somebody digitised — sitting beside the
    complete-series uploads and unconnected to them. `south-park-s-14-e-06-201-end-uncut`
    is one item, one file, titled `SOUTH PARK S 14 E 06 201( END UNCUT)`. Nothing
    in the record says "South Park"; the show's name is only recoverable as the
    text before the episode marker.

    Recovered from the item title first and the filename second, because the title
    is what a person wrote and the filename is what their encoder wrote. Returns
    None when there is no marker or nothing convincing in front of it, which is
    the common case and must stay cheap — most items are not scattered episodes.
    """
    for text in (rec.get("title"), *(base_stem(v.get("file") or "")
                                     for v in (rec.get("videos") or [])[:1])):
        m = TITLE_MARKER.search(text or "")
        if not m or m.start() < MIN_SHOW_NAME:
            continue
        name = series_name(text[:m.start()].strip(" -–—:._([{"))
        if len(name) >= MIN_SHOW_NAME:
            return name
    return None


def episode_label(season: int | None, ep: int | None, title: str) -> str:
    """`S01E04 - Garurumon`, or just the title when it isn't episodic. The zero
    padding is what makes a plain lexical sort put episode 2 before episode 10."""
    if season is None or ep is None:
        return title or "untitled"
    return f"S{season:02d}E{ep:02d}" + (f" - {title}" if title else "")


# ── cues ─────────────────────────────────────────────────────────────────────

TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def _secs(m: re.Match) -> float:
    h, mm, ss, ms = m.groups()
    return int(h or 0) * 3600 + int(mm) * 60 + int(ss) + int(ms.ljust(3, "0")) / 1000


def parse_cues(text: str) -> list[dict]:
    """WebVTT or SubRip → [{start, end, text}]. One parser for both: they differ in
    a header, a comma-vs-dot and an index line, none of which survive this."""
    out = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if lines and lines[0].strip().upper().startswith("WEBVTT"):
            lines = lines[1:]
        if not lines:
            continue
        if lines[0].strip().isdigit() and len(lines) > 1:  # SubRip index line
            lines = lines[1:]
        stamps = list(TIME.finditer(lines[0]))
        if len(stamps) < 2:
            continue
        body = WS.sub(" ", " ".join(lines[1:])).strip()
        if body:
            out.append({"start": round(_secs(stamps[0]), 2), "end": round(_secs(stamps[1]), 2), "text": body})
    return out


def to_passages(cues: list[dict], chars: int = PASSAGE_CHARS, gap: float = PASSAGE_GAP) -> list[dict]:
    """Merge Whisper's ~5-second cues into passages worth embedding.

    Whisper emits a cue every breath; a 256-d vector of eight words is noise, and a
    vector of a whole hour is mush. Break on a character budget or on a silence long
    enough to be a scene change — the same rule server/shard.js uses, because a
    passage is the unit a search result seeks to.
    """
    out: list[dict] = []
    cur: dict | None = None
    for c in cues:
        if cur and (len(cur["text"]) + len(c["text"]) + 1 > chars or c["start"] - cur["end"] > gap):
            out.append(cur)
            cur = None
        if cur is None:
            cur = {"start": c["start"], "end": c["end"], "text": c["text"]}
        else:
            cur["text"] = f"{cur['text']} {c['text']}"
            cur["end"] = c["end"]
    if cur:
        out.append(cur)
    return out


# ── is this a WORK, or is it somebody's feed? ────────────────────────────────
#
# THE ALEX JONES PROBLEM. archive.org holds hundreds of items called "The Alex
# Jones Show 2015-03-04", each three hours, each with a real description, a real
# creator, a real thumbnail and tens of thousands of downloads. Every quality
# signal the gate had said yes, and the shelf filled with one man shouting.
#
# The fix is not a blocklist of names — there are a thousand daily shows and the
# next one is not on the list. It is that a daily broadcast is a different KIND of
# object from a work: it is dated rather than titled, it is one of hundreds by one
# uploader, and its identity is the date. All three are measurable.
#
# This is a "not now" judgement, not a "never" one. The full catalog of a talk
# show is legitimate content and may well be worth indexing later; it is not what
# a broad first launch should be made of.

DATED_TITLE = re.compile(r"""
    \b(19|20)\d{2}\s*[-/.]\s*(0?[1-9]|1[0-2])\s*[-/.]\s*(0?[1-9]|[12]\d|3[01])\b
  | \b(0?[1-9]|1[0-2])\s*[-/.]\s*(0?[1-9]|[12]\d|3[01])\s*[-/.]\s*((19|20)\d{2}|\d{2})\b
  | \b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?\s*,?\s*(19|20)\d{2}\b
  | \b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(19|20)\d{2}\b
""", re.X | re.I)

# What a feed episode is titled when it is not titled with a date. `hour 1` is
# talk radio; `full show` is a broadcast; a four-digit episode number is a daily.
#
# NB the escaped `\#`. These are re.X patterns, where a bare `#` opens a comment
# and eats the rest of the line — which truncated `episode #1234` to `episode`
# and rejected "Forensic Files All Episodes Collection", "BBC Horizon Collection
# 512 Episodes" and every other complete run as a feed. Exactly the rows the
# crawl exists to find, dropped by a comment character.
FEED_TITLE = re.compile(r"""
    \bhours?\s*[1-4]\b | \bfull\s+(show|broadcast|episode\s+archive)\b
  | \blive\s*stream\b | \bstream\s+(archive|vod)\b | \bcall[\s-]?in\s+show\b
  | \bdaily\s+(show|broadcast|briefing|update|news)\b | \bnews\s*cast\b
  | \bepisode\s*\#?\s*\d{4,}\b | \#\s*\d{3,}\b        # "…Show #2456"
  | \bwebcam\b | \bscreen\s*(cast|recording)\b
  | \bre-?upload\b | \btest\s+(upload|video)\b | \buntitled\b
  | \bmy\s+(video|movie|upload)\b | \bpart\s*\d{3,}\b
""", re.X | re.I)


def feed_shape(title: str) -> str | None:
    """Why this title is an episode of a feed rather than a work, or None."""
    if DATED_TITLE.search(title or ""):
        return "dated broadcast, not a titled work"
    if FEED_TITLE.search(title or ""):
        return "looks like a feed episode (stream, full show, daily)"
    return None


# ── does it look complete and published? ─────────────────────────────────────
#
# The other half of pickiness, and the positive half. Everything above says what
# to throw away; this says what has to be TRUE before something is kept.
#
# No single one of these is required, because each is missing from something
# excellent: plenty of public-domain features carry no creator, plenty of good
# uploads carry no year, and a fine series has a two-line blurb. But an item that
# has almost none of them is not a work anybody catalogued — it is a file somebody
# uploaded. Requiring N of them is the dial: it widens and tightens the crawl
# without a single new threshold to tune.

FEATURE_SECONDS = 1200      # 20 minutes: an episode or a feature, not a segment
RICH_DESC = 400             # somebody wrote about this, rather than pasting a line
POPULAR_DOWNLOADS = 2000    # IA's only free quality signal, at a level that means it
COMPLETE_EPISODES = 6       # enough episodes to be a run of a show, not two scraps
CURRENT_YEAR = 2026         # a year past this is a typo or a stream date, not a work


YEAR_RE = re.compile(r"\d{4}")


def first_year(*vals):
    """The earliest four-digit year in the first of `vals` that has one.

    archive.org's solr fields are MULTI-VALUED, and `year` is no exception: an
    item with two release dates comes back as `[1964, 1965]`. That went into the
    payload as the list itself, which every consumer downstream reads as the
    string "[1964,1965]" — it fails the isdigit() gate in legitimacy() below (so
    the item silently loses a signal it earned) and it fails Number() in the
    viewer and the catalog summary, where one such row printed a whole
    collection's year span as NaN–NaN. `subject` and `collection` are normalized
    for exactly this reason a few lines down in _record; this is the third field
    with the same problem, not a new one.
    """
    for v in vals:
        found = [int(m) for x in (v if isinstance(v, list) else [v]) for m in YEAR_RE.findall(str(x or ""))]
        if found:
            return min(found)
    return None


def legitimacy(rec: dict) -> set[str]:
    """Which marks of a real, catalogued, complete work this item carries.

    Deliberately independent signals — a boilerplate uploader can fake any one of
    them, and faking four means having actually done the work.
    """
    got: set[str] = set()
    creator = clean(rec.get("creator"))
    # An email or a bare handle is an uploader, not a credited creator.
    if len(creator) > 2 and "@" not in creator:
        got.add("creator")
    year = str(rec.get("year") or "")[:4]
    if year.isdigit() and 1870 <= int(year) <= CURRENT_YEAR:
        got.add("year")
    if len(rec.get("subject") or []) >= 2:
        got.add("subject")
    if len(clean(rec.get("desc"))) >= RICH_DESC:
        got.add("description")
    videos = rec.get("videos") or []
    n_titles, _ = episode_signal(rec)
    if len(videos) >= COMPLETE_EPISODES and n_titles >= COMPLETE_EPISODES:
        # A run of distinctly titled episodes IS the completeness we are after —
        # the whole reason for preferring a series item over a loose upload.
        got.add("episodes")
    if any((v.get("duration") or 0) >= FEATURE_SECONDS for v in videos):
        got.add("runtime")
    if int(rec.get("downloads") or 0) >= POPULAR_DOWNLOADS:
        got.add("audience")
    # The only mark here that archive.org does not supply about itself, and the
    # strongest one for that reason: somebody else, independently, has a record of
    # this work existing. Measured on a live crawl, the titles that resolve to
    # nothing are `28-2fweg`, `BOLADEDRAC CAT` and `BBC-packs-01-ArabHD.net`,
    # while the ones that resolve are Bonanza, Blackadder and Blue's Clues.
    if rec.get("wikidata"):
        got.add("identified")
    # A SCATTERED EPISODE, vouched for by the run it belongs to.
    #
    # `episodes` is the completeness mark, and a one-file item can never earn it
    # on its own — which is why archive.org's single-episode uploads (a banned
    # episode, a lost pilot, one tape somebody digitised) fail a gate that the
    # complete-series upload of the same show sails through. `series_of` is set
    # in build_graph's pre-pass and ONLY when some other record in this crawl
    # holds a real run of that same show, so the completeness being credited here
    # is real and present, just attributed to the show rather than the item.
    if rec.get("series_of"):
        got.add("episodes")
    return got


SIGNAL_NAMES = ("creator", "year", "subject", "description", "episodes", "runtime",
                "audience", "identified")
MIN_SIGNALS = 3


# ── the gate ─────────────────────────────────────────────────────────────────

def episode_signal(rec: dict) -> tuple[int, int]:
    """(distinct episode titles, content words across them).

    A series can carry a two-line item description and still be full of signal,
    because the signal is in the episode titles: *Digimon Ghost Game* has a 102-char
    blurb and 30 episodes called "The Sewn-Mouth Man", "The Mystery of the Museum",
    "Scribbles". Judging that item on its description alone threw away 30 real rows.

    The same measure rejects the other half of the population: *Digimon Xros Wars*
    has 30 episodes all titled "Digimon Xros Wars", and `Health: Your Posture` has
    "HealthYo1953" three times. Distinctness is what separates them.
    """
    titles = {(v.get("title") or "").strip().lower() for v in rec.get("videos", [])}
    titles.discard("")
    return len(titles), len(tokens(" ".join(titles)))


# How many items may share one description before the rest are assumed to be
# collection boilerplate and dropped without a metadata call. NOT 1: `judge()`
# already keeps only the first, but two uploads of one series legitimately share a
# blurb and are then admitted on their DISTINCT episode titles — a pre-gate of 1
# would drop the second upload before its episode titles were ever fetched. Three
# wasted metadata calls per boilerplate group is the price of not doing that.
BOILERPLATE_COPIES = 3


# A series must clear both to stand in for a description: enough DISTINCT episode
# titles, and enough content in them. Measured against the two populations above.
MIN_EP_TITLES = 3
# 8, not 12: five real episode titles ("The Sewn-Mouth Man", "The Mystery of the
# Museum", "Scribbles", "The Ghost in the Tunnel", "A Detective's Vacation") come to
# ten content words once the stopwords go. Episode titles are short by nature, and a
# threshold set by eye rather than by counting rejected the exact rows it was added
# to admit.
MIN_EP_TOKENS = 8


BLOCKED_REASON = "blocked by content policy (adult/explicit)"


def judge(rec: dict, seen_desc: set[str], seen_title: set[str], *,
          require_transcript: bool = False, min_signals: int = MIN_SIGNALS,
          blocked: dict[str, int] | None = None) -> str | None:
    """Why this ITEM must not be published, or None if it may be.

    Judged at the item level even for a series, because an episode has no
    description of its own — it inherits the item's, so admitting an item admits its
    episodes.

    The return value is a histogram KEY, so it must never carry the per-item number
    that caused it: that turned one cause into seven rows of the dry-run report.
    """
    # FIRST, and before anything else can admit it. This is the legal gate, not a
    # quality one: it must not be reachable only when some other check passes, and
    # the term that fired is tallied separately so the block can be audited
    # without the reason histogram turning into a wordlist.
    hit = record_block(rec)
    if hit:
        if blocked is not None:
            blocked[hit] = blocked.get(hit, 0) + 1
        return BLOCKED_REASON
    if not rec.get("videos"):
        return "no browser-playable video"
    if not rec.get("thumb"):
        return "no thumbnail"
    why = feed_shape(rec.get("title") or "")
    if why:
        return why
    # Wikidata prose counts as description. `_identify` runs before build_graph and
    # a matched work carries the densest text a thin IA row will ever get — judging
    # on the raw blurb alone threw away 1,299 items on a live crawl, and the ones it
    # threw away were disproportionately the works somebody had actually catalogued.
    desc = clean(rec.get("desc"))
    wd = rec.get("wikidata")
    if wd:
        desc = (desc + " " + wd_text(wd)).strip()
    n_titles, ep_tokens = episode_signal(rec)
    # A series whose episodes are distinctly titled carries its own description.
    rich_series = (len(rec["videos"]) > 1 and n_titles >= MIN_EP_TITLES
                   and ep_tokens >= MIN_EP_TOKENS)
    if len(desc) < MIN_DESC and not rich_series:
        return f"description under {MIN_DESC} chars"
    title = seg(rec.get("title") or "")
    if not title:
        return "no title"
    # THE archive.org failure mode: a whole collection sharing one description. 400
    # copies of one point in the embedding space is not a catalog — it is one row
    # with 400 names, and it poisons every ranking that touches it.
    # Fingerprint the episode titles for a series admitted on them: two uploads of
    # one show share a blurb, and judging THAT as boilerplate would drop the second
    # upload even when it carries different episodes.
    fp = fingerprint(desc if not rich_series else " ".join(
        sorted({(v.get("title") or "") for v in rec["videos"]})))
    if fp in seen_desc:
        return "description is collection boilerplate (already seen verbatim)"
    key = title.lower()
    if key in seen_title:
        return "duplicate title"
    rich = tokens(" ".join([title, str(rec.get("creator") or ""),
                            " ".join(rec.get("subject") or []), desc,
                            # Episode titles are content — for a thin-blurbed series
                            # they are the only content there is.
                            *[(v.get("title") or "") for v in rec["videos"]]]))
    if len(rich) < MIN_TOKENS:
        return f"under {MIN_TOKENS} distinct content words"
    # Only meaningful for a single-video item. A series' duration is the sum of its
    # episodes and says nothing about whether any one of them is a clip.
    if len(rec["videos"]) == 1:
        dur = rec["videos"][0].get("duration") or 0
        if dur and dur < MIN_FILM_SECONDS:
            return f"shorter than {MIN_FILM_SECONDS}s"
    # …and finally: does it look like a work somebody catalogued? Last, because it
    # is the most expensive to explain and the least certain — everything above is
    # a defect, this is a preference, and a preference should not shadow a defect
    # in the report.
    marks = legitimacy(rec)
    if len(marks) < min_signals:
        return f"under {min_signals} marks of a complete published work"
    if require_transcript and not any(v.get("cues") for v in rec["videos"]):
        return "no transcript"
    seen_desc.add(fp)
    seen_title.add(key)
    return None


def prejudge(doc: dict, boiler: dict[str, int],
             blocked: dict[str, int] | None = None) -> str | None:
    """Why this SEARCH RESULT is not worth a metadata call, or None.

    A wide crawl's cost is one paced metadata request per candidate; the search
    that produced the candidate was free and already carried `description`. So
    every rejection that can be made from the search row is a request not spent.

    Deliberately weaker than `judge()`, and it must stay that way: description
    LENGTH is not checked here, because a thin-blurbed series is admitted on its
    episode titles and those only exist after the metadata call. The one thing
    worth catching early is archive.org's signature failure — a whole collection
    sharing one description, 400 copies of one point in the embedding space.
    """
    # The block and the feed check both run here as well as in judge(). Both are
    # answerable from the search row, and answering them here is the difference
    # between skipping 400 Alex Jones broadcasts for free and paying 400 paced
    # metadata requests to skip them.
    hit = (text_block(doc.get("title"), label=True)
           or text_block(doc.get("creator"), label=True)
           or text_block(doc.get("identifier"), label=True)
           # subject and description are both prose here — see record_block().
           or text_block(doc.get("subject") or [])
           or text_block(doc.get("description")))
    if hit:
        if blocked is not None:
            blocked[hit] = blocked.get(hit, 0) + 1
        return BLOCKED_REASON
    why = feed_shape(clean(doc.get("title")))
    if why:
        return why
    desc = clean(doc.get("description"))
    if not desc:
        return None  # a series can still be admitted on its episode titles
    fp = fingerprint(desc)
    boiler[fp] = boiler.get(fp, 0) + 1
    if boiler[fp] > BOILERPLATE_COPIES:
        return "description is collection boilerplate (already seen verbatim)"
    return None


ITEM_FIELDS = ("identifier", "title", "description", "year", "date", "creator",
               "subject", "collection", "downloads", "runtime")
# The scrape API returns the same fields but 10,000 at a time behind a cursor,
# where advancedsearch's `page` degrades badly past a few thousand rows. Crucially
# it carries `description` and `downloads`, which is what lets a candidate be
# rejected BEFORE its one-per-item metadata call — the metadata calls, not the
# search, are what a wide crawl actually spends.
SCRAPE_FIELDS = ITEM_FIELDS + ("week", "avg_rating", "num_reviews")
SCRAPE_MAX = 10000   # the endpoint's own page ceiling; count<100 is rejected

# Uploads that are a feed, not a work. Excluded in the QUERY, so they never cost a
# metadata call. NOT a quality judgement on ads and politics as such — they are
# thousands of near-identical 30-second items, which is the same shape of problem
# as collection boilerplate.
NOISE_ITEM_COLLECTIONS = ("twitchstreams", "social-media-video", "podcasts_mirror",
                          "political_ads", "tv_ads", "adviews", "tvnews", "tvarchive", "911")
# `fav-*` is one user's favourites list, not a topic. Left in, the tree fills with
# thousands of one-person collections and the structure stops meaning anything.
NOISE_COLLECTION = re.compile(
    r"^(fav-|.*_inbox$|additional_collections|.*[-_]podcasts?$|podcast[-_].*|"
    r"tv-.*|.*[-_]livestreams?$)", re.I)


# ── network ──────────────────────────────────────────────────────────────────

class _Fetcher:
    """One paced, retrying reader for everything. archive.org owes us nothing and
    being rate-limited is not a transient blip — it comes out as a corpus quietly
    missing a whole collection."""

    def __init__(self, gap: float = 0.3):
        self.gap = gap
        self.last = 0.0
        self.calls = 0

    def _raw(self, url: str, tries: int = 4) -> bytes:
        for i in range(tries):
            wait = self.last + self.gap - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.calls += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                    body = r.read()
                    if r.headers.get("content-encoding") == "gzip":
                        body = gzip.decompress(body)
                    return body
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    back = int(e.headers.get("retry-after") or 0) or 5 * (i + 1)
                    print(f"\n    429 — backing off {back}s")
                    time.sleep(back)
                    continue
                if e.code < 500:
                    raise
            except Exception:  # noqa: BLE001 — transport flake; retry
                pass
            time.sleep(1 + i)
        raise RuntimeError(f"gave up on {url}")

    def json(self, url: str):
        return json.loads(self._raw(url))

    def scrape(self, q: str, sort: str, want: int, fields=SCRAPE_FIELDS) -> list[dict]:
        """Ranked candidates from archive.org's scrape API, cursor-paged.

        advancedsearch is capped and gets slower the deeper you page; scrape hands
        back 10,000 rows a call with a cursor, under the same solr query and the
        same `sorts`. `television` alone is 739,282 items — this is the difference
        between seeing the top 40 of a collection and seeing the top 10,000.
        """
        out: list[dict] = []
        cursor = None
        while len(out) < want:
            params = {"q": q, "fields": ",".join(fields), "sorts": sort,
                      "count": max(100, min(SCRAPE_MAX, want - len(out)))}
            if cursor:
                params["cursor"] = cursor
            d = self.json("https://archive.org/services/search/v1/scrape?"
                          + urllib.parse.urlencode(params))
            items = d.get("items") or []
            out.extend(items)
            cursor = d.get("cursor")
            # No cursor means that was the last page — asking again returns the
            # first page forever, which is an infinite loop, not a bigger crawl.
            if not cursor or not items:
                break
        return out[:want]

    def text(self, url: str) -> str:
        return self._raw(url).decode("utf-8", "replace")


def _search_url(q: str, fields: tuple[str, ...], rows: int, sort: str = "downloads desc") -> str:
    fl = "".join(f"&fl%5B%5D={f}" for f in fields)
    return (f"https://archive.org/advancedsearch.php?q={urllib.parse.quote(q)}{fl}"
            f"&rows={rows}&page=1&output=json&sort%5B%5D={urllib.parse.quote(sort)}")




class ArchiveVideoSource(SourceBase):
    name = "archive-videos"
    # THE ENTITY NAMES ARE LOAD-BEARING, and lowercase on purpose.
    #
    # A node's entity key becomes its vertex `tag`, the tag becomes the projection's
    # `root_type`, and quickbeam's `_project()` ends with `fields["entityType"] = rt`
    # — it OVERWRITES whatever entityType the payload carried. So the tag is what
    # src/catalog/search.js actually sees, and there it matters three times: `STRUCTURAL`
    # holds the literal strings "folder" and "subtitles", and searchSubtitles()
    # resolves a hit back to its video with `row.entityType === "subtitles"`.
    stems = {"video": "videos", "subtitles": "transcripts", "folder": "collections"}
    snapshot_stems = {"videos", "transcripts", "collections"}
    role_map = {"title": "name", "subtitle": "series", "tags": ["subject"], "text": ["text"]}
    presentation = {"accent": "#a78bfa",
                    "icons": {"video": "movie", "subtitles": "subtitles", "folder": "folder"}}

    def __init__(self):
        self.http = _Fetcher()
        self.stats: dict[str, int] = {}
        self.unresolved: dict[str, int] = {}
        # What the content block actually caught, by term. Kept apart from `stats`
        # on purpose: a reason histogram with four hundred one-row entries is
        # unreadable, and "which terms are earning their place" is a different
        # question from "why did the gate drop things".
        self.blocked: dict[str, int] = {}
        self.budget: dict[str, int] = {}
        self.dropped_episodes = 0
        self.blocked_episodes = 0
        # Which marks the ADMITTED items earned. See report().
        self.signal_counts: dict[str, int] = {}
        # The driver reports the gate before staging, and `Publisher.ingest()` then
        # calls read() again with the same arguments. Without this that is two full
        # crawls of archive.org to publish one thing.
        self._cache: dict[tuple, list[dict]] = {}
        self._disk: dict[str, dict | None] = {}
        self._require_transcript = False
        self._max_episodes = 40
        self._min_signals = MIN_SIGNALS
        self._max_per_creator = 3
        self.wikidata_stats: dict[str, int] = {}

    def add_source_args(self, p: argparse.ArgumentParser) -> None:
        p.add_argument("--collection", action="append", default=[],
                       help="Explicit archive.org collection id; repeatable.")
        p.add_argument("--crawl", action="append", default=[],
                       help="Walk the collection tree from this root (e.g. movies, television).")
        p.add_argument("--query", action="append", default=[],
                       help='Seed by search instead of collection, e.g. --query "digimon". '
                            "The shows worth having are found by name, not walked to.")
        p.add_argument("--max-depth", type=int, default=2,
                       help="How far down the collection tree --crawl descends.")
        p.add_argument("--max-collections", type=int, default=40,
                       help="Ceiling on collections visited per crawl root.")
        p.add_argument("--per-collection", type=int, default=500,
                       help="Items CONSIDERED per collection, most-downloaded first. "
                            "Cursor-paged, so this is no longer capped at a search page.")
        p.add_argument("--sort", default="downloads desc",
                       help='How candidates are RANKED before --per-collection cuts them: '
                            '"downloads desc" (all-time popular), "week desc" (trending now), '
                            '"avg_rating desc", "date desc".')
        p.add_argument("--min-downloads", type=int, default=500,
                       help="Floor on an item's all-time downloads. Applied in the search "
                            "query, so a rejected item costs nothing. 500, not 0: the gate "
                            "below is expensive per item and downloads is the one quality "
                            "signal archive.org hands out for free. Drop it to 0 when "
                            "seeding a --query for something genuinely obscure.")
        p.add_argument("--exclude-collection", action="append", default=None,
                       help=f"Drop items in this collection. Repeatable. Defaults to "
                            f"{', '.join(NOISE_ITEM_COLLECTIONS)}.")
        p.add_argument("--min-collection-items", type=int, default=200,
                       help="A crawled collection needs this many items to be ranked at all. "
                            "200, not 30: downloads-per-item elects small campaign-ad dumps "
                            "(DonaldJ.TrumpForPresident, 41 items; PrioritiesUsaAction, 64) "
                            "over classic_tv_1970s. One threshold beats an endless blocklist, "
                            "and a collection under 200 items cannot carry a wide crawl anyway.")
        p.add_argument("--max-episodes", type=int, default=40,
                       help="Episodes taken per series, so one 614-file item can't be the corpus.")
        p.add_argument("--max-items", type=int, default=5000,
                       help="Global ceiling on video vertices.")
        p.add_argument("--min-signals", type=int, default=MIN_SIGNALS,
                       help="How many independent marks of a complete published work an "
                            f"item must carry ({', '.join(sorted(SIGNAL_NAMES))}). "
                            "THE PICKINESS DIAL: 2 is a wide net, 4 admits only things "
                            "somebody plainly catalogued.")
        p.add_argument("--max-per-creator", type=int, default=3,
                       help="Items kept per creator across the whole crawl. This is what "
                            "stops one prolific uploader — the hundreds of Alex Jones "
                            "broadcasts — from becoming the catalog. A series counts once, "
                            "however many episodes it carries. 0 disables it.")
        p.add_argument("--max-bytes", type=int, default=64_000_000,
                       help="Estimated payload budget; the crawl stops when it is spent.")
        p.add_argument("--require-transcript", action="store_true",
                       help='Only items already carrying captions (searches format:"SubRip").')
        p.add_argument("--no-transcripts", action="store_true",
                       help="Skip caption fetching entirely — much faster, and what a wide crawl wants.")
        p.add_argument("--max-passages", type=int, default=40)
        p.add_argument("--no-wikidata", action="store_true",
                       help="Skip Wikidata enrichment. It is on by default: it is CC0, it is "
                            "one lookup per distinct WORK rather than per file, and a "
                            "confident match is both the richest text a thin row will get "
                            "and the strongest legitimacy signal there is.")
        p.add_argument("--wikidata-cache", default=None,
                       help="JSONL of resolved works, keyed by title+year. Misses are cached "
                            "too — the titles that resolve to nothing are most of the cost.")
        p.add_argument("--cache-file", default=None,
                       help="JSONL of resolved items, keyed by identifier. A wide crawl is "
                            "thousands of paced HTTP calls; this makes a re-run free and a "
                            "crash cost nothing.")

    # ── read: every network call lives here ──────────────────────────────────
    def read(self, cursor: int, args: argparse.Namespace) -> list[dict]:
        key = self._cache_key(args)
        if key in self._cache:
            print(f"  (reusing {len(self._cache[key])} records already read)")
            return self._cache[key]

        self.unresolved = {}
        self._require_transcript = args.require_transcript
        self._max_episodes = args.max_episodes
        self._min_signals = args.min_signals
        self._max_per_creator = args.max_per_creator
        # Resolved items from a previous run. Keyed by identifier, so widening the
        # crawl re-reads only what is genuinely new.
        self._disk = _load_cache(getattr(args, "cache_file", None))
        if self._disk:
            print(f"  cache: {len(self._disk)} item(s) already resolved")
        sources = self._discover(args)
        out: list[dict] = []
        taken = 0
        est = 0
        boiler: dict[str, int] = {}

        for origin, ident in sources:
            if taken >= args.max_items or est >= args.max_bytes:
                break
            docs = self._items(origin, ident, args)
            print(f"  {ident}: {len(docs)} candidates "
                  f"({taken}/{args.max_items} videos, {est // 1000}/{args.max_bytes // 1000} KB)")
            for i, d in enumerate(docs, 1):
                if taken >= args.max_items or est >= args.max_bytes:
                    print("\r    budget reached          ")
                    break
                why = prejudge(d, boiler, self.blocked)
                if why:
                    self.unresolved[why] = self.unresolved.get(why, 0) + 1
                    continue
                print(f"\r    resolving {i}/{len(docs)}  ", end="", flush=True)
                cached = self._disk.get(d.get("identifier"))
                if cached is not None:
                    rec, why = (cached, "") if cached else (None, "no browser-playable video")
                else:
                    rec, why = self._resolve(d, ident, args)
                    # A miss is cached too — as `null` — or every re-run pays the
                    # metadata call again for every item that had no playable video.
                    _append_cache(getattr(args, "cache_file", None), d.get("identifier"), rec)
                if not rec:
                    self.unresolved[why] = self.unresolved.get(why, 0) + 1
                    continue
                out.append(rec)
                capped = rec["videos"][:args.max_episodes]
                taken += len(capped)
                est += (len(capped) * BYTES_PER_VIDEO
                        + sum(len(v.get("cues") or []) for v in capped) * BYTES_PER_PASSAGE)
            print()

        if not args.no_wikidata:
            self._identify(out, args)

        self.budget = {"videos": taken, "estimated_bytes": est, "http_calls": self.http.calls}
        self._cache[key] = out
        return out

    def _identify(self, records: list[dict], args) -> None:
        """Attach each item's Wikidata match, in place.

        Keyed on the SERIES name, not the item title: `Bonanza - Bitter Water`,
        `Bonanza public domain episodes` and `Bonanza PD Episodes` are three
        uploads of one show and must all resolve to the one entity — which they
        do, and which the resolver's cache then makes free for the second and
        third. Runs after the crawl loop rather than inside it so that a cached
        item still gets enriched: the two caches are independent on purpose, and
        adding enrichment must not force a re-crawl of everything already
        resolved.
        """
        wd = Wikidata(self.http, getattr(args, "wikidata_cache", None), now=CURRENT_YEAR)
        for i, rec in enumerate(records, 1):
            print(f"\r  identifying {i}/{len(records)}  ", end="", flush=True)
            rec["wikidata"] = wd.resolve(series_name(rec["title"]), rec.get("year"))
            # Wikidata's publication year, when archive.org gave us none. 43% of a
            # published crawl carried no year at all, and `wdYear` — already
            # extracted by the resolver, and CC0 — was sitting unused in the match
            # the whole time: it was left out of the `wd_fields` copy in
            # build_graph, so it reached neither the payload nor the gate.
            #
            # Filled HERE rather than at payload time, so the `year` mark in
            # legitimacy() sees it too. An item Wikidata can date is an item that
            # has earned that signal, and filling it only for display would leave
            # the gate judging on an absence it no longer has.
            #
            # IA's own year wins when it exists, for the same reason IA's creator
            # does a few hundred lines down: it is what the item was catalogued
            # under. Only the resolver's `year` argument sees the original, and it
            # already ran on the line above.
            if not rec.get("year"):
                rec["year"] = ((rec["wikidata"] or {}).get("wdYear")
                               or first_year(rec.get("date")))
        self.wikidata_stats = dict(wd.stats)
        found = sum(1 for r in records if r.get("wikidata"))
        print(f"\r  identified {found}/{len(records)} item(s) on wikidata      ")

    @staticmethod
    def _cache_key(args) -> tuple:
        return (tuple(args.collection), tuple(args.crawl), tuple(args.query),
                args.max_depth, args.max_collections, args.per_collection,
                args.max_episodes, args.max_items, args.max_bytes,
                args.require_transcript, args.no_transcripts, args.max_passages,
                args.sort, args.min_downloads, args.min_collection_items,
                args.min_signals, args.max_per_creator, args.no_wikidata,
                tuple(args.exclude_collection or ()))

    # ── discovery ────────────────────────────────────────────────────────────
    def _discover(self, args) -> list[tuple[str, str]]:
        """[(origin, identifier)] to pull items from. `origin` is "collection" or
        "query" and decides how `_items` phrases the search."""
        found: list[tuple[str, str]] = [("collection", c) for c in args.collection]
        found += [("query", q) for q in args.query]
        for root in args.crawl:
            found += [("collection", c) for c in self._walk(root, args)]
        # Dedupe, first mention wins — an explicit --collection must not be visited
        # twice because the crawl also reached it.
        seen = set()
        out = []
        for pair in found:
            if pair in seen:
                continue
            seen.add(pair)
            out.append(pair)
        return out

    def _walk(self, root: str, args) -> list[str]:
        """Breadth-first over the collection tree, then RANKED before it is cut.

        `mediatype:collection AND collection:<parent>` is the edge; `movies` has
        8,754 children and `television` 871, so something has to choose which
        --max-collections of them get crawled. Discovery order is the wrong answer
        — it is alphabetical-ish noise.

        The ranking is downloads-per-item, not downloads. Raw downloads elects the
        grab-bags: `opensource_movies` is 5.3 BILLION downloads across 2,604,841
        items, which is a junk drawer with a big number on it. Per-item it comes
        out behind `classic_tv_1970s` (807 items, 5,429 downloads each), which is
        what a person actually meant by "popular". `--min-collection-items` keeps
        the other failure mode out: three items and one viral hit is not a
        collection worth crawling.
        """
        excl = set(NOISE_ITEM_COLLECTIONS if args.exclude_collection is None
                   else args.exclude_collection)
        seen = {root}
        ranked: list[tuple[int, str]] = []
        frontier = [root]
        for _ in range(max(0, args.max_depth)):
            level: list[tuple[int, str]] = []
            for parent in frontier:
                try:
                    docs = self.http.json(_search_url(
                        f"mediatype:collection AND collection:{parent}",
                        ("identifier", "title", "downloads", "item_count", "collection"), 200,
                    )).get("response", {}).get("docs", [])
                except Exception as e:  # noqa: BLE001 — a dead branch must not kill the crawl
                    print(f"  ! {parent}: sub-collection query failed ({e})")
                    continue
                for d in docs:
                    c = d.get("identifier")
                    if not c or c in seen or c in excl or NOISE_COLLECTION.match(str(c)):
                        continue
                    seen.add(c)
                    # A whole collection is the cheapest thing the block can
                    # reject: skipping it here is thousands of items never
                    # searched, let alone resolved.
                    hit = text_block(f"{c} {d.get('title') or ''}", label=True)
                    if hit:
                        self.blocked[hit] = self.blocked.get(hit, 0) + 1
                        continue
                    # …and drop it if its PARENT is excluded. `DonaldTrump` and
                    # `HillaryForAmerica` are 630 and 202 items, so no size floor
                    # reaches them, but both are filed under `political_ads` — which
                    # is already excluded at the item level, so crawling them spends
                    # a --max-collections slot on rows that get dropped anyway.
                    # Structural, so it holds for whatever is put in --exclude-collection.
                    parents = d.get("collection") or []
                    if excl & set(parents if isinstance(parents, list) else [parents]):
                        continue
                    n = int(d.get("item_count") or 0)
                    if n < args.min_collection_items:
                        continue
                    level.append((int(d.get("downloads") or 0) // max(1, n), str(c)))
            level.sort(reverse=True)
            ranked += level
            # Descend only into the best of this level. Otherwise depth 2 fans out
            # to hundreds of sub-queries to rank children of collections that will
            # never be crawled anyway.
            frontier = [c for _, c in level[:args.max_collections]]
            if not frontier:
                break
        ranked.sort(reverse=True)
        # The root always leads: it is the union of everything under it, and its
        # own top-ranked items are the best rows the whole subtree has.
        order = [root] + [c for _, c in ranked]
        order = order[:args.max_collections]
        print(f"  crawl {root}: {len(order)} of {len(ranked) + 1} collection(s), "
              f"by downloads-per-item — {', '.join(order[:8])}"
              + (" …" if len(order) > 8 else ""))
        return order

    def _items(self, origin: str, ident: str, args) -> list[dict]:
        """Ranked candidates for one source, filtered as far as the QUERY allows.

        Everything that can be expressed in solr is expressed in solr: a rejected
        item then costs zero HTTP calls, where rejecting it after `_resolve` costs
        one paced metadata request. Raw keyword search for "digimon" returns twitch
        VODs and YouTube rips; the same search ranked by downloads returns the
        complete series with half a million downloads. Popularity is the only
        quality signal IA hands out for free — `--sort week desc` asks the same
        question about right now instead of all time.
        """
        if origin == "query":
            q = f"({ident}) AND mediatype:movies"
        else:
            q = f"mediatype:movies AND collection:{ident}"
        excl = NOISE_ITEM_COLLECTIONS if args.exclude_collection is None else args.exclude_collection
        if excl:
            q += " AND -collection:(" + " OR ".join(excl) + ")"
        if args.min_downloads:
            q += f" AND downloads:[{args.min_downloads} TO *]"
        # Free rejection: archive.org filters these server-side, so the worst of it
        # never comes back to be filtered here. The local block is still the real
        # one — this only saves the metadata calls.
        q += solr_exclusions()
        if args.require_transcript:
            # Indexed server-side, so this is free and finds the caption-carrying
            # subset of ANY collection rather than being stuck with the few that
            # happen to be fully transcribed.
            q += ' AND format:"SubRip"'
        try:
            return self.http.scrape(q, args.sort, args.per_collection)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {ident}: search failed ({e})")
            return []

    # ── one item → a record carrying 1..N videos ─────────────────────────────
    def _resolve(self, d: dict, origin: str, args) -> tuple[dict | None, str]:
        ident = d.get("identifier")
        if not ident:
            return None, "no identifier"
        try:
            meta = self.http.json(f"https://archive.org/metadata/{ident}")
        except Exception as e:  # noqa: BLE001
            return None, f"metadata unreadable ({type(e).__name__})"

        files = meta.get("files") or []
        videos = self._videos(ident, files, args)
        if not videos:
            return None, "no browser-playable video"

        md = meta.get("metadata") or {}
        subject = d.get("subject") or md.get("subject")
        subject = [subject] if isinstance(subject, str) else list(subject or [])
        cols = d.get("collection") or md.get("collection") or []
        cols = [cols] if isinstance(cols, str) else list(cols)
        return {
            "id": ident,
            "title": clean(d.get("title") or md.get("title")) or ident,
            "desc": clean(d.get("description") or md.get("description"))[:MAX_DESC],
            "creator": clean(d.get("creator") or md.get("creator")) or None,
            # IA's `year` ONLY. `date` is kept beside it and used as a last
            # resort in _identify, after Wikidata has had its say: for a user
            # upload `date` is when they uploaded it, not when the work was made.
            # `south-park-s-14-e-06-201-end-uncut` has no `year` and `date`
            # 2025-07-12, for an episode that aired in 2010 — and because the old
            # order took `date` before anything else, the record arrived with a
            # year that was both wrong and confident enough to block a correction.
            "year": first_year(d.get("year")),
            "date": d.get("date") or md.get("date"),
            "subject": subject[:8],
            # The item's real ancestry, minus the noise. This is what places it in
            # the tree, and it is why a crawl and a --query seed produce the same
            # shape: both end with an item that knows its own collections.
            "collections": [str(c) for c in cols if not NOISE_COLLECTION.match(str(c))][:4],
            "origin": origin,
            "downloads": int(d.get("downloads") or 0),
            "thumb": f"https://archive.org/services/img/{urllib.parse.quote(ident)}",
            "videos": videos,
        }, ""

    def _videos(self, ident: str, files: list[dict], args) -> list[dict]:
        """The item's playable video files, deduped and capped.

        `.mkv` is deliberately absent from PLAYABLE: every episode in these series
        ships an mkv twin no browser will play, and half a catalog silently failing
        to start is worse than half a catalog missing.
        """
        by_key: dict[tuple, dict] = {}
        for f in files:
            name = f.get("name") or ""
            ext = re.search(r"\.[A-Za-z0-9]{2,4}$", name)
            mime = PLAYABLE.get(ext.group(0).lower()) if ext else None
            if not mime:
                continue
            stem = base_stem(name)
            season, ep, title = episode_of(stem)
            # Two files that are the same episode (a `_512kb` derivative beside the
            # source, or two encodes) collapse onto one row, and the smaller wins:
            # these are streams for a browser, and an 800 MB master makes the player
            # look broken.
            # Keyed on the DERIVATIVE-STRIPPED stem, so `x.mp4` and `x_512kb.mp4`
            # are one row and the smaller wins.
            key = (season, ep, title.lower()) if ep is not None else (None, None, stem.lower())
            size = int(f.get("size") or 0)
            prev = by_key.get(key)
            if prev and prev["size"] and size and prev["size"] <= size:
                continue
            by_key[key] = {
                "file": name, "mime": mime, "size": size,
                "season": season, "episode": ep, "title": title,
                "url": f"https://archive.org/download/{urllib.parse.quote(ident)}/"
                       f"{urllib.parse.quote(name)}",
                "duration": _duration(f),
                "cues": [],
            }
        # NOT capped here. `--max-episodes` is applied in build_graph(), so the
        # cache holds every episode an item has: capped at resolve time, raising the
        # cap would silently do nothing for any item already cached, which is a
        # setting that lies about what it does.
        vids = sorted(by_key.values(),
                      key=lambda v: (v["season"] or 0, v["episode"] or 0, v["file"]))
        if not args.no_transcripts:
            names = [f.get("name") or "" for f in files]
            for v in vids[:args.max_episodes]:
                v["cues"] = self._captions(ident, names, v["file"], args.max_passages,
                                           lone=len(vids) == 1)
        return vids

    def _captions(self, ident: str, names: list[str], video: str, cap: int,
                  *, lone: bool) -> list[dict]:
        """archive.org has already run Whisper over much of its own digitised video
        and published `<id>.autogenerated.vtt` next to it. We fetch that rather than
        running ASR: no GPU, no RAM ceiling, and their transcripts are good.

        A per-episode caption is preferred when one exists (`<episode>.srt` beside
        the file). The item-level transcript is only used when the item holds ONE
        video — otherwise every episode of a series would be handed the same
        transcript, which is worse than having none.
        """
        stem = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", video)
        wanted = [rf"^{re.escape(stem)}\.(vtt|srt)$", rf"^{re.escape(stem)}\..*\.(vtt|srt)$"]
        if lone:
            wanted += [rf"^{re.escape(ident)}\.autogenerated\.vtt$",
                       rf"^{re.escape(ident)}\.asr\.vtt$",
                       r"\.autogenerated\.vtt$", r"\.asr\.vtt$", r"\.vtt$", r"\.srt$"]
        for pat in wanted:
            rx = re.compile(pat, re.I)
            hit = next((n for n in names if rx.search(n)), None)
            if not hit:
                continue
            try:
                raw = self.http.text(
                    f"https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(hit)}")
            except Exception:  # noqa: BLE001 — a missing transcript is not a dead item
                return []
            return to_passages(parse_cues(raw))[:cap]
        return []

    # ── build_graph: pure, and where every judgement is made ─────────────────
    def build_graph(self, records: list[dict]):
        cap = self._max_episodes
        videos, transcripts, folders, edges = [], [], [], []
        seen_desc: set[str] = set()
        seen_title: set[str] = set()
        seen_episode: set[tuple] = set()
        seen_collection: set[str] = set()
        # series name → the collection it was first filed under. IA files two
        # uploads of one show in different collections (Digimon is in both `anime`
        # and `anime_miscellaneous`), so without this the same series appears twice
        # in the browse tree with its episodes split between the two.
        series_home: dict[str, str] = {}
        # show_key → the display title the first scattered upload of that show
        # established, so `SOUTH PARK` and `South Park` accrete into one folder
        # rather than two that differ only in shouting.
        show_titles: dict[str, str] = {}
        # creator → items already kept. `records` arrives ranked (downloads, or
        # whatever --sort asked for), so the ones a prolific uploader gets to keep
        # are their best, not their first alphabetically.
        per_creator: dict[str, int] = {}
        stats: dict[str, int] = {}
        self.dropped_episodes = 0
        self.blocked_episodes = 0
        self.signal_counts = {}

        # ── pre-pass: which shows this crawl actually holds a RUN of ────────
        # Before judging anything, because both things it feeds are otherwise
        # order-dependent: `records` arrives ranked, and a scattered episode that
        # sorts above its own series would be judged un-vouched and filed in the
        # wrong folder, purely on upload popularity. One extra walk of a list
        # already in memory buys an answer that does not depend on the order.
        runs: set[str] = set()
        for rec in records:
            if len(rec.get("videos") or []) > 1 and episode_signal(rec)[0] >= COMPLETE_EPISODES:
                runs.add(show_key(rec["title"]))
        for rec in records:
            if len(rec.get("videos") or []) == 1:
                show = show_of(rec)
                if show and rec["videos"][0].get("episode") is not None:
                    # The folder it belongs in, always — an episode of a nameable
                    # show is filed with the show whether or not this crawl also
                    # found the box set, so later crawls accrete into one place
                    # instead of scattering a second time.
                    rec["scattered_into"] = show
                    # The completeness VOUCH, only when the run is really here.
                    if show_key(show) in runs:
                        rec["series_of"] = show

        for rec in records:
            why = judge(rec, seen_desc, seen_title,
                        require_transcript=self._require_transcript,
                        min_signals=self._min_signals, blocked=self.blocked)
            if why:
                stats[why] = stats.get(why, 0) + 1
                continue
            # AFTER the gate, so the cap spends its slots on items that would have
            # published — checking it first would let three rejects use up a good
            # creator's whole allowance.
            creator = clean(rec.get("creator")).lower()
            if self._max_per_creator and creator:
                if per_creator.get(creator, 0) >= self._max_per_creator:
                    stats["creator already at --max-per-creator"] = stats.get(
                        "creator already at --max-per-creator", 0) + 1
                    continue
                per_creator[creator] = per_creator.get(creator, 0) + 1
            stats["published"] = stats.get("published", 0) + 1
            # What the admitted items were admitted ON. `--min-signals N` reads
            # like "N of 8", and on a real crawl it is not: `audience` fired for
            # 96.9% of resolved items and `runtime` for 92.3%, because
            # --min-downloads already filtered popularity in the solr query and
            # almost everything IA holds is longer than 20 minutes. Two of the
            # eight are free, so `--min-signals 5` is really "3 of the other 6",
            # and nothing said so. `identified` was 0.0% for a whole published
            # crawl — the strongest mark in the set, silently never firing.
            for mark in legitimacy(rec):
                self.signal_counts[mark] = self.signal_counts.get(mark, 0) + 1

            item_title = seg(series_name(rec["title"]), 70)
            desc = clean(rec["desc"])
            # The CC0 half of the row. `wd_text` is a dense run of the nouns that
            # distinguish one work from another — what it is, who made it, who is
            # in it — which is exactly what 53% of these rows are missing.
            wd = rec.get("wikidata") or {}
            wd_desc = wd_text(wd)
            # Additive, and every one of them CC0. `qid` and `imdb` are the join
            # keys a later enrichment pass — Wikipedia prose, TMDB artwork —
            # would start from, rather than re-deriving this match from the title
            # a second time.
            wd_fields = {k: wd[k] for k in
                         ("qid", "imdb", "genre", "director", "cast", "network",
                          "country", "language") if wd.get(k)}
            # P170 is Wikidata's creator, and the row already has archive.org's.
            # IA's wins when it exists: it is what the item was catalogued under,
            # and two spellings of one name in one field help nobody.
            if wd.get("creator") and not rec["creator"]:
                wd_fields["creator"] = wd["creator"]
            # Where this sits in the tree: the item's own first collection, which is
            # its most specific one — IA lists them narrowest-first.
            top = seg(rec["collections"][0] if rec["collections"] else rec["origin"], 60)
            series = len(rec["videos"]) > 1
            # A one-file item that names a show and parses as an episode of it is a
            # SCATTERED UPLOAD, and from here on it is treated exactly as a member
            # of that show: same folder, same SxxEyy label, same cross-item dedupe.
            # Without this it published as a loose file at the top of a collection,
            # under whatever the uploader typed — `SOUTH PARK S 14 E 06 201( END
            # UNCUT).mp4` sitting beside feature films, findable only by knowing to
            # search for it, and unable to merge with the nineteen other scattered
            # episodes of the same show a crawl also found.
            if not series and rec.get("scattered_into"):
                key = show_key(rec["scattered_into"])
                item_title = show_titles.setdefault(key, seg(rec["scattered_into"], 70))
                series = True
            if series:
                # First upload of a show decides where the show lives; later ones
                # join it rather than starting a second folder of the same name.
                top = series_home.setdefault(item_title.lower(), top)
            iid = f"archive:{rec['id']}"

            for c in rec["collections"]:
                if c not in seen_collection:
                    seen_collection.add(c)
                    # Tagged `folder`, which is in sond3r's STRUCTURAL set: quickbeam
                    # gets a real tree to traverse, sond3r ignores these and keeps
                    # synthesizing its browse tree from `path` as it already does.
                    folders.append({"name": f"collection:{c}", "fields": {
                        "entityType": "folder", "kind": "folder",
                        "name": seg(c, 60), "collection": c,
                        "text": f"archive.org collection {c}",
                    }})
            # NB the `contains` edges are emitted per VIDEO, below — not once per
            # item. `archive:<id>` is a vertex only for a standalone film; a series'
            # vertices are `archive:<id>#<file>`, so an item-level edge pointed at a
            # node that does not exist. 949 of 1,393 edges dangled that way, and
            # `fangorn commit` rejected the whole batch rather than saying so.

            for v in rec["videos"][:cap]:
                label = episode_label(v["season"], v["episode"], v["title"] or item_title)
                # Three different Digimon uploads carry episode 1x01. Publishing all
                # of them gives a shelf that is the same episode three times.
                dedupe = (item_title.lower(), v["season"], v["episode"]) if series else None
                if dedupe and dedupe in seen_episode:
                    # Counted apart from the item-level reasons: those are out of
                    # `records`, this is out of episodes, and adding them made
                    # "18/90 items admitted" arithmetic that doesn't hold.
                    self.dropped_episodes += 1
                    continue
                if dedupe:
                    seen_episode.add(dedupe)
                # The last place the block runs, and the only one that sees this
                # particular file's name. A 104-episode item can carry one file
                # nobody should be served, and the item passing is not a reason to
                # publish it.
                hit = episode_block(v["file"], v.get("title"))
                if hit:
                    self.blocked[hit] = self.blocked.get(hit, 0) + 1
                    self.blocked_episodes += 1
                    continue

                name = f"{seg(label, 90)}.mp4"
                path = f"{top}/{item_title}/{name}" if series else f"{top}/{seg(item_title, 90)}.mp4"
                vid = f"{iid}#{v['file']}" if series else iid

                for c in rec["collections"]:
                    edges.append({"rel": "contains", "from": f"collection:{c}", "to": vid,
                                  "fromType": "folder", "toType": "video"})

                videos.append({"name": vid, "fields": {
                    "entityType": "video", "kind": "video",
                    "name": name, "path": path,
                    # An episode has no description of its own, so it inherits the
                    # item's — which is why the gate judges at the item level.
                    "desc": desc,
                    # Free catalog entry: the bytes already have a public URL, so
                    # there is no resource to mint and no worker in the path. This is
                    # what makes bulk ingest one commit rather than one
                    # createResource per file.
                    "price": "0", "url": v["url"], "thumb": rec["thumb"],
                    "mime": v["mime"], "size": v["size"] or 0,
                    "year": rec["year"], "creator": rec["creator"],
                    "subject": rec["subject"] or None,
                    "source": "archive.org", "identifier": rec["id"],
                    "duration": v["duration"],
                    **wd_fields,
                    **({"series": item_title, "season": v["season"], "episode": v["episode"]}
                       if series else {}),
                    # What gets embedded. The distinctive nouns lead because the
                    # harness truncates embed text at 1000 chars — and for an episode
                    # the distinctive part is its own title, not the series blurb it
                    # shares with 103 siblings.
                    # Ordered by what distinguishes THIS row, because the
                    # embedder's window is finite (nomic-embed-text-v1.5 is built
                    # with max_length=512) and the front is what survives a
                    # truncation. The episode's own title leads; the Wikidata
                    # description comes before the IA blurb because it says what
                    # the work IS in one dense line, where the blurb is as often
                    # as not a scan note shared with 103 siblings.
                    "text": " ".join(x for x in [
                        v["title"] or item_title, item_title if series else None,
                        wd_desc, rec["creator"], " ".join(rec["subject"] or []),
                        desc] if x),
                }})

                for i, p in enumerate(v["cues"]):
                    pid = f"{vid}#p{i}"
                    transcripts.append({"name": pid, "fields": {
                        # No `path`. That single omission keeps a transcript out of
                        # the browse tree while searchSubtitles() still resolves it
                        # through videoPath and seeks the player to its cue.
                        "entityType": "subtitles", "kind": "subtitles",
                        "name": name, "videoPath": path,
                        "cues": [p], "start": p["start"], "end": p["end"],
                        "text": p["text"],
                    }})
                    edges.append({"rel": "subtitles", "from": vid, "to": pid,
                                  "fromType": "video", "toType": "subtitles"})

        for why, n in self.unresolved.items():
            stats[why] = stats.get(why, 0) + n
        self.stats = stats
        return {"video": videos, "subtitles": transcripts, "folder": folders}, edges

    def next_cursor(self, records, prev: int) -> int:
        return prev  # snapshot source — each run re-reads the current top of the tree


def _load_cache(path: str | None) -> dict[str, dict | None]:
    """{identifier: record | None} from a JSONL cache. A truncated last line — the
    normal shape of a file whose writer was killed — is skipped rather than taking
    the whole cache with it."""
    if not path:
        return {}
    out: dict[str, dict | None] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                out[row["id"]] = row.get("rec")
    except FileNotFoundError:
        pass
    return out


def _append_cache(path: str | None, ident: str | None, rec: dict | None) -> None:
    """Append-only, flushed per item: a crawl that dies at item 3000 must keep 2999."""
    if not path or not ident:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"id": ident, "rec": rec}, separators=(",", ":")) + "\n")


def _duration(f: dict) -> int | None:
    """Seconds from a file's `length` ("1234.5" or "20:34"). Absent on plenty of
    files, and absence is not a failure — the gate only drops what it can prove is
    too short."""
    raw = f.get("length")
    if not raw:
        return None
    s = str(raw).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return int(float(s))
    parts = s.split(":")
    if 2 <= len(parts) <= 3 and all(re.fullmatch(r"\d+(\.\d+)?", p) for p in parts):
        secs = 0.0
        for p in parts:
            secs = secs * 60 + float(p)
        return int(secs)
    return None
