// The embedder, off the main thread.
//
// nomic-embed-text-v1.5 q8 is a 131MB ONNX download, and ONNX Runtime's WASM init
// and every inference after it are synchronous CPU. On the main thread that is a
// frozen tab for as long as it takes — which on a first visit is a minute or two
// of an app that looks broken rather than busy.
//
// Nothing here decides anything. It owns the pipeline and answers three messages,
// so that the one copy of MODEL, DIM and matryoshka stays in embed.js and the two
// sides cannot drift into embedding queries and documents differently — which is
// the failure that makes cosine meaningless while every test still passes.

import { embedQueryDirect, embedDocumentDirect, warmDirect } from "./embed.js";

const jobs = { query: embedQueryDirect, document: embedDocumentDirect };

self.onmessage = async ({ data: { id, kind, text } }) => {
    try {
        if (kind === "warm") { await warmDirect(); return self.postMessage({ id, vec: null }); }
        self.postMessage({ id, vec: await jobs[kind](text) });
    } catch (err) {
        // The model failing to load must reject the caller, not kill the worker
        // silently and leave a promise pending forever.
        self.postMessage({ id, error: err?.message ?? String(err) });
    }
};
