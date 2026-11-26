#!/bin/sh
# Installs the rtk distribution adapter with `cline plugin install`.
# Extra arguments are passed through, e.g. --cwd <path> or --json.
# Environment: CLINE_BIN (default: cline), RTK_VERSION, RTK_EDITION=oss, RTK_INSTALL_DIR.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR="$SCRIPT_DIR/cline-plugin"
CLINE_BIN="${CLINE_BIN:-cline}"

if ! command -v "$CLINE_BIN" >/dev/null 2>&1; then
    echo "[ERROR] '$CLINE_BIN' not found. Install the Cline CLI or set CLINE_BIN." >&2
    exit 1
fi

exec "$CLINE_BIN" plugin install "$PLUGIN_DIR" --force "$@"
