/**
 * The TV.
 *
 * The Guide is a browse surface; this is the thing you sit in front of. It
 * takes the whole viewport — the picture is the product, and every control is
 * glass laid over it that fades out when you stop touching anything.
 *
 * The difference that matters is that nothing here is a playlist cursor: what
 * plays is `airing(chan, Date.now())`, exactly as in the grid, so "next" is not
 * a state machine — it is the same pure function called a minute later. When a
 * slot rolls over the effect below fires because the item changed, and the next
 * thing starts. Nothing advances anything, which is also why surfing is free:
 * changing channel is reading a different pure function, not seeking a stream.
 *
 * ponytail: no picture-in-picture, no resume, no volume memory. A channel you
 * leave and come back to is wherever the clock put it — that is what a channel
 * is. Native <video> controls do scrubbing and fullscreen; we draw none of it.
 */
import { useEffect, useRef, useState } from "react";
import { airing, linkFor, randomChan, slotLabel } from "../catalog/channels.js";
import { mimeFor, nodeKey, ratingOf } from "../catalog/browse.js";
import { lede } from "../catalog/wiki.js";
import { warmEmbedder } from "../llm/embed.js";
import { answer, emit, watch } from "./intent.js";

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const IDLE = 3200;          // how long the glass stays up after you stop
const SWIPE = 55;           // px before a drag counts as a channel change

/**
 * Copy this channel's link.
 *
 * The whole channel is in the fragment, so the link IS the channel — no room, no
 * socket, no server deciding what is on. Two people who open it are on the same
 * frame, because both are evaluating the same function of UTC. linkFor() decides
 * whether that fragment is a vector or a row id, so this button works the same on
 * "rainy cyberpunk" and on Wonder Showzen.
 *
 * Lives here and is imported by the Guide: the address bar already holds the
 * link, but "select the URL" is not a share button, and the Guide is where
 * someone is looking when they decide to send a channel to somebody.
 */
export function ShareChan({ chan, className = "file", onDone }) {
    const [copied, setCopied] = useState(false);
    return (
        <button className={className} onClick={async () => {
            try {
                await navigator.clipboard.writeText(linkFor(chan));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            } catch { setCopied(false); }
            onDone?.();
        }} title="Copy a link that puts anyone on this channel, in sync, with no account">
            {copied ? "✓ Link copied — watch together" : "↗ Share channel"}
        </button>
    );
}

/** One second, because a channel shows a countdown. Only this component
 *  re-renders on it — the expensive derivations all live up in Viewer. */
function useNow(ms = 1000) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}

