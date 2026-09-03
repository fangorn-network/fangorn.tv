"""
The content block. What must never be published, regardless of how good it looks.

This is not a quality gate — `judge()` in archive_source.py is the quality gate,
and it is allowed to be wrong in both directions because the cost of a mistake is
a mediocre shelf. THIS file is the legal one. It decides what a widely-launched
catalog is not allowed to contain, and it is deliberately over-broad: a false
positive costs one film out of two million, a false negative costs the launch.

Held apart from the crawler on purpose. It is the piece most likely to be
reviewed by somebody who is not going to read a thousand lines of crawler to find
the list, the piece most likely to need a term added in a hurry, and the piece
that most needs its own tests.

WHERE IT RUNS
-------------
Four places, cheapest first, because the whole point is that a blocked item never
costs a network call:

    solr_exclusions()  folded into the search query — never even returned
    text_block()       on the search row, before its metadata call (prejudge)
    record_block()     on the resolved item, over every field including filenames
    record_block()     the SUBSTRINGS tier per episode filename, so a dump whose
                       item fields stayed clean still dies (and it dies WHOLE —
                       one bad file condemns every sibling, which is why that
                       check runs the narrowest tier and not the broadest)

Belt and braces is intentional. Any one of these could be bypassed by a coy
title; all four together need the uploader to have labelled nothing.

THREE TIERS
------------
EXPLICIT is matched in every field, free prose included. These are words that do
not appear in the description of a work we want.

RATINGS is `softcore`/`hardcore`/`x rated` — see its own note below. Matched in
the label fields and in `subject`, never in free prose.

LABELS is matched only in the fields an uploader uses to NAME a thing — title,
subject, creator, collection id, filename. `rape`, `incest` and `prostitute` are
subjects serious films are about; "The Accused" and "Chinatown" have them in
their synopses and belong in a catalog. An uploader who puts them in the TITLE is
telling you what the file is.

WHAT IS DELIBERATELY ABSENT
---------------------------
Orientation and identity — gay, lesbian, bisexual, trans, queer, drag — are not
on any list here and must never be added. They describe people and a large body
of legitimate film; blocking them would be both a bug and a slur. If porn labelled
with them slips through, it slips through on `porn`, `xxx` or `hardcore`, which
it always also carries.

Words legitimate works collide with are absent for the same reason: `dick`
(Dick Tracy, Moby Dick), `naked` (The Naked Gun, The Naked City), `sperm` (sperm
whale), `bikini` (Bikini Atoll), `flogging`, `climax`, `nipple`. `cock` and
`pussy` were on EXPLICIT until a crawl measured them: they blocked *Garfield and
Friends* ("Cock-a-Doodle Dandy", two seasons) and *The Bullwinkle Show* ("I Love
Little Pussy", a nursery rhyme) — 74 rows of children's television. `whore` and
`spanking` went the same way on the same crawl, for *Six Feet Under* ("The Liar
and the Whore") and *Joey* ("Joey and the Spanking") — 60 more. They sit on
LABELS now, where a porn TITLE still trips them and an episode title does not.

`poop` and `butthole` sit on LABELS rather than EXPLICIT for a related but
distinct reason: they are not adult content at all, they are a TRASH signal, and
this file is the legal gate rather than the quality one. On LABELS they still
block an item called *HARLEM SHAKE POOP* — the thing they were added for — while
an episode of *Jackass* called "Poo Poo Platter" survives, which on EXPLICIT it
did not (25 rows). Quality filtering belongs in `judge()`, which has signals to
weigh; a word list can only say yes or no. Everything that
IS listed is matched on word boundaries in a normalized string, which is what
keeps Sussex, Scunthorpe, cocktail, analysis, analog and titanium out of it —
those need no exception because they can never match.
"""
from __future__ import annotations

import re
import unicodedata

# ── the lists ────────────────────────────────────────────────────────────────
# Phrases are written in NORMALIZED space: lowercase, and every run of
# non-alphanumerics is one space. So "x-rated", "X Rated" and "x.rated" are all
# the entry `x rated`, and the joined form `xrated` needs its own entry.

