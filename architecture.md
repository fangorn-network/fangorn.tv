# Architecture

How the pieces fit together: **contracts**, **fangorn**, **x402f**, the **access
worker**, **quickbeam**, **sond3r**, and the **sond3r-buy** agent plugin.

This document is about the seams — what each piece owns, what crosses between
them, and which agreements break silently when one side changes. Each repo's own
README covers its internals.

---

## 1. The system in one paragraph

A **publisher** owns files and a knowledge graph describing them. The graph is
content-addressed and lives off-chain; the chain holds one `bytes32` pointer per
publisher. Files are encrypted client-side under a random key, and that key is
sealed to a **key-release oracle** that hands it out only to someone the chain
says has paid. A **buyer** pays in USDC, and proves they paid using a  zero-knowledge
membership proof, so the address that reads the file is never linked on-chain to
the wallet that paid for it. Nobody in the middle — not the relay, not the
facilitator, not the worker — ever holds plaintext, and none of them can spend or
sign on anyone's behalf.

Three properties drive nearly every design decision:

| Property | What it means | What enforces it |
|---|---|---|
| **No custody** | No service holds a user's key or their money | Every on-chain action is signed by the user's own wallet; relays hold service keys for reads only |
| **No plaintext** | No service can read what it stores or serves | Envelope encryption; the worker only ever sees a sealed 32-byte DEK |
| **No linkage** | Paying for something doesn't reveal who reads it, and two purchases by the same reader don't reveal each other | Semaphore group membership + a stealth address derived per (identity, resource) |

---

## 2. The map

```
                                    ARBITRUM SEPOLIA
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  DataRegistry          SubscriptionRegistry        SettlementRegistry    │
   │  addr → bytes32        addr → subscribed_at        resource → {owner,    │
   │  (one graph head       (paid storage,               price, group, uri,   │
   │   per publisher)        gates uploads)              disabled}            │
   │        ▲                      ▲                       │      ▲     ▲     │
   └────────┼──────────────────────┼───────────────────────┼──────┼─────┼─────┘
            │ commitStateRoot      │ subscribe          createResource │  │
            │ (browser wallet)     │                    (publisher)    │  │
            │                      │                                   │  │
            │                      │              register + settle ───┘  │
            │                      │              (facilitator relays,     │
            │                      │               pays the gas)           │
            │                      │                    ▲                  │
   ┌────────┴──────────────────────┴────────────────────┼──────────────────┼───┐
   │  PUBLISHER SIDE                                    │   BUYER SIDE     │   │
   │                                                    │                  │   │
   │  sond3r relay ──── fangorn SDK ──── IPFS/Pinata    │            isSettled  │
   │  (server/)         (graph, commits,  (the graph)   │            isDisabled │
   │      │              sealing)                       │                  │   │
   │      │                                     x402f facilitator          │   │
   │      │ encrypt + upload                    (/verify → register)       │   │
   │      ▼                                     (/settle  → settle)        │   │
   │  ACCESS WORKER  ◄──────────────────────────────────────────────────── │   │
   │  (Cloudflare + R2)     POST /access: signed by the stealth key ────────┘   │
   │   ciphertext + sealed DEK                                                  │
   │   GET /ct/:id  ungated (it's ciphertext)          ▲                        │
   │   POST /access gated ──────► releases the DEK ────┘                        │
   └────────────────────────────────────────────────────────────────────────────┘
            │                                          ▲            ▲
            │ published graph                          │            │
            ▼                                          │            │
   quickbeam (embeddings)                     sond3r SPA      sond3r-buy
   watch → embed → bake shards                (browser)       (agent CLI)
            │                                    │                 │
            └──── Semantic CDN shards ───────────┴─────────────────┘
                  (search runs on the client; the query never leaves it)
```

---

## 3. The pieces

| Repo | What it is | Owns |
|---|---|---|
| `contracts/` | Three Stylus (Rust→WASM) contracts | Publisher identity, the graph pointer, resource pricing + settlement |
| `fangorn/` | TypeScript SDK + CLI | The graph model, commits, IPLD/CAR packing, sealing primitives |
| `webworker/fangorn-access-worker/` | Cloudflare Worker + R2 | Ciphertext storage and the key-release gate |
| `webworker/pinata-url-provider/` | Cloudflare Worker | Short-lived presigned upload URLs (so no Pinata JWT is shipped to clients) |
| `x402f/packages/facilitator/` | Express service | Gas-paying relayer for `register` + `settle` |
| `x402f/packages/fetch/` | Library (`@fangorn-network/fetch`) | The buyer's whole path as one call |
| `embeddings/` (quickbeam) | Python | Embedding the published graph; the Semantic CDN; the MCP server |
| `sond3r/` | Node relay + React SPA | A storefront: publisher portal, catalog, player, purchase flow |
| `sond3r-buy/` | Claude Code plugin | An agent that browses and buys unattended |

