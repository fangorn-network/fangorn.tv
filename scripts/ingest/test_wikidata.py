"""
Tests for the Wikidata join. No network.

    python3 scripts/ingest/test_wikidata.py

The entities below are trimmed copies of real API responses, and the awkward cases
are all things that actually happened on a live crawl. The rule this file exists to
defend is that a WRONG match is worse than no match: it writes a confident,
plausible, false description into a row and then embeds it, where a refusal just
leaves the row as thin as it already was.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from wikidata import (  # noqa: E402
    WORK_TYPES, embed_text, fields_from, names_of, norm, pick, query_title,
    referenced_qids, tidy_genre, types_of, year_of,
)

ok = 0


def check(cond, msg):
    global ok
    if not cond:
        raise AssertionError(msg)
    ok += 1


def ent(qid, label, p31, year=None, aliases=(), desc="", **claims):
    e = {"id": qid, "labels": {"en": {"value": label}},
         "descriptions": {"en": {"value": desc}},
         "aliases": {"en": [{"value": a} for a in aliases]},
         "claims": {"P31": [{"mainsnak": {"datavalue": {"value": {"id": t}}}} for t in p31]}}
    if year:
        e["claims"]["P577"] = [{"mainsnak": {"datavalue": {"value": {"time": f"+{year}-01-01T00:00:00Z"}}}}]
    for p, vals in claims.items():
        e["claims"][p] = [{"mainsnak": {"datavalue": {"value": {"id": v}}}} for v in vals]
    return e


TV, FILM = "Q5398426", "Q11424"

# ── an uploader's title is not a label ───────────────────────────────────────
# Every case is a real archive.org title. The join is only as good as this.
for raw, want in [
    ("Bonanza - Bitter Water", "Bonanza"),                    # episode name after the show
    ("Blackadder Remastered: The Ultimate Collection", "Blackadder"),
    ("Blue's Clues - Full Series", "Blues Clues"),            # apostrophe is not identity
    ("Night of the Living Dead (1968)", "Night of the Living Dead"),
    ("The Boondocks S01 S02 1080p DVD Upscale", "The Boondocks"),
    ("Digimon: Digital Monsters - The Complete Collection", "Digimon: Digital Monsters"),
    ("Mr. Bean", "Mr. Bean"),                                 # nothing to strip
]:
    got = query_title(raw)
    check(got == want, f"query_title({raw[:36]!r}) = {got!r}, wanted {want!r}")
# Stripping must never take the whole name: a short title with a separator is
# still a title, and an empty query matches everything.
check(query_title("Joey - S01") == "Joey", "a short head must survive its separator")
check(query_title("Up") == "Up", "a two-letter title must not be stripped to nothing")

check(norm("Blue's Clues") == norm("BLUES  CLUES") == "bluesclues", "identity ignores case and punctuation")

# ── the confidence rules ─────────────────────────────────────────────────────
BONANZA = ent("Q862187", "Bonanza", [TV], 1959, desc="American western television series")

got, why = pick("Bonanza", 1959, [BONANZA])
check(got is BONANZA, f"an exact name and a matching year must resolve: {why}")
got, why = pick("Bonanza", None, [BONANZA])
check(got is BONANZA, f"a missing year must not block a certain match: {why}")

# THE failure this file exists for. `wbsearchentities` is a label search and it
# returns rivers, taxa, record labels and family names; the top hit for both
# "Looney Tunes" and "The Beverly Hillbillies" is a VIDEO GAME.
RIVER = ent("Q4022", "Bonanza", ["Q4022"], desc="river")
got, why = pick("Bonanza", None, [RIVER])
check(got is None and "film or television" in why, f"a river is not a work: {why}")
got, why = pick("Bonanza", None, [RIVER, BONANZA])
check(got is BONANZA, "the work must be found past the noise, not blocked by it")

# A name that matches nothing must not fall back to something close.
got, why = pick("Bonanza", None, [ent("Q1", "Bananas", [FILM], 1971)])
check(got is None and "exact name" in why, f"near-misses must not resolve: {why}")

# An alias is a real name. `Digimon: Digital Monsters` is an alias of the entity
# labelled `Digimon Adventure`, and a label-only rule refuses a true match.
DIGI = ent("Q2", "Digimon Adventure", [TV], 1999, aliases=["Digimon: Digital Monsters"])
got, _ = pick("Digimon: Digital Monsters", None, [DIGI])
check(got is DIGI, "an alias must count as a name")

# Two works, one name. The year decides, and without one it must refuse.
NOSF22 = ent("Q3", "Nosferatu", [FILM], 1922, desc="1922 German film")
NOSF79 = ent("Q4", "Nosferatu", [FILM], 1979, desc="1979 film")
got, _ = pick("Nosferatu", 1922, [NOSF22, NOSF79])
check(got is NOSF22, "the year must disambiguate two works of one name")
got, why = pick("Nosferatu", None, [NOSF22, NOSF79])
check(got is None and "ambiguous" in why, f"without a year this must REFUSE, not guess: {why}")

# A year that disagrees is a different work. A year that is merely absent is not
# evidence of anything and must not reject.
got, why = pick("Nosferatu", 1922, [NOSF79])
check(got is None and "year does not" in why, f"a wrong year must reject: {why}")
got, _ = pick("Nosferatu", 1922, [ent("Q5", "Nosferatu", [FILM])])
check(got is not None, "an entity with no year must not be rejected by one")

# Nothing released after the crawl runs can be sitting in the archive. This is
# what separated the 2004 series `Drawn Together` from the 2026 film of the same
# name on an item that carried no year — the live crawl matched the film.
DRAWN04 = ent("Q268438", "Drawn Together", ["Q117467246"], 2004)
DRAWN26 = ent("Q140958739", "Drawn Together", [FILM], 2026, desc="2026 film")
KNOWS_HIERARCHY = lambda t: bool(t & (WORK_TYPES.keys() | {"Q117467246"}))  # noqa: E731
got, why = pick("Drawn Together", None, [DRAWN26], now=2020)
check(got is None, f"an unreleased work must not match an archived upload: {why}")
got, _ = pick("Drawn Together", None, [DRAWN04, DRAWN26], is_work=KNOWS_HIERARCHY, now=2020)
check(got is DRAWN04, "with the film not yet released, the series wins outright")
# Once BOTH are plausible the honest answer is neither, and that is what the live
# crawl now does — this pairing is the one that produced the false match.
got, why = pick("Drawn Together", None, [DRAWN04, DRAWN26], is_work=KNOWS_HIERARCHY, now=2026)
check(got is None and "ambiguous" in why,
      f"two releasable works of one name, no year to separate them: refuse. got {why!r}")

# The type test is INJECTED because a flat list is wrong in the long tail: both
# `Drawn Together` and `The Boondocks` are P31 Q117467246 (animated television
# series), which subclasses to television series but is not itself listed. The
# flat list rejected the real show and admitted a 2026 film of the same name.
check(not types_of(DRAWN04) & WORK_TYPES.keys(),
      "this is exactly the leaf the flat list misses — if it ever gains it, the "
      "hierarchy walk still has to be what decides")

check(pick("", None, [BONANZA])[0] is None, "an empty title must resolve to nothing")
check(pick("ab", None, [BONANZA])[0] is None, "a two-character title identifies nothing")
check(pick("Bonanza", None, [])[0] is None, "no candidates must be answerable, not fatal")

# ── reading an entity ────────────────────────────────────────────────────────
check(year_of(BONANZA) == 1959, f"publication year: {year_of(BONANZA)}")
check(year_of(ent("Q6", "x", [TV])) is None, "a missing date is None, not a guess")
check(names_of(DIGI) == {norm("Digimon Adventure"), norm("Digimon: Digital Monsters")},
      f"names are the label and every alias: {names_of(DIGI)}")

FULL = ent("Q7", "Doctor Who", [TV], 1963, desc="British science fiction television series",
           P136=["Qg1", "Qg2"], P57=["Qd1"], P161=["Qa1", "Qa2"], P449=["Qn1"])
LABELS = {"Qg1": "science fiction", "Qg2": "adventure", "Qd1": "Waris Hussein",
          "Qa1": "William Hartnell", "Qa2": "Patrick Troughton", "Qn1": "BBC"}
check(referenced_qids(FULL) == set(LABELS), f"every item-valued QID must be collected for one "
      f"batched lookup: {referenced_qids(FULL)}")
f = fields_from(FULL, LABELS)
check(f["qid"] == "Q7" and f["wdYear"] == 1963, f"identity and year must survive: {f}")
check(f["genre"] == ["science fiction", "adventure"], f"QIDs must come back as names: {f}")
check(f["cast"] == ["William Hartnell", "Patrick Troughton"], f"cast: {f}")
check(f["wdDesc"].startswith("British science fiction"), "the one-line description is the point")
# An unresolved QID must be dropped, not written into a row as "Q12345".
check("director" not in fields_from(FULL, {k: v for k, v in LABELS.items() if k != "Qd1"}),
      "a QID with no label must be omitted, never emitted raw")

# Wikidata restates the medium in every genre. Doctor Who comes back as three
# genres and the words "television series" three times, which in a 256-d average
# is dilution, not information — the medium is already in wdDesc.
check(tidy_genre("science fiction television series") == "science fiction", tidy_genre("science fiction television series"))
check(tidy_genre("adventure film") == "adventure", tidy_genre("adventure film"))
check(tidy_genre("drama") == "drama", "a genre that does not restate the medium is left alone")
check(tidy_genre("science fiction") == "science fiction", "and trimming must be idempotent")
check(tidy_genre("film") == "film", "a genre that IS only the medium must not be trimmed to nothing")
DUPES = ent("Q8", "Who", [TV], 1963, P136=["Qg1", "Qg2", "Qg3"])
g = fields_from(DUPES, {"Qg1": "action television series", "Qg2": "action film", "Qg3": "drama"})
check(g["genre"] == ["action", "drama"], f"trimming must collapse the duplicates it creates: {g['genre']}")

t = embed_text(f)
check(t.startswith("British science fiction television series"),
      f"what the work IS must lead the embed text: {t[:50]!r}")
check("William Hartnell" in t and "BBC" in t, f"the distinctive nouns must all be there: {t}")
check(embed_text({}) == "", "no match must contribute no text, not the word 'None'")

print(f"wikidata self-check ok — {ok} assertions: title reduction, name/alias identity, "
      "the confidence rules (type, exact name, year agreement, ambiguity, unreleased "
      "works), entity reading, batched label resolution, and the embed text")