EXPLICIT = """
porn porno pornos pornographer porny xxx xxxx x_rated xrated
ecchi doujin doujinshi lolicon shotacon
jailbait camgirl cam_girl camwhore onlyfans only_fans nsfw milf milfs gilf
sexploitation sexcapades sexpot intercourse fellatio cunnilingus blowjob
blow_job blowjobs handjob hand_job rimjob rimming creampie cumshot cum_shot
jizz jism gangbang gang_bang bukkake fisting deepthroat felching
masturbate masturbating masturbation onanism jerking_off jacking_off wanking
orgasm orgasms orgasmic ejaculate ejaculation ejaculating coitus fornication
fornicating sodomy sodomize buggery anal_sex analingus buttfuck butt_fuck titfuck
tit_fuck dildo dildos buttplug butt_plug strapon strap_on fleshlight sextoy
sex_toy sextoys
vagina vaginal vulva labia clitoris clitoral clit penis penile
twat cunt asshole ass_hole anus scrotum
genitals genitalia foreskin
striptease stripclub strip_club
peepshow peep_show nudie nudies nudist nudists naturist naturists penthouse_pet
girls_gone_wild slut sluts nympho nymphomaniac nymphomania
fetish fetishes bdsm bondage sadomasochism sadomasochistic masochism masochist
sadism femdom maledom upskirt downblouse voyeur voyeurism
exhibitionism golden_shower coprophilia urophilia zoophilia bestiality necrophilia
child_porn childporn kiddie_porn child_pornography pedophile pedophilia pedophiles
underage
adult_film adult_films adult_video adult_videos adult_movie adult_movies
adult_entertainment
pornografia pornografico pornografica
felacion masturbacion masturbarse masturbandose eyaculacion eyacular orgasmo
orgasmos mamada mamadas follar follando follada corrida_anal penetracion_anal
consolador vibrador_sexual sadomasoquismo sadomasoquista pedofilia pederasta
pederastia zoofilia bestialismo prostibulo lupanar
pene penes verga vulva clitoris vagina
"""

# Matched only where an uploader LABELS a thing: the title, the creator, the
# identifier, the filename. NOT in free prose, and not in `subject` either — see
# the note below on why subject sits with prose.
#
# Two kinds of word live here, for the same reason and from the same evidence.
#
# The first are subjects that serious films are ABOUT. A synopsis that says
# "a courtroom drama about the trial that followed the rape" is describing The
# Accused. An uploader who puts the word in the TITLE is describing something
# else.
#
# The second are TOPICAL words — `sex`, `sexual`, `pornography`, `preteen`,
# `hardcore`, `playboy`, `burlesque`. These were in EXPLICIT until the block was
# measured against 6,000 real archive.org rows, where matching them in free prose
# rejected: My Little Pony ("sexually oriented pony art" in a fan note), Baywatch
# ("before the sex tape"), The Paul Hogan Show ("the lovely and sexy Delvene
# Delaney"), Maya & Miguel ("pre-teen Hispanic twins"), Home Movies ("more
# resounding sexual themes"), and Woody Allen's filmography (a film with the word
# in its own title). Every one of those is a work the catalog wants, and every one
# was dropped by a passing mention. In a TITLE the same words still block, which
# is what keeps "Real Sex (HBO)" and "Sexy Nurses" out.
LABELS = """
sex sexy sexier sexiest sexual sexually sexuality sexualized pornography
pornographic playboy burlesque preteen pre_teen adults_only
nude nudes nudity topless bottomless rape raped raping rapist incest incestuous
molest molested molestation prostitute prostitutes prostitution brothel bordello
orgy orgies taboo kink kinky swinger swingers sleaze sleazy smut smutty
uncensored unrated lingerie tits titties boobs knockers dominatrix deep_throat
stripper strippers cock cocks pussy pussies whore whores spanking
poop butthole
hot_web_series bold_web_series ullu nuefliks nue_flik charmsukh kooku primeflix
hentai erotic erotica eroticism erotique erotico erotismo
sexo sexual sexuales sexualidad desnuda desnudo desnudas desnudos desnudez
desnudismo destape tetas tetona tetonas nalgas culito puta putas puto putita
puteria prostituta prostitutas prostitucion burdel incesto violacion sin_censura solo_para_adultos para_adultos peliculas_para_adultos
"""


