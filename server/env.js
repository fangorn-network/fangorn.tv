// A blank line in .env means "unset". Node disagrees — it hands over "" — and
// `??` only catches null/undefined, so every `process.env.X ?? fallback` in this
// codebase silently took the empty string instead of its default.
//
// That is not theoretical. `.env.example` ships half its keys blank on purpose
// (UPLOAD_TOKEN, SHARED_QUOTA_BYTES, BILLING_ADDRESS, READ_ONLY…), so anyone who
// copies it and deletes a value they don't want is producing "" everywhere. It
// crashed the relay at boot once already: `ETH_PRIVATE_KEY=` with nothing after
// it reached the Fangorn SDK as "" and threw "Either privateKey or walletClient
// must be provided", when the whole point of that key being optional is that
// leaving it blank mints a throwaway.
//
// Normalizing here beats fixing the twelve call sites: `??` is the natural thing
// to write, this repo already had one `|| default` carrying a comment explaining
// why it wasn't `??`, and the thirteenth call site would get it wrong again.
//
// MUST BE THE FIRST IMPORT in server/index.js. ES modules evaluate imports before
// the importing module's own body, so a loop written inline in index.js would run
// *after* modules like subtitles.js have already read their env at import time.
for (const [key, value] of Object.entries(process.env)) {
    if (value === "") delete process.env[key];
}

// `node server/env.js` — one check, because the whole file is one behaviour.
if (process.argv[1] === (await import("node:url")).fileURLToPath(import.meta.url)) {
    const { strict: assert } = await import("node:assert");
    process.env.SOND3R_BLANK = "";
    process.env.SOND3R_SPACE = " ";
    process.env.SOND3R_SET = "x";
    for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];

    assert.equal(process.env.SOND3R_BLANK ?? "default", "default", "blank must fall through to the default");
    assert.equal(process.env.SOND3R_SET ?? "default", "x", "a real value is untouched");
    // Whitespace is a value someone typed, not an omission — trimming it here
    // would silently discard a padded secret rather than let it fail loudly.
    assert.equal(process.env.SOND3R_SPACE ?? "default", " ", "whitespace is left alone");
    console.log("env.js self-check ok — blank unset, value kept, whitespace kept");
}
