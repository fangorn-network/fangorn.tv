// You as a walkable wiki. wiki.js derives it; this draws it.
//
// The spine is second-brain's, with the pages this reader actually has:
//
//   index          you: left off, next, did you know, your concepts, what you said
//   shelf page     one generated row (browse.js shelves()) as a list
//   concept page   a term, every item that mentions it, and what it sits near
//   item page      Detail, in App.jsx — the "note page", cited to a resourceId
//
// Every link on every page is one of four things, and all four land somewhere
// that has its own links out. That is the whole difference from a grid: a grid is
// a dead end with a back button.
//
// The mirror at the top of the index is prose and a trail of what you actually
// opened. It replaced a 64-label attractor disc with a drift slider: that drawing
// was the kernel's geometry rendered literally, which is a picture of the model
// rather than a picture of the reader. Nobody can read their own taste off a
// scatter of overlapping filenames, and the slider asked a question ("how much
// serendipity?") that has no answer before you have seen anything. The kernel
// still does all of the same work — it just gets described in the words it
// already produces (heading(), alias(), the concept counts) and evidenced by the
// row of things you opened, which is the one thing on the page that is
// unarguably about you.
import React from "react";
import { conceptsOf, lede, nearest, related } from "../catalog/wiki.js";
import { inRun, nextUp, nodeKey, watched } from "../catalog/browse.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "unknown");
export const A = ({ onClick, children, ...rest }) => (
    <button className="wlink" onClick={onClick} {...rest}>{children}</button>
);


/**
 * "Show more", the only pagination in the app.
 *
 * Every wall in here is the same wall: a list the catalog made that is longer
 * than anyone wants at once — 400 series, 1,400 files in a folder, a shelf with
 * every match on it. One hook and one button, rather than a virtualized grid: the
 * DOM cost is what makes a big catalog feel broken, and not drawing it is the
 * whole fix.
 *
 * `key` is what a NEW list looks like — a shelf id, a folder path. The count
 * resets when you walk to a different list and survives a re-render of the same
 * one (which is what depending on the array identity would break).
 * ponytail: a button, not an intersection observer. Infinite scroll when someone
 * asks for it.
 */
export function useMore(items = [], { step = 60, key = items.length } = {}) {
    const [n, setN] = React.useState(step);
    React.useEffect(() => { setN(step); }, [key, step]);
    return {
        shown: items.length > n ? items.slice(0, n) : items,
        rest: Math.max(0, items.length - n),
        more: () => setN((k) => k + step),
    };
}

export const More = ({ of, what = "" }) => (of.rest > 0
    ? <button className="loadmore" onClick={of.more}>Show more{what && ` ${what}`} <span className="wmeta">{of.rest} left</span></button>
    : null);

/** One item, as a line of a page rather than a tile: name, what it is, what it
 *  costs. No art, no placeholder — the description is the picture.
 *
 *  `rate` is the 👍/👎 pair, passed in rather than imported: this file draws the
 *  wiki and App.jsx owns the session state the buttons write to. A list page is
 *  where you are actually reading titles and forming an opinion, so it is the
 *  cheapest place in the whole app to correct the kernel. */
function Row({ node, price, onOpen, rate, seen }) {
    const line = lede(node, 150);
    // How far this browser got, if it ever started. A tick when it is finished, a
    // sliver under the thumbnail when it is part way — the two states a list of
    // episodes actually needs.
    const [p] = seen?.[nodeKey(node)] ?? [];
    return (
        <li className={`wrow${p >= 0.95 ? " done" : ""}`}>
            {p > 0.02 && p < 0.95 && <span className="wprog" style={{ "--p": `${Math.round(p * 100)}%` }} aria-hidden="true" />}
            <Thumb node={node} onOpen={onOpen} />
            <span className="wbody">
                <A onClick={() => onOpen(node)} title={node.path}>{node.name}</A>
                {line && <span className="wlede">{line}</span>}
                {/* A folded show is a page, not a purchase — it has no price of its
                    own and nothing to rate; its episodes have both. */}
                <span className="wmeta">{node.shelf ? node.why : price(node)} · {short(node.owner)}</span>
                {!node.shelf && rate?.(node)}
            </span>
        </li>
    );
}

