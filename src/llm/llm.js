// In-browser GENERATIVE model. Sibling of embed.js: that one turns text into a
// vector for search, this one is a small instruction-tuned LLM that answers a
// bounded question about a file — today, "which shelf does this belong on".
//
// Lifted from embeddings/examples/places/src/lib/llm.ts, trimmed to the one job
// this app has for it. transformers.js is already a dependency (embed.js), so
// this adds no package, only a (large, cached) model download — which is why it
// NEVER loads on its own. Something in the UI has to ask for it. See genres.js.
//
// ponytail: 0.5B, greedy, no sampling knobs exposed. It picks from a closed list;
// a bigger model is the upgrade path only if the picks are measurably wrong.

const MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

let status = { stage: "idle", progress: 0, message: "" };
const listeners = new Set();
const setStatus = (next) => {
    status = { ...status, ...next };
    for (const fn of listeners) fn(status);
};
export const getLlmStatus = () => status;
export function onLlmStatus(fn) {
    listeners.add(fn);
    fn(status);
    return () => listeners.delete(fn);
}

// `navigator.gpu` can exist with no usable adapter behind it, so probe for real.
async function webgpu() {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
}

// One 0..1 bar across the model's files instead of a flurry of per-file events.
const files = new Map();
const track = (e) => {
    if (e.status === "progress" && e.file && typeof e.progress === "number") files.set(e.file, e.progress / 100);
    else if (e.status === "done" && e.file) files.set(e.file, 1);
    if (!files.size) return;
    let sum = 0;
    for (const v of files.values()) sum += v;
    setStatus({ progress: sum / files.size, message: "downloading the sorter…" });
};

let _gen = null;
const generator = () => (_gen ??= (async () => {
    setStatus({ stage: "loading", progress: 0, message: "waking the sorter…" });
    const { pipeline } = await import("@huggingface/transformers");
    // WebGPU first when there's an adapter, WASM as the fallback — a machine that
    // can't build a GPU session self-downgrades instead of hard-failing.
    const chain = (await webgpu())
        ? [{ device: "webgpu", dtype: "q4f16" }, { device: "wasm", dtype: "q4" }]
        : [{ device: "wasm", dtype: "q4" }];
    let last;
    for (const cfg of chain) {
        files.clear();
        setStatus({ progress: 0 });
        try {
            const gen = await pipeline("text-generation", MODEL, { ...cfg, progress_callback: track });
            setStatus({ stage: "ready", progress: 1, message: "sorter ready" });
            return gen;
        } catch (e) { last = e; console.error(`[llm] load failed (${cfg.device}/${cfg.dtype}):`, e); }
    }
    setStatus({ stage: "error", message: last?.message ?? "the sorter failed to load" });
    _gen = null; // let a retry try again rather than caching the failure forever
    throw last;
})());

/** Start the download. Never rejects — subscribe to onLlmStatus for the outcome. */
export const warmLLM = () => { generator().catch(() => {}); };

/** One system+user turn, greedy, returns the assistant text. */
export async function chat(system, user, maxTokens = 32) {
    const gen = await generator();
    const out = await gen(
        [{ role: "system", content: system }, { role: "user", content: user }],
        {
            max_new_tokens: maxTokens,
            do_sample: false,
            // A 0.5B decodes into loops without these; the n-gram ban is what
            // actually breaks a runaway phrase.
            repetition_penalty: 1.3,
            no_repeat_ngram_size: 3,
            return_full_text: false,
        },
    );
    const msgs = out?.[0]?.generated_text;
    const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
    return (last?.content ?? "").trim();
}
