import { useEffect, useRef, useState } from "react";
import { nodeKey } from "../catalog/browse.js";

// ─── one back button, everywhere ─────────────────────────────────────────────
// ponytail: a stack of nav snapshots, not a router. Every page in the viewer is
// a combination of five pieces of state — which view, which folder, which wiki
// page, which item, which search — so the PREVIOUS combination is the previous
// page. One hook restores it, instead of a back button wired by hand at twenty
// call sites (and forgotten at half of them, which is how we got here).
//
// Filters (publisher, type) are deliberately NOT in the snapshot: they are
// settings, not places, and they stay where you put them.
export const navKey = ({ view, at, page, detail, hits }) => JSON.stringify([
    view, at, page?.concept?.slug ?? page?.shelf?.id ?? null,
    detail ? nodeKey(detail.node) : null, hits ? hits.length : null,
]);

export function useBack(snap, apply) {
    const key = navKey(snap);
    const prev = useRef({ key, snap });
    const stack = useRef([]);
    const popping = useRef(false);
    const [, bump] = useState(0);
    useEffect(() => {
        const was = prev.current;
        prev.current = { key, snap };
        if (was.key === key) return;
        if (popping.current) popping.current = false;
        else stack.current.push(was.snap);
        bump((n) => n + 1);
        // `snap` changes identity every render; only the key decides whether the
        // page did, so this must not depend on it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // Nothing on the stack but not on the front page — a deep link, a reload —
    // still gets a back button. It goes home, which is the true parent.
    const to = stack.current[stack.current.length - 1] ?? null;
    return {
        to,
        back: () => {
            popping.current = true;
            apply(stack.current.pop() ?? { view: snap.view, at: null, page: null, detail: null, hits: null });
        },
    };
}

// What pressing back lands on, in words — a back button that doesn't say where
// it goes is a guess the reader has to make twice.
export const backLabel = (s) => {
    if (!s) return "Home";
    if (s.detail) return s.detail.node.name ?? "item";
    if (s.hits) return "search results";
    if (s.page) return s.page.concept?.name ?? s.page.shelf?.title ?? "page";
    if (s.at) return s.at.dir ? s.at.dir.split("/").pop() : "Collections";
    return "Home";
};

// ── self-check: `node src/ui/nav.js` ────────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
    const home = { view: "wiki", at: null, page: null, detail: null, hits: null };
    const item = (name) => ({ ...home, detail: { node: { resourceId: `0x${name}`, name } } });

    // A page is the same page when the tuple is: a re-render with a new object
    // for the same item must NOT push a duplicate onto the stack.
    eq(navKey(item("a")), navKey(item("a")), "same item is the same page");
    if (navKey(item("a")) === navKey(item("b"))) throw new Error("two items must be two pages");
    if (navKey(home) === navKey({ ...home, at: { owner: "0x1", dir: "Show" } })) throw new Error("a folder is not home");
    if (navKey(home) === navKey({ ...home, view: "folders" })) throw new Error("a view switch is a page change");
    // Filters are settings, not places — they must not appear in the key.
    eq(navKey({ ...home, kind: "music", owner: "0x1" }), navKey(home), "filters are not navigation");

    eq(backLabel(null), "Home", "an empty stack goes home");
    eq(backLabel(home), "Home", "the front page is Home");
    eq(backLabel(item("Airplane.mp4")), "Airplane.mp4", "an item page is named by its file");
    eq(backLabel({ ...home, at: { owner: "0x1", dir: "Show/S1" } }), "S1", "a folder is named by its leaf");
    eq(backLabel({ ...home, at: { owner: "0x1", dir: "" } }), "Collections", "a publisher root is Collections");
    eq(backLabel({ ...home, page: { shelf: { id: "genre:Anime", title: "Anime" } } }), "Anime", "a shelf page by title");
    eq(backLabel({ ...home, hits: [1, 2] }), "search results", "a query is a place too");
    console.log("nav.js self-check ok — page identity, filters excluded, back labels");
}
