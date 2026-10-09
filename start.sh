#!/usr/bin/env bash
# Serve the built Family Meals PWA (app/dist) in the foreground.
#
# - Source and build output stay inside PROJECT_DIR (this repo).
# - OPENCODE_WEB_DIR is used only for worker metadata (deployment-output.json).
# - Installs dependencies and rebuilds only when needed.
# - Listens on $PORT (default 3000). The controller reuses a healthy server.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
export PORT
WEB_DIR="${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}"
PROJECT_ROOT="$PWD"
APP_DIR="$PROJECT_ROOT/app"
DIST_DIR="$APP_DIR/dist"

/usr/bin/time -p test -d "$APP_DIR"
/usr/bin/time -p test -f "$APP_DIR/package.json"

# Install dependencies when node_modules is missing or manifests changed.
if [[ ! -d "$APP_DIR/node_modules" ]] \
  || [[ "$APP_DIR/package.json" -nt "$APP_DIR/node_modules" ]] \
  || [[ "$APP_DIR/package-lock.json" -nt "$APP_DIR/node_modules" ]]; then
  if [[ -f "$APP_DIR/package-lock.json" ]]; then
    /usr/bin/time -p npm ci --prefix "$APP_DIR" --no-audit --no-fund
  else
    /usr/bin/time -p npm install --prefix "$APP_DIR" --no-audit --no-fund
  fi
fi

# Rebuild when dist is missing or sources are newer than the last build.
if [[ ! -f "$DIST_DIR/index.html" ]] \
  || [[ "$APP_DIR/package.json" -nt "$DIST_DIR/index.html" ]] \
  || [[ -n "$(/usr/bin/time -p find "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/index.html" "$APP_DIR/vite.config.ts" -newer "$DIST_DIR/index.html" -print -quit 2>/dev/null)" ]]; then
  /usr/bin/time -p npm run build --prefix "$APP_DIR"
fi
/usr/bin/time -p test -f "$DIST_DIR/index.html"

# Publish the built static directory for the controller (metadata only).
/usr/bin/time -p mkdir -p "$WEB_DIR"
WEB_DIR="$WEB_DIR" PROJECT_ROOT="$PROJECT_ROOT" DIST_DIR="$DIST_DIR" /usr/bin/time -p node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const out = path.join(process.env.WEB_DIR, "deployment-output.json");
  fs.writeFileSync(out, JSON.stringify({ project: process.env.PROJECT_ROOT, directory: process.env.DIST_DIR }));
'

# Serve the static build in the foreground (controller-owned tmux session).
cd "$APP_DIR"
/usr/bin/time -p ./node_modules/.bin/vite preview --port "$PORT" --host 127.0.0.1 --strictPort
