/**
 * The page talking back.
 *
 * WebMCP as everyone writes it is a remote control: the agent calls, the page
 * obeys, and nothing about the arrangement needs a browser — ship the corpus to
 * a server and a server MCP does the same job. What a server cannot do is be
 * WHERE THE PERSON IS. Two directions fall out of that, and both are missing
 * from a tools-only design:
 *
 *   page → agent   Nobody says a tool has to resolve immediately. `next()`
 *                  returns a promise that stays pending until the viewer
 *                  actually does something — changes channel, rates, sits still
 *                  long enough to mean it. An agent parked in that call is
 *                  SUBSCRIBED to a human, and wakes when they move. No polling,
 *                  no socket, no server holding a queue.
 *
 *   agent → page   `propose()` puts a card on the screen the person is already
 *                  looking at and stays pending until they answer it. This is
 *                  the honest shape for an agent acting on someone's behalf: it
 *                  cannot retune the TV or spend the money, it can only ask, in
 *                  the place where asking is cheap. WebMCP has no consent
 *                  primitive — this is what one looks like built out of a page.
 *
 * Deliberately not an EventTarget: waiters need a TIMEOUT and a one-shot
 * resolve, and DOM events give neither without a wrapper longer than this file.
 *
 * ponytail: one bus per tab, module-scoped. There is one page and one person in
 * front of it; a registry keyed by anything would be scaffolding for a second
 * viewer who does not exist.
 */

// ── page → agent ─────────────────────────────────────────────────────────────
// Kept so an agent that arrives mid-session, or asks again after handling one,
// sees what it missed rather than blocking on a signal that already fired.
const LOG = 40;
const log = [];
let seq = 0;
const waiters = new Set();

/** Record something the viewer did. Wakes every agent waiting on a signal. */
export function emit(kind, data = {}) {
    const sig = { seq: ++seq, kind, at: Date.now(), ...data };
    log.push(sig);
    if (log.length > LOG) log.shift();
    for (const w of [...waiters]) { waiters.delete(w); w.resolve(sig); }
    return sig;
}

/** Signals after `since`, without waiting. */
export const since = (n = 0) => log.filter((s) => s.seq > n);

/** The subscription. Resolves with the next signal after `after`, or with null
 *  when `ms` passes quietly — a timeout is an answer ("they are still watching"),
 *  not a failure, and an agent that treats it as one will loop forever. */
export function next({ after = 0, ms = 45_000 } = {}) {
    const missed = since(after);
    if (missed.length) return Promise.resolve(missed[0]);
    return new Promise((resolve) => {
        const w = { resolve };
        waiters.add(w);
        setTimeout(() => { if (waiters.delete(w)) resolve(null); }, ms);
    });
}

/** The high-water mark, so an agent can say "anything after this". */
export const mark = () => seq;

// ── agent → page ─────────────────────────────────────────────────────────────
const open = new Map();          // id -> { id, question, options, resolve }
const subs = new Set();          // React setState fns
const publish = () => { const rows = [...open.values()]; for (const fn of subs) fn(rows); };

/** Ask the person something, on the screen. Resolves with the option they
 *  chose, or null if they let it expire — silence is a "no", and an agent that
 *  reads no answer as consent is exactly the thing this exists to prevent. */
export function propose({ question, options = ["Yes", "No"], ms = 60_000 }) {
    const id = `p${++seq}`;
    return new Promise((resolve) => {
        let done = false;
        const finish = (choice) => {
            if (done) return;
            done = true; open.delete(id); publish(); resolve(choice);
        };
        open.set(id, { id, question, options, resolve: finish });
        publish();
        setTimeout(() => finish(null), ms);
    });
}

/** What the viewer pressed. `null` for dismissing it. */
export const answer = (id, choice) => open.get(id)?.resolve(choice ?? null);

/** Subscribe a component to the open proposals. Returns an unsubscribe. */
export function watch(fn) { subs.add(fn); fn([...open.values()]); return () => subs.delete(fn); }

// ── self-check: `node src/ui/intent.js` ──────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

    // A waiter parked before the event gets it.
    const at = mark();
    const p = next({ after: at, ms: 500 });
    emit("skip", { from: 0, to: 1 });
    eq((await p).kind, "skip", "a parked waiter wakes on the next signal");

    // One that arrives late still sees it — the whole reason there is a log.
    eq((await next({ after: at, ms: 500 })).kind, "skip", "a late waiter is not stranded");

    // Quiet is an answer, not an error.
    eq(await next({ after: mark(), ms: 60 }), null, "a quiet window resolves null");

    // Proposals: answered, dismissed, expired — three different outcomes, and
    // none of them is "assume yes".
    let shown = [];
    const off = watch((rows) => { shown = rows; });
    const ask = propose({ question: "Pull toward nature docs?", options: ["Yes", "Not now"], ms: 5000 });
    eq(shown.length, 1, "a proposal shows up on the page");
    answer(shown[0].id, "Yes");
    eq(await ask, "Yes", "and comes back with what was pressed");
    eq(shown.length, 0, "then clears");

    const drop = propose({ question: "?", ms: 5000 });
    answer(shown[0].id, null);
    eq(await drop, null, "dismissing answers null");
    eq(await propose({ question: "?", ms: 60 }), null, "and silence expires to null, never to consent");
    off();

    // The log is bounded — an agent left parked overnight must not grow the tab.
    for (let i = 0; i < LOG * 2; i++) emit("tick");
    eq(log.length, LOG, "the signal log is bounded");

    console.log("intent.js self-check ok — subscription, replay, timeout, proposal answer/dismiss/expiry, bounded log");
}
