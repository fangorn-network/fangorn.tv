---
description: Park on the SOND3R tab and steer the channel off what the viewer skips. Optional argument = the channel to build, e.g. /tv-watch firetrucks on screen.
---

Watch along with the viewer and keep the channel honest. Use the `sond3r-tv`
skill for the tool details.

$ARGUMENTS

Do this, and do not ask the user anything — everything you need to say goes on
the page:

1. `list_pages`, then `list_webmcp_tools` on the SOND3R tab. If Chrome will not
   start, follow the skill's Troubleshooting section and stop with one line
   saying what the user must run.
2. If an argument was given, `tune-channel` with `scenes: true` and that as the
   prompt. Otherwise `list-channels` and stay on whatever is already on.
3. `propose` once, telling them you are watching and to skip anything that does
   not belong. Their answer is the start signal. If it comes back `null`, they
   declined — stop.
4. Park in `await-viewer-signal` with `seconds: 120`.
5. When it returns:
   - `null` — still watching. Park again. Say nothing.
   - `dislike` — a real verdict. `read-taste`, then `tune-channel` with the
     same prompt, `scenes: true`, and the returned id in `unlike[]`. Keep every
     id collected so far in `unlike[]`, not just the newest, so the channel
     accumulates the correction instead of forgetting it.
   - `skip` — check `seconds` and `to` first. A short skip is a rejection; a
     skip after most of the slot, or one whose `to.channel` differs, is someone
     moving on. Never add an id to `unlike[]` if it already has a `like` or
     `finished` this session — that overrides. When in doubt, record and park.
   - `like` or `finished` — add the id to `like[]` on the next retune.
   - `channel` or `tuned` — they took the wheel. Adopt their channel as the new
     baseline and keep parking.
6. Pass `after: <the seq you just saw>` on the next park so nothing is missed
   between calls.
7. Go back to step 4.

Retune quietly. Do not `propose` before each one — they already consented in
step 3, and a card per skip is worse than the mistuned channel. Re-`propose`
only to change something they did not ask for, like abandoning the theme
entirely.

Keep your terminal output to one line per retune: what was skipped, and what the
ring became. The user is watching television, not a log.