/** The one big picture on the page: the thing you were last watching, 16/9 and
 *  full measure, with the same ▶ the item page uses so it reads as a player and
 *  not as an illustration. */
function Hero({ node, onPlay }) {
    const [broken, setBroken] = React.useState(false);
    if (!node.thumb || broken) return null;
    return (
        <button className="whero" onClick={() => onPlay(node)} aria-label={`Play ${node.name}`}>
            <img src={node.thumb} alt="" loading="lazy" onError={() => setBroken(true)} />
            <span className="pplay" aria-hidden="true">▶</span>
        </button>
    );
}

/**
 * A real frame, or nothing at all.
 *
 * The wiki is a document, so a picture has to earn its place: it appears only when
 * the row actually carries a `thumb` (an open catalog derives one; a sold file's
 * bytes are encrypted, so there is no frame to grab). The generated gradient art
 * the grid uses is deliberately NOT reused here — next to a sentence it says
 * nothing, it just makes the page louder. A 404 removes itself for the same
 * reason: a broken-image icon in a paragraph reads as a broken page.
 */
function Thumb({ node, onOpen }) {
    const [broken, setBroken] = React.useState(false);
    React.useEffect(() => setBroken(false), [node?.thumb]);
    if (!node?.thumb || broken) return null;
    return (
        <span className="wthumb" onClick={() => onOpen?.(node)}
            role={onOpen ? "button" : undefined} aria-hidden={!onOpen}>
            <img src={node.thumb} alt="" loading="lazy" onError={() => setBroken(true)} />
        </span>
    );
}

/** One half of the tag line: "Your tags video, Chronicles". Nothing at all when
 *  the kernel holds no tags of that sign — an empty lead-in reads as a bug. */
