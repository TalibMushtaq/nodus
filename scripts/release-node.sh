#!/usr/bin/env bash
# Cut a Nodus Storage Node release: bump the crate version, run the same gates
# as CI, commit, tag `node-vX.Y.Z`, and push. The tag push triggers
# `.github/workflows/release-node.yml`, which builds the Linux binary and opens
# a draft GitHub release.
#
# Usage: bash scripts/release-node.sh 0.2.0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: bash scripts/release-node.sh <version>" >&2
  echo "example: bash scripts/release-node.sh 0.2.0" >&2
  exit 2
fi

# Reject tags that would not be valid semver; the workflow trusts the tag as
# the release identity and should not have to re-litigate its shape.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '${VERSION}' is not a semver version (expected X.Y.Z)" >&2
  exit 2
fi

TAG="node-v${VERSION}"
MANIFEST="services/storage-node/Cargo.toml"

# Only tracked changes block a release: the repo intentionally carries local
# reports and scratch files, and refusing on those would make the script
# unusable on a normal working tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: tracked files have uncommitted changes; commit or stash them first" >&2
  git status --short
  exit 1
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
if [ -n "$UNTRACKED" ]; then
  echo "warning: untracked files present (not included in the release commit):"
  echo "$UNTRACKED"
fi

# The tag must point at the workflow and installer it depends on. These can be
# present-but-untracked during the first setup, which the warning above would
# otherwise let through into a release that cannot build.
for required in .github/workflows/release-node.yml scripts/install-node.sh; do
  if ! git ls-files --error-unmatch "$required" >/dev/null 2>&1; then
    echo "error: ${required} is not tracked; commit it before releasing" >&2
    exit 1
  fi
done

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} already exists locally" >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "error: tag ${TAG} already exists on origin" >&2
  exit 1
fi

# Check the tree before changing it: a failing test should not leave a
# half-applied version bump behind.
echo "Running release checks..."
(cd services/storage-node && cargo fmt --check)
(cd services/storage-node && cargo clippy --locked -- -D warnings)
(cd services/storage-node && cargo test --locked)

CURRENT_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$MANIFEST" | head -n1)"
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  # The first release starts from the version already in the tree; tagging it
  # directly avoids an empty commit that would only restate the manifest.
  echo "${MANIFEST} is already at ${VERSION}; tagging the current commit."
else
  echo "Updating ${MANIFEST} from ${CURRENT_VERSION} to ${VERSION}..."
  # Replace only the first `version =` (the [package] version); dependency
  # versions follow it and must stay untouched. The explicit pattern matters:
  # an empty `s//…/` reuses the range address and corrupts the line.
  sed -E -i.bak "0,/^version = \"[^\"]*\"/s//version = \"${VERSION}\"/" "$MANIFEST"
  rm -f "${MANIFEST}.bak"

  # Refresh Cargo.lock for the new package version; the release workflow builds
  # with --locked and would reject a stale lock.
  (cd services/storage-node && cargo check --quiet)

  # Cargo.lock is committed in this repo, so the version bump belongs in the
  # release commit alongside the manifest.
  git add "$MANIFEST" services/storage-node/Cargo.lock
  git commit -m "chore(node): release v${VERSION}"
fi

git tag -a "$TAG" -m "Nodus Storage Node v${VERSION}"

echo "Pushing $(git rev-parse --abbrev-ref HEAD) and ${TAG}..."
git push origin HEAD "$TAG"

echo
echo "Release ${TAG} pushed. Watch the release-node workflow, then publish the draft:"
echo "  gh run watch"
echo "  gh release list"
