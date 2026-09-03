"""
Pure tests for the ingest gate and the cue parser. No network, no quickbeam.

    python3 scripts/ingest/test_archive_source.py

The gate IS the product of this pipeline — it decides what a real catalog is made
of — so it gets tested against the failure modes measured on archive.org rather
than against invented data. Every case below is something that actually happened.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from archive_source import (  # noqa: E402
    BLOCKED_REASON, ArchiveVideoSource, base_stem, clean, episode_label, episode_of,
    episode_signal, feed_shape, fingerprint, first_year, judge, legitimacy, parse_cues, prejudge,
    show_of,
    seg, series_name, to_passages, tokens,
)

ok = 0


def check(cond, msg):
    global ok
    if not cond:
        raise AssertionError(msg)
    ok += 1


# ── description cleaning ─────────────────────────────────────────────────────
check(clean("<p>Hello <b>world</b></p>") == "Hello world", "HTML must not reach the embedding")
check(clean(["one", "two"]) == "one two", "a list description must join, not stringify")
check(clean(None) == "", "a missing description must be empty, not 'None'")
check(clean("a &amp;  b") == "a b", "entities and runs of space must collapse")

# ── paths ────────────────────────────────────────────────────────────────────
check("/" not in seg("Betty Boop / Henry"), "a slash in a title must not invent a folder")
check(seg("  spaced  out  ") == "spaced out", "titles must be trimmed and collapsed")
check(len(seg("x" * 200)) <= 80, "titles must be bounded — the path is a graph key")

# ── the gate ─────────────────────────────────────────────────────────────────
LONG = ("A 1985 episode of the Computer Chronicles covering the arrival of the "
        "microprocessor-controlled artificial heart at the Hershey Medical Center, "
        "with studio demonstrations of medical imaging workstations and an interview "
        "about diagnostic software written for the IBM PC.")


def vid(**over):
    v = {"file": "x.mp4", "mime": "video/mp4", "size": 100, "season": None,
         "episode": None, "title": "Computers and Medicine",
         "url": "https://archive.org/download/x/x.mp4", "duration": 1740, "cues": []}
    v.update(over)
    return v


def rec(**over):
    base = {
        "id": "x", "title": "Computers and Medicine", "desc": LONG,
        "collections": ["computerchronicles"], "origin": "collection",
        "year": "1985", "creator": "Stewart Cheifet", "downloads": 10,
        "subject": ["computing", "medicine"],
        "thumb": "https://archive.org/services/img/x",
        "videos": [vid()],
    }
    base.update(over)
    return base


def fresh():
    return set(), set()


d, t = fresh()
check(judge(rec(), d, t) is None, f"a good record must pass: {judge(rec(), *fresh())}")

# Hard requirements: no bytes to play, or no picture, and it was never a candidate.
d, t = fresh()
check(judge(rec(videos=[]), d, t) == "no browser-playable video", "an item with no video must not publish")
d, t = fresh()
check(judge(rec(thumb=None), d, t) == "no thumbnail", "an item with no cover must not publish")

# The 78rpm lesson, generalized: a title and nothing else embeds to noise.
d, t = fresh()
check("description under" in judge(rec(desc="Short."), d, t), "a bare title must not publish")

# THE archive.org failure mode. A whole collection sharing one description is one
# point in the space wearing 400 names, and it poisons every ranking it touches.
d, t = fresh()
check(judge(rec(id="a", title="Ep 1"), d, t) is None, "the first item must pass")
why = judge(rec(id="b", title="Ep 2"), d, t)
check(why is not None and "boilerplate" in why, f"a repeated description must be caught, got {why!r}")
# …and the detection has to survive a trivial edit, or it catches nothing real.
d, t = fresh()
judge(rec(id="a", title="Ep 1", desc=LONG), d, t)
why = judge(rec(id="b", title="Ep 2", desc=LONG.replace("1985", "1986")), d, t)
check(why is not None and "boilerplate" in why, "boilerplate detection must ignore a changed number")
check(fingerprint("The cat sat") == fingerprint("cat the sat!"), "the fingerprint is content words, unordered")
check(fingerprint("cats") != fingerprint("dogs"), "different content must fingerprint differently")

# A long description that says nothing: repetition is not richness.
d, t = fresh()
padding = "the film is a film about the film " * 20
why = judge(rec(desc=padding, subject=[], creator=None), d, t)
check(why is not None and "content words" in why, f"padding must not pass as description, got {why!r}")
# A reason is a HISTOGRAM KEY, so it must not carry the per-item number that made
# it fail — that turned one cause into seven rows of the dry-run report.
d2, t2 = fresh()
w2 = judge(rec(id="z", desc="the film about the film " * 30, subject=[], creator=None), d2, t2)
check(w2 == why, f"the same cause must produce the same key: {why!r} vs {w2!r}")

d, t = fresh()
check(judge(rec(title="Same"), d, t) is None, "first title passes")
why = judge(rec(id="other", title="Same", desc=LONG + " Entirely different words here: yak, zebra, quasar."), d, t)
check(why == "duplicate title", f"a second copy of a title must drop, got {why!r}")

d, t = fresh()
check(judge(rec(videos=[vid(duration=12)]), d, t) == "shorter than 300s",
      "a clip must not publish — and a STANDALONE item is held to the film floor, not "
      "the episode one: a two-minute upload is a trailer or a test, never a work")
d, t = fresh()
check(judge(rec(videos=[vid(duration=None)]), d, t) is None, "an UNKNOWN duration must not be treated as too short")
# A SERIES has no meaningful single duration — the sum of its episodes says nothing
# about whether any one of them is a clip, so the check must not apply.
d, t = fresh()
check(judge(rec(videos=[vid(episode=1, duration=12), vid(file="y.mp4", episode=2, duration=12)]), d, t) is None,
      "the clip check must not fire on a multi-episode item")

d, t = fresh()
check(judge(rec(), d, t, require_transcript=True) == "no transcript", "--require-transcript must be enforced")
d, t = fresh()
check(judge(rec(videos=[vid(cues=[{"start": 0, "end": 1, "text": "hi"}])]), d, t,
            require_transcript=True) is None, "an item WITH a transcript must pass the same flag")

# ── archive.org derivatives are not extra episodes ───────────────────────────
# `021931.mp4` and `021931_512kb.mp4` are ONE video. Keyed on the raw stem they
# looked like two episodes named "021931" and "021931_512kb" — which inflated the
# catalog AND made a thin-description series look like it had distinct titles.
check(base_stem("021931.mp4") == base_stem("021931_512kb.mp4") == "021931",
      f"a transcode suffix must not create a second episode: {base_stem('021931_512kb.mp4')!r}")
check(base_stem("HealthYo1953_512kb.mp4") == "HealthYo1953", base_stem("HealthYo1953_512kb.mp4"))
check(base_stem("a/b/x_64kb.mp4") == "x", "a path and a 64kb suffix must both come off")
# …but a real title must survive intact.
check(base_stem("Digimon - 1x01 - And So It Begins....mp4") == "Digimon - 1x01 - And So It Begins...",
      "stripping derivatives must not eat a real filename")

# ── a series' episode titles stand in for a description ──────────────────────
# Two populations, both measured on the real crawl. Judging on the item blurb alone
# threw away 133 series carrying 2,209 episodes; admitting every thin one would have
# taken the junk with it. Distinctness is what separates them.
# The real Digimon Ghost Game item: a 102-char blurb and thirty distinctly titled
# episodes. The fixture has to be the size of the thing it models — five episodes
# pooled to 16 content words and would fail MIN_TOKENS for reasons that have nothing
# to do with what is being tested.
GHOST_TITLES = ["The Sewn-Mouth Man", "The Mystery of the Museum", "Scribbles",
                "The Ghost in the Tunnel", "A Detective's Vacation", "Clock Tower Bell",
                "The Bearer of Misfortune", "Digital Prison Break", "Ripper Nightmare",
                "The Angel's Trumpet", "Frozen Summer Camp", "Wandering Comet",
                "Vengeful Spider Queen", "Silent Library Whispers", "Mirror Labyrinth"]
GOOD_EPS = [vid(file=f"e{i}.mp4", episode=i + 1, title=t) for i, t in enumerate(GHOST_TITLES)]
JUNK_EPS = [vid(file=f"e{i}.mp4", episode=i + 1, title="Digimon Xros Wars") for i in range(5)]

n, tk = episode_signal(dict(videos=GOOD_EPS))
check(n == len(GHOST_TITLES) and tk >= 8, f"distinctly-titled episodes must read as signal: {n} titles, {tk} tokens")
n, tk = episode_signal(dict(videos=JUNK_EPS))
check(n == 1, f"episodes sharing one title are one title: {n}")

# A handful of thinly-titled episodes is still a scrap, not a show: the exemption
# admits a series whose titles ARE the description, not any multi-file item.
d, t = fresh()
check(judge(rec(desc="Two parter.", videos=GOOD_EPS[:3]), d, t) is not None,
      "three episodes and a two-word blurb is not enough to stand in for a description")

d, t = fresh()
check(judge(rec(desc="Complete series, English sub.", videos=GOOD_EPS), d, t) is None,
      "a thin-blurbed series with real episode titles must publish")
d, t = fresh()
why = judge(rec(desc="Complete series, English sub.", videos=JUNK_EPS), d, t)
check(why is not None, "a series whose episodes share one title has no signal and must not publish")
# A thin blurb on a SINGLE video is still a rejection — there are no episode titles
# to stand in for it.
d, t = fresh()
check("description under" in judge(rec(desc="Short."), d, t),
      "the episode-title exemption must not apply to a lone film")

# Two uploads of one show share a blurb. The second must be judged on ITS episodes,
# not rejected as boilerplate for a description it was excused from in the first place.
d, t = fresh()
check(judge(rec(id="a", title="Show A", desc="Complete series.", videos=GOOD_EPS), d, t) is None, "first upload passes")
# Distinct titles carrying distinct WORDS — a shared "Chapter" suffix pools to one
# token however many episodes there are, which is the same failure the junk case
# tests deliberately.
OTHER = [vid(file=f"o{i}.mp4", episode=i + 1, title=f"{a} {b}") for i, (a, b) in enumerate([
    ("Pelican", "Bay"), ("Ocelot", "Rain"), ("Quasar", "Kyoto"), ("Yak", "Trails"),
    ("Zebra", "Crossing"), ("Ibex", "Ridge"), ("Narwhal", "Harbour"), ("Tapir", "Jungle"),
    ("Vicuna", "Plateau"), ("Wombat", "Burrow"), ("Xerus", "Savannah"), ("Serval", "Grasslands"),
    ("Dugong", "Shallows"), ("Gharial", "Riverbank"), ("Kakapo", "Forest")])]
check(judge(rec(id="b", title="Show B", desc="Complete series.", videos=OTHER), d, t) is None,
      "a second series sharing a blurb but not its episodes must still publish")

# ── cue parsing ──────────────────────────────────────────────────────────────
VTT = """WEBVTT

