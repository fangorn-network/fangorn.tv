"""
Who is this, really? — resolving an archive.org item to a Wikidata entity.

WHY WIKIDATA AND NOT WIKIPEDIA
------------------------------
Wikipedia has far more text: a matched work's lede runs a median 1,804 characters
against the 232 an IA description carries, which would fill the embedder's window
almost exactly. It is also **CC BY-SA**, so redistributing those extracts inside a
published shard carries attribution and share-alike obligations, and mapping that
provenance through the pipeline is a real problem rather than a footnote.

Wikidata is **CC0**. Labels, descriptions, genres, directors, cast, dates and the
IMDb id can be copied into a vertex with no strings at all. It is less prose and
more nouns — which happens to suit a 256-d vector, where the distinctive entity
names carry most of the signal and boilerplate only dilutes it.

Wikipedia stays on the table. This is the half that needs no legal work first.

TWO JOBS, AND THE SECOND ONE IS THE POINT
-----------------------------------------
The obvious job is ENRICHMENT: a row for a 1963 serial that says only "Doctor Who"
becomes one that says British science-fiction television series, Sydney Newman,
William Hartnell, BBC, time travel. Measured on a live crawl, 53% of admitted rows
carry under 300 characters of embed text, so for most of the catalog this is the
difference between embedding a title and embedding a description of the work.

The quieter job is IDENTIFICATION. A title that resolves to nothing is usually not
a title: on the same crawl, the unmatched half was `28-2fweg`, `BOLADEDRAC CAT`,
`BBC-packs-01-ArabHD.net` and `Classic British TV Pack`, while the matched half was
Bonanza, Blackadder and Blue's Clues. So a confident match is external
corroboration that the work exists at all, and it feeds `legitimacy()` as a signal
worth more than any field archive.org hands out about itself.

CONFIDENCE IS THE WHOLE DESIGN
------------------------------
`wbsearchentities` is a label search, and it is happy to hand back a river, a taxon,
a record label or a family name. Searching "Doctor Who" returns Time Lords; the top
hit for "Looney Tunes" and for "The Beverly Hillbillies" is a VIDEO GAME. A wrong
match is worse than no match — it writes a confident, plausible, false description
into a row and then embeds it — so `pick()` refuses on ambiguity rather than
guessing, and every rule it applies is a reason it can name.
"""
from __future__ import annotations

import json
import re
import urllib.parse

API = "https://www.wikidata.org/w/api.php?format=json&"

# THE TYPE TEST IS A HIERARCHY WALK, NOT A LIST.
#
# The list below came first, and it was wrong in the worst possible direction.
# Both `Drawn Together` and `The Boondocks` are P31 `Q117467246` — "animated
# television series" — which is not in the list, so the real 2004 series was
# rejected as "not a film or television work" while a 2026 film of the same name
# and an unreleased reboot, whose types WERE listed, sailed through. The filter
# was removing the right answer and admitting the wrong one.
#
# Wikidata's type graph has thousands of these leaves and they are added faster
# than anyone will maintain an enumeration. `Q117467246` subclasses (P279) to
# `Q5398426` television series in ONE hop, so walking up a few levels and asking
# whether any root is reached answers the question for every leaf, including the
# ones invented next year. `Wikidata._is_work()` does that walk, batched and
# memoized; the crawl sees a few dozen distinct P31 values, so it converges to
# almost no traffic.
#
# WORK_ROOTS is what the walk is looking for. WORK_TYPES stays as the offline
# fallback `pick()` uses when no resolver is injected — which is how the pure
# tests run without a network.
WORK_ROOTS = {
    "Q11424": "film", "Q5398426": "television series",
    "Q15416": "television program", "Q24862": "short film",
    "Q202866": "animated film", "Q10301427": "moving image",
}
MAX_SUBCLASS_DEPTH = 4

WORK_TYPES = {
    "Q11424": "film", "Q24869": "feature film", "Q226730": "silent film",
    "Q20667187": "silent short film", "Q24862": "short film",
    "Q202866": "animated film", "Q29168811": "animated feature film",
    "Q17517379": "animated short film", "Q113791292": "animated short film series",
    "Q93204": "documentary film", "Q506240": "television film",
    "Q842256": "musical film", "Q200092": "horror film",
    "Q5398426": "television series", "Q63952888": "anime television series",
    "Q117467261": "anime series", "Q581714": "animated series",
    "Q1366112": "drama television series", "Q15416": "television program",
    "Q1259759": "miniseries", "Q1261214": "television special",
    "Q3464665": "television series season", "Q653916": "television pilot",
}

