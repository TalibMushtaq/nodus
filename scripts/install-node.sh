#!/bin/sh
# Install a prebuilt Nodus Storage Node (`nodus`) from GitHub Releases.
#
# The release pipeline currently publishes Linux x86_64 builds only. On any
# other platform this exits with the `cargo install` fallback instead of
# downloading a binary that cannot run.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/TalibMushtaq/nodus/main/scripts/install-node.sh | sh
#   sh scripts/install-node.sh --version 0.1.0 --dir ~/.local/bin
#
# Environment:
#   NODUS_VERSION       version (0.1.0 / v0.1.0 / node-v0.1.0) or "latest"
#   NODUS_INSTALL_DIR   destination directory (default: ~/.local/bin)
set -eu

REPO="TalibMushtaq/nodus"
ARCH="x86_64-unknown-linux-musl"
VERSION="${NODUS_VERSION:-latest}"
INSTALL_DIR="${NODUS_INSTALL_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'EOF'
Install the Nodus Storage Node binary.

Usage: install-node.sh [--version VERSION] [--dir DIRECTORY]

  --version VERSION   Release to install (default: latest)
  --dir DIRECTORY     Install location (default: ~/.local/bin)
  -h, --help          Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "error: --version requires a value" >&2; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || { echo "error: --dir requires a value" >&2; exit 2; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Clear failures beat a 404: only Linux x86_64 assets exist today.
if [ "$(uname -s)" != "Linux" ]; then
  echo "error: prebuilt Nodus binaries are currently Linux-only." >&2
  echo "install from source: cargo install --git https://github.com/${REPO} storage-node" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ;;
  *)
    echo "error: no prebuilt Nodus binary for $(uname -m)." >&2
    echo "install from source: cargo install --git https://github.com/${REPO} storage-node" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "error: tar is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "error: sha256sum is required" >&2; exit 1; }

# Normalize the caller's version into a release tag. Accepting the bare
# version (the common case) avoids forcing users to know the `node-v` prefix.
case "$VERSION" in
  latest)
    # Pick the newest `node-v*` release rather than `/releases/latest`: a later
    # web/relay release in this monorepo would otherwise be selected by mistake.
    # Stable versions only; an rc can still be installed by naming its version.
    TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" \
      | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"node-v[^"]*"' \
      | sed 's/.*"\(node-v[^"]*\)"/\1/' \
      | grep -Ev '^node-v[0-9]+\.[0-9]+\.[0-9]+-' \
      | head -n1)"
    if [ -z "$TAG" ]; then
      echo "error: no Nodus node release found for ${REPO}" >&2
      exit 1
    fi
    ;;
  node-v*) TAG="$VERSION" ;;
  v*) TAG="node-${VERSION}" ;;
  *) TAG="node-v${VERSION}" ;;
esac

VERSION_NUM="${TAG#node-v}"
ASSET="nodus-node-v${VERSION_NUM}-${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

TMP_DIR="$(mktemp -d)"
# shellcheck disable=SC2064 # Expand TMP_DIR now so the trap is path-safe.
trap "rm -rf '$TMP_DIR'" EXIT

echo "Downloading ${ASSET} from ${TAG}..."
curl -fL --retry 3 --retry-delay 1 -o "${TMP_DIR}/${ASSET}" "$URL"
curl -fL --retry 3 --retry-delay 1 -o "${TMP_DIR}/${ASSET}.sha256" "${URL}.sha256"

# Verify before unpacking: the checksum lives next to the asset in the release,
# so a truncated or swapped download fails here instead of at first run.
(cd "$TMP_DIR" && sha256sum -c "${ASSET}.sha256")

tar -xzf "${TMP_DIR}/${ASSET}" -C "$TMP_DIR"
BIN="${TMP_DIR}/${ASSET%.tar.gz}/nodus"
[ -f "$BIN" ] || { echo "error: ${ASSET} did not contain a nodus binary" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
cp "$BIN" "${INSTALL_DIR}/nodus"
chmod 0755 "${INSTALL_DIR}/nodus"

echo "Installed nodus ${VERSION_NUM} to ${INSTALL_DIR}/nodus"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to PATH to run it as 'nodus'." ;;
esac