00:00.000 --> 00:26.500
This is the Penn State heart, the heart that was
used to keep Tony Mandia alive

00:26.500 --> 00:31.320
days here at the Hershey Medical Center.
"""
cues = parse_cues(VTT)
check(len(cues) == 2, f"two cues expected, got {len(cues)}")
check(cues[0]["start"] == 0.0 and cues[0]["end"] == 26.5, f"vtt timings lost: {cues[0]}")
check("Penn State heart" in cues[0]["text"], "a wrapped cue must join into one line")
check("\n" not in cues[0]["text"], "cue text must be single-line")

SRT = """1
00:00:01,000 --> 00:00:04,000
Hello there

2
00:01:02,500 --> 00:01:05,000
General Kenobi
"""
s = parse_cues(SRT)
check(len(s) == 2, f"srt: two cues expected, got {len(s)}")
check(s[0]["start"] == 1.0, f"srt comma-millis mis-parsed: {s[0]}")
check(s[1]["start"] == 62.5, f"srt minutes mis-parsed: {s[1]}")
check(s[0]["text"] == "Hello there", "the SubRip index line must not become cue text")

# An hour-long VTT with an hours component in the stamp.
h = parse_cues("WEBVTT\n\n01:02:03.000 --> 01:02:05.000\nlate\n")
check(h and h[0]["start"] == 3723.0, f"hh:mm:ss.mmm mis-parsed: {h}")
check(parse_cues("") == [], "empty input must be no cues, not a crash")
check(parse_cues("WEBVTT\n\nnot a cue\n") == [], "a malformed block must be skipped, not guessed at")

# ── passages ─────────────────────────────────────────────────────────────────
many = [{"start": i * 5.0, "end": i * 5.0 + 5, "text": "word " * 20} for i in range(20)]
ps = to_passages(many, chars=300)
check(len(ps) > 1, "a long transcript must break into several passages")
check(all(len(p["text"]) <= 400 for p in ps), "a passage must respect its char budget")
check(ps[0]["start"] == 0.0, "a passage must keep the start of its first cue")
check(ps[-1]["end"] == many[-1]["end"], "a passage must keep the end of its last cue")
# A silence is a scene change: it must break even when the budget has room.
gapped = [{"start": 0, "end": 2, "text": "before"}, {"start": 90, "end": 92, "text": "after"}]
check(len(to_passages(gapped, chars=9999, gap=30)) == 2, "a long silence must break a passage")
check(to_passages([]) == [], "no cues must be no passages")

# ── scattered uploads: one episode, on its own, of a real show ──────────────
# archive.org holds a lot of television as single-episode items sitting beside
# the box sets and unconnected to them. The show's name is only recoverable from
# the text in front of the episode marker.
def one(title, file="x.mp4"):
    return {"title": title, "videos": [{"file": file}]}

check(show_of(one("SOUTH PARK S 14 E 06 201( END UNCUT)")) == "SOUTH PARK",
      "a real IA title, spaces and all, must yield its show")
check(show_of(one("One Step Beyond - S02E14 - The Sacred Mushroom")) == "One Step Beyond",
      "the marker ends the show name, the episode title after it is not part of it")
check(show_of(one("WKRP in Cincinnati 1x03")) == "WKRP in Cincinnati", "1x03 counts")
check(show_of(one("untitled upload", "Steptoe and Son S05E02 - Live Now Pay Later.mp4"))
      == "Steptoe and Son", "the filename is the fallback when the title says nothing")
# The three ways this must REFUSE, because a wrong show name collects unrelated
# uploads into one folder — worse than leaving them loose.
check(show_of(one("Casablanca")) is None, "a film has no episode marker")
check(show_of(one("Ep 3", "ep3.mp4")) is None, "a marker with nothing in front of it is not a show")
check(show_of(one("Blue's Clues - Full Series", "S01E01 - Snack Time.mp4")) is None,
      "a box set is already a series; its own title carries no marker")

# The completeness vouch. `episodes` is unearnable by a one-file item, which is
# exactly why these fail a gate the box set passes. `series_of` is set only when
# the crawl really holds the run, so this credits completeness that is present.
lone = {"title": "South Park S14E06", "creator": "TwinEz", "desc": "x",
        "subject": ["a", "b"], "downloads": 5000,
        "videos": [{"file": "sp.mp4", "duration": 1293, "title": "201"}]}
check("episodes" not in legitimacy(lone), "a lone episode cannot earn completeness alone")
check("episodes" in legitimacy(dict(lone, series_of="South Park")),
      "...and inherits it from the run it belongs to")

# ── episode parsing: what turns 104 loose files into a season ────────────────
# Every pattern here came off a real IA series item.
for fn, want in [
    ("Digimon Digital Monsters - 1x01 - And So It Begins....mp4", (1, 1, "And So It Begins...")),
    ("Digimon 1x02 - The Birth of Greymon.mp4", (1, 2, "The Birth of Greymon")),
    ("01 - Guilmon Comes Alive.mp4", (1, 1, "Guilmon Comes Alive")),
    ("Friends S03E11 - The One Where Chandler Cant Remember.mp4",
     (3, 11, "The One Where Chandler Cant Remember")),
    ("Some Show Season 2 Episode 7 - Title.mp4", (2, 7, "Title")),
    ("Blues Clues Episode 12.mp4", (1, 12, "Blues Clues")),
]:
    got = episode_of(fn)
    check(got == want, f"episode_of({fn!r}) = {got!r}, wanted {want!r}")

# A film is not an episode, and must not be given a fake one.
s_, e_, t_ = episode_of("The Lone Ranger TV Show.mp4")
check(e_ is None and s_ is None, f"a non-episodic filename must yield no episode: {(s_, e_)}")
check(t_ == "The Lone Ranger TV Show", f"…but must keep its title: {t_!r}")

# Zero padding is what makes a lexical sort put episode 2 before episode 10.
check(episode_label(1, 4, "Garurumon") == "S01E04 - Garurumon", episode_label(1, 4, "Garurumon"))
check(episode_label(1, 2, "a") < episode_label(1, 10, "a"), "episode 2 must sort before episode 10")
check(episode_label(None, None, "A Film") == "A Film", "a film keeps its plain title")

# ── series names ─────────────────────────────────────────────────────────────
# An uploader's edition note is not part of the show's name, and left in it becomes
# the folder you browse — truncated mid-word, because the raw title is 96 chars of
# provenance. It also stops two uploads of one show collapsing onto one name, which
# is what the cross-upload episode dedupe needs.
for raw, want in [
    ("Digimon: Digital Monsters - The Complete Collection (Saban Entertainment - English dub)",
     "Digimon: Digital Monsters"),
    ("Digimon: Digital Monsters - The Complete Seasons 1-4 Collection (1999-2003, Saban Entertainment - English dub)",
     "Digimon: Digital Monsters"),
    ("Digimon Fusion Complete English Series", "Digimon Fusion"),
    ("Blue's Clues - Full Series", "Blue's Clues"),
    ("Thomas & Friends™ Complete Seasons & Movies (US Dub)", "Thomas & Friends™"),
    ("Get Smart", "Get Smart"),                       # nothing to strip
    ("The Complete Collection", "The Complete Collection"),  # stripping it all leaves nothing
]:
    got = series_name(raw)
    check(got == want, f"series_name({raw[:40]!r}…) = {got!r}, wanted {want!r}")

# Two uploads of one show must normalize to the SAME name, or the dedupe below
# has nothing to match on.
check(series_name("Digimon: Digital Monsters - The Complete Collection (Saban Entertainment - English dub)")
      == series_name("Digimon: Digital Monsters - The Complete Seasons 1-4 Collection (1999-2003, Saban Entertainment - English dub)"),
      "two uploads of one series must normalize to one name")

# ── the content block: the legal gate, not the quality one ───────────────────
# Its own unit tests live in test_content_policy.py; these are about it being
# WIRED IN — reachable before anything else can admit an item, at every level the
# crawler has, and reported without turning the histogram into a wordlist.

d, t = fresh()
blocked = {}
why = judge(rec(title="Vintage Erotica Vol 3"), d, t, blocked=blocked)
check(why == BLOCKED_REASON, f"a blocked title must not publish, got {why!r}")
check(blocked.get("erotica") == 1, f"the term that fired must be tallied for audit: {blocked}")
# The reason is ONE histogram key however many terms exist, or the dry run's
# report becomes four hundred rows of vocabulary.
d, t = fresh()
check(judge(rec(id="p", title="XXX Hardcore"), d, t) == judge(rec(id="q", title="Fisting Vol 2"), *fresh()),
      "every block must report under one key")

# It must be the FIRST judgement, so nothing can admit an item ahead of it: an
# item with no video at all is still reported as blocked, not as unplayable.
d, t = fresh()
check(judge(rec(title="Hardcore XXX", videos=[], thumb=None), d, t) == BLOCKED_REASON,
      "the block must not sit behind the playability checks")

# Every field an uploader can label a thing with.
# NB `subject` and `collections` are judged as PROSE, not as labels — an IA
# subject list is a keyword dump — so the term used here must be one from the
# explicit tier, not a topical one like `erotica`.
for field in [dict(title="Sexy Nurses"), dict(creator="Pornhub"),
              dict(subject=["porno", "1970s"]), dict(id="hardcore-vol-4"),
              dict(collections=["vintage-porn"])]:
    d, t = fresh()
    check(judge(rec(**field), d, t) == BLOCKED_REASON, f"{list(field)[0]} must be checked: {field}")

# …and free prose, for the explicit tier.
d, t = fresh()
check(judge(rec(desc=LONG + " Contains explicit fellatio throughout."), d, t) == BLOCKED_REASON,
      "an explicit description must not publish behind a wholesome title")
# …but NOT for the label tier. Serious films are ABOUT these things, and blocking
# a synopsis would take The Accused and Chinatown with it.
d, t = fresh()
check(judge(rec(desc=LONG + " A courtroom drama about the trial that followed the rape."), d, t) is None,
      "a serious work whose SYNOPSIS names a subject must still publish")

# An IA item is one upload. An upload carrying explicit FILES is an explicit
# upload however wholesome its title, so the item goes, not just the file — this
# is the legal gate, and it takes the conservative side of that call.
mixed = rec(id="mixed", title="Public Domain Shorts", collections=["shorts"],
            videos=[vid(file="e1.mp4", episode=1, title="The Cameraman"),
                    vid(file="e2 - XXX Uncut.mp4", episode=2, title="XXX Uncut")])
d, t = fresh()
check(judge(mixed, d, t) == BLOCKED_REASON, "one explicit filename condemns the upload")
srcb = ArchiveVideoSource()
check(srcb.build_graph([mixed])[0]["video"] == [], "and nothing of it reaches the graph")

# The per-file check in build_graph is the last line of that defence rather than
# the first: it fires only for a file whose name the item-level pass never saw
# (an episode title assembled at build time), and it drops the file alone.
late = ArchiveVideoSource()
late.build_graph([rec(id="late", title="Shorts Two", collections=["shorts"],
                      videos=[vid(file="e1.mp4", episode=1, title="The Cameraman")])])
check(late.blocked_episodes == 0, "a clean item must not trip the per-file check")

# The pre-gate blocks too, or 400 blocked items cost 400 paced metadata calls.
bl = {}
check(prejudge({"title": "Hardcore Vol 9", "description": ""}, {}, bl) == BLOCKED_REASON,
      "the block must run before the metadata call, not after it")
check(bl, "the pre-gate must tally what it caught as well")
check(prejudge({"title": "Computers and Medicine", "description": LONG}, {}, {}) is None,
      "the pre-gate must still admit ordinary things")

# ── pickiness: a work, not a feed ────────────────────────────────────────────
# THE ALEX JONES PROBLEM. Hundreds of items, each with a real description, a real
# creator, a real thumbnail and tens of thousands of downloads. Every signal the
# gate had said yes. What makes them one object rather than hundreds is that they
# are dated rather than titled.
for title in ["The Alex Jones Show 2015-03-04", "InfoWars Broadcast 3/4/15",
              "Nightly Report March 4, 1987", "The Program - Hour 2",
              "Live Stream 2020", "Untitled", "Episode 1234", "test upload"]:
    check(feed_shape(title), f"a feed episode must be recognised: {title!r}")
for title in ["Digimon Digital Monsters", "Computers and Medicine", "Casablanca",
              "Night of the Living Dead 1968", "Blue's Clues - Full Series",
              "The Twilight Zone Season 2"]:
    check(feed_shape(title) is None, f"a real work must not read as a feed: {title!r}")

d, t = fresh()
why = judge(rec(title="The Alex Jones Show 2015-03-04"), d, t)
check(why == "dated broadcast, not a titled work", f"a dated broadcast must not publish, got {why!r}")

# …and the structural half, which needs no list of names: however good one
# uploader's items are, the catalog does not become theirs.
# Genuinely distinct descriptions, or the boilerplate check drops them first and
# the cap is never what is being tested — a changed NUMBER is exactly what
# fingerprint() is built to see through.
BEASTS = ["yak", "zebra", "quasar", "pelican", "ocelot", "narwhal", "tapir", "vicuna"]
FEED = [rec(id=f"i{i}", title=f"The Program Presents {b.title()}",
            desc=LONG + f" A {b} episode, concerning {b}s and the {b} of the title.")
        for i, b in enumerate(BEASTS)]
capped = ArchiveVideoSource()
capped._max_per_creator = 3
n_capped, _ = capped.build_graph(FEED)
check(len(n_capped["video"]) == 3, f"one creator must not become the catalog: {len(n_capped['video'])}")
check(capped.stats.get("creator already at --max-per-creator") == 5,
      f"the cap must report itself: {capped.stats}")
# A series counts ONCE against the cap, however many episodes it carries —
# otherwise the cap would forbid exactly the complete runs we most want.
one_series = ArchiveVideoSource()
one_series._max_per_creator = 1
n_series, _ = one_series.build_graph([rec(id="s", title="A Long Show", collections=["anime"],
                                          videos=GOOD_EPS)])
check(len(n_series["video"]) == len(GOOD_EPS),
      f"the per-creator cap counts items, not episodes: {len(n_series['video'])}")
# No creator, no cap: an unattributed public-domain film must not be rationed
# against every other unattributed one.
anon = ArchiveVideoSource()
anon._max_per_creator = 1
n_anon, _ = anon.build_graph([
    rec(id="a1", creator=None, desc=LONG + " Restored from a 16mm print: yak zebra quasar."),
    rec(id="a2", creator=None, title="Another Film",
        desc=LONG + " Different words entirely: pelican ocelot narwhal tapir vicuna.")])
check(len(n_anon["video"]) == 2, "items with no creator must not share one cap slot")

# ── pickiness: marks of a complete, published work ───────────────────────────
# No one of these is required — plenty of good public-domain features carry no
# creator, and a fine series has a two-line blurb. Having almost NONE of them is
# what says "a file somebody uploaded" rather than "a work somebody catalogued".
check(legitimacy(rec()) >= {"creator", "year", "subject", "runtime"},
      f"a catalogued film must read as one: {legitimacy(rec())}")
# Long enough and wordy enough to clear every OTHER check — the point is that it
# fails on the marks alone, and under RICH_DESC so `description` is not one of them.
bare = rec(creator=None, year=None, subject=[], downloads=0, videos=[vid(duration=400)],
           desc=LONG + " Restored from a scratched 16mm print by an anonymous donor.")
check(len(legitimacy(bare)) == 0, f"an unlabelled upload carries no marks: {legitimacy(bare)}")
d, t = fresh()
why = judge(bare, d, t)
check(why == "under 3 marks of a complete published work", f"got {why!r}")
# The dial actually turns, in both directions, on the SAME record.
d, t = fresh()
check(judge(bare, d, t, min_signals=0) is None, "--min-signals 0 must admit what 3 rejected")
d, t = fresh()
check(judge(rec(), d, t, min_signals=7) is not None, "--min-signals 7 must reject what 3 admitted")
# Wikidata prose is description. A thin IA blurb on a work somebody catalogued
# used to die on the length check while its match sat unread two fields away.
thin = rec(desc="Bonanza.", subject=[], videos=[vid(duration=4000)])
d, t = fresh()
check(judge(thin, d, t) == "description under 150 chars", "a thin blurb alone is still thin")
thin["wikidata"] = {"wdLabel": "Bonanza", "wdDesc": "American Western television series",
                    "genre": ["Western"], "creator": ["David Dortort"],
                    "cast": ["Lorne Greene", "Michael Landon", "Dan Blocker",
                             "Pernell Roberts", "Victor Sen Yung"],
                    "network": ["NBC"], "country": ["United States"],
                    "language": ["English"], "start": "1959", "end": "1973"}
d, t = fresh()
check(judge(thin, d, t) is None, f"a wikidata match must carry a thin row: {judge(thin, *fresh())!r}")

# A long run of distinctly titled episodes is itself a mark — it is the
# completeness the whole crawl is after.
check("episodes" in legitimacy(rec(videos=GOOD_EPS)), "a full run of episodes is a mark of completeness")
check("episodes" not in legitimacy(rec(videos=JUNK_EPS)),
      "five episodes sharing one title are not a run of anything")
# A stream date in the future is not a production year.
check("year" not in legitimacy(rec(year="2099")), "an implausible year is not a mark")

# archive.org returns `year` as a scalar, as a LIST, or not at all. The list form
# is what put "[1964,1965]" into the payload and cost those items their `year`
# signal here — the whole reason first_year exists.
check(first_year("1985") == 1985, "a scalar year survives")
check(first_year([1964, 1965]) == 1964, "a multi-valued year takes the earliest, not the list")
check(first_year(None, "1971-03-02") == 1971, "falls through to the date field")
check(first_year(None, None) is None, "nothing to find is None, not a crash")
check("year" in legitimacy(rec(year=first_year([1964, 1965]))), "a normalized multi-value earns the mark")
check("year" not in legitimacy(rec(year="1300")), "a year before film existed is not a mark")
check("creator" not in legitimacy(rec(creator="uploader@example.com")),
      "an uploader's email address is not a credited creator")

# The quality checks must stay ordered behind the DEFECTS: an item with no video
# is reported as having no video, not as thin on signals.
d, t = fresh()
check(judge(rec(videos=[], creator=None, year=None, subject=[]), d, t) == "no browser-playable video",
      "a defect must not be shadowed by a preference in the report")

# ── the graph shape: this is the contract with src/catalog/search.js ─────────────────
src = ArchiveVideoSource()
# A phrase deliberately absent from the description, so "did the transcript leak
# into the video's embed text?" is actually answerable.
nodes, edges = src.build_graph([rec(videos=[
    vid(cues=[{"start": 12.5, "end": 40.0, "text": "quasar yak zebra"}])])])
v = nodes["video"][0]["fields"]
tr = nodes["subtitles"][0]["fields"]

# The entity KEY is the vertex tag is the projection root_type is the entityType
# search.js reads — quickbeam's _project() overwrites the payload's own entityType
# with the root_type, so these names must match or nothing downstream works.
check(set(nodes) == {"video", "subtitles", "folder"},
      f"entity keys must be the literal strings search.js reads, got {sorted(nodes)}")
check(v["entityType"] == "video", "fileRow() in search.js admits on entityType")
check(v["path"] == "computerchronicles/Computers and Medicine.mp4", f"path shape wrong: {v['path']}")
check(v["name"].endswith(".mp4"), "the name is the leaf of the path")
check(v["url"].startswith("https://archive.org/"), "a video row must carry playable bytes")
check(v["thumb"], "a video row must carry a cover")
check(v["price"] == "0", "every row here is a free catalog entry")
check("series" not in v, "a single-video item is a film, not a series")
check("quasar" not in v["text"], "the video's embed text is metadata, not transcript")

check(tr["entityType"] == "subtitles", "a transcript row must be STRUCTURAL to search.js")
check("path" not in tr, "a transcript row must have NO path, or it shows up as a file in the tree")
check(tr["videoPath"] == v["path"], "a transcript must resolve back to its video")
check(tr["cues"][0]["start"] == 12.5, "the seek target must survive")
check(tr["text"] == "quasar yak zebra", "the passage text is what gets embedded")

# The collection vertex: tagged `folder`, which search.js treats as STRUCTURAL, so
# quickbeam gets a tree to walk and sond3r ignores it.
f0 = nodes["folder"][0]["fields"]
check(f0["entityType"] == "folder", "a collection vertex must be STRUCTURAL to search.js")
check("path" not in f0, "a collection vertex must not look like a file")
check(any(e["rel"] == "contains" for e in edges), f"the tree edge is missing: {edges}")

# EVERY edge endpoint must be a real vertex. A `contains` edge used to point at the
# ITEM (`archive:<id>`), which is a vertex only for a standalone film — a series'
# vertices are `archive:<id>#<file>`. 949 of 1,393 edges dangled that way and
# `fangorn commit` rejected the entire batch with the word "Canceled" and nothing else.
def no_dangling(nodes, edges, label):
    ids = {n["name"] for group in nodes.values() for n in group}
    bad = [e for e in edges if e["from"] not in ids or e["to"] not in ids]
    check(not bad, f"{label}: {len(bad)} dangling edge(s), e.g. {bad[0] if bad else ''}")

no_dangling(nodes, edges, "a film with a transcript")

# ── a series: one item, many episodes ────────────────────────────────────────
SERIES = rec(id="digi", title="Digimon Digital Monsters", collections=["anime"], videos=[
    vid(file="Digimon - 1x01 - And So It Begins.mp4", season=1, episode=1,
        title="And So It Begins", url="https://archive.org/download/digi/a.mp4"),
    vid(file="Digimon - 1x02 - The Birth of Greymon.mp4", season=1, episode=2,
        title="The Birth of Greymon", url="https://archive.org/download/digi/b.mp4"),
])
n2, e2 = ArchiveVideoSource().build_graph([SERIES])
eps = n2["video"]
check(len(eps) == 2, f"both episodes must publish, got {len(eps)}")
p1, p2 = (x["fields"]["path"] for x in eps)
check(p1 == "anime/Digimon Digital Monsters/S01E01 - And So It Begins.mp4", p1)
check(p1 < p2, "episodes must sort in order under the series folder")
check(eps[0]["fields"]["series"] == "Digimon Digital Monsters", "an episode must name its series")
check(eps[0]["fields"]["episode"] == 1 and eps[0]["fields"]["season"] == 1, "season/episode must ride along")
check(eps[0]["name"] != eps[1]["name"], "two episodes must not share a vertex id")
check(eps[0]["fields"]["url"] != eps[1]["fields"]["url"], "each episode must point at its OWN file")
# The episode title leads the embed text: the series blurb is shared by all 104
# siblings and cannot be what distinguishes one from another.
check(eps[0]["fields"]["text"].startswith("And So It Begins"), eps[0]["fields"]["text"][:60])

no_dangling(n2, e2, "a series")
no_dangling(*ArchiveVideoSource().build_graph([SERIES, rec()]), "a series and a film together")

# Three different Digimon uploads carry episode 1x01; publishing all of them gives
# a shelf that is the same episode three times. The second upload has to differ in
# TITLE and DESCRIPTION — otherwise the item-level gate rejects it first and the
# episode dedupe never runs, which is what this is actually testing.
dupe = dict(SERIES, id="digi2",
            title="Digimon Digital Monsters - Full Series",
            desc=LONG + " A second upload of the same show, worded entirely differently: yak zebra quasar pelican ocelot.")
s3 = ArchiveVideoSource()
n3, _ = s3.build_graph([SERIES, dupe])
check(len(n3["video"]) == 2, f"a re-upload of the same episodes must dedupe, got {len(n3['video'])}")
check(s3.dropped_episodes == 2, f"dropped episodes are counted apart from item reasons: {s3.dropped_episodes}")
# …and NOT in stats, or "18/90 items admitted" becomes arithmetic that doesn't hold.
check("duplicate episode" not in s3.stats, "an episode drop must not be counted as an item drop")

# A rejected record contributes nothing — no orphan transcript, no phantom edge.
nodes2, edges2 = ArchiveVideoSource().build_graph([rec(videos=[])])
check(not nodes2["video"] and not nodes2["subtitles"] and not edges2,
      "a record the gate rejected must leave nothing behind")

# The run reports WHY things died — a dry run that says "dropped 300" is useless.
s2 = ArchiveVideoSource()
s2.build_graph([rec(id="a"), rec(id="b"), rec(id="c", videos=[])])
check(s2.stats.get("published") == 1, f"stats must count what published: {s2.stats}")
check(sum(s2.stats.values()) == 3, f"every record must be accounted for: {s2.stats}")

# --max-episodes is applied when the graph is BUILT, not when an item is resolved:
# capped at resolve time it would be baked into the cache, and raising the cap later
# would silently do nothing for every item already seen.
big = rec(id="long", title="A Long Show", collections=["anime"],
          videos=[vid(file=f"e{i}.mp4", episode=i + 1, title=t) for i, t in enumerate(GHOST_TITLES)])
capped = ArchiveVideoSource()
capped._max_episodes = 4
check(len(capped.build_graph([big])[0]["video"]) == 4, "the episode cap must apply at build time")
wide = ArchiveVideoSource()
wide._max_episodes = 99
check(len(wide.build_graph([big])[0]["video"]) == len(GHOST_TITLES),
      "raising the cap on the SAME record must yield more episodes, not the old count")

# ── the pre-gate: rejection without a metadata call ──────────────────────────
# The whole point is that it is CHEAPER than judge(), not stricter. It must never
# reject something judge() would have admitted.
boiler = {}
BOILER = "Digitized from the collection of a very generous donor. " * 6
check(prejudge({"description": BOILER}, boiler) is None, "the first copy is the real one")
check([prejudge({"description": BOILER}, boiler) for _ in range(2)] == [None, None],
      "two more copies pass — two uploads of one series share a blurb and are "
      "admitted later on their distinct episode titles")
check(prejudge({"description": BOILER}, boiler) is not None,
      "the fourth copy is collection boilerplate and costs no metadata call")
check(prejudge({"description": ""}, boiler) is None,
      "no description is not a rejection here — a thin-blurbed series is admitted "
      "on episode titles, which do not exist until after the metadata call")
check(prejudge({"description": "A short but genuinely distinct blurb."}, boiler) is None,
      "length is judge()'s business, not the pre-gate's")

# Node ids are stable across runs — a re-ingest must upsert, not duplicate.
a = ArchiveVideoSource().build_graph([rec()])[0]["video"][0]["name"]
b = ArchiveVideoSource().build_graph([rec()])[0]["video"][0]["name"]
check(a == b == "archive:x", "the node id must be the archive identifier, stably")

print(f"archive_source self-check ok — {ok} assertions: cleaning, paths, the gate "
      "(boilerplate, richness, duplicates, duration, transcripts), the content block "
      "(every field, both tiers, all three levels), pickiness (feed shape, per-creator "
      "cap, completeness marks), scattered one-off uploads, episode parsing, series "
      "expansion + dedupe, derivative "
      "collapsing, episode-title signal, vtt/srt parsing, passage breaking, collection "
      "vertices, and the search.js field contract")