# What is worth copying out, and what it is called in the vertex. All CC0.
# Item-valued properties need a second lookup to turn a QID into a name; string
# and time values do not, which is why they are listed apart.
ITEM_PROPS = {
    "P136": "genre", "P57": "director", "P170": "creator", "P58": "writer",
    "P161": "cast", "P495": "country", "P364": "language", "P449": "network",
    "P162": "producer",
}
STRING_PROPS = {"P345": "imdb"}
TIME_PROPS = {"P577": "published", "P580": "started"}
QUANTITY_PROPS = {"P2437": "seasons", "P1113": "episodes"}
# How many names to keep from a multi-valued property. Cast lists run to hundreds
# on a popular series; past the top few they are extras, and in a 256-d average
# they are noise that dilutes the leads.
MAX_VALUES = 5

# Uploader cruft that is never part of a work's name. Stripped before the search,
# because `wbsearchentities` matches labels and no label contains "720p".
CRUFT = re.compile(
    r"\b(remastered|restored|uncut|complete|full|ultimate|collection|colorized|"
    r"episodes?|season\s*\d*|series|boxset|box\s*set|pack|volume\s*\d*|vol\.?\s*\d*|"
    r"unrated|uncensored|dub(bed)?|sub(bed|titled)?|english|hindi|spanish|"
    r"hd|sd|uhd|4k|720p|1080p|480p|dvd|blu-?ray|vhs|rip|webrip|hdtv|xvid|divx|x26[45]|"
    r"public\s+domain|pd|ai\s+upscale[d]?|reupload|archive)\b", re.I)
# Season/episode markers, including a season on its own: `The Boondocks S01 S02
# 1080p DVD Upscale` is one show, and leaving `S01 S02` on the query means it
# matches no label anywhere.
SXXEXX = re.compile(r"\bS\s*\d{1,2}\s*E\s*\d{1,3}\b|\b\d{1,2}x\d{1,3}\b"
                    r"|\bS\s?\d{1,2}\b|\bE\s?\d{1,3}\b", re.I)
BRACKETS = re.compile(r"\([^)]*\)|\[[^\]]*\]|\{[^}]*\}")
NON_ALNUM = re.compile(r"[^a-z0-9]+")


def norm(s) -> str:
    """Identity of a name for comparison. Case, punctuation and spacing all vary
    between an uploader's title and a Wikidata label and none of them mean
    anything: `Blue's Clues`, `Blues Clues` and `BLUE'S CLUES` are one show."""
    return NON_ALNUM.sub("", str(s or "").lower())


def query_title(title: str) -> str:
    """An uploader's title reduced to something that could be a Wikidata label.

    Order matters. Brackets go first because they hold the year and the release
    notes; the episode marker next, because `Bonanza - Bitter Water` must become
    `Bonanza` and not `Bonanza Bitter Water`; then the cruft words; then a trailing
    separator clause, but ONLY when what precedes it is substantial — otherwise
    `Blue's Clues - Full Series` and `Mr. Bean` are cut to nothing.
    """
    t = BRACKETS.sub(" ", str(title or ""))
    t = SXXEXX.sub(" ", t)
    t = CRUFT.sub(" ", t)
    head = re.split(r"\s[-–—:|]\s|\s{2,}", t)[0]
    if len(head.strip()) >= 4:
        t = head
    t = re.sub(r"[\"'`]+", "", t)
    return re.sub(r"\s+", " ", t).strip(" -–—:,.|")


def year_of(entity: dict) -> int | None:
    """The work's year, from publication date or series start. Wikidata times are
    ISO-ish with a leading sign (`+1963-11-23T00:00:00Z`)."""
    for prop in ("P577", "P580"):
        for claim in entity.get("claims", {}).get(prop, []):
            t = _value(claim)
            if isinstance(t, dict) and t.get("time"):
                m = re.search(r"(\d{4})", t["time"])
                if m:
                    return int(m.group(1))
    return None