---

## 4. Two planes that meet at one identifier

The system is really **two independent planes**. Understanding which plane a
question belongs to answers most "where does this live?" questions.

**The data plane** answers *what exists and who published it.*
Publisher registers → builds a graph → commits it → the chain holds the head.
`DataRegistry.commit_state_root(old, new)` is a compare-and-swap, which is what
makes the timeline linear — it is a git ref update with a lock. The graph itself
(vertices, edges, CAR packfiles) never touches the chain.

**The payment plane** answers *who is allowed to read this.*
Publisher creates a priced resource → buyer pays → buyer proves payment
anonymously → the access gate releases a key. `SettlementRegistry` never knows
what the bytes are, and `DataRegistry` never knows anyone paid.

They meet at exactly one value: the **`resourceId`**. A graph vertex describing a
file carries the `resourceId` its bytes are settled under. That is the entire
coupling — which is why either plane can be swapped without touching the other.

```
   data plane                                payment plane
   ──────────                                ─────────────
   vertex { name, mime, size,                resource { owner, price,
            chunks, workerUrl,                          groupId, uri,
            resourceId ──────────────────────────────►  disabled }
            plaintextHash }
```

---

## 5. The contracts

Three contracts, no proxies, no factories, no shared storage. Where two need to
talk they do it with a plain call to a stored address.

### DataRegistry
`address → bytes32`, one head per publisher, plus registration status. The only
mutating route is `commit_state_root(old_root, new_root)`, which rejects unless
the caller is active and `old_root` matches the stored head. It emits
`StateCommitted`, the single event the SDK's light client follows — no indexer,
because a commit is a self-contained diff and the chain holds the tip.

The contract is deliberately structure-agnostic: it moves a `bytes32` and the SDK
decides what that value means.

### SubscriptionRegistry
Paid storage subscription, kept separate so the data registry never has an
opinion about billing. It cross-calls `DataRegistry.isRegistered`, so an upload
gate gets "is this a real publisher, and have they paid?" from one `eth_call`.

### SettlementRegistry
The payment plane in one contract. Per resource it stores `owner`, `price`,
`uri`, a `disabled` flag, and **its own Semaphore group**.

```
create_resource(uid, price, uri) → resourceId          // publisher
    resourceId = keccak(msg.sender ++ uid)             // derived, not chosen
    creates a Semaphore group for this resource

register(resourceId, commitment, from, amount, …sig)   // relayed by facilitator
    pays resource_owners[resourceId] via ERC-3009
    adds `commitment` to THIS resource's group

settle(resourceId, stealthAddress, proof…)             // relayed by facilitator
    verifies a Semaphore membership proof over that group, scope = resourceId
    records settlements[stealthAddress ++ resourceId] = true
    burns the nullifier, so one membership settles once

set_disabled(resourceId, bool)                         // owner OR registry admin
```

Three properties of this contract are load-bearing, and each closes a specific
hole that existed in v1:

1. **One group per resource.** Membership in resource R's group *is* "somebody
   paid for R", so verifying against R's own group is a payment check that stays
   anonymous. Under a single global group, one $0.10 purchase entitled the buyer
   to every resource from every publisher, forever.
2. **The registry derives the `resourceId`.** A caller-supplied id could be
   front-run: watch the mempool, claim the id, set your own price, collect the
   payments while the real publisher's transaction reverts forever.
3. **`register` has no `to` parameter.** The recipient is read from storage. A
   caller-supplied recipient let a buyer sign an authorization paying *themselves*
   the correct amount and still join the group.

**What it deliberately does not do:** disabling stops new registrations and new
settlements, but it does not un-settle anyone — `is_settled` stays true, because
the payment is a historical fact. Enforcing a takedown against buyers who already
paid is the access gate's job (§7), and it is the only place that can do it.

---

## 6. Fangorn (the SDK)

The data plane's whole implementation.

- **The graph.** Vertices (a JSON payload tagged by a schema id) and edges
  (labeled relations, as native IPLD links), committed under a **namespace**. A
  publisher has one on-chain root; namespaces are keys in the root map it points at.