# ── the third tier: RATINGS ──────────────────────────────────────────────────
# Words that say how explicit a thing IS, rather than naming what it is. They
# needed a tier of their own because they are an honest label and dishonest prose
# at the same time, and neither tier above can express that:
#
#   subject ['Comedy', 'Softcore', 'Sitcom']        Hot Springs Hotel. A label.
#   desc "oft called 'Softcore TV' in retrospective  WCE Wrestling, subject
#         articles"                                  ['Pro wrestling','ECW'].
#
# Measured on a published crawl of 14,223 rows: with `softcore` in EXPLICIT it
# matched free prose, and that one sentence about a fan restoration of a
# wrestling show cost 30 rows. The same measurement found 16 rows correctly
# blocked on `softcore` in a SUBJECT list. EXPLICIT reads prose and would keep
# losing the wrestling; LABELS does not read subject and would lose Hot Springs.
# So: matched in the label fields AND in `subject`, and never in free prose.
RATINGS = """
softcore soft_core hardcore hard_core x_rated xrated
"""

# `WCE Hardcore TV`, `ECW Hardcore TV`, `Hardcore Championship`. Hardcore is a
# wrestling genre with its own long-running programmes, and on that same crawl it
# was the single largest block in the entire policy — 60 rows, every one of them
# a wrestling match. Stripped before matching rather than dropped from the list,
# exactly as ROMAN_ORDINAL handles `XXX Encuentro`: `Hardcore Anal` is untouched,
# because that is not a kind of wrestling.
WRESTLING = re.compile(
    r"\bhardcore\s+(tv|wrestling|championship|champion|title|match|matches|"
    r"federation|division|legend|legends|era|classic|classics)\b")


def _phrases(block: str) -> list[str]:
    """One entry per whitespace-separated token; an underscore inside an entry is
    a space, so a multi-word phrase (`blow_job`, `girls_gone_wild`) stays one
    unambiguous entry sitting in the list beside the single words.

    Writing them inline rather than in a separate phrase list is not cosmetic: a
    separate list needs the phrase's component words kept OUT of the word list,
    and the first version of this file did that by stripping them — which
    silently removed `sex`, `porn`, `cum` and `adult` from the block, because
    each is also half of a phrase. Everything is one list now, so that cannot
    recur.
    """
    return sorted({w.replace("_", " ") for w in block.split() if len(w) > 2})


_WORDS_EXPLICIT = _phrases(EXPLICIT)
_WORDS_LABELS = _phrases(LABELS)
_WORDS_RATINGS = _phrases(RATINGS)


NORMALIZE = re.compile(r"[^a-z0-9]+")
COMBINING = re.compile(r"[\u0300-\u036f]")


def fold(text: str) -> str:
    """Accents off: `pornografía` → `pornografia`, `erótica` → `erotica`.

    Not optional, and not only for Spanish. Without it `[^a-z0-9]` shreds every
    accented word into fragments — `erótica` became `er tica`, so the English
    `erotica` entry never fired on a Spanish-language title at all, and the block
    was quietly monolingual.
    """
    return COMBINING.sub("", unicodedata.normalize("NFKD", text))


# `XXX Encuentro de Payadores` is the THIRTIETH meeting of something. Spanish and
# Latin American archives number festivals, congresses and anniversaries in roman
# numerals as a matter of course, so a bare `xxx` there is an ordinal and nothing
# else. Stripping the whole phrase before matching is narrower than dropping the
# term: `XXX Hardcore` is untouched, because `hardcore` is not a kind of meeting.
ROMAN_ORDINAL = re.compile(
    r"\b[xivl]{2,7}\s+(encuentro|festival|aniversario|congreso|edicion|jornadas|"
    r"certamen|semana|muestra|feria|concurso|simposio|coloquio|asamblea|"
    r"anniversary|edition|congress|meeting|annual|olympiad|symposium|conference)\b")


