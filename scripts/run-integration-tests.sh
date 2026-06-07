#!/usr/bin/env bash
#
# Run the Matrix integration tests against a real Conduit homeserver.
#
# These tests are #[ignore]d by default (they spawn a Conduit homeserver and
# need the `matrix-native` feature). They must be run inside the Nix dev shell,
# which provides the `conduit` binary, the Rust toolchain, and the C compiler:
#
#   nix develop --command bash scripts/run-integration-tests.sh
#
# Mirrors the `integration` job in .github/workflows/ci.yml.
set -euo pipefail

if ! command -v conduit >/dev/null 2>&1; then
  echo "error: 'conduit' not found in PATH." >&2
  echo "       Run this inside the Nix dev shell: nix develop --command bash scripts/run-integration-tests.sh" >&2
  exit 1
fi

# When run from a Windows mount (/mnt/c/...), keep build artifacts on the native
# Linux filesystem — both for speed and to avoid OneDrive churning target/.
if [[ "$PWD" == /mnt/* && -z "${CARGO_TARGET_DIR:-}" ]]; then
  export CARGO_TARGET_DIR="$HOME/.cache/sca-target"
  echo "==> CARGO_TARGET_DIR=$CARGO_TARGET_DIR (off the Windows mount)"
fi

echo "==> conduit: $(command -v conduit)"
echo

echo "==> tables-over-matrix integration tests"
cargo test -p tables-over-matrix --no-default-features --features matrix-native \
  -- --ignored --nocapture

echo
echo "==> app-core workspace_matrix integration tests"
cargo test -p app-core --no-default-features --features matrix-native \
  --test workspace_matrix -- --ignored --nocapture --test-threads=4

echo
echo "==> integration tests complete"