export default function Tv({ channels, id, onChan, onExit, onDetail, hero, w,
                             onTune, tuning, tuned, saved = [], onSave, onDrop,
                             seriesOf, onSeries }) {
    const now = useNow();
    const [q, setQ] = useState(tuned ?? "");
    const [clips, setClips] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const kept = new Set(saved.map((s) => s.id));
    // Glass up on any input, down after IDLE. Held open while the drawer is out,
    // or the panel you are reading would fade under your finger.
    const [awake, setAwake] = useState(true);
    const timer = useRef(null);
    const wake = () => {
        setAwake(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setAwake(false), IDLE);
    };
    useEffect(() => { wake(); return () => clearTimeout(timer.current); }, []);

    const i = Math.max(0, channels.findIndex((c) => c.id === id));
    const chan = channels[i];
    const on = chan && airing(chan, now);
    const next = on && airing(chan, on.endsAt);

    // The only effect in the room. Keyed on WHICH item is on, so it fires when
    // you change channel and when the clock rolls into the next slot, and never
    // on the once-a-second tick. `offset` is read fresh at fire time, so joining
    // a channel drops you into the middle of what is on — the whole point.
    const key = on ? `${chan.id}/${nodeKey(on.item)}` : null;
    const at = useRef(null);
    at.current = on;
    // What we were on last time this fired, so leaving one slot for another can
    // be told apart from a slot simply ending. That distinction is the whole
    // signal: `skip` is the strongest negative this surface produces, and an
    // agent parked in await-viewer-signal is waiting for exactly it.
    const was = useRef(null);
    useEffect(() => {
        const cur = at.current;
        const p = was.current;
        if (p) {
            emit(Date.now() < p.endsAt - 1500 ? "skip" : "finished", {
                item: p.label, id: p.id, channel: p.chan,
                seconds: Math.round((Date.now() - p.since) / 1000),
                to: cur ? { channel: chan.title, item: slotLabel(cur.item) } : null,
            });
        }
        was.current = cur && { label: slotLabel(cur.item), id: nodeKey(cur.item),
            chan: chan.title, since: Date.now(), endsAt: cur.endsAt };
        if (cur) w.play(cur.item, cur.offset);
    }, [key]);

    // Anything the agent has asked. It draws on the glass the person is already
    // looking at, and nothing happens until they press something — see intent.js.
    const [asks, setAsks] = useState([]);
    useEffect(() => watch(setAsks), []);
    const ask = asks[0];
    useEffect(() => { if (ask) wake(); }, [ask?.id]);

    // The channel card that flashes up on a hop, the way a set does. Same state
    // as the glass, so it inherits the fade for free.
    const hop = (d) => { wake(); onChan(channels[(i + d + channels.length) % channels.length].id); };
    // The fourth button. ▲▼ walk the deck in order, which is the wrong gesture
    // for "I don't know what I want" — that is what this is.
    const surprise = () => { const c = randomChan(channels, chan?.id); if (c) { wake(); onChan(c.id); } };

    // A remote has four buttons and these are three of them.
    useEffect(() => {
        const onKey = (e) => {
            if (e.target.tagName === "INPUT") { if (e.key === "Escape") e.target.blur(); return; }
            if (e.key === "ArrowUp") hop(-1);
            else if (e.key === "ArrowDown") hop(1);
            else if (e.key === "r" || e.key === "R") surprise();
            else if (e.key === "Escape") drawer ? setDrawer(false) : onExit();
            else { wake(); return; }
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    // The page behind is a scrolling browse surface. Leaving it scrollable under
    // a fixed overlay is how you end up back at the top of the guide after a swipe.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = prev; };
    }, []);

    // Swipe: vertical changes channel, horizontal opens the deck. Only past
    // SWIPE px and only on the dominant axis, so a tap on the native transport
    // bar and a drag of the scrubber both still mean what they mean.
    const from = useRef(null);
    const touch = {
        onTouchStart: (e) => { from.current = e.touches[0]; wake(); },
        onTouchEnd: (e) => {
            const a = from.current, b = e.changedTouches[0];
            from.current = null;
            if (!a || !b) return;
            const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
            if (Math.abs(dy) > Math.abs(dx)) { if (Math.abs(dy) > SWIPE) hop(dy < 0 ? 1 : -1); }
            else if (Math.abs(dx) > SWIPE) setDrawer(dx < 0);
        },
    };

    if (!chan) return null;

    // What is on either side of you, with its headers already fetched. A hop
    // otherwise starts a cold connection while the old <video> is still tearing
    // down, which on a phone is the whole of the lag when you flick through the
    // deck. preload="metadata" is the cheap half of that — container + moov, not
    // the film — and the browser reuses the connection when the real element
    // asks for the same URL a moment later.
    //
    // ponytail: only free rows with a public URL. A paid row costs somebody money
    // to fetch, and speculatively settling for a channel nobody tuned to is the
    // one thing this must never do.
    const near = [...new Set([-1, 1]
        .map((d) => channels[(i + d + channels.length) % channels.length])
        .map((c) => c && c.id !== chan.id && airing(c, now)?.item)
        .filter((it) => it && it.url && !it.resourceId && /^(video|audio)\//.test(mimeFor(it) || ""))
        .map((it) => it.url))];

    // The show this slot is an episode of, when it is one — the climb out of the
    // channel and into the rest of the series.
    const show = on && seriesOf?.(on.item);
    const rated = on ? ratingOf(on.item, w.history) : 0;
    const left = on ? Math.max(1, Math.round((on.endsAt - now) / 60_000)) : 0;
    const done = on ? (now - on.startsAt) / (on.endsAt - on.startsAt) : 0;

    return (
        <div className={`tv${awake || drawer ? "" : " idle"}`} onPointerMove={wake} {...touch}>
            <div className="tv-screen">{hero ?? <p className="empty">Nothing on this channel right now.</p>}</div>

            {/* pointer-events:none on the layer, auto on each control — so the
                dead space between them belongs to the video, not to us. */}
            <div className="tv-glass">
                <div className="tv-bar">
                    <span className="glass tv-badge"><b>{chan.number}</b>{chan.title}</span>
                    <span className="tv-gap" />
                    <ShareChan chan={chan} className="glass tv-btn" onDone={wake} />
                    {chan.spec && onSave && <button className="glass tv-btn"
                        onClick={() => { kept.has(chan.id) ? onDrop(chan.id) : onSave(chan.spec); wake(); }}
                        title={kept.has(chan.id) ? "Remove from your channels" : "Keep this channel"}>
                        {kept.has(chan.id) ? "★ Saved" : "☆ Save"}
                    </button>}
                    <button className="glass tv-btn" onClick={() => setDrawer((d) => !d)}>☰ Channels</button>
                    <button className="glass tv-btn" onClick={onExit}>Guide</button>
                </div>

                <div className="tv-side">
                    <button className="glass tv-hop" onClick={() => hop(-1)} title="Channel up (↑)">▲</button>
                    <button className="glass tv-hop" onClick={() => hop(1)} title="Channel down (↓)">▼</button>
                </div>

                {on && <div className="glass tv-foot">
                    <div className="tv-what">
                        <b>{slotLabel(on.item)}</b>
                        <p className="tv-slot">{clock(on.startsAt)}—{clock(on.endsAt)} · {left} min left</p>
                        {lede(on.item, 140) && <p className="tv-desc">{lede(on.item, 140)}</p>}
                        {next && <p className="tv-next">Next · {slotLabel(next.item)} at {clock(next.startsAt)}</p>}
                    </div>
                    {/* The two ways out of linear. The episode page is this ONE
                        thing; the show page is the rest of it, which is what you
                        actually want when a channel drops you into episode seven of
                        something you have never seen. */}
                    <div className="tv-outs">
                        {/* The remote's other two buttons. 👎 is not a bookmark: the
                            row leaves the ring, so the channel moves off it now and
                            never airs it again — and the kernel hears it everywhere
                            else in the app. */}
                        <button className={`tv-btn${rated > 0 ? " on" : ""}`} title="More like this"
                            onClick={() => { w.rate(on.item, rated > 0 ? 0 : 1); wake(); }}>👍</button>
                        <button className={`tv-btn${rated < 0 ? " on" : ""}`} title="Not this — skip it and don’t air it again"
                            onClick={() => { w.rate(on.item, -1); wake(); }}>👎</button>
                        <button className="tv-btn" onClick={() => onDetail(on.item)}>Episode page →</button>
                        {show && <button className="tv-btn" onClick={() => onSeries(show)}>All of {show.title} →</button>}
                    </div>
                    <div className="tv-prog" aria-hidden="true"><i style={{ width: `${done * 100}%` }} /></div>
                </div>}
            </div>

            {/* Above the glass layer's fade: a question must not disappear while
                the person is reading it. */}
            {ask && (
                <div className="glass tv-ask" role="alertdialog">
                    <p>{ask.question}</p>
                    <div className="tv-ask-go">
                        {/* Only the first reads as the affirmative — three equally
                            loud buttons is a dialog that does not say what it wants. */}
                        {ask.options.map((o, n) => (
                            <button key={o} className={`tv-btn${n ? "" : " primary"}`}
                                onClick={() => answer(ask.id, o)}>{o}</button>
                        ))}
                        <button className="tv-btn" onClick={() => answer(ask.id, null)}>Dismiss</button>
                    </div>
                    <small>asked by the agent in this tab</small>
                </div>
            )}

            {/* Off-screen, and deliberately not display:none — a hidden element
                still preloads, a removed one does not. */}
            <div className="tv-pre" aria-hidden="true">
                {near.map((u) => <video key={u} src={u} preload="metadata" muted playsInline />)}
            </div>

            <div className={`tv-deck glass${drawer ? " out" : ""}`}>
                <button className="tv-x" onClick={() => setDrawer(false)} title="Close (Esc)"
                    aria-label="Close channels">×</button>
                {/* Not file search — retuning. On this surface a query makes a
                    CHANNEL, so the box that looks like search has to do that or it
                    lies about where you land. */}
                <form className="tuner" onSubmit={(e) => { e.preventDefault(); onTune(q, { clips }); setDrawer(false); }}>
                    <input value={q} onChange={(e) => setQ(e.target.value)} disabled={tuning}
                        onFocus={warmEmbedder} placeholder="Tune to a mood — “rainy cyberpunk”" />
                    <button className="primary" type="submit" disabled={tuning || !q.trim()}>
                        {tuning ? "Tuning…" : "Tune"}
                    </button>
                    {/* One switch, not a second box: the mood is the same either
                        way, and what changes is how much of each film you get. */}
                    <label className="tuner-clips" title="Play the moments that match, instead of the whole films">
                        <input type="checkbox" checked={clips} disabled={tuning}
                            onChange={(e) => setClips(e.target.checked)} />
                        clips
                    </label>
                </form>
                {/* Only while it is out. This list calls airing() per channel and
                    re-renders on the one-second tick; off-screen that is a whole
                    deck's worth of work every second for something nobody is
                    looking at, and on a phone it is what makes a flick stutter. */}
                <div className="tv-chans">
                    {drawer && <>
                    {channels.length > 1 && (
                        <button className="tv-chan tv-rand"
                            onClick={() => { surprise(); setDrawer(false); }}>
                            <b>🎲</b><span>Random<small>drop me anywhere (r)</small></span>
                        </button>
                    )}
                    {channels.map((c) => {
                        const cur = airing(c, now);
                        return (
                            <button key={c.id} className={`tv-chan${c.id === chan.id ? " on" : ""}`}
                                onClick={() => { onChan(c.id); setDrawer(false); }}>
                                <b>{c.number}</b>
                                <span>{c.title}<small>{cur ? slotLabel(cur.item) : "off air"}</small></span>
                            </button>
                        );
                    })}
                    </>}
                </div>
                <p className="tv-tip">
                    Swipe up/down or ↑/↓ to change channel · <b>r</b> for a random one ·
                    swipe right to close.
                    A shared channel needs no account and no model download — everyone
                    holding the link is on the same frame.
                </p>
            </div>
        </div>
    );
}
