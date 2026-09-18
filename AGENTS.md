# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# PC Edition

`pc/` is the desktop web wrapper — plain Node.js (no Expo, no TypeScript, no
build step). Server lives in `pc/server`, the no-build web UI in `pc/public`.
Runtime data (chats, API keys, memory) is git-ignored under `pc/data/`. The
`skills/` directory at the repo root is the project's skill dictionary shared
by the PC agent. Design rules for `pc/public/styles.css` are locked in
`pc/DESIGN.md` — extend the token system, don't bypass it.