def normalize(text) -> str:
    """Lowercase, accents folded, and every run of non-alphanumerics becomes one
    space, so that `X-Rated`, `x.rated` and `X  RATED` are one string and one
    pattern matches all three. Padded with spaces so a phrase at either end still
    has a boundary."""
    if isinstance(text, (list, tuple, set)):
        text = " ".join(str(t) for t in text)
    flat = NORMALIZE.sub(" ", fold(str(text or "")).lower())
    return " " + WRESTLING.sub(" ", ROMAN_ORDINAL.sub(" ", flat)).strip() + " "


# Matched ANYWHERE, boundaries ignored — `pornhub`, `bigtitsxxx`, `pedophilia`,
# `MILFhunter`. Word boundaries are what keep Sussex, Scunthorpe and cocktail out
# of the block, so this tier is short and every entry is a string that cannot
# occur inside an innocent English word. Nothing goes in here without checking
# that: `sex` cannot (Sussex, sextant, unisex), `anal` cannot (analysis), `cock`
# cannot (cocktail). These can.
#
# LABEL FIELDS ONLY, like the LABELS tier and for a sharper version of the same
# reason: this tier exists for handles and filenames, where a name is jammed into
# one token and boundaries cannot help — `Pornhub`, `camgirl4u`, `bigtitsxxx`.
# Prose has spaces in it and needs no such help, and running this over prose is
# what blocked My Little Pony on one substring buried in a fan note.
SUBSTRINGS = """
porn hentai doujin bukkake bestiality pedophil paedophil lolicon shotacon jailbait
camgirl camwhore cumshot blowjob handjob dildo masturbat fellatio cunnilingus
clitor vagina ejaculat striptease nymphoman dominatrix upskirt downblouse
deepthroat gangbang creampie sodomi sodomy necrophil zoophil coprophil urophil
milf bdsm fetish
ullu nueflik charmsukh kooku primeflix spankbang xvideos xhamster xnxx redtube
""".split()
# `xxx` is deliberately NOT in that list — it is a roman numeral. As a substring
# it blocks "Super Bowl XXXV" and "Olympiad XXXI"; the word tier already carries
# it, and standing alone as a word it is only ever the other thing.


# ── Spanish, and the words that could not go in ──────────────────────────────
# archive.org's Spanish-language holdings are large, and until accents were folded
# the block did not read them at all. The terms are folded into the two lists
# above rather than kept apart, because a tier is a statement about how a word
# behaves in prose and that does not change with the language.
#
# What is missing from those lines matters more than what is on them. Folding
# turns `ñ` into `n`, and these collisions are why each of the following is
# ABSENT and must stay absent:
#
#   ano, anos     `año`/`años` — YEAR. The single most common word in a catalog
#                 of dated films. Blocking it would empty the Spanish shelf.
#   cono          `coño` folds onto `cono`, a cone. Unfixable while folding, and
#                 folding buys more than this word costs.
#   corrida       a bullfight run (`corrida de toros`) far more often than the
#                 other thing.
#   coger         "to take/to catch" across most of Spain; vulgar only regionally.
#   concha        a shell, and a common given name.
#   zorra         a vixen. `chichi`, `senos`, `pechos` and `caliente` are out for
#                 the same reason — ordinary words doing ordinary work.
#   joder         a mild expletive that turns up in perfectly normal prose.
#   cachondo      "funny" as readily as "horny". It blocked *Mortadelo y Filemón
#                 Contra Jimmy El Cachondo*, a mainstream family animation.
#   pedo          "fart", and a syllable of Spanish names. It fired on a subject
#                 dump reading `cabildo de pedo san gines`. `pedophile`,
#                 `pederasta` and the `pedophil` substring carry the real meaning
#                 without the collateral.
#
# Folding also made two ENGLISH entries reach Spanish prose for the first time,
# and both had to move to the label tier as a result: `erotica` was blocking
# "Adi Pasos, ilustración erótica al estilo japonés" (an art item — in Spanish the
# word is an adjective far more often than a genre), and `hentai` was blocking
# three podcast episodes about the history of manga in Mexico that merely mention
# it. Both still block a TITLE that leads with them.
#
# And as in English: `travesti`, `transexual` and every other identity word are
# not here and must never be added.
#
# `violacion` IS on the label list, but it is the weakest entry there — a human
# rights documentary is a `violación de derechos humanos`. It is label-only, so a
# synopsis is safe; a TITLE that leads with it is telling you what it is.


