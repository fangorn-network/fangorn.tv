/**
 * The grid.
 *
 * Everything on this page is derived from `Date.now()` and the rings in
 * channels.js — there is no schedule to fetch and nothing to keep in sync. The
 * one piece of state is which row you are looking at.
 *
 * ponytail: a fixed three-hour window starting at the current half hour. No
 * scrubbing forward, because the answer to "what's on at 4am" is a click on the
 * item itself — this is a browse surface, not a DVR.
 */
import { useEffect, useMemo, useState } from "react";
import { airing, randomChan, schedule, slotLabel } from "../catalog/channels.js";
import { lede } from "../catalog/wiki.js";
import { warmEmbedder } from "../llm/embed.js";
import { ShareChan } from "./tv.jsx";

const SLOT = 30 * 60 * 1000;      // the grid's ruler
const WINDOW = 6 * SLOT;          // three hours, six marks
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const pct = (ms) => `${(ms / WINDOW) * 100}%`;

/** Wall clock, once a minute. A cell is thirty minutes wide; anything finer is
 *  a re-render nobody can see. */
function useNow(ms = 60_000) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}

export default function Guide({ channels, onPlay, onTv, card, empty, onTune, tuning, tuned, focus }) {
    const now = useNow();
    const [pick, setPick] = useState(null);
    const [q, setQ] = useState(tuned ?? "");
    // A tuned channel is the one the viewer just asked for, so it takes the hero
    // the moment it exists. Keyed on the channel id, not on `channels`, or every
    // genre label that lands would yank the selection back.
    useEffect(() => { if (focus) setPick(focus); }, [focus]);
    const start = Math.floor(now / SLOT) * SLOT;
    const chan = channels.find((c) => c.id === pick) ?? channels[0];
    const on = chan && airing(chan, now);

    // One walk per channel per window. Rebuilt when the window ticks over, not
    // when the minute does.
    const rows = useMemo(
        () => channels.map((c) => ({ chan: c, cells: schedule(c, start, start + WINDOW) })),
        [channels, start],
    );

    // Above the empty guard on purpose: a catalog with no episodic content to ring
    // up still has vectors, so tuning is exactly what it has left to offer.
    const tuner = onTune && (
        <form className="tuner" onSubmit={(e) => { e.preventDefault(); onTune(q); }}>
            {/* Same reason as the search box: the model is a 131MB download, so it
                starts when someone reaches for the field, not when the page opens. */}
            <input value={q} onChange={(e) => setQ(e.target.value)} disabled={tuning} onFocus={warmEmbedder}
                placeholder="Tune to a mood — “rainy cyberpunk”, “slow documentary”" />
            <button className="primary" type="submit" disabled={tuning || !q.trim()}>
                {tuning ? "Tuning…" : "Tune"}
            </button>
            {tuned && <button className="file" type="button"
                onClick={() => { setQ(""); setPick(null); onTune(""); }}>Clear</button>}
            {tuned && !focus && !tuning &&
                <small className="tuner-miss">Nothing here is near “{tuned}” yet.</small>}
        </form>
    );

    // The other half of a guide. Tuning is for when you know what you want;
    // this is for when the answer is "something else" — and on a schedule that
    // is a pure function of the clock it costs nothing to land mid-slot.
    const surprise = channels.length > 1 && (
        <button className="file guide-rand" type="button"
            onClick={() => { const c = randomChan(channels, chan?.id); if (c) onTv(c); }}
            title="Drop me on another channel, mid-slot">🎲 Surprise me</button>
    );

    if (!channels.length) return <div className="guide">{tuner}<p className="empty">{empty}</p></div>;

    return (
        <div className="guide">
            <div className="guide-top">{tuner}{surprise}</div>
            {on && (
                <div className="guide-hero">
                    <div className="guide-art">{card(on.item)}</div>
                    <div className="guide-about">
                        <h2>{chan.title}</h2>
                        <p className="guide-when">
                            {clock(on.startsAt)} — {clock(on.endsAt)}
                            <span className="guide-bar" aria-hidden="true">
                                <i style={{ width: `${((now - on.startsAt) / (on.endsAt - on.startsAt)) * 100}%` }} />
                            </span>
                            {Math.max(1, Math.round((on.endsAt - now) / 60_000))} min left
                        </p>
                        <p className="guide-title">{slotLabel(on.item)}</p>
                        {lede(on.item, 220) && <p className="guide-desc">{lede(on.item, 220)}</p>}
                        <div className="guide-go">
                            {/* Two different products behind two buttons. The first
                                is a channel — it drops you mid-slot and keeps going
                                on its own. The second is the item page, which is
                                where you go when the channel handed you episode 7
                                of something you have never seen. */}
                            <button className="primary" onClick={() => onTv(chan)}>▶ Watch channel</button>
                            <button className="file" onClick={() => onPlay(on.item, 0)}>Episode page</button>
                            <ShareChan chan={chan} />
                        </div>
                    </div>
                </div>
            )}

            <div className="guide-grid">
                <div className="guide-ruler">
                    <span className="guide-date">
                        {new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                        {" "}{clock(now)}
                    </span>
                    <div className="guide-marks">
                        {Array.from({ length: WINDOW / SLOT }, (_, i) => (
                            <span key={i} style={{ left: pct(i * SLOT) }}>{clock(start + i * SLOT)}</span>
                        ))}
                        <b className="guide-now" style={{ left: pct(now - start) }} />
                    </div>
                </div>

                {rows.map(({ chan: c, cells }) => (
                    <div key={c.id} className={`guide-row${c.id === chan?.id ? " on" : ""}`}>
                        <button className="guide-name" onClick={() => setPick(c.id)}>
                            <span className="guide-no">{c.number}</span>
                            <span>
                                {c.title}
                                {/* A tuned channel has no playlist to count — it has a
                                    walk, and it is always on. */}
                                <small>{c.kind === "walk"
                                    ? "tuned · always on"
                                    : `${c.items.length} ${c.kind === "show" ? "episodes" : "titles"}`}</small>
                            </span>
                        </button>
                        <div className="guide-cells">
                            {cells.map((cell) => (
                                <button
                                    key={cell.startsAt}
                                    className={`guide-cell${cell.startsAt <= now && now < cell.endsAt ? " live" : ""}`}
                                    style={{ left: pct(cell.startsAt - start), width: pct(cell.endsAt - cell.startsAt) }}
                                    title={`${c.title} · ${clock(cell.startsAt)} — ${cell.item.name}`}
                                    /* What is on NOW is a channel to tune to; anything else is
                                       a thing to go read about, since you cannot watch 9pm at 4. */
                                    onClick={() => { setPick(c.id); if (cell.startsAt <= now && now < cell.endsAt) onTv(c); else onPlay(cell.item, 0); }}
                                >
                                    {slotLabel(cell.item)}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
