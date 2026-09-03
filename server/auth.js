// Wallet sessions for the relay (EIP-4361 "Sign-In With Ethereum", trimmed).
//
// The staging endpoints used to be wide open: any visitor could read, rename or
// DELETE another publisher's unreleased footage, and /api/publish/prepare took
// its `owner` straight from the request body. This module is the gate. It proves
// one thing only — the caller controls the private key for an address — which is
// exactly what's needed to scope media/<address>/ to its owner.
//
//   POST /api/session/nonce {address}      → { nonce, message }   (server-authored)
//   POST /api/session       {nonce, sig}   → { token, address }
//   …then: Authorization: Bearer <token> on every mutating request.
//
// ponytail: the message is BUILT and STORED server-side at nonce time, so
// verification is "look it up by nonce and recover the signer" — no SIWE parser,
// no field validation, nothing to get subtly wrong. A signature is only ever
// checked against a message this server wrote, which is what kills replay from
// another dapp. One `viem` call, no new dependency.
//
// Sessions live in memory: a restart logs everyone out. That's the right trade
// for a relay that's meant to become stateless anyway — nothing to persist, and
// no session store to leak. Swap the Maps for Redis if you ever run >1 replica.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";

/**
 * Where signed rights attestations are appended, one JSON object per line.
 *
 * This is the durable half of sign-in, and the only part of this module that
 * outlives a restart — on purpose. Sessions are a convenience; the attestation
 * is evidence, and evidence that evaporates when the relay reboots is not
 * evidence. Each line carries the full message and signature, so anyone can
 * recover the signer from the file alone with no help from this server: that is
 * what makes it worth anything to a lawyer.
 *
 * ponytail: append-only JSONL, no database. It is written once per sign-in and
 * read by a human roughly never. Move it to Postgres when someone needs to
 * *query* it.
 */
export const attestationLog = () => process.env.ATTESTATION_LOG ?? "attestations.jsonl";

/** The claim a publisher makes to open a session. Kept to ONE line because
 *  EIP-4361's `statement` is defined as a single line — a wallet that parses
 *  SIWE renders this as the prompt, and a multi-line statement drops it back to
 *  a raw text blob. The full terms are linked, not inlined, for the same reason:
 *  nobody reads a contract inside a MetaMask popup. */
const ATTESTATION =
    "I own or am licensed to distribute everything I publish from this address, "
    + "and I accept the Publisher Terms, including takedown on notice.";

/** How long an unused nonce stays valid. Long enough to read the MetaMask popup. */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** How long a signed-in session lasts before the wallet has to sign again. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const nonces = new Map(); // nonce → { message, address, expires }
const sessions = new Map(); // token → { address, expires }

const now = () => Date.now();
const token64 = () => randomBytes(32).toString("hex");

/** Drop anything past its expiry. Called on every issue/verify, so the Maps
 *  can't grow without bound from abandoned sign-in attempts. */
function sweep() {
    const t = now();
    for (const [k, v] of nonces) if (v.expires <= t) nonces.delete(k);
    for (const [k, v] of sessions) if (v.expires <= t) sessions.delete(k);
}

const isAddress = (a) => /^0x[0-9a-f]{40}$/.test(String(a ?? "").toLowerCase());

/** Normalized (lowercase) address, or throw. Every address in this app is stored
 *  and compared lowercased — a mixed-case checksum address must not open a
 *  second, separate staging directory for the same wallet. */
export function normalizeAddress(a) {
    const addr = String(a ?? "").toLowerCase();
    if (!isAddress(addr)) throw new Error("bad address");
    return addr;
}

/**
 * Issue a nonce and the exact message the wallet must sign. EIP-4361 layout so
 * MetaMask renders it as a readable sign-in prompt rather than a hex blob.
 *
 * @param address  the wallet claiming the session
 * @param origin   the requesting origin, e.g. "http://localhost:5173"
 */
