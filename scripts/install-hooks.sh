#!/bin/sh
# Installs repo-managed git hooks (.githooks/) via core.hooksPath.
# POSIX sh (not bash): runs as the npm "prepare" lifecycle script (npm
# install / npm ci), including inside node:20-alpine Docker builds, which
# ship busybox sh but no bash.
# Safe no-op outside a git checkout (e.g. inside a Docker build context that
# only COPYs package.json, or npm installs run from a tarball).
set -eu

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "install-hooks: not a git checkout, skipping hook install"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
git -C "$REPO_ROOT" config core.hooksPath .githooks
chmod +x "$REPO_ROOT/.githooks/pre-push" 2>/dev/null || true
echo "install-hooks: core.hooksPath -> .githooks (pre-push runs scripts/lint-routes.sh)"
