// The review deck: what the agent said it saw, before it becomes public.
//
// This is the human half of the loop. An agent describing a film is a claim, and
// a claim that goes on-chain under someone's own publisher identity should pass
// in front of them first — so every scene here is seekable (press it, watch it,
// see whether the description is true), editable in place, and droppable.
//
// It deliberately does NOT publish. It stages the annotation into the
// publisher's library and sends them to the Publish page, because committing to
// Fangorn is a wallet signature and the existing publish button already knows
// how to take one. A second publish path here would be a second thing to keep
// correct.
import { useEffect, useState } from "react";
import { allDrafts, draftFor, dropScene, editScene, clearDraft, onScenes } from "../catalog/scenes.js";
import { api, UnauthorizedError } from "../catalog/api.js";
import { nodeKey } from "../catalog/browse.js";

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Re-render on any draft change. Returns the draft for `node`, or every draft
 *  when no node is given. */
export function useDrafts(node) {
    const [, bump] = useState(0);
    useEffect(() => onScenes(() => bump((n) => n + 1)), []);
    return node ? draftFor(nodeKey(node)) : allDrafts();
}

export function SceneDeck({ node, mediaRef }) {
    const id = nodeKey(node);
    const draft = useDrafts(node);
    const [state, setState] = useState(null); // { ok } | { error }
    const [editing, setEditing] = useState(null);

    if (!draft?.scenes.length) return null;

    const contribute = async () => {
        setState({ busy: true });
        try {
            const { scenes } = await api.saveAnnotation({
                path: draft.path, mime: draft.mime, url: draft.url, desc: draft.desc,
                cues: draft.scenes,
            });
            clearDraft(id);
            setState({ ok: `${scenes} scenes staged — open Publish to sign them onto the chain.` });
        } catch (e) {
            setState({ error: e instanceof UnauthorizedError
                ? "Sign in with your wallet on the Publish page first — annotations are published under your own publisher identity."
                : e.message });
        }
    };

    return (
        <div className="deck">
            <div className="deck-head">
                <b>{draft.scenes.length} scene{draft.scenes.length === 1 ? "" : "s"} described</b>
                <span className="deck-sub">by your agent, not yet public</span>
                <button className="ghost" onClick={() => clearDraft(id)}>✕ discard</button>
            </div>
            <ol className="deck-list">
                {draft.scenes.map((s, i) => (
                    <li key={`${s.start}-${i}`}>
                        <button className="deck-at" title="Watch this moment"
                            onClick={() => { if (mediaRef?.current) mediaRef.current.currentTime = s.start; }}>
                            {mmss(s.start)}
                        </button>
                        {editing === i
                            ? <input className="deck-text" autoFocus defaultValue={s.text}
                                onBlur={(e) => { editScene(id, i, e.target.value); setEditing(null); }}
                                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }} />
                            : <span className="deck-text" onClick={() => setEditing(i)} title="Click to correct">{s.text}</span>}
                        <button className="ghost deck-drop" title="Wrong — drop it" onClick={() => dropScene(id, i)}>✕</button>
                    </li>
                ))}
            </ol>
            <div className="deck-foot">
                <button className="primary" disabled={state?.busy} onClick={contribute}>
                    {state?.busy ? "Staging…" : "⇧ Contribute to Fangorn"}
                </button>
                {/* The pitch, in the one place someone is deciding whether to bother. */}
                <span className="deck-sub">
                    {state?.ok ?? state?.error ?? "Free to publish — these become searchable moments for everyone, and cost no transaction of their own."}
                </span>
            </div>
        </div>
    );
}
