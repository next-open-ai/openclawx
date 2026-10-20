#!/usr/bin/env bash
# Slim a prepared OpenClawX Docker builder tree without changing runtime behavior.
set -euo pipefail

ROOT="${1:-/opt/openclawx}"
VENV="${ROOT}/runtimes/agentscope-runtime/.venv"

echo "[slim] root=${ROOT}"

if [[ -d "${VENV}" ]]; then
  SITE="$(find "${VENV}/lib" -maxdepth 2 -type d -name site-packages | head -n 1 || true)"
  if [[ -n "${SITE}" ]]; then
    echo "[slim] pruning python tooling from ${SITE}"
    rm -rf \
      "${SITE}/pip" \
      "${SITE}/pip-"* \
      "${SITE}/setuptools" \
      "${SITE}/setuptools-"* \
      "${SITE}/pkg_resources" \
      "${SITE}/wheel" \
      "${SITE}/wheel-"* \
      "${SITE}/_distutils_hack" \
      "${SITE}/distutils-precedence.pth" || true

    echo "[slim] removing python caches/tests"
    find "${VENV}" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
    find "${VENV}" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete 2>/dev/null || true
    find "${SITE}" -type d \( -name 'tests' -o -name 'test' -o -name 'testing' \) -prune -exec rm -rf {} + 2>/dev/null || true
    find "${SITE}" -type d -name 'examples' -prune -exec rm -rf {} + 2>/dev/null || true
  fi
  rm -rf "${VENV}/share" "${VENV}/include" 2>/dev/null || true
fi

echo "[slim] pruning node install residue"
rm -rf \
  /root/.npm \
  /root/.cache \
  /tmp/npm-* \
  "${ROOT}/node_modules/.cache" \
  "${ROOT}/package-lock.json" 2>/dev/null || true

# Drop TypeScript-only leftovers that sometimes land via transitive deps.
rm -rf \
  "${ROOT}/node_modules/@types" \
  "${ROOT}/node_modules/@swc" 2>/dev/null || true

find "${ROOT}/node_modules" -type f -name '*.map' -delete 2>/dev/null || true

echo "[slim] done"
du -sh "${ROOT}" "${ROOT}/node_modules" "${VENV}" 2>/dev/null || true
