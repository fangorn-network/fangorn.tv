"""
Tests for the content block. No network, no crawler.

    python3 scripts/ingest/test_content_policy.py

This file is more important than its size suggests. The block is the mechanism a
wide launch rests on, and it fails in two directions that need very different
evidence:

  MISSES are a legal problem. Covered by feeding it the vocabulary and the
  evasions — spacing, punctuation, casing, a term buried inside a longer word.

  FALSE POSITIVES are a catalog problem, and they are the ones that get shipped
  unnoticed, because nobody sees the film that was silently not indexed. Every
  title in `KEEP` is a real work or a real place whose name collides with a
  blocked term. They are the regression test for anybody adding a word.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from content_policy import (  # noqa: E402
    EXPLICIT, SOLR_TERMS, _phrases, fold, normalize, record_block, solr_exclusions,
    text_block,
)

ok = 0


def check(cond, msg):
    global ok
    if not cond:
        raise AssertionError(msg)
    ok += 1


# ── normalization: one string, so one pattern catches every spelling ─────────
check(normalize("X-Rated") == normalize("X Rated") == normalize("x.rated") == " x rated ",
      f"punctuation must not be an evasion: {normalize('X-Rated')!r}")
check(normalize(["a", "b"]) == " a b ", "a list field must normalize, not stringify")
# Accents are folded before matching. Without this `[^a-z0-9]` shreds every
# accented word into fragments — `erótica` became `er tica`, so the English
# `erotica` entry never fired on a Spanish title and the block was monolingual.
check(fold("pornografía") == "pornografia" and fold("erótica") == "erotica",
      f"accents must fold: {fold('erótica')!r}")
check(text_block("pornografía casera") is not None, "an accented term must reach the block")
check(normalize(None) == "  ", "a missing field must not crash the block")

# ── FALSE POSITIVES: the half nobody notices ─────────────────────────────────
# Real works, real places, real names. A word added to the block that breaks any
# of these is the wrong word, or needs a boundary it hasn't got.
KEEP = [
    "Moby Dick", "Dick Tracy", "The Dick Van Dyke Show",       # \bdick\b is not blocked
    "The Naked Gun", "The Naked City", "The Naked Spur",       # nor \bnaked\b
    "Sussex by the Sea", "Essex County", "Middlesex Hospital", # …sex, without a boundary
    "Scunthorpe United 1954", "Penistone Line",
    "A cocktail party", "Hitchcock", "Woodcock", "Peacock", "Cockburn",
    "Analysis of an analog computer", "Annals of Anatomy",
    "The Sperm Whale", "Bikini Atoll test footage", "Titanic", "Titanium",
    "Super Bowl XXXV", "Olympiad XXXI",                        # xxx the roman numeral
    "Sexton Blake", "A sextant at sea", "String Sextet in B",
    "Unisex fashions of 1974", "The Scarlet Letter",
    # Orientation and identity are not on any list here and must never be.
    "A Gay Day at the Races", "Lesbian Filmmakers of the 1970s",
    "Paris Is Burning", "The Queer Cinema Reader", "Drag Race 1965",
    # Medicine, art history and law, which use the vocabulary honestly.
    "Breast Cancer Screening 1979", "Computers and Medicine", "Health: Your Posture",
]
for title in KEEP:
    check(text_block(title, label=True) is None,
          f"FALSE POSITIVE — {title!r} blocked on {text_block(title, label=True)!r}")

# ── Spanish: what folding costs, and what must survive it ────────────────────
# Folding turns `ñ` into `n`, which puts several ordinary Spanish words one step
# from a blocked one. Each of these is why a term is deliberately absent from the
# lists, and each would be a large, quiet hole in the Spanish-language catalog.
ES_KEEP = [
    # Roman ordinals. Spanish and Latin American archives number festivals and
    # anniversaries this way as a matter of course, so a bare `xxx` there is a
    # THIRTIETH, not the other thing.
    "XXX Encuentro De Payadores", "XXV Festival de Cine de Bogotá",
    "XXX Aniversario de la Revolución", "XL Muestra de Cine",
    # "funny" at least as often as the other reading — a family animation.
    "Mortadelo y Filemón Contra Jimmy El Cachondo",
    "Los Años Maravillosos", "Cien Años de Soledad",      # año -> ano
    "El Cono Sur", "Cono de Luz",                          # coño -> cono
    "Corrida de Toros 1965",                               # a bullfight run
    "Concha Velasco", "La Concha Marina",                  # a shell, and a name
    "Coger el Autobús", "Niños del Barrio", "Doña Bárbara",
    "La Zorra y el Cuervo", "Senos y Pulmones: Anatomía",
    "El Sexteto de Cámara", "Noticiario Hechos", "Tele Elx Tele Nit",
]
for title in ES_KEEP:
    check(text_block(title, label=True) is None,
          f"FALSE POSITIVE (es) — {title!r} blocked on {text_block(title, label=True)!r}")

check(text_block("XXX Hardcore", label=True), "the ordinal guard must not disarm the term")
ES_BLOCK = ["Mujer Desnuda 1974", "Cine Erótico Español", "pornografía casera",
            "La Puta del Rey", "Sexo en Nueva York", "Tetas Grandes",
            "Sin Censura - Solo Para Adultos", "Prostitución en Madrid",
            "Destape Español", "felación", "masturbación", "Cine Porno Mexicano"]
for title in ES_BLOCK:
    check(text_block(title, label=True), f"MISS (es) — {title!r} was not blocked")

# The tiers mean the same thing in either language: `sexo` and `desnuda` are
# topical, so they block a title and not a synopsis.
check(text_block("un documental sobre la sexualidad en el cine") is None,
      "a Spanish synopsis must survive the topical tier, as an English one does")
check(text_block("La Sexualidad Adolescente", label=True),
      "…and the same word in a Spanish title must still block")
# Identity words are absent in every language.
for title in ["Cine Gay Latinoamericano", "Documental Travesti 1987"]:
    check(text_block(title, label=True) is None, f"identity is never blocked: {title!r}")

# ── MISSES: the vocabulary, and the ways round it ────────────────────────────
BLOCK = ["Hardcore XXX", "PORNO 1974", "Vintage Erotica Vol 3", "Sexy Nurses",
         "fellatio", "The Vagina Monologues", "blow-job", "X-Rated Feature",
         "Adult Film Archive", "Deep Throat", "girls gone wild", "Bukkake",
         "preteen models", "child porn", "BDSM Bondage Training", "Nudist Colony",
         "Striptease Reels", "A dominatrix at work", "Cum Shot Compilation",
         "gang bang", "Fetish Fuel", "hentai collection"]
for title in BLOCK:
    check(text_block(title, label=True), f"MISS — {title!r} was not blocked")

# Buried in a longer word, which word boundaries alone would let through. This is
# what the substring tier is for, and it is why that tier is short.
for handle in ["Pornhub", "MILFhunter", "bigpornstar", "Pedophilia", "camgirl4u"]:
    check(text_block(handle, label=True), f"MISS — {handle!r} evaded by being one token")
# …and only for LABELS. Prose has spaces and needs no such help; running the
# substring tier over prose blocked My Little Pony on one buried fan-note token.
check(text_block("a note thanking the pornhub-era fan artists") is None,
      "the substring tier must not reach into prose")

# Casing and separators are not an evasion.
check(text_block("C U N N I L I N G U S") is None, "letter-spacing is out of scope, and honestly so")
check(all(text_block(v) for v in ["CuNnIlInGuS", "cunni.lingus".replace(".", "")]),
      "casing must collapse to one match")
check(all(text_block(v, label=True) for v in ["Gang-Bang", "gang bang", "GANG_BANG"]),
      "separators must all collapse to one match")

# ── the two tiers ────────────────────────────────────────────────────────────
# Explicit vocabulary is blocked in free prose. It does not appear in the
# description of a work worth having.
check(text_block("The film contains explicit fellatio."), "explicit prose must block")
# Label vocabulary is not, because serious films are ABOUT these things. Blocking
# a synopsis takes The Accused and Chinatown with it.
for prose in ["A courtroom drama about the trial that followed the rape.",
              "A study of prostitution in Weimar Berlin.",
              "The story of an incestuous family in decline.",
              "Documentary on nudity in postwar cinema.",
              "A survey of the nude in Western art, from Titian onward."]:
    check(text_block(prose) is None, f"a synopsis must survive: {prose!r}")
    check(text_block(prose, label=True), f"…but the same words in a TITLE must not: {prose!r}")

# The topical words, which is where the tiers were actually measured. Each of
# these prose snippets is quoted from a real archive.org description that the
# block rejected before the rebalance, and each names a work the catalog wants.
for prose, work in [
    ("…your clop artist friends who like to give you sexually oriented pony art…", "My Little Pony"),
    ("Pamela Anderson before the sex tape, Jason Momoa before becoming Aquaman", "Baywatch"),
    ("also stars the lovely and sexy Delvene Delaney", "The Paul Hogan Show"),
    ("the series focuses on the lives of pre-teen Hispanic twins", "Maya & Miguel"),
    ("the episodes become racier, with more resounding sexual themes", "Home Movies"),
    ("Everything You Always Wanted to Know About Sex But Were Afraid to Ask (1972)", "Woody Allen"),
    ("a history of American hardcore punk, 1980-1986", "hardcore punk"),
    ("Candice Bergen's Murphy Brown interviews Deep Throat about Watergate", "Murphy Brown"),
    ("Aeon Flux, a leather-clad dominatrix of an assassin", "Aeon Flux"),
    ("bark strippers and paint stripper at the Tasmanian logging mill", "Tasmania: Logging"),
]:
    check(text_block(prose) is None, f"FALSE POSITIVE — {work} blocked on {text_block(prose)!r}")
# …and the same words in a title are still the block working.
for title in ["Real Sex (HBO Series) - Complete Docuseries", "Sexy Nurses",
              "Playboy: The Complete Collection", "Vintage Burlesque Reels",
              "Striptease Reels 1958", "The Stripper (1963 Reissue Print)",
              # A genre that names itself rather than describing itself. Found in
              # a live crawl, where it passed the entire block.
              "Air Hostess S 01 E 01 Unrated Hindi Hot Web Nue Flik",
              "Charmsukh Unrated Hot Web Series", "Ullu Originals Complete",
              "Kooku Web Series 2021", "Bold Web Series Uncut"]:
    check(text_block(title, label=True), f"MISS — {title!r} is labelled with what it is")

# A subject list on archive.org is a keyword dump, not a label — one item lists
# forty films it shows, including Ed Wood's "Orgy of the Dead". Judged as prose.
check(text_block(["Vincent Price", "Orgy of the Dead", "Tales from the Crypt"]) is None,
      "a subject dump naming other films must not label the item")
check(text_block(["porno", "1970s"]) is not None,
      "…but a subject that is genuinely the category still blocks")
# `erotica` and `hentai` are NOT that case any more. Folding made both reach
# Spanish prose for the first time, where they blocked an art item (`ilustración
# erótica al estilo japonés`) and three podcasts on the history of manga in
# Mexico. Both are topical now — a title that leads with them still blocks.
check(text_block(["ilustracion", "erotica", "dibujos"]) is None,
      "a subject dump naming a style must not read as a category")
check(text_block("pionera del movimiento hentai en Mexico") is None,
      "a genre mentioned in prose is a mention, not a label")

# ── whole records ────────────────────────────────────────────────────────────
GOOD = {"id": "computerchronicles-medicine", "title": "Computers and Medicine",
        "desc": "An episode about diagnostic software and medical imaging.",
        "creator": "Stewart Cheifet", "subject": ["computing", "medicine"],
        "collections": ["computerchronicles"],
        "videos": [{"file": "cc1985.mp4", "title": "Computers and Medicine"}]}
check(record_block(GOOD) is None, f"a clean record must pass: {record_block(GOOD)}")
for field, value in [("title", "Sexy Nurses"), ("creator", "Pornhub"),
                     ("id", "hardcore-vol-4"), ("subject", ["porno", "1970s"]),
                     ("collections", ["vintage-porn"]),
                     ("desc", "Contains explicit fellatio."),
                     ("videos", [{"file": "scene1-xxx.mp4", "title": "Scene 1"}])]:
    check(record_block(dict(GOOD, **{field: value})),
          f"a record must be blocked on its {field}: {value!r}")
# A record is checked field by field, so a missing one is not a crash.
check(record_block({}) is None, "an empty record must be answerable, not fatal")
check(record_block({"title": None, "videos": None, "subject": None}) is None,
      "null fields must not crash the block")

# ── the RATINGS tier: a label in `subject`, a mention in prose ───────────────
# Both halves measured on one published crawl; each was a real regression once.
check(record_block(dict(GOOD, subject=["Comedy", "Softcore", "Sitcom"])) == "softcore",
      "a rating word in a SUBJECT list is the uploader's own genre tag — block it")
check(record_block(dict(GOOD, desc="A fan restoration of WCE Wrestling (oft called "
                                   "'Softcore TV' in retrospective articles).")) is None,
      "the same word in free PROSE is a passing mention — 30 wrestling rows rode on this")
check(text_block("Softcore", ratings=True) == "softcore", "subject gets the ratings tier")
check(text_block("oft called Softcore TV in articles") is None, "prose does not")

# ── the wrestling exception ─────────────────────────────────────────────────
# 60 rows, and the single largest block in the whole policy, were one wrestling
# programme. `hardcore` still blocks everywhere it is not a kind of wrestling.
for keep in ("WCE Hardcore TV - 1999", "ECW Hardcore TV", "Hardcore Championship 1998",
             "WWF Hardcore Title Match"):
    check(text_block(keep, label=True) is None, f"wrestling must survive: {keep!r}")
for block in ("Hardcore Anal", "Hardcore Vol 4", "hardcore-collection-1978"):
    check(text_block(block, label=True), f"hardcore that is not wrestling must block: {block!r}")

# ── episodes are BROADCAST titles, not uploader labels ──────────────────────
# This loop condemns the whole item, so a false positive here costs a series, not
# a file. Every title below is a real one from a published crawl, and each cost
# 8-30 rows of exactly the catalog this is trying to build.
for ep in ("S01E08 - Full Frontal Nudity.mp4",           # Monty Python
           "S02E11 - The Liar and the Whore.mp4",        # Six Feet Under
           "S02E16 - Date Rape.mp4",                     # Cagney & Lacey
           "S01E37 - China Cat, Cock-a-Doodle Dandy.mp4",  # Garfield and Friends
           "S01E28 - Bullwinkle's Corner - I Love Little Pussy.mp4",
           "S01E27 - Joey and the Spanking.mp4",         # Joey
           "S01E01 - Dear Sexy Knickers.mp4",            # Are You Being Served?
           "S02E04 - Sex, Lies and DNA.mp4",             # Forensic Files
           "S10E19 - Acoso sexual.mp4",                  # ER (Latin dub)
           "S01E04 - Poo Poo Platter.mp4"):              # Jackass
    check(record_block(dict(GOOD, videos=[{"file": ep, "title": ep}])) is None,
          f"a broadcast episode title must not condemn its series: {ep!r}")
# What the episode loop is FOR: the tokens an uploader jams into a filename,
# where word boundaries cannot help and the item's own fields stayed clean.
for ep in ("SpankBang.com_secret+nightclub+yunatbm+3d+hentai_720p.mp4",
           "Kavita Bhabhi Season 3 2022 Ullu Hindi Hot Web Series.mp4",
           "See.You.Later.Masturbator.720p.HDTV.x264.mp4",
           "scene1-xxx.mp4"):
    check(record_block(dict(GOOD, videos=[{"file": ep, "title": ep}])),
          f"a dump filename must still condemn the item: {ep!r}")

# ── trash words are a LABEL, not an EXPLICIT term ───────────────────────────
# `poop` exists to drop `HARLEM SHAKE POOP` (2.8M downloads, and the shape of
# thing --min-downloads actively promotes). On EXPLICIT it also read prose and
# filenames, and took 25 rows of Jackass with it.
check(record_block(dict(GOOD, title="HARLEM SHAKE POOP")), "a trash title must block")

# ── the free half ────────────────────────────────────────────────────────────
q = solr_exclusions()
check(q.startswith(" AND -("), f"the clause must AND onto an existing query: {q[:20]!r}")
check("title:(" in q and "subject:(" in q and "description:(" in q,
      "the query filter must cover the fields a search row carries")
check("porn" in q and "bestiality" in q, "the worst of it must be excluded server-side")
# The invariant that keeps the two halves of the block honest. solr matches
# `description` — free prose — and an item it drops never reaches the local gate,
# so a label-tier or ratings-tier word on that list is a stricter, invisible,
# unappealable rule. `hardcore` (a wrestling genre) and `erotic` were both on it.
_explicit = set(_phrases(EXPLICIT))
for term in SOLR_TERMS:
    check(term in _explicit,
          f"SOLR_TERMS must be a subset of EXPLICIT — {term!r} reads prose server-side")
check(len(q) < 1200, f"the clause rides in a URL on every page of every crawl: {len(q)} chars")

print(f"content_policy self-check ok — {ok} assertions: normalization and accent "
      f"folding, {len(KEEP) + len(ES_KEEP)} real works that must NOT be blocked "
      f"(en+es), {len(BLOCK) + len(ES_BLOCK)} that must be, substring evasion, the "
      "explicit/label/ratings split, the wrestling exception, broadcast episode "
      "titles, whole records, and the solr clause")