- **Commits.** Versioned like git down to the storage model: each commit points
  at its parent and at one **CAR file** holding only the blocks it introduced.
  `commit` persists any graph as exactly two uploads; `push` moves the on-chain
  pointer and is the single permissioned step. Unchanged data re-derives identical
  CIDs and is never re-uploaded.
- **Sealing ("gadgets").** A field that shouldn't be public is sealed under a
  named pairing of a scheme and the condition that opens it. Two exist:
  `self-hkdf-v1` (only the publisher can re-derive the key) and **`worker-usdc-v1`**
  (settlement-gated — the access worker releases it once the reader has paid).
  `worker-usdc-v1` is the join between the SDK and the payment plane.
- **The light client.** Follows `StateCommitted` and resolves commits from IPFS.
  Reconstructing the full history needs nothing but the on-chain tip.

The SDK holds the crypto primitives (`seal`, `unseal`, `sha256Hex`) that the
publisher side of every other repo reuses rather than reimplements.

---

## 7. The access worker

A **key-release oracle, not a decryptor.** It is the only component whose job is
to say no.

```
GET  /pubkey            the X25519 pubkey publishers seal DEKs to
GET  /ct/:id            stream the ciphertext — UNGATED, on purpose
POST /access            the gate: unseal the DEK and return 32 bytes
GET  /upload/:id        read an object back (the publisher's own manifest)
POST /upload/:id        store ciphertext + sealed DEK
DELETE /upload/:id      drop an object and its sealed DEK
```

The three `/upload/` routes are gated on an **owner-bearing token**, described
below. `/access` and `/ct/` are gated on the chain and on nothing, respectively.

**Why `/ct/` is open:** ciphertext is safe to hand to anyone, and leaving it
ungated is what lets a video stream with ordinary HTTP Range requests. Only *keys*
are gated. The guard that makes this safe is that every legitimate object key is a
bytes32 — without it, `GET /ct/.worker-x25519-secret` would serve the private key
that opens every DEK in the bucket.

**The gate, in order:**

1. **Timestamp** within `TIMESTAMP_WINDOW`, and the signature recovers an address.
   Both are checked before the worker talks to any chain.
2. **The resource exists** (`getOwner != 0`). An unregistered id reads back a
   price of zero, so checking price first would treat every id the registry has
   never heard of as free.
3. **It is not disabled** (`isDisabled`). This check exists here because it can
   exist nowhere else — the registry keeps `isSettled` true after a takedown, so a
   disabled resource is refused by this worker or by no one, *including* buyers who
   already paid.
4. **It is settled** (`isSettled(stealthAddress, resourceId)`), unless the price
   is zero, which releases to any valid signer.

The address it checks is recovered from the request signature, so the buyer proves
control of the stealth key without sending it. The worker never sees the buyer's
real wallet.

### One bucket, many publishers

One worker and one R2 bucket serve **every publisher on a relay**, on the relay
operator's Cloudflare account. So the write gate cannot be "do you hold this
bucket's token" — it has to know *which* publisher is writing. The token therefore
names its bearer:

```
Authorization: Bearer <owner>.<keccak256(UPLOAD_HMAC_SECRET ++ owner)>
```

The relay derives it from its own service key (`uploadTokenFor` in
`server/index.js`); the worker recomputes the MAC from the same secret
(`macFor`) and reads the owner address straight out of the token. No bucket
state, no round trip, nothing to claim — a publisher who has never touched the
worker can upload immediately, and the same wallet derives the same token on a
machine that has never seen it. Without `UPLOAD_HMAC_SECRET` the worker
authorizes **nobody**, rather than falling open on a bucket someone pays for.

Object keys are already namespaced per publisher (`resourceIdFor(owner, uid)`,
`manifestKey(owner)`), so accidental collisions are impossible. Deliberate ones
are not: uids are public, so any publisher can compute another's `resourceId`.
The worker therefore stamps the owner on every object as R2 custom metadata and
re-checks it on every write, delete and read-back — first writer keeps the key,
and an existing object with no owner recorded is refused rather than adopted.

**Bring your own storage** — a publisher provisioning a bucket into their own
Cloudflare account — is gone for now and will come back as an option. It is in git
(`server/cloudflare.js`, the worker's `/claim` route and its `.upload-token`
bucket state).

**The X25519 identity** is still self-minting: unset, the worker generates one
into its own bucket on first use. Pin `WORKER_X25519_SECRET` on any real
deployment — a minted key lives in the bucket it protects, and losing it strands
every resource sealed to it.

