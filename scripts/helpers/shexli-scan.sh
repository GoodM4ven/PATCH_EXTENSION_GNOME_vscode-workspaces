#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SHEXLI_VERSION="${SHEXLI_VERSION:-0.2.1}"
SHEXLI_VENV="${SHEXLI_VENV:-${EXT_DIR}/.tools/shexli-venv}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    echo "error: python interpreter not found: ${PYTHON_BIN}" >&2
    exit 1
fi

if [[ ! -x "${SHEXLI_VENV}/bin/python" ]]; then
    "${PYTHON_BIN}" -m venv "${SHEXLI_VENV}"
fi

"${SHEXLI_VENV}/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true
"${SHEXLI_VENV}/bin/python" -m pip install \
    --disable-pip-version-check \
    --quiet \
    --upgrade \
    "shexli==${SHEXLI_VERSION}"

if [[ $# -eq 0 ]]; then
    set -- "${EXT_DIR}/vscodium-workspaces.zip" --format text
fi

exec "${SHEXLI_VENV}/bin/python" -m shexli "$@"