def _value(claim: dict):
    return (claim.get("mainsnak") or {}).get("datavalue", {}).get("value")


def types_of(entity: dict) -> set[str]:
    out = set()
    for claim in entity.get("claims", {}).get("P31", []):
        v = _value(claim)
        if isinstance(v, dict) and v.get("id"):
            out.add(v["id"])
    return out


def names_of(entity: dict) -> set[str]:
    """Every string this entity answers to: its label and all its aliases. An
    alias is what catches `Digimon: Digital Monsters` for an entity labelled
    `Digimon Adventure`, which is a real match a label-only rule would refuse."""
    out = {entity.get("labels", {}).get("en", {}).get("value", "")}
    for a in entity.get("aliases", {}).get("en", []) or []:
        out.add(a.get("value", ""))
    return {norm(n) for n in out if n}


def is_listed_work(p31: set[str]) -> bool:
    """The offline type test: a flat membership check against WORK_TYPES. Correct
    for the common leaves and wrong for the long tail, which is why the resolver
    injects a hierarchy walk instead. Kept so `pick()` stays pure and testable."""
    return bool(p31 & WORK_TYPES.keys())


def pick(title: str, year, candidates: list[dict], is_work=is_listed_work,
         now: int | None = None) -> tuple[dict | None, str]:
    """The one entity this title certainly is, or None and the reason it isn't.

    Refuses on ambiguity by design. A wrong match writes a confident, plausible,
    false description into a row and then embeds it, which is strictly worse than
    the thin row it replaced — so every rule here is a reason to say no.
    """
    q = norm(query_title(title))
    if not q or len(q) < 3:
        return None, "title too short to identify"
    want = None
    if year and str(year)[:4].isdigit():
        want = int(str(year)[:4])

    typed = [c for c in candidates if is_work(types_of(c))]
    # Nothing released after the crawl is running can be sitting in the archive.
    # This is what separates the 2004 series `Drawn Together` from the 2026 film
    # of the same name when the IA item carries no year of its own to compare.
    if now:
        typed = [c for c in typed if (year_of(c) or 0) <= now]
    if not typed:
        return None, "no candidate is a film or television work"
    named = [c for c in typed if q in names_of(c)]
    if not named:
        return None, "no exact name match among the works"

    if want:
        # A year that DISAGREES is a different work with the same name — the two
        # Nosferatus, the four Draculas. A year that is merely absent is not
        # evidence of anything and must not reject a candidate.
        dated = [c for c in named if year_of(c) is not None]
        agreeing = [c for c in dated if abs(year_of(c) - want) <= 1]
        if dated and not agreeing:
            return None, "name matches but the year does not"
        if len(agreeing) == 1:
            return agreeing[0], "name and year"
        if agreeing:
            named = agreeing
    if len(named) > 1:
        return None, "ambiguous — several works share the name"
    return named[0], "name and type"


# Wikidata's genre labels restate the medium: a single work comes back as
# "science fiction television series, action television series, drama television
# series", which is three genres and the same three words three times. In a 256-d
# average that repetition is dilution — the medium is already in `wdDesc`, and the
# only part carrying information is the adjective.
GENRE_TAIL = re.compile(r"\s+(television\s+(series|program|programme|show)|film|movie|"
                        r"series|fiction\s+film)$", re.I)


def tidy_genre(name: str) -> str:
    out = GENRE_TAIL.sub("", str(name or "")).strip()
    return out or str(name or "")


