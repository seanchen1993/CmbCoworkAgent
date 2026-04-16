#!/bin/bash
# Download vscode-java VSIX packages (contains JDTLS + JRE 21)
# Usage: ./scripts/download-jdtls.sh

set -e

VERSION="1.42.0"
BUILD="561"
BASE_URL="https://github.com/redhat-developer/vscode-java/releases/download/v${VERSION}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${SCRIPT_DIR}/../resources/lsp-vsix"
mkdir -p "$DEST"

download() {
  local platform=$1
  local file="java-${platform}-${VERSION}-${BUILD}.vsix"
  local out="${DEST}/java-${platform}.vsix"
  if [ -f "$out" ]; then
    echo "[${platform}] Already exists, skipping."
  else
    echo "[${platform}] Downloading..."
    curl -fSL "${BASE_URL}/${file}" -o "$out"
    echo "[${platform}] OK ($(du -h "$out" | cut -f1))"
  fi
}

download "darwin-arm64"
download "win32-x64"
download "linux-x64"

echo ""
echo "Done. VSIX files are in: ${DEST}"
echo "They will be extracted on first LSP start to ~/.cmbcoworkagent/lsp-runtime/"