export function issueNonce(address, origin) {
    sweep();
    const addr = normalizeAddress(address);
    const nonce = randomBytes(16).toString("hex");
    const domain = (() => { try { return new URL(origin).host; } catch { return "localhost"; } })();
    // The terms are linked as an EIP-4361 `Resources` entry rather than pasted
    // into the statement: it keeps the signed bytes short, and it puts the exact
    // URL inside the signature, so the record says WHICH terms were agreed to.
    const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        addr,
        "",
        `Sign in to stage and publish your SOND3R library. ${ATTESTATION}`,
        "",
        `URI: ${origin}`,
        "Version: 1",
        `Nonce: ${nonce}`,
        `Issued At: ${new Date().toISOString()}`,
        "Resources:",
        `- ${origin.replace(/\/$/, "")}/terms.html`,
    ].join("\n");
    nonces.set(nonce, { message, address: addr, expires: now() + NONCE_TTL_MS });
    return { nonce, message };
}

/**
 * Verify a signature over a previously-issued nonce's message and mint a session.
 * The nonce is consumed either way, so a signature can never be replayed.
 *
 * @returns { token, address, expiresAt }
 */
export async function verifyAndCreateSession(nonce, signature) {
    sweep();
    const pending = nonces.get(String(nonce));
    nonces.delete(String(nonce)); // one shot, success or failure
    if (!pending) throw new Error("unknown or expired nonce — request a new one");

    let recovered;
    try {
        recovered = await recoverMessageAddress({ message: pending.message, signature });
    } catch {
        throw new Error("malformed signature");
    }
    if (recovered.toLowerCase() !== pending.address) throw new Error("signature does not match the claimed address");

    // Record BEFORE minting the session, and let a write failure fail the whole
    // sign-in. A publisher who is staging files against an attestation nobody
    // kept is the exact situation this slice exists to prevent, and the failure
    // is loud here — at the first signature, on a relay that is misconfigured —
    // instead of silent until the day the record is actually needed.
    recordAttestation({ address: pending.address, message: pending.message, signature });

    const token = token64();
    const expires = now() + SESSION_TTL_MS;
    sessions.set(token, { address: pending.address, expires });
    return { token, address: pending.address, expiresAt: expires };
}

/**
 * Append one signed attestation. Synchronous and unbuffered: the caller treats a
 * throw as "refuse the sign-in", which only works if the bytes are on disk by
 * the time this returns.
 *
 * `message` is stored verbatim rather than as parsed fields — the signature is
 * over those exact bytes, so anything reconstructed from parts is not what was
 * signed and cannot be verified.
 */