def fields_from(entity: dict, labels: dict[str, str]) -> dict:
    """The CC0 payload, flattened. `labels` maps the QIDs referenced by
    item-valued properties to their English names, resolved in bulk by the caller
    — one batched lookup for a whole crawl rather than one per genre per row."""
    out: dict = {"qid": entity.get("id")}
    label = entity.get("labels", {}).get("en", {}).get("value")
    if label:
        out["wdLabel"] = label
    desc = entity.get("descriptions", {}).get("en", {}).get("value")
    if desc:
        # "1963 British science fiction television series" — one line that says
        # what the thing IS, which is exactly what a thin row is missing.
        out["wdDesc"] = desc
    claims = entity.get("claims", {})
    for prop, name in ITEM_PROPS.items():
        vals = []
        for claim in claims.get(prop, [])[:MAX_VALUES]:
            v = _value(claim)
            if isinstance(v, dict) and labels.get(v.get("id")):
                vals.append(tidy_genre(labels[v["id"]]) if name == "genre"
                            else labels[v["id"]])
        if vals:
            # dict.fromkeys keeps first-seen order — trimming the medium off
            # three genres can leave two of them identical.
            out[name] = list(dict.fromkeys(vals))
    for prop, name in STRING_PROPS.items():
        for claim in claims.get(prop, [])[:1]:
            v = _value(claim)
            if isinstance(v, str):
                out[name] = v
    for prop, name in QUANTITY_PROPS.items():
        for claim in claims.get(prop, [])[:1]:
            v = _value(claim)
            if isinstance(v, dict) and v.get("amount"):
                try:
                    out[name] = int(float(str(v["amount"]).lstrip("+")))
                except ValueError:
                    pass
    y = year_of(entity)
    if y:
        out["wdYear"] = y
    return out


def referenced_qids(entity: dict) -> set[str]:
    """The QIDs an entity's item-valued properties point at, so a crawl can
    resolve every genre and director it will ever need in batches of 50 instead
    of one call per value per row."""
    out = set()
    for prop in ITEM_PROPS:
        for claim in entity.get("claims", {}).get(prop, [])[:MAX_VALUES]:
            v = _value(claim)
            if isinstance(v, dict) and v.get("id"):
                out.add(v["id"])
    return out


def embed_text(f: dict) -> str:
    """What the match contributes to the vector.

    Ordered by how much each part distinguishes ONE work from another: what it is,
    then the people, then the categories. The embedder's window is finite and the
    front of the string is what survives a truncation.
    """
    parts = [f.get("wdDesc") or ""]
    for key in ("creator", "director", "writer", "cast", "genre", "network",
                "country", "language"):
        v = f.get(key)
        if v:
            parts.append(", ".join(v) if isinstance(v, list) else str(v))
    return " ".join(p for p in parts if p).strip()


# ── network ──────────────────────────────────────────────────────────────────

