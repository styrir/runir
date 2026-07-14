#!/bin/zsh
# OM adapter regression harnesses (OM-4/5/6, Rúnir-tfxt.4/.5/.6).
# Stub-server based — no Pi runtime and no Runir service required.
# The live smokes (om*-live-smoke.mjs) are NOT run here: they hit the real
# service on :7700 as tenant brooks — run them individually when wanted.
set -e
cd "$(dirname "$0")"
# pi-tui must be bundled IN (the harness fakes run outside Pi, so externals
# would fail to resolve at import time). PATH-based discovery is unreliable
# here (volta shims shadow the homebrew pi in non-login shells), so probe the
# known install locations and verify existence.
PI_TUI=""
for candidate in \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  "$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"; do
  if [ -d "$candidate/node_modules/@earendil-works/pi-tui" ]; then
    PI_TUI="$candidate/node_modules/@earendil-works/pi-tui"
    break
  fi
done
if [ -z "$PI_TUI" ]; then
  echo "cannot locate @earendil-works/pi-tui (checked homebrew and npm root -g)" >&2
  exit 1
fi
npx --yes esbuild ../extensions/runir-memory.ts --bundle --platform=node --format=esm \
  --outfile=runir-memory-bundle.mjs --external:@earendil-works/pi-coding-agent \
  --alias:@earendil-works/pi-tui="$PI_TUI"
node om4-harness.mjs
node om5-harness.mjs
node om6-harness.mjs
node store-harness.mjs
