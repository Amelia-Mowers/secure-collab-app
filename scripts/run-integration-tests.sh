#!/usr/bin/env bash
#
# Run the Matrix integration tests against a real Synapse homeserver.
#
# These tests are #[ignore]d by default (they spawn a Synapse homeserver and
# need the `matrix-native` feature). Synapse (not Conduit) so they run against
# the same homeserver software as prod (ADR 0002) — Conduit omits the inviter
# from the invite stripped state, which breaks MSC4268 history-on-invite. They
# must be run inside the Nix dev shell, which provides the `synapse_homeserver`
# binary, the Rust toolchain, and the C compiler:
#
#   nix develop --command bash scripts/run-integration-tests.sh
#
# Mirrors the `integration` job in .github/workflows/ci.yml.
set -euo pipefail

if ! command -v synapse_homeserver >/dev/null 2>&1; then
  echo "error: 'synapse_homeserver' not found in PATH." >&2
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
# Bound parallelism: each test spins up its own Synapse (heavier than Conduit),
# so cap concurrent instances to keep memory/CPU in check.
cargo test -p tables-over-matrix --no-default-features --features matrix-native \
  -- --ignored --nocapture --test-threads=4

echo
echo "==> app-core workspace_matrix integration tests"
cargo test -p app-core --no-default-features --features matrix-native \
  --test workspace_matrix -- --ignored --nocapture --test-threads=4

echo
echo "==> integration tests complete"