def _pattern(*groups: list[str]) -> re.Pattern:
    """Longest alternative first, so `child porn` is reported rather than `porn`
    — the term that fired is what somebody auditing the block needs to see."""
    alts = sorted({a for g in groups for a in g}, key=len, reverse=True)
    return re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(a) for a in alts) + r")(?![a-z0-9])")


_EXPLICIT_RX = _pattern(_WORDS_EXPLICIT)
_LABEL_RX = _pattern(_WORDS_EXPLICIT, _WORDS_LABELS, _WORDS_RATINGS)
_RATING_RX = _pattern(_WORDS_EXPLICIT, _WORDS_RATINGS)
_SUBSTRING_RX = re.compile("|".join(re.escape(w) for w in sorted(SUBSTRINGS, key=len, reverse=True)))


def text_block(text, *, label: bool = False, ratings: bool = False) -> str | None:
    """The offending term, or None.

    `label=True` for a field an uploader NAMES a thing with — title, creator,
    collection id, filename — which is also matched against the LABELS and
    RATINGS tiers, and against SUBSTRINGS.

    `ratings=True` for `subject`: prose rules, plus the RATINGS tier. A subject
    list is a keyword dump rather than a label (see record_block), so it must not
    get the LABELS tier — but `Softcore` sitting in one is the uploader's own
    genre tag and is exactly what that tier is for.
    """
    norm = normalize(text)
    m = (_LABEL_RX if label else _RATING_RX if ratings else _EXPLICIT_RX).search(norm)
    if m:
        return m.group(1)
    if label:
        m = _SUBSTRING_RX.search(norm)
        if m:
            return m.group(0)
    return None


def record_block(rec: dict) -> str | None:
    """The offending term anywhere in a resolved item, or None.

    Filenames and episode titles are checked with the rest: a wholesome item
    description over a file called `...xxx.mp4` is exactly the shape of thing this
    exists to stop, and it is the last check before the row is published.
    """
    for field in ("title", "creator", "id", "identifier"):
        hit = text_block(rec.get(field), label=True)
        if hit:
            return hit
    # `subject` and `collections` are judged with PROSE, not with labels. On
    # archive.org a subject list is a keyword dump, not a label: The Hypnotic Eye
    # Episode 4 lists forty of the films it shows, one of which is Ed Wood's "Orgy
    # of the Dead", and the label tier read that as a label for the item itself.
    for key in ("subject", "collections"):
        hit = text_block(rec.get(key) or [], ratings=key == "subject")
        if hit:
            return hit
    hit = text_block(rec.get("desc") or rec.get("description"))
    if hit:
        return hit
    # EPISODES: the SUBSTRINGS tier only, and nothing else.
    #
    # This loop condemns the whole ITEM — one bad file drops every sibling — which
    # is right for a dump and catastrophic for a series. It ran the LABELS tier,
    # and an episode title is not a label: it is a BROADCASTER'S title, the same
    # argument that already puts `subject` on the prose tier a few lines up.
    # Measured over a published crawl it condemned 22 items totalling 430 rows,
    # of which two were things anyone wanted gone:
    #
    #   Monty Python "Full Frontal Nudity"   Six Feet Under "The Liar and the Whore"
    #   Cagney & Lacey "Date Rape"           Are You Being Served? "Dear Sexy Knickers"
    #   Garfield "Cock-a-Doodle Dandy"       Bullwinkle "I Love Little Pussy"
    #   Forensic Files "Sex, Lies and DNA"   The Apprentice "Sex, Lies and Altitude"
    #
    # EXPLICIT was no better here — on filenames it ran 5 false positives to 1 real
    # hit. SUBSTRINGS is the tier that fits: tokens that cannot occur inside an
    # innocent English word, which is exactly what an uploader jams into a
    # filename ("SpankBang.com_...hentai_720p", "Kavita.Bhabhi.Ullu.WebSeries").
    # Re-measured on the same crawl, this catches every real hit the label tier
    # found and NONE of the 23 false positives.
    for v in rec.get("videos") or []:
        hit = episode_block(v.get("file"), v.get("title"))
        if hit:
            return hit
    return None


