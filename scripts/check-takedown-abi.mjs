// Does the deployed SettlementRegistry still expose the takedown lever under the
// name src/ui/App.jsx encodes? `node scripts/check-takedown-abi.mjs`
//
// This is the one thing about the takedown button that can rot silently. Stylus
// renames snake_case -> camelCase, so the contract's `set_disabled` is
// `setDisabled` over the wire; get that wrong (or redeploy a registry that
// renamed it) and the tx doesn't fail in a way anyone notices at review time —
// it reverts in the publisher's wallet, at the moment they are trying to pull a
// file for a legal reason. Everything else in the flow is UI.
//
// A non-owner call reverting with a TYPED error proves the method dispatched.
// MethodNotFound (or empty revert data) is what a wrong name looks like.

import { createPublicClient, http, parseAbi, encodeFunctionData, toFunctionSelector } from "viem";
import { arbitrumSepolia } from "viem/chains";
import assert from "node:assert/strict";

const REG = process.env.SETTLEMENT_REGISTRY_ADDR ?? process.env.VITE_SETTLEMENT_REGISTRY_ADDR;
assert.match(REG ?? "", /^0x[0-9a-fA-F]{40}$/, "set SETTLEMENT_REGISTRY_ADDR (try: env $(grep -v '^#' .env | xargs) node scripts/check-takedown-abi.mjs)");

// Must stay identical to TAKEDOWN_ABI in src/ui/App.jsx.
const ABI = parseAbi([
    "function setDisabled(bytes32 resource_id, bool disabled)",
    "function isDisabled(bytes32 resource_id) view returns (bool)",
]);

const RPC = process.env.CHAIN_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const client = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC) });
const NOBODY = "0x000000000000000000000000000000000000dEaD";
const MISSING = `0x${"11".repeat(32)}`;
const METHOD_NOT_FOUND = toFunctionSelector("function MethodNotFound()");

assert.notEqual(await client.getCode({ address: REG }), undefined, `nothing deployed at ${REG} on ${RPC}`);

// The read half: the flag the access gate itself checks.
assert.equal(await client.readContract({ address: REG, abi: ABI, functionName: "isDisabled", args: [MISSING] }), false);

// The write half, simulated from an address that owns nothing.
const err = await client.call({
    to: REG,
    account: NOBODY,
    data: encodeFunctionData({ abi: ABI, functionName: "setDisabled", args: [MISSING, true] }),
}).then(() => null, (e) => e);

assert.ok(err, "setDisabled on a nonexistent resource should revert");
const data = err.walk?.((x) => typeof x?.data === "string")?.data;
assert.ok(data && data !== "0x", `setDisabled reverted with no error data — the registry probably doesn't have that method`);
assert.notEqual(data.slice(0, 10), METHOD_NOT_FOUND, "registry answered MethodNotFound: setDisabled(bytes32,bool) is not its name any more");

console.log(`ok — ${REG} dispatches setDisabled/isDisabled (revert ${data.slice(0, 10)}, as expected for a nonexistent resource)`);
