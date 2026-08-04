#!/usr/bin/env bash
# Install a pre-commit hook that scans staged changes for credentials.
# CI remains the backstop for contributors who do not install the local hook.
#
# Usage:
#   ./scripts/install-git-hooks.sh
#   ./scripts/install-git-hooks.sh --force  # replace an existing pre-commit hook
#
# A commit can bypass the hook with --no-verify when there is a reviewed reason.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-commit"
FORCE=0

for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=1
done

if [[ -f "$HOOK_PATH" && "$FORCE" -ne 1 ]]; then
  echo "$HOOK_PATH already exists. Re-run with --force to overwrite it."
  exit 1
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Canopy pre-commit hook: scan staged changes for secrets with Gitleaks.
set -e

if ! command -v gitleaks > /dev/null 2>&1; then
  echo "gitleaks is not installed; skipping the local secret scan."
  echo "Install it with: brew install gitleaks"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"

if ! gitleaks protect \
  --staged \
  --source "$REPO_ROOT" \
  --config "$REPO_ROOT/.gitleaks.toml" \
  --redact \
  --verbose; then
  echo
  echo "Secret detected in staged files; commit blocked."
  echo "Remove and rotate the credential before committing."
  echo "For a false positive, add a narrow allowlist entry after review."
  exit 1
fi
HOOK

chmod +x "$HOOK_PATH"
echo "Installed the Gitleaks pre-commit hook at $HOOK_PATH"
