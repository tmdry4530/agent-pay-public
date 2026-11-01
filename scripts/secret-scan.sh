#!/usr/bin/env bash
# Greps tracked files for key-shaped strings and fails if any are found or a .env file is tracked.
# Patterns: GitHub tokens, Anthropic and OpenRouter (sk-or-) keys, Tailscale, Slack, AWS access keys, PEM private
# keys, inline client secrets, NEAR ed25519 private keys. This file is excluded because it contains the patterns.
set -u
cd "$(git rev-parse --show-toplevel)"
PATTERN='(ghp_|github_pat_|sk-ant-|sk-or-[A-Za-z0-9_-]{16,}|tskey-|xox[bp]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|client_secret\s*[:=]\s*[A-Za-z0-9]{20,}|ed25519:[1-9A-HJ-NP-Za-km-z]{40,})'
status=0
if git grep -nIE "$PATTERN" -- ':!scripts/secret-scan.sh'; then
  echo "secret-scan: key-shaped strings found (above)" >&2
  status=1
fi
tracked_env=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$tracked_env" ]; then
  echo "secret-scan: tracked .env files: $tracked_env" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "secret-scan: clean"
exit "$status"