class Wikidata:
    """Search, fetch and cache. Every network call in this file is behind here.

    The cache is keyed on the QUERY (title + year), not on the entity, and it
    stores misses as well as hits — a wide crawl's cost is dominated by the titles
    that resolve to nothing, and paying for those twice is the whole expense.
    """

    def __init__(self, http, cache_file: str | None = None, now: int | None = None):
        self.http = http
        self.cache_file = cache_file
        self.cache: dict[str, dict | None] = _load(cache_file)
        self.labels: dict[str, str] = {}
        self.stats: dict[str, int] = {}
        self.now = now
        # qid → is it (a subclass of) a film or television work. Seeded with the
        # roots so the walk terminates on them without a lookup.
        self._is_work_memo: dict[str, bool] = {q: True for q in WORK_ROOTS}

    def resolve(self, title: str, year=None) -> dict | None:
        """The CC0 fields for this title, or None. Never raises: an unreachable
        Wikidata is a thinner row, not a failed crawl."""
        q = query_title(title)
        key = f"{norm(q)}|{str(year or '')[:4]}"
        if key in self.cache:
            self._tally("cached hit" if self.cache[key] else "cached miss")
            return self.cache[key]
        try:
            found = self._lookup(q, year)
        except Exception as err:  # noqa: BLE001 — a thin row beats a dead crawl
            # The REASON, not just the fact. A published crawl came back
            # `identified 0.0%` — the strongest mark in legitimacy() never firing
            # once, across every item — and the only thing the report could say
            # was "wikidata unreachable", which reads like a network blip. It is
            # the same counter whether the endpoint is down, the API shape moved,
            # or every call is being refused, and those need different fixes.
            # The transport already retries and backs off on 429 (see _raw in
            # archive_source.py); what it could not do was say what it gave up on.
            self._tally(f"wikidata unreachable ({type(err).__name__}"
                        f"{f' {err.code}' if hasattr(err, 'code') else ''})")
            return None
        self.cache[key] = found
        _append(self.cache_file, key, found)
        return found

    def _lookup(self, q: str, year) -> dict | None:
        if not q or len(q) < 3:
            self._tally("title too short to identify")
            return None
        d = self.http.json(API + "action=wbsearchentities&type=item&language=en"
                                 "&uselang=en&limit=12&search=" + urllib.parse.quote(q))
        ids = [c["id"] for c in (d.get("search") or []) if c.get("id")]
        if not ids:
            self._tally("no such name on wikidata")
            return None
        ents = self.http.json(
            API + "action=wbgetentities&props=labels|descriptions|aliases|claims"
                  "&languages=en&ids=" + "|".join(ids[:50])).get("entities", {})
        for qid, e in ents.items():
            e.setdefault("id", qid)
        entity, why = pick(q, year, list(ents.values()), self._is_work, self.now)
        self._tally(why if not entity else "matched")
        if not entity:
            return None
        self._resolve_labels(referenced_qids(entity))
        return fields_from(entity, self.labels)

    def _is_work(self, p31: set[str]) -> bool:
        """Is any of these types a film or television work, transitively?

        Breadth-first up P279, bounded by MAX_SUBCLASS_DEPTH — the graph is deep
        and everything eventually reaches "work", which would say yes to a novel.
        Every QID the walk touches is memoized in both directions, so a crawl pays
        for each distinct type once and then never again.
        """
        unknown = {q for q in p31 if q not in self._is_work_memo}
        if any(self._is_work_memo.get(q) for q in p31):
            return True
        frontier, seen = set(unknown), set(unknown)
        for _ in range(MAX_SUBCLASS_DEPTH):
            if not frontier:
                break
            parents = self._parents(sorted(frontier))
            if WORK_ROOTS.keys() & {p for ps in parents.values() for p in ps}:
                # Reached a root. Everything on the path is a work — memoizing the
                # whole path is what makes the next crawl of the same collection
                # cost nothing.
                for q in seen | set(p31):
                    self._is_work_memo[q] = True
                return True
            nxt = {p for ps in parents.values() for p in ps} - seen
            seen |= nxt
            frontier = nxt
        for q in p31:
            self._is_work_memo.setdefault(q, False)
        return False

    def _parents(self, qids: list[str]) -> dict[str, list[str]]:
        """P279 (subclass of) for a batch of types, 50 at a time."""
        out: dict[str, list[str]] = {}
        for i in range(0, len(qids), 50):
            try:
                d = self.http.json(API + "action=wbgetentities&props=claims&ids="
                                   + "|".join(qids[i:i + 50]))
            except Exception:  # noqa: BLE001
                continue
            for qid, e in (d.get("entities") or {}).items():
                out[qid] = [v["id"] for v in
                            (_value(c) for c in e.get("claims", {}).get("P279", []))
                            if isinstance(v, dict) and v.get("id")]
        return out

    def _resolve_labels(self, qids: set[str]) -> None:
        """QID → English name, 50 at a time, cached across the whole crawl. Genres
        and countries repeat constantly, so this converges to almost no traffic."""
        todo = sorted(qids - self.labels.keys())
        for i in range(0, len(todo), 50):
            batch = todo[i:i + 50]
            try:
                d = self.http.json(API + "action=wbgetentities&props=labels"
                                         "&languages=en&ids=" + "|".join(batch))
            except Exception:  # noqa: BLE001
                return
            for qid, e in (d.get("entities") or {}).items():
                name = e.get("labels", {}).get("en", {}).get("value")
                if name:
                    self.labels[qid] = name
            # Anything the batch did not answer for is marked resolved-to-nothing,
            # or every row carrying it re-requests it for the rest of the crawl.
            for qid in batch:
                self.labels.setdefault(qid, "")

    def _tally(self, why: str) -> None:
        self.stats[why] = self.stats.get(why, 0) + 1


def _load(path: str | None) -> dict[str, dict | None]:
    if not path:
        return {}
    out: dict[str, dict | None] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a half-written last line, not a dead cache
                out[row["k"]] = row.get("v")
    except FileNotFoundError:
        pass
    return out


def _append(path: str | None, key: str, value) -> None:
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"k": key, "v": value}, separators=(",", ":")) + "\n")