const tags = (ts, lead) => {
    if (!ts.length) return null;
    const names = ts.map((t) => t.tag.replace(/^top:[^/]*\//, "").replace(/^top:/, ""));
    const list = names.join(", ");
    return <span className="wpull">{lead} <b>{list}</b></span>;
};

/**
 * The front page: the reader, not the catalog.
 *
 * Everything here is a fact about this browser — what it opened, what it rated,
 * which concepts those land in, what the kernel infers from that, and where the
 * signal was carried in from. The only forward-looking section is Next, and every
 * row of it names the item it was derived from, so a recommendation is checkable
 * rather than a black box.
 *
 * Cold is a first-class state: with no history there is nothing to reflect, and
 * the page says exactly that instead of dressing the catalog up as a portrait.
 */
// How many tiles a row carries. The row scrolls sideways, so this is not "how
// many fit" — it is how far you can travel before the heading is the better way
// to see the rest.
const TILES = 12;

export function WikiIndex({ w, files, point, price, card, fold = (x) => x,
    shelves = [], publishers = 0, onOpen, onPlay, onConcept, onShelf, onCollections }) {
    const { cold, who, last, seen, dyk, yours, recs, liked, disliked, apps, taste, concepts, stats } = w;
    // Six rows to start. A front page that renders forty carousels is the wall
    // this was supposed to remove, one level up.
    const rows = useMore(shelves, { step: 6, key: shelves.length && shelves[0].id });
    return (
        <article className="wiki">
            {/* The mirror, in one plate rather than six sections. Who this session
                looks like, how far in it is, and what it leans toward — the whole
                self-portrait above the fold, because everything BELOW it is the
                catalog and that is what someone came to browse. The workings that
                used to be five prose sections are at the foot of the page, folded. */}
            <header className="whead wplate">
                <div className="wself">
                    {/* The handle IS the page's title: this page is about a session, and
                        the session's name is the one thing on screen that no server has
                        a copy of. It moves as the kernel moves — see alias(). */}
                    <h1 className="wname">{who?.name ?? "You"}</h1>
                    {who
                        ? <p className="wsub">{who.why}</p>
                        : <p className="wsub">Nothing opened yet.</p>}

                    {/* The mirror, in a sentence and a trail.
                        Three labelled percentage bars (drift / focus / rated) were a
                        dashboard about the model. These are the same numbers said as
                        the things they are counts OF — and the row underneath is the
                        actual evidence: the last dozen things this browser opened, in
                        order, which needs no legend at all. */}
                    {!cold && <p className="wmirror">
                        <span>{stats.opened} opened{stats.liked + stats.disliked > 0 && `, ${stats.liked + stats.disliked} rated`}</span>
                        {yours.length > 0 && <span>mostly {yours.slice(0, 3).map((c) => c.name).join(", ")}</span>}
                        {tags(taste.filter((t) => t.w > 0), "leaning")}
                        {tags(taste.filter((t) => t.w < 0), "avoiding")}
                    </p>}

                    {/* Where the kernel points, in the words it already produces. */}
                    {point}

                    <Trail of={seen} onOpen={onOpen} />
                </div>

                {/* Beside the portrait, not under it: what you were last watching is
                    the one thing on this page you might want before you have read a
                    word of it, and the plate is the only place it can sit without
                    pushing the catalog below the fold.
                    The frame is the button. Clicking it does exactly what clicking
                    the row does — a paid file still stops at its buy button — and
                    then asks for fullscreen; leaving fullscreen drops you on the
                    item's page, which is where the click had already taken you. */}
                {last && <aside className="wcontinue">
                    <h2>Continue</h2>
                    {last.thumb ? <Hero node={last} onPlay={onPlay ?? onOpen} /> : null}
                    <h3><A onClick={() => onOpen(last)}>{last.name}</A></h3>
                    <p className="wmeta">{price(last)} · {short(last.owner)}</p>
                    <Concepts of={last} concepts={concepts} onConcept={onConcept} />
                </aside>}
            </header>

            {/* The catalog, as rows you scroll sideways.
                This is the page now — it used to be the seventh section, under five
                lists about the reader. A row is a PEEK, and its heading is the way
                to the whole thing; the picks the kernel made are just the first row
                rather than a prose block of their own. Rows come in a handful at a
                time for the same reason the items in them do. */}
            <section className="wsec wbrowse">
                {recs.length > 0 && (
                    <Shelf title={cold ? "Starting points" : "Picked for you"}
                        why={recs[0]?.because ? `closest to ${recs[0].because.name}which you opened` : "popular items"}
                        items={fold(recs.map((r) => r.f))} card={card} />
                )}
                {rows.shown.map((s) => (
                    <Shelf key={s.id} title={s.title} why={s.why} items={s.items}
                        card={card} onAll={() => onShelf(s)} />
                ))}
                <More of={rows} what="rows" />
                <p className="wmeta">
                    <A onClick={onCollections}>Collections</A>
                    {" · "}{publishers} publisher{publishers === 1 ? "" : "s"} · {files.length.toLocaleString()} items
                </p>
            </section>

            {/* The workings. Every one of these was a full section at the top of the
                page, and together they were the reason it read as a wall. They are
                the receipts for the portrait above, so they stay — closed, at the
                bottom, where a reader goes when they want to check it. */}
            {!cold && <details className="wworkings">
                <summary>What this page is made of</summary>
                {dyk.length > 0 && <section className="wsec">
                    <h2>Recently opened</h2>
                    <ul className="wlist">
                        {dyk.map(({ f, line }) => (
                            <li key={`${f.owner}/${f.path}`}>{line} — <A onClick={() => onOpen(f)}>{f.name}</A></li>
                        ))}
                    </ul>
                </section>}
                {yours.length > 0 && <section className="wsec">
                    <h2>Recurring themes</h2>
                    <ul className="wlist">
                        {yours.map((c) => (
                            <li key={c.slug}>
                                <A onClick={() => onConcept(c)}>{c.name}</A>
                                <span className="wmeta"> — {c.mine} of {c.items.length} opened</span>
                            </li>
                        ))}
                    </ul>
                </section>}
                {(liked.length > 0 || disliked.length > 0) && <section className="wsec">
                    <h2>Ratings</h2>
                    <ul className="wlist">
                        {liked.map((f) => (
                            <li key={`+${f.owner}/${f.path}`}>
                                <span className="wmeta">positive</span> <A onClick={() => onOpen(f)}>{f.name}</A></li>
                        ))}
                        {disliked.map((f) => (
                            <li key={`-${f.owner}/${f.path}`}>
                                <span className="wmeta">negative</span> <A onClick={() => onOpen(f)}>{f.name}</A></li>
                        ))}
                    </ul>
                </section>}
                {apps.length > 1 && <section className="wsec">
                    <h2>Recorded in</h2>
                    {/* The kernel crosses apps by vector, so a drift can originate
                        somewhere you are not looking. Naming it is the difference
                        between useful and spooky. */}
                    <ul className="wlist">
                        {apps.map(({ app, n }) => (
                            <li key={app}>{app === "here" ? "this app" : app}<span className="wmeta"> — {n} item{n === 1 ? "" : "s"}</span></li>
                        ))}
                    </ul>
                </section>}
            </details>}
        </article>
    );
}

/**
 * What you actually opened, most recent first.
 *
 * This is the mirror. Not a projection of a 256-d vector onto a disc — the
 * literal row of things, small, in order, each one a link back to itself. A
 * reader recognises their own week in it instantly, which is the thing the
 * geometry never managed however correct it was.
 *
 * ponytail: no dates, no session boundaries, no "you watched this 3 days ago".
 * The order carries it. Add timestamps when someone asks what day it was.
 */
function Trail({ of = [], onOpen, n = 14 }) {
    const items = of.slice(0, n).filter((f) => f.thumb);
    if (items.length < 3) return null;
    return (
        <div className="trail" aria-label="Recently opened">
            {items.map((f) => (
                <button key={`${f.owner}/${f.path}`} className="trailcell" onClick={() => onOpen(f)} title={f.name}>
                    <img src={f.thumb} alt="" loading="lazy" />
                </button>
            ))}
        </div>
    );
}

/** One row of the catalog: a heading that is also the way in, and TILES of it
 *  scrolled sideways. Horizontal, not a grid — a row that wraps is a page, and
 *  the point of a row is that the next one is right below it. */
function Shelf({ title, why, items, card, onAll }) {
    const row = React.useRef(null);
    // A page of tiles per press, minus a sliver so the tile you were looking at
    // stays on screen as the anchor. ponytail: no end-of-track disabling — that
    // needs a scroll listener per row, and a press at the end is a no-op anyway.
    const nudge = (d) => row.current?.scrollBy({ left: d * row.current.clientWidth * 0.85, behavior: "smooth" });
    if (!items?.length) return null;
    return (
        <div className="shelf">
            <h3 className="shelfhead">
                {onAll ? <A onClick={onAll}>{title}</A> : title}
                {why && <span className="wmeta">{why}</span>}
                {onAll && items.length > TILES && (
                    <A className="shelfall" onClick={onAll}>All {items.length.toLocaleString()} →</A>
                )}
            </h3>
            {/* Buttons, not just a scrollbar: a trackpad-less mouse has no sideways
                gesture, and a thin overlay scrollbar is not a control. */}
            <div className="shelfwrap">
                <button className="shelfnav prev" onClick={() => nudge(-1)} aria-label={`Scroll ${title} left`}>‹</button>
                <div className="shelfrow" ref={row}>
                    {items.slice(0, TILES).map((f) => (
                        <span className="shelfcell" key={`${f.owner}/${f.path}`}>{card(f)}</span>
                    ))}
                </div>
                <button className="shelfnav next" onClick={() => nudge(1)} aria-label={`Scroll ${title} right`}>›</button>
            </div>
        </div>
    );
}

const Concepts = ({ of, concepts, onConcept }) => {
    const cs = conceptsOf(of, concepts);
    if (!cs.length) return null;
    return (
        <p className="wconcepts">
            {cs.map((c) => <A key={c.slug} onClick={() => onConcept(c)}>{c.name}</A>)}
        </p>
    );
};

/**
 * A concept page, and — same shape, same code — a shelf page. Both are "a named
 * group of items with a way back and a way onward".
 *
 * The see-also list is what makes the wiki walkable instead of a two-level index:
 * every concept that shares an item with this one is one click away, so you can
 * cross the catalog sideways without ever going back to the front page.
 */
export function ListPage({ concept, shelf, concepts, vectors, price, rate, share, onOpen, onConcept, onBack, onPlayAll, root = "Index", fold = (x) => x }) {
    // A concept page is ranked over FILES, so without the fold "cartoon" is forty
    // Johnny Bravos. A SHELF page is never folded: a series page whose items were
    // collapsed into the series would be a page about itself.
    const items = concept ? fold(nearest(concept, vectors)) : shelf.items ?? [];
    const also = concept ? related(concept, concepts) : [];
    // A publisher who wrote a description wrote it once for the whole series, so
    // the first episode's is the page's. Concepts of the same item give the page
    // its links out — a series page with no way onward is a list.
    const blurb = concept ? "" : lede(items[0] ?? {}, 320);
    const tags = concept ? [] : conceptsOf(items[0] ?? {}, concepts, 6);
    // A shelf IS a channel: a named, ordered group the catalog picked out. The
    // only thing it was missing was a way to just start it. Two playable items is
    // the floor — one is an item page with extra steps.
    const run = items.filter(inRun);
    // A shelf page is where "show all" lands, so it really does hold all of them —
    // 60 at a time, because 1,400 <li> is a second of layout and a wall to read.
    const page = useMore(items, { step: 60, key: concept?.slug ?? shelf?.id });
    // One localStorage read for the page, not one per row.
    const seen = React.useMemo(watched, [concept?.slug, shelf?.id]);
    return (
        <article className="wiki">
            <nav className="crumbs"><button className="crumb" onClick={onBack}>{root}</button></nav>
            <header className="whead">
                <h1>{concept?.name ?? shelf.title}</h1>
                <p className="wsub">
                    {concept
                        ? `${items.length} item${items.length === 1 ? "" : "s"} mention this`
                        : shelf.why ?? `${items.length} item${items.length === 1 ? "" : "s"}`}
                </p>
                {blurb && <p className="wlede">{blurb}</p>}
                {/* Continue, not restart. A show page whose only button starts at
                    episode one is useless by episode two; `nextUp` is the first
                    episode this browser has not finished, and it names it so the
                    button is never a surprise. */}
                {share}
                {onPlayAll && run.length > 1 && (() => {
                    const next = shelf ? nextUp(shelf) : null;
                    const i = next ? run.findIndex((f) => nodeKey(f) === nodeKey(next)) : -1;
                    return (
                        <button className="file" onClick={() => onPlayAll(run, Math.max(0, i))}>
                            {i > 0 ? `▶ Continue — ${next.name}` : `▶ Play all ${run.length}`}
                        </button>
                    );
                })()}
            </header>
            {/* The middle shell. A show with four seasons used to be four cards on
                the front page; now it is one page, divided here. One season is not
                a division, so seriesShelves leaves `seasons` null and the flat list
                below is the page — same as every other shelf. */}
            {shelf?.seasons
                ? shelf.seasons.map((sn) => (
                    <section className="wsec" key={sn.season}>
                        <h2>{sn.season === "" ? "Episodes" : `Season ${sn.season}`}
                            <span className="wmeta"> {sn.items.length} episode{sn.items.length === 1 ? "" : "s"}
                                {(() => {
                                    const n = sn.items.filter((f) => (seen[nodeKey(f)]?.[0] ?? 0) >= 0.95).length;
                                    return n ? ` · ${n} watched` : "";
                                })()}</span>
                            {onPlayAll && sn.items.filter(inRun).length > 1 && (
                                <A className="shelfall" onClick={() => onPlayAll(sn.items.filter(inRun))}>▶ Play season</A>
                            )}
                        </h2>
                        <ul className="wlist wrows">
                            {sn.items.map((f) => <Row key={`${f.owner}/${f.path}`} node={f} price={price} rate={rate} seen={seen} onOpen={onOpen} />)}
                        </ul>
                    </section>
                ))
                : <><ul className="wlist wrows">
                    {page.shown.map((f) => <Row key={`${f.owner}/${f.path}`} node={f} price={price} rate={rate} seen={seen} onOpen={onOpen} />)}
                </ul>
                    <More of={page} /></>}
            {tags.length > 0 && <section className="wsec">
                <h2>Concepts</h2>
                <p className="wconcepts">
                    {tags.map((c) => <A key={c.slug} onClick={() => onConcept(c)}>{c.name}</A>)}
                </p>
            </section>}
            {also.length > 0 && <section className="wsec">
                <h2>See also</h2>
                <p className="wconcepts">
                    {also.map((c) => <A key={c.slug} onClick={() => onConcept(c)}>{c.name}</A>)}
                </p>
            </section>}
        </article>
    );
}

export { Concepts };
