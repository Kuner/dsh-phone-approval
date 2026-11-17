#!/usr/bin/env bash
# Regenerate docs/images/ from the plugin's real page.js and client.js with sample data.
# See README.md in this directory for requirements.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE=${NODE:-node}
PYTHON=${PYTHON:-python3}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
DSH_APP=${DSH_APP:-"/Applications/DeepSeek Harness.app"}
PORT=${PORT:-47380}

WORK=$(mktemp -d)
SERVER_PID=
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -d "$HERE/node_modules/react/umd" ]; then
  (cd "$HERE" && npm install --no-audit --no-fund)
fi

# The DSH theme stylesheet lives inside app.asar, which only DSH's own Electron can read.
ELECTRON_RUN_AS_NODE=1 "$DSH_APP/Contents/MacOS/DeepSeek Harness" -e '
  const fs = require("fs")
  fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]))
' "$DSH_APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css" "$WORK/theme.css"

"$NODE" "$HERE/server.mjs" "$REPO" "$WORK/theme.css" "$PORT" >/dev/null &
SERVER_PID=$!
for _ in $(seq 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/settings" && break
  sleep 0.1
done

mkdir -p "$WORK/out" "$WORK/profile"
BASE="http://127.0.0.1:$PORT"

# shot <name> <url> <width> <height> <scale> [extra chrome flags...]
shot() {
  local name=$1 url=$2 width=$3 height=$4 scale=$5
  shift 5
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --no-first-run --lang=zh-CN \
    --user-data-dir="$WORK/profile" --force-device-scale-factor="$scale" --window-size="$width,$height" \
    --virtual-time-budget=4000 "$@" --screenshot="$WORK/out/$name.png" "$url" >/dev/null 2>&1
  echo "captured $name"
}

# Desktop Chrome will not lay out narrower than about 500px, so phone pages render in a 390px iframe.
for state in approval question enroll; do
  shot "phone-$state" "$BASE/frame?src=/a/$state" 600 844 3 --force-dark-mode
done
shot settings-light "$BASE/settings?theme=light" 1100 2350 2
shot settings-dark "$BASE/settings?theme=dark" 1100 2350 2
shot card-encryption "$BASE/settings?theme=light&enc=pending&card=2" 900 700 2
shot card-messages "$BASE/settings?theme=light&card=3" 900 800 2
shot card-phone "$BASE/settings?theme=light&card=4" 900 700 2

mkdir -p "$REPO/docs/images"
"$PYTHON" "$HERE/postprocess.py" "$WORK/out" "$REPO/docs/images"
