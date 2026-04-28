#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup_python.sh — install Python dependencies (Unix / macOS / WSL).
#
# Usage (run from the repository root):
#   bash scripts/setup_python.sh
#
# The script installs every package listed in python/requirements.txt.
# On Windows, wheel files are loaded from H:\Models-D1\wheels first; on other
# platforms WHEELS_DIR can be overridden via environment variable.
# Passes --find-links so pip prefers local wheels over downloading from PyPI.
#
# To install *only* from local wheels (no internet required), pass --no-index:
#   bash scripts/setup_python.sh --no-index
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REQUIREMENTS="$REPO_ROOT/python/requirements.txt"
export PIP_CONFIG_FILE="$REPO_ROOT/python/pip.ini"

# Default wheels directory — Windows path (also works under WSL with /mnt/h/...)
WHEELS_DIR="${WHEELS_DIR:-H:\\Models-D1\\wheels}"

# Normalise Windows path for WSL/bash if needed
if [[ "$WHEELS_DIR" =~ ^[A-Za-z]:\\ ]]; then
    DRIVE="${WHEELS_DIR:0:1}"
    REST="${WHEELS_DIR:3}"
    REST="${REST//\\//}"
    WSL_PATH="/mnt/${DRIVE,,}/${REST}"
    if [ -d "$WSL_PATH" ]; then
        WHEELS_DIR="$WSL_PATH"
    fi
fi

EXTRA_FLAGS=()
if [[ "${1:-}" == "--no-index" ]]; then
    EXTRA_FLAGS+=(--no-index)
fi

if [ ! -d "$WHEELS_DIR" ]; then
    echo "[setup_python] WARNING: wheel directory not found: $WHEELS_DIR"
    echo "[setup_python] Falling back to PyPI only."
    python3 -m pip install -r "$REQUIREMENTS"
else
    echo "[setup_python] Installing from $REQUIREMENTS"
    echo "[setup_python] Using local wheels: $WHEELS_DIR"
    python3 -m pip install --find-links "$WHEELS_DIR" "${EXTRA_FLAGS[@]}" -r "$REQUIREMENTS"
fi

echo "[setup_python] Done."
