// The attractor field — the front page as a place instead of a shelf.
//
// kernel.js `field()` does the geometry; this only draws it. Everything on screen
// is a number the kernel already computes, and nothing here is decoration:
//
//   distance from the centre   how far a row sits from the session's attractor
//   type size / brightness     the same, so the near rows read first
//   angle                      which topics() region the row belongs to, blended
//                              toward its runner-up, so cluster edges are soft
//   the rays                   where the region argmax flips
//
// Opening a row feeds the Markov kernel, the attractor moves, and the field
// re-lays itself out — the CSS transition below is the only reason that reads as
// the space warping rather than the page repainting.
//
// ponytail: no collision solver. Radius is rank-unique and the sector nudge in
// field() spreads ties, which is enough at ~64 labels; add one if the corpus
// grows dense enough that names actually overlap.
import React, { useMemo, useState } from "react";
import { field } from "../geometry/kernel.js";

const R = 100;                 // disc radius in viewBox units
const trim = (s = "", n = 30) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export default function Field({ files, vectors, state, groups, impulse, point, onOpen }) {
    // Strict ←→ serendipity: how far along the session's velocity the attractor
    // is pushed. This is the one knob the geometry gives the user directly.
    const [drift, setDrift] = useState(0.4);
    const f = useMemo(
        () => field(files, vectors, state, { groups, drift, to: impulse }),
        [files, vectors, state, groups, drift, impulse],
    );
    if (!f) return null;

    // A boundary sits halfway between two neighbouring region centres. With one
    // region there is no boundary to draw, which is correct: no edges, no flip.
    const angles = f.regions.map((r) => r.angle).sort((a, b) => a - b);
    const bounds = angles.length > 1
        ? angles.map((a, i) => (a + (i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI)) / 2)
        : [];

    return (
        <section className="field">
            <svg viewBox={`${-R * 1.35} ${-R * 1.35} ${R * 2.7} ${R * 2.7}`} role="presentation">
                {/* conceptual regions — the boundaries move when the clusters do */}
                <g className="regions">
                    {bounds.map((a, i) => (
                        <line key={i} x1={Math.cos(a) * R * 0.18} y1={Math.sin(a) * R * 0.18}
                            x2={Math.cos(a) * R * 1.28} y2={Math.sin(a) * R * 1.28} />
                    ))}
                    {/* Two clusters can be named the same thing — topics() splits on
                        geometry, not on words — so the index is the key, not the title. */}
                    {f.regions.map((r, i) => (
                        <text key={i} className="rlabel"
                            x={Math.cos(r.angle) * R * 1.2} y={Math.sin(r.angle) * R * 1.2}
                            textAnchor={Math.cos(r.angle) < -0.3 ? "end" : Math.cos(r.angle) > 0.3 ? "start" : "middle"}>
                            {r.title}
                        </text>
                    ))}
                </g>

                {/* the attractor: where the session is, right now */}
                <circle className="attractor-halo" r={R * 0.13} />
                <circle className="attractor" r={2.4} />

                {f.nodes.map((n) => (
                    <g key={`${n.f.owner}/${n.f.path}`} className="fnode"
                        transform={`translate(${n.x * R} ${n.y * R})`}
                        style={{ opacity: 0.3 + 0.7 * n.w }}
                        onClick={() => onOpen(n.f)} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") onOpen(n.f); }}>
                        <title>{`${n.f.path} — ${n.score.toFixed(3)}`}</title>
                        <text style={{ fontSize: `${3 + 4.5 * n.w}px` }}>{trim(n.f.name, 34)}</text>
                        <text className="fmeta" y={6}>{(n.score).toFixed(2)}</text>
                    </g>
                ))}
            </svg>

            {/* the trajectory HUD: where the kernel points, and how far it may wander */}
            <div className="hud">
                {point}
                <label className="driftbar" title="How far along the session's velocity the attractor sits">
                    <span>strict</span>
                    <input type="range" min="0" max="1" step="0.02" value={drift}
                        onChange={(e) => setDrift(Number(e.target.value))} />
                    <span>drift</span>
                </label>
            </div>
        </section>
    );
}