def episode_block(filename, title=None) -> str | None:
    """The offending term in ONE episode's filename and title, or None.

    Its own function because it has two callers — record_block above, and the
    per-episode check in build_graph that is the last thing to run before a video
    vertex is written. They were separate copies of `text_block(..., label=True)`
    and only one of them got fixed, which is how a Monty Python episode came back
    from record_block clean and was then dropped one layer down.

    The tiers are SUBSTRINGS and EXPLICIT, never LABELS — see the note in
    record_block for the measurement. Everything about an episode is written by
    the broadcaster except the mangling around it, and mangling is what
    SUBSTRINGS reads."""
    norm = normalize(f"{filename or ''} {title or ''}")
    m = _SUBSTRING_RX.search(norm) or _EXPLICIT_RX.search(norm)
    return m.group(0) if m else None


# ── the free half: what solr can reject before it is ever returned ───────────
# A short list on purpose. Every term here is one archive.org filters server-side
# for free, but the query is a URL and `television` alone is 739,282 items behind
# a cursor — a 400-term clause makes every page of every crawl slower to buy back
# rejections that `text_block` does for nothing. The local gate is the real one;
# this is the part that saves metadata calls.
# EVERY TERM HERE MUST BE ON THE EXPLICIT TIER. The clause matches `description`,
# which is free prose, and an item it excludes never comes back — so a LABELS or
# RATINGS word here quietly enforces a STRICTER rule server-side than the local
# gate would, with no appeal and no way to see what was lost. `hardcore` was here
# and is a wrestling genre; `erotic`, `erotica`, `erotico`, `desnuda`, `desnudo`
# and `destape` are all label-tier words that read prose from this list alone.
# So are `pornography`, `pornographic` and `hentai` — the last of which was
# blocking podcast episodes about the history of manga before it was demoted, and
# was still doing it server-side afterwards. The test suite asserts the
# invariant, so this cannot drift back.
#
# The cost of each removal is metadata calls, not catalog: `hentai` is on both
# LABELS and SUBSTRINGS, so a hentai item now comes back from solr and dies
# locally on its title or its identifier instead. That is the trade this list is
# for — it saves calls, it does not decide anything.
#
# `xxx` is off it for the ROMAN_ORDINAL reason: `XXX Encuentro de Payadores` is a
# thirtieth meeting, and the exception that knows this runs locally, on an item
# solr would never have returned. The word tier still catches the real thing.
SOLR_TERMS = ("porn", "fetish", "bdsm", "nudist", "striptease", "sexploitation",
              "milf", "camgirl", "bestiality",
              # Spanish, unaccented: solr will not fold for us, and these are the
              # forms an uploader types anyway.
              "porno", "pornografia")


def solr_exclusions(fields=("title", "subject", "description")) -> str:
    """A solr clause excluding the worst of it at the source. Appended to the
    crawler's query, so a blocked item costs zero HTTP calls rather than one."""
    clauses = [f'{f}:({" OR ".join(SOLR_TERMS)})' for f in fields]
    return " AND -(" + " OR ".join(clauses) + ")"
