# SOND3R relay. One stage, prod deps only — small enough for a Raspberry Pi.
#
# The frontend is NOT built here. Run `pnpm build` on a dev machine and dist/
# ships in. Bundling React + Privy + transformers.js needs ~2GB of RAM, which
# OOM-kills the build on a small host, and dist/ is arch-independent so shipping
# it costs nothing and removes the heaviest step. (Same reasoning as
# ../fangorn-md, which is where this layout comes from.)
#
# There is no ffmpeg and no whisper. There used to be an `asr` target twice this
# size for the publisher's relay; publishing runs in the publisher's browser now
# and this process never sees a media file, so there is nothing here to
# transcribe. Hand-written .vtt sidecars still reach the graph.
#
# `pnpm install --prod` installs exactly three packages — viem, the Fangorn SDK
# and @noble/hashes — because everything browser-only (react, privy,
# transformers.js, semaphore) lives in devDependencies precisely so it stays out
# of here. Check before adding a runtime import: server/ and scripts/ import no
# other external package.
FROM node:22-alpine
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY server ./server
# src/ ships because server/ imports from it: envelope.js (the chunk format and
# resourceId derivation, shared with the browser so the two cannot drift) and
# embed.js (model constants only — the transformers.js runtime behind them is a
# dynamic import that never fires here).
COPY src ./src
# public/ holds terms.html — the terms gate hashes the served bytes, and refuses
# to gate on a document nobody can read — plus the baked search shard.
COPY public ./public
COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# No VOLUME. The relay stages nothing: publishers encrypt in the browser and
# upload to their own Cloudflare worker, and their manifest lives in their own
# bucket. Nothing in this container needs to survive a restart.
CMD ["node", "server/index.js"]
