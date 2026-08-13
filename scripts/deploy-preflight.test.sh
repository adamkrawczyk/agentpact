#!/usr/bin/env bash
# Self-test for scripts/deploy.sh's environment-variable preflight guard.
#
# WHY THIS EXISTS
# ---------------
# The guard shipped broken for its entire life. The condition was written as:
#
#     if [ -z "${!var}"; then          # <-- missing closing ]
#
# `bash -n` does NOT catch this: `[` is an ordinary COMMAND, not shell syntax,
# so a malformed test is a runtime error, not a parse error. At runtime bash
# printed `[: missing ']'` to stderr and the `if` evaluated FALSE — so with
# EVERY required variable unset, deploy.sh printed
# "Environment variables validated" and proceeded to build, migrate and start
# services against an unconfigured environment. A guard that cannot fail is
# not a guard.
#
# This test asserts the OBSERVABLE BEHAVIOUR (does it refuse to proceed?),
# not the source text, so it stays valid if the implementation is rewritten.
#
# Run: bash scripts/deploy-preflight.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$SCRIPT_DIR/deploy.sh"
fails=0

pass() { echo "  ok   — $1"; }
fail() { echo "  FAIL — $1"; fails=$((fails + 1)); }

echo "deploy.sh preflight guard self-test"
echo "==================================="

# ---------------------------------------------------------------------------
# 1. Static: the malformed-test class must not reappear anywhere.
#    Static check: the malformed-test class must not reappear anywhere.
#    ShellCheck catches SC1072/SC1073 (the exact bug) if it is installed.
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S error "$DEPLOY" >/dev/null 2>&1; then
    pass "shellcheck -S error clean"
  else
    fail "shellcheck reports an error-level finding:"
    shellcheck -S error "$DEPLOY" 2>&1 | sed 's/^/       /'
  fi
else
  echo "  skip — shellcheck not installed (CI installs it)"
fi

# Belt-and-braces: grep for a bracket test that never closes before `; then`.
# Catches the class even where shellcheck is unavailable.
if grep -nE '^\s*(if|elif)\s+\[{1,2}[^]]*;\s*then\s*$' "$DEPLOY" >/dev/null 2>&1; then
  fail "found an unterminated [ / [[ test (missing ] or ]]):"
  grep -nE '^\s*(if|elif)\s+\[{1,2}[^]]*;\s*then\s*$' "$DEPLOY" | sed 's/^/       /'
else
  pass "no unterminated bracket tests"
fi

# ---------------------------------------------------------------------------
# 2. Behavioural: with a required var unset the script MUST refuse (non-zero)
#    and MUST NOT claim the environment is validated.
#
#    deploy.sh builds containers after the guard, so we must never let it past
#    the guard. We stub `docker`/`curl` onto PATH as loud failures: if the guard
#    works we never reach them; if it is broken the stub fires and the test
#    still fails rather than launching real containers.
# ---------------------------------------------------------------------------
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
for cmd in docker curl; do
  cat > "$STUB_DIR/$cmd" <<'STUB'
#!/usr/bin/env bash
echo "GUARD-BYPASSED: reached '$(basename "$0")' with an unconfigured environment" >&2
exit 97
STUB
  chmod +x "$STUB_DIR/$cmd"
done

run_with_missing() {
  # Runs deploy.sh with every required var unset except those passed in.
  env -i PATH="$STUB_DIR:/usr/bin:/bin" HOME="$HOME" \
    bash "$DEPLOY" 2>&1
}

output="$(run_with_missing)"
rc=$?

if [ "$rc" -eq 0 ]; then
  fail "exited 0 with all required env vars unset (guard did not fire)"
else
  pass "non-zero exit ($rc) when required env vars are missing"
fi

if printf '%s' "$output" | grep -q "Environment variables validated"; then
  fail "claimed 'Environment variables validated' while vars were unset"
else
  pass "did not claim validation with unset vars"
fi

if printf '%s' "$output" | grep -q "Missing required environment variable"; then
  pass "named the missing variable"
else
  fail "did not report which variable was missing; output was:"
  printf '%s\n' "$output" | sed 's/^/       /'
fi

if printf '%s' "$output" | grep -q "GUARD-BYPASSED"; then
  fail "execution reached docker/curl — the guard let an unconfigured deploy through"
else
  pass "never reached docker/curl"
fi

# `[: missing ]` on stderr is the fingerprint of the original bug.
if printf '%s' "$output" | grep -qE "\[: missing|unexpected token"; then
  fail "bash reported a malformed test at runtime (the original defect)"
else
  pass "no malformed-test runtime error"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "✅ all preflight-guard checks passed"
  exit 0
fi
echo "❌ $fails check(s) failed"
exit 1
