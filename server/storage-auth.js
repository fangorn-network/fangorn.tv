// Pinning to IPFS, authorized by the PUBLISHER instead of by this relay.
//
// The storage gate (pinata-url-provider) meters uploaded bytes per wallet and,
// past a free tier, requires that wallet's own fangorn.network subscription. So
// signing its challenge with one shared relay key would bill every publisher's
// library to whoever runs the relay — the same subsidy we refuse to float for R2.
//
// The publisher's key lives in their browser. Their wallet signs the gate's
// challenge there and we replay that one { message, signature } pair here. One
// pair covers every upload a commit makes (the CAR + the commit block) because
// the gate keeps no nonce: it re-derives the canonical message, checks Issued-At
// is fresh (~5 min), and recovers the signer.
import { SignedUrlBackend } from "@fangorn-network/sdk";
import { recoverMessageAddress } from "viem";

/** The gate the SDK pins through. One constant, shared with the browser via
 *  /api/config so both halves talk to the same one. */
export const SIGNED_URL_WORKER = "https://sepolia.storage-worker.fangorn.network";

/**
 * A SignedUrlBackend that replays a pre-signed challenge.
 *
 * The override is the whole point: the stock backend fetches a FRESH challenge
 * before every upload and signs it, which is impossible here — we hold a
 * signature, not a key, and a fresh challenge carries a different Issued-At.
 * Skipping straight to the grant leg is fine; the gate validates the message
 * it is given and never checks that it issued it.
 */
export class DelegatedStorage extends SignedUrlBackend {
    constructor(address, auth, gateway, workerUrl = SIGNED_URL_WORKER) {
        super(workerUrl, { address, signMessage: async () => auth.signature }, gateway);
        this.auth = auth;
    }

    async requestUploadUrl(size, uploadId) {
        const grant = await this.workerJson({ address: this.signer.address, ...this.auth, size, uploadId });
        if (!grant?.ok || !grant.uploadUrl) {
            throw new Error(`Storage gate denied an upload URL: ${grant?.error ?? "unknown error"}${grant?.detail ? ` (${grant.detail})` : ""}`);
        }
        return { uploadUrl: grant.uploadUrl, network: grant.network ?? "public" };
    }
}

/**
 * Why `auth` may not be used to pin as `owner`, or null if it may.
 *
 * The gate would reject a FORGED pair on its own. This exists for a REPLAYED
 * one: a captured signature is a bearer token for someone else's storage quota,
 * and the gate has no idea which relay session presented it.
 */
export async function storageAuthError(owner, auth) {
    if (!auth?.message || !auth?.signature) return "missing storage authorization — sign in again and re-run publish";
    const signer = await recoverMessageAddress({ message: auth.message, signature: auth.signature }).catch(() => null);
    if (signer?.toLowerCase() !== owner.toLowerCase()) return "storage authorization was not signed by the publishing wallet";
    return null;
}

// `node server/storage-auth.js`
if (process.argv[1] === (await import("node:url")).fileURLToPath(import.meta.url)) {
    const { strict: assert } = await import("node:assert");
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");

    const alice = privateKeyToAccount(generatePrivateKey());
    const mallory = privateKeyToAccount(generatePrivateKey());
    const message = "Fangorn onchain-gate access request\n\nAddress: x\nIssued-At: 1";
    const auth = { message, signature: await alice.signMessage({ message }) };

    assert.equal(await storageAuthError(alice.address, auth), null, "the signer may pin as itself");
    assert.equal(await storageAuthError(alice.address.toLowerCase(), auth), null, "address casing is not identity");
    assert.match(await storageAuthError(mallory.address, auth) ?? "", /publishing wallet/, "a replayed pair cannot pin as someone else");
    assert.match(await storageAuthError(alice.address, {}) ?? "", /missing/, "no pair, no pin");
    assert.match(await storageAuthError(alice.address, { message, signature: "0xdead" }) ?? "", /publishing wallet/, "garbage signature is a refusal, not a crash");

    // The override must send the pair it was handed, NOT go fetch a challenge:
    // a second round trip would produce a message our signature doesn't cover.
    let posts = 0, sent;
    globalThis.fetch = async (_url, init) => {
        posts++;
        sent = JSON.parse(init.body);
        return { json: async () => ({ ok: true, uploadUrl: "https://pinata/u", network: "public" }) };
    };
    const store = new DelegatedStorage(alice.address, auth, "https://gw", "https://gate");
    const grant = await store.requestUploadUrl(42, "up-1");
    assert.equal(posts, 1, "one round trip — the challenge leg is skipped");
    assert.deepEqual(sent, { address: alice.address, message, signature: auth.signature, size: 42, uploadId: "up-1" });
    assert.deepEqual(grant, { uploadUrl: "https://pinata/u", network: "public" });

    globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: "Not registered", detail: "sub expired" }) });
    // The gate's own words reach the publisher: "denied" alone sends them hunting
    // through relay logs for a quota problem only they can fix.
    await assert.rejects(() => store.requestUploadUrl(1, "up-2"), /Not registered \(sub expired\)/);

    console.log("storage-auth.js self-check ok — replay refused, pair sent verbatim, gate errors surfaced");
}