export function recordAttestation({ kind = "signin", address, message, signature, ...rest }) {
    const path = attestationLog();
    const line = JSON.stringify({ at: new Date().toISOString(), kind, address, ...rest, message, signature });
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${line}\n`);
}

/**
 * The exact bytes a publisher signs to accept a specific version of the terms.
 *
 * Deterministic and un-nonced, unlike sign-in. A nonce guards against replaying
 * someone else's signature into a session; there is no equivalent win here,
 * because the only thing this signature can be replayed into is the same address
 * accepting the same terms it already accepted. What DOES matter is that the
 * bytes can't have been harvested from another app — hence naming SOND3R, the
 * address, and the digest, none of which appear in anyone else's prompt.
 *
 * The digest, not just the URL, is what makes the record worth keeping: it says
 * which VERSION was accepted, and it means an edited terms page can be shown to
 * be a different document rather than quietly rewriting what everyone agreed to.
 */
export const termsMessage = ({ address, termsHash, termsUrl }) => [
    "SOND3R — Publisher Terms",
    "",
    `I accept the Publisher Terms published at ${termsUrl}.`,
    "",
    "I own or am licensed to distribute everything I publish from this address,",
    "and I accept takedown on notice.",
    "",
    `Publisher: ${address}`,
    `Terms-SHA256: ${termsHash}`,
].join("\n");

/**
 * Verify and record an acceptance of one version of the terms.
 * Throws — like every other verify here — rather than returning a flag.
 */
export async function acceptTerms({ address, termsHash, termsUrl, signature }) {
    const addr = normalizeAddress(address);
    const message = termsMessage({ address: addr, termsHash, termsUrl });
    let recovered;
    try {
        recovered = await recoverMessageAddress({ message, signature });
    } catch {
        throw new Error("malformed signature");
    }
    if (recovered.toLowerCase() !== addr) throw new Error("signature does not match the claimed address");
    recordAttestation({ kind: "terms", address: addr, termsHash, message, signature });
    return { address: addr, termsHash };
}

/**
 * Has this address accepted THIS version of the terms?
 *
 * ponytail: linear scan of the whole log, no index, no cache — it is one line
 * per sign-in and it is read on registration and publish, not per request. Build
 * an in-memory Set at boot if the file ever gets big enough to notice.
 *
 * Deliberately version-exact: editing terms.html changes the digest and every
 * publisher is asked again. That is the point of pinning the hash, and it is why
 * the file should be edited on purpose and not incidentally.
 */
export function hasAcceptedTerms(address, termsHash) {
    const path = attestationLog();
    if (!existsSync(path)) return false;
    const addr = normalizeAddress(address);
    return readFileSync(path, "utf8").split("\n").some((line) => {
        if (!line) return false;
        try {
            const r = JSON.parse(line);
            return r.kind === "terms" && r.address === addr && r.termsHash === termsHash;
        } catch { return false; } // a torn last line must not hide earlier acceptances
    });
}

/** The address behind an `Authorization: Bearer …` header, or null. */
export function addressForRequest(req) {
    const header = req.headers?.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return null;
    const session = sessions.get(match[1]);
    if (!session) return null;
    if (session.expires <= now()) { sessions.delete(match[1]); return null; }
    return session.address;
}

/** Forget a session (sign out). */
export const destroySession = (req) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers?.authorization ?? "");
    return match ? sessions.delete(match[1]) : false;
};

// ── self-check: `node server/auth.js` — no server, no network ─────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // A real file, in a temp dir: the whole point of this half is that it lands
    // on disk, so a stub would test nothing.
    const LOG = join(tmpdir(), `sond3r-attest-${randomBytes(6).toString("hex")}.jsonl`);
    rmSync(LOG, { force: true });
    process.env.ATTESTATION_LOG = LOG;
    const readLog = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });
    const rejects = async (label, fn) => {
        try { await fn(); } catch { return; }
        throw new Error(`${label}: should have been rejected`);
    };

    // Happy path: nonce → sign → session → the header resolves to the signer.
    const { nonce, message } = issueNonce(account.address, "http://localhost:5173");
    if (!message.includes(account.address.toLowerCase())) throw new Error("message must name the signing address");
    if (!message.includes(`Nonce: ${nonce}`)) throw new Error("message must bind the nonce");
    // The rights claim and the terms it points at must be INSIDE the signed
    // bytes. If either drifts out of the message, every attestation collected
    // afterwards is a plain sign-in wearing a compliance label.
    if (!message.includes(ATTESTATION)) throw new Error("message must carry the rights attestation");
    if (!message.includes("/terms.html")) throw new Error("message must link the terms it binds the signer to");
    // EIP-4361 defines `statement` as a single line; a multi-line one stops
    // wallets rendering it as a sign-in prompt at all.
    if (message.split("\n")[3] !== `Sign in to stage and publish your SOND3R library. ${ATTESTATION}`) {
        throw new Error("the statement must be exactly one line");
    }
    const { token, address } = await verifyAndCreateSession(nonce, await account.signMessage({ message }));
    if (address !== account.address.toLowerCase()) throw new Error("session address must be normalized lowercase");
    if (addressForRequest(bearer(token)) !== account.address.toLowerCase()) throw new Error("bearer token did not resolve");

    // A checksummed address must reuse the SAME session identity, or a publisher
    // gets two staging directories depending on how their wallet cased it.
    const mixed = issueNonce(account.address.toLowerCase().replace("0x", "0X"), "http://x");
    if ((await verifyAndCreateSession(mixed.nonce, await account.signMessage({ message: mixed.message }))).address
        !== account.address.toLowerCase()) throw new Error("address casing leaked into the session");

    // Someone else's signature over my nonce must not open my session.
    const imposter = issueNonce(account.address, "http://localhost:5173");
    await rejects("wrong signer", () => verifyAndCreateSession(imposter.nonce, other.signMessage({ message: imposter.message })));

    // Replay: the nonce is consumed on first use, even a failed one.
    const once = issueNonce(account.address, "http://localhost:5173");
    const sig = await account.signMessage({ message: once.message });
    await verifyAndCreateSession(once.nonce, sig);
    await rejects("nonce replay", () => verifyAndCreateSession(once.nonce, sig));

    // Garbage in.
    await rejects("unknown nonce", () => verifyAndCreateSession("deadbeef", sig));
    await rejects("malformed signature", () => verifyAndCreateSession(issueNonce(account.address, "http://x").nonce, "0xnope"));
    if (addressForRequest({ headers: {} }) !== null) throw new Error("missing header must not authenticate");
    if (addressForRequest(bearer("not-a-token")) !== null) throw new Error("bogus token must not authenticate");

    // Sign out really does revoke.
    destroySession(bearer(token));
    if (addressForRequest(bearer(token)) !== null) throw new Error("destroyed session still authenticates");

    // ── the attestation record ────────────────────────────────────────────────
    // Only the sign-ins that SUCCEEDED are on disk: two happy paths and the
    // replay's first use. A rejected signature must never leave a line behind
    // claiming someone agreed to anything.
    const log = readLog();
    if (log.length !== 3) throw new Error(`expected 3 attestations, got ${log.length} — a rejected sign-in was recorded`);

    // The record has to stand on its own. Recovering the signer from the stored
    // bytes, with nothing from this module's memory, is the whole point: that is
    // what someone with the file and no server can check.
    const [first] = log;
    if ((await recoverMessageAddress({ message: first.message, signature: first.signature })).toLowerCase() !== first.address) {
        throw new Error("stored attestation does not verify against its own stored address");
    }
    if (!first.message.includes(ATTESTATION)) throw new Error("stored attestation lost the rights claim");
    if (!Date.parse(first.at)) throw new Error("stored attestation needs a parseable timestamp");

    // A failed write must fail the sign-in, not be swallowed. Pointing the log at
    // an existing DIRECTORY is the cheapest guaranteed EISDIR.
    const blockedPath = join(tmpdir(), `sond3r-attest-dir-${randomBytes(6).toString("hex")}`);
    mkdirSync(blockedPath, { recursive: true });
    process.env.ATTESTATION_LOG = blockedPath;
    const blocked = issueNonce(account.address, "http://localhost:5173");
    // Signature AWAITED: an unresolved promise here would be rejected as a
    // malformed signature and this would pass without ever reaching the write.
    const blockedSig = await account.signMessage({ message: blocked.message });
    await rejects("unwritable attestation log", () => verifyAndCreateSession(blocked.nonce, blockedSig));
    process.env.ATTESTATION_LOG = LOG;
    if (readLog().length !== 3) throw new Error("a refused sign-in still wrote an attestation");

    // ── terms acceptance ──────────────────────────────────────────────────────
    const HASH = "a".repeat(64);
    const URL_ = "http://localhost:5173/terms.html";
    const accept = (acct, hash) => acct.signMessage({ message: termsMessage({ address: acct.address.toLowerCase(), termsHash: hash, termsUrl: URL_ }) });

    if (hasAcceptedTerms(account.address, HASH)) throw new Error("nobody has accepted anything yet");
    await acceptTerms({ address: account.address, termsHash: HASH, termsUrl: URL_, signature: await accept(account, HASH) });
    if (!hasAcceptedTerms(account.address, HASH)) throw new Error("acceptance was not recorded");

    // Version-exact: a new terms digest means the old acceptance does not cover it.
    if (hasAcceptedTerms(account.address, "b".repeat(64))) throw new Error("an acceptance must not carry over to a different terms version");
    // And it is per-address: one publisher accepting must not clear another.
    if (hasAcceptedTerms(other.address, HASH)) throw new Error("acceptance leaked across addresses");

    // A signature over the right text from the wrong wallet must be refused, and
    // must leave nothing behind that hasAcceptedTerms would later believe.
    await rejects("acceptance signed by someone else", () => acceptTerms({
        address: account.address, termsHash: "c".repeat(64), termsUrl: URL_, signature: accept(other, "c".repeat(64)),
    }));
    if (hasAcceptedTerms(account.address, "c".repeat(64))) throw new Error("a refused acceptance was recorded anyway");

    rmSync(LOG, { force: true });
    rmSync(blockedPath, { force: true, recursive: true });
    console.log("auth.js self-check ok — sign-in, casing, wrong signer, replay, bad token, sign-out, attestation recorded + verifiable, terms acceptance version-exact");
}