---

## 8. x402f — the payment rails

x402f speaks the [x402](https://docs.cdp.coinbase.com/x402) wire protocol
(`/verify`, `/settle`, `paymentPayload` + `paymentRequirements`), with the
Fangorn-specific fields riding in `paymentRequirements.extra`.

### The facilitator
A **gas-paying relayer, and nothing more.** All payment logic lives in the
contract; the facilitator submits two transactions:

| Route | Relays | Effect |
|---|---|---|
| `POST /verify` | `register(...)` | Buyer's ERC-3009 authorization runs, owner is paid, commitment joins the resource's group |
| `POST /settle` | `settle(...)` | Membership proof verified on-chain, settlement recorded against the stealth address |

It charges no fee and *cannot*: the registry enforces `amount == price` and pays
the owner from storage. It serializes its own writes behind a mutex (one EOA, one
nonce sequence) and checks receipt `status` on both calls — viem resolves a
*reverted* transaction rather than throwing, so an unchecked receipt reports a
failed register as a success and the buyer only finds out when the gate says they
never paid.

Because it holds nothing but gas money, the worst a hostile facilitator can do is
refuse to relay. It cannot redirect a payment (recipient comes from storage),
overcharge (amount is checked), or forge a settlement (it cannot produce a proof).

### `@fangorn-network/fetch`
The buyer's whole path as one call, for anyone who isn't the sond3r SPA:

```ts
const mw = await FangornX402Middleware.create({ walletClient, chain, rpcUrl,
                                                registryAddress, usdcAddress,
                                                facilitatorUrl });
const { data } = await mw.fetchResource({ publisher, uid });
```

It reads the resource, refuses if disabled, pays only if this identity hasn't
already settled, proves membership, fetches the DEK, decrypts, and verifies the
plaintext against the hash committed on-chain. A resource already settled in an
earlier session is never paid for twice: the settlement is permanent and the
nullifier is recomputable from the identity, so a wiped cache costs one RPC read.

---

## 9. quickbeam — discovery

Everything above is retrieval by *identifier*. quickbeam is retrieval by
*meaning*, and it is strictly optional: buying never needs it.

- **`watch`** subscribes to publishers/namespaces and embeds commits as they
  land — push-based off the same `StateCommitted` light client, no indexer, no
  polling. Each commit is a self-contained diff, so it embeds only what changed
  and tombstones what the commit removed.
- **`build`** walks the typed graph (one publisher's bundle, or a **view** fusing
  several publishers by global identity), projects it through root profiles, and
  embeds it into Qdrant.
- **`cdn` / `pull`** is the interesting part. Serving search from a server means
  the server sees every query vector — and a semantic query *is* intent. The
  **Semantic CDN** inverts it: the operator bakes the embedded graph into
  immutable, content-addressed shard files and serves them as static downloads.
  The client pulls the shards and searches locally. Knowledge moves to the user;
  the network never sees a query.
- **`mcp`** is a local pull-client of that CDN, exposing semantic search and
  typed-edge traversal to agents with on-chain provenance on every result.

sond3r consumes the CDN directly: `src/catalog/search.js` streams a view's shards into the
browser and ranks them there, so the storefront's search has the same property —
the query never leaves the tab. It is why sond3r's search works across publishers
while its `/api/catalog` is per-storefront.

---

## 10. sond3r — the storefront

A publisher portal, a catalog, a player, and a purchase flow, over everything above.

**The relay holds no wallet key.** Its `ETH_PRIVATE_KEY` is a service key used
only to construct a Fangorn engine for chain *reads*. Every on-chain action is
signed by the browser wallet: the publisher signs `createResource` and
`commitStateRoot`; the buyer signs an ERC-3009 authorization. The relay's job is
the expensive, unprivileged half — transcode, encrypt, chunk, upload, build the
graph, and hand the browser unsigned transactions.

**Tenancy** is per wallet. A publisher signs a SIWE message to open a session and
the relay resolves `media/<their address>/` from that session, never from a
request parameter. One publisher cannot list, rename, or delete another's
unreleased work.

### A publish, end to end

```
1. Publisher drops files into media/<0xaddr>/ through the portal
2. /api/publish/prepare, per new file:
     transcribe (optional) → AES-256-GCM in 64MiB chunks under one DEK
     seal the DEK to the worker's X25519 key → upload every chunk
     build the unsigned createResource(uid, price, uri) tx
3. Browser wallet signs the createResource txs
4. Relay builds the folder/file graph (vertex per folder + file, parent→child
   edges) and commits it via the SDK
5. Browser wallet signs commitStateRoot(old, new)
```

The `uri` packs `${workerUrl}#${plaintextHash}` — where to fetch from and what
the bytes must hash to. That single string is what lets a buyer verify they got
the right file without trusting the catalog that pointed them at it.

### A purchase, end to end

```
1. Derive the buyer identity: one signature over "fangorn:identity:v1"
     → Semaphore identity (wallet-wide)
   Derive the stealth key for THIS resource: keccak(…secretScalar, resourceId)
     → stealth address (one per resource, never reused across resources)
2. Read isSettled + isDisabled
3. If not settled and not already a member of THIS resource's group:
     read price AND owner from the contract (never from the catalog)
     sign an ERC-3009 authorization → POST /verify → register
4. Rebuild the resource's group from its MemberRegistered logs
     generate a Semaphore proof (scope = resourceId) → POST /settle
5. Confirm isSettled on-chain (not just the facilitator's word)
6. POST /access signed with the stealth key → DEK
7. Stream chunks through the service worker, decrypting on demand
```

Step 3's "read price and owner from the contract" matters: the catalog is a
convenience index, and with cross-publisher aggregation it may be one this client
didn't build. A poisoned index can then neither overcharge the buyer nor redirect
the payment.

### sond3r-buy

The same flow with the two browser-only pieces swapped out: a local viem account
instead of a wallet extension, and a file on disk instead of the service worker.
It vendors sond3r's `buy.js` **verbatim** so the seller cannot tell an agent from
a person. A storefront URL is the only thing it needs — registry, USDC,
facilitator and RPC all come from the public `GET /api/config`.

Its distinguishing constraint is that nobody is watching it spend, so
`AGENT_MAX_SPEND` bounds the **whole run**, not each file. With a payment per
file, a per-file ceiling would bound nothing.

---

## 11. Cross-repo agreements

These are the seams. Each is a value computed independently in two or more repos,
where a change on one side is **silent** on the other — no type error, no failed
build, just a wrong answer at runtime.

| Agreement | Definition | Computed in |
|---|---|---|
| `resourceId` | `keccak(publisher ++ uid)` | `settlement_registry` (`resource_id_of`), sond3r (`resourceIdFor`), `@fangorn-network/fetch` (`resourceIdOf`) |
| Identity seed | `keccak(sign("fangorn:identity:v1"))` | every buyer client |
| Stealth key | `keccak(encodePacked("fangorn:stealth:", secretScalar, resourceId))` | every buyer client |
| Nullifier | `poseidon2([hash(resourceId), secretScalar])` | Semaphore; recomputed by clients for the already-settled path |
| Access message | `keccak(abi.encodePacked(uint256 nullifier, bytes32 resourceId, uint64 timestamp))` | worker (`buildMessageHash`) and every buyer |
| Chunk key | chunk 0 = `resourceId`; `i>0` = `keccak(encodePacked(resourceId, uint32 i))` | sond3r `server/settle.js` and `src/pay/buy.js` |
| Seal info | `resourceId ++ ":sealed"` (HKDF info) | fangorn SDK and the worker |
| Upload token | `<owner> ++ "." ++ keccak(encodePacked(bytes32 secret, address owner))` | worker (`macFor`) and sond3r relay (`uploadTokenWith`) |
| Registry ABI | function signatures **and** event field order | facilitator, fetch pkg, worker, sond3r, sond3r-buy |

Three of these are pinned by tests that fail loudly on drift, which is the pattern
worth extending to the rest:

- sond3r's `index.js --selfcheck` asserts `resourceIdFor` against a vector read
  from the deployed registry's own `resourceIdFor` view.
- The upload-token vector is asserted in both the worker's test suite and
  sond3r's self-check, so drift reddens one of them.
- x402f's node example asserts that the recomputed nullifier equals the one the
  real proof produced.

Two footguns worth naming:

- **Stylus exports `Vec<u8>` as `uint8[]`, not `bytes`.** Declaring `settle`'s
  `hookData` as `bytes` changes the selector, so the call hits no function and the
  router reverts with *empty* data — which reads like a failed proof rather than a
  wrong signature.
- **Adding a field to an event breaks every decoder that omits it.** `ResourceCreated`
  gained `groupId` before `uri`; a stale ABI mis-reads every field after it rather
  than failing.

---

## 12. Trust model

| Actor | Can | Cannot |
|---|---|---|
| sond3r relay | See plaintext *before* the publisher encrypts it (it does the encrypting); serve a wrong catalog | Sign anything; spend; decrypt anything already published |
| Facilitator | Refuse to relay; see resourceIds and commitments | Redirect payment, overcharge, forge a settlement, learn which wallet reads what |
| Access worker | Refuse to release a DEK; see which stealth address asks for what | Decrypt the bulk data; link a stealth address to a wallet |
| Publisher | Set the price; take a resource down | Un-take-a-payment; recover a buyer's identity |
| Registry admin | Take any resource down | Move funds; alter settlements |
| A poisoned catalog | Show wrong prices, names, owners | Cause an overcharge or a misdirected payment (both read from the contract) |

**The anonymity set** is the buyers of one resource — narrower than v1's "every
buyer ever". That is the real cost of correctness here, and it is the right trade:
an entitlement nobody paid for is not privacy, it is a broken paywall. A resource
with exactly one buyer offers that buyer no anonymity at all; this is inherent to
per-resource groups, and worth saying out loud rather than implying otherwise.

**What is public:** every resourceId, price, owner, group membership event, and
settlement. What is *not* public is the mapping from a paying wallet to the
stealth address that reads the file.

Nor is the mapping between two purchases by the same reader. The stealth key
mixes in the resourceId, so a buyer holds a different address per resource.
Before that, one buyer had one address forever — and since `settle`'s calldata
is public, anyone could enumerate the chain and reconstruct that buyer's entire
purchase history under a stable pseudonym. Payer↔reader was unlinkable;
reader↔reader was not. Co-purchase graphs are the most re-identifying dataset
there is, so that leak made the "no linkage" property much narrower than it
sounded. Per-resource addresses close it: the anonymity set is the buyers of one
resource, and it does not leak sideways.

Settlements made under the old derivation stay linked; the calldata is on-chain
and permanent.

---

## 13. Deployment topology

| Component | Where it runs | Key material |
|---|---|---|
| Contracts | Arbitrum Sepolia | — |
| Access worker | Cloudflare Workers + R2, one per relay (the operator's account) | `WORKER_X25519_SECRET` (pin it); `UPLOAD_HMAC_SECRET`, shared with the relay |
| Facilitator | Any host (Docker, Cloud Run) | A relayer EOA funded with ETH for gas |
| quickbeam | Operator's box (GPU for embedding) + static CDN | — |
| sond3r relay | Operator's box or Cloud Run (`READ_ONLY=1` for a hosted viewer) | Service key, reads only |
| sond3r SPA | Static bundle | The user's own wallet |
| sond3r-buy | The agent's machine | `~/.sond3r/env`, mode 600 |

`SETTLEMENT_REGISTRY_ADDR` must agree across the facilitator, the worker, the
relay, and the SPA bundle. When the facilitator points at a different deployment
than the storefront advertises, the symptom is a `ResourceNotFound` revert during
settle — which is why sond3r-buy decodes that selector into exactly that
sentence. Note that the SPA's copy is a **build-time** `VITE_*` inline: changing
it is a rebuild, not a restart.

---

## 14. Known gaps

- **Two envelope formats exist.** sond3r chunks and binds the chunk index into
  the GCM AAD; `@fangorn-network/fetch` writes a single unchunked blob with no
  AAD. Both are "nonce(12) || AES-256-GCM" and both are correct on their own, but
  ciphertext written by one cannot be read by the other. Anything reading across
  the two needs to know which wrote it.
- ~~**Takedown is not wired to sond3r's UI.**~~ Wired: the publisher's inspector
  signs `setDisabled` straight to the registry (`Takedown` in `src/ui/App.jsx`),
  separately from `/api/delete`, which still only removes the staged copy.
  `scripts/check-takedown-abi.mjs` asserts the deployed registry still dispatches
  that name. Still missing on this axis: nothing lets a *third party* report a
  resource, and only the owner or the registry admin can pull one.
- **The SubscriptionRegistry is not wired to the settlement path.** It gates
  uploads; it has no opinion about reads.
- **Group rebuilds scan from block 0.** Filtered to one resource now, but the
  block range is still all of history, which metered RPC providers refuse
  (hence the public-endpoint fallback). The registry's deploy block is the
  obvious fix.
- **Revenue is counted as `registrations × current price`.** The log doesn't
  carry the amount, so re-pricing rewrites reported history.
