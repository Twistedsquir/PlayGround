#!/usr/bin/env bash
# Capture desktop + mobile screenshots of the running app.
#
# Env: CAPTURE_URL (exact URL to open), CAPTURE_DIR (output directory).
# Writes final-desktop.png and final-mobile.png into CAPTURE_DIR.
# Capture output stays outside the source tree; the app is left running.
# Exit 75 = temporary navigation/browser infrastructure failure.
# Exit 1  = script usage error or rendering defect.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${CAPTURE_URL:-}" || -z "${CAPTURE_DIR:-}" ]]; then
  echo 'Set CAPTURE_URL and CAPTURE_DIR.' >&2
  exit 1
fi

/usr/bin/time -p mkdir -p "$CAPTURE_DIR"

rc=0
/usr/bin/time -p node "${RUNTIME_DIR:?}/scripts/default-capture.mjs" || rc=$?

# Rendering defect (not infrastructure): browser worked but output is missing.
if [[ ! -s "$CAPTURE_DIR/final-desktop.png" || ! -s "$CAPTURE_DIR/final-mobile.png" ]]; then
  echo 'Capture did not produce final-desktop.png and final-mobile.png.' >&2
  [[ "$rc" -eq 75 ]] && exit 75
  exit 1
fi

/usr/bin/time -p ls -l "$CAPTURE_DIR/final-desktop.png" "$CAPTURE_DIR/final-mobile.png"
exit "$rc"
