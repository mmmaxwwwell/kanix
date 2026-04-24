#!/usr/bin/env bash
# Diagnose an MCP server dep.
#
# Usage: mcp-diagnose.sh <mcp-browser|mcp-android>
#
# Prints a single JSON object to stdout:
#   {"status":"working"|"fixable"|"broken","remediation":string|null,"detail":string}
#
# status values:
#   working  — binary runs and responds to stdio MCP init; task can proceed
#   fixable  — failure is bounded and the remediation hint can be executed without
#              human input (e.g. re-enter devshell, update flake input, rebuild venv)
#   broken   — failure requires human input (missing credentials, hardware, upstream
#              bug that is not fixable in this repo)
#
# Exit code is always 0 so callers parse the JSON rather than branching on $?.

set -u

dep="${1:-}"
if [[ -z "$dep" ]]; then
  printf '{"status":"broken","remediation":null,"detail":"no dep name passed"}\n'
  exit 0
fi

emit() {
  local status="$1" remediation="$2" detail="$3"
  # Escape embedded quotes in detail/remediation for JSON safety.
  detail="${detail//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  detail="${detail//$'\n'/\\n}"
  if [[ "$remediation" == "null" ]]; then
    printf '{"status":"%s","remediation":null,"detail":"%s"}\n' "$status" "$detail"
  else
    remediation="${remediation//\\/\\\\}"
    remediation="${remediation//\"/\\\"}"
    remediation="${remediation//$'\n'/\\n}"
    printf '{"status":"%s","remediation":"%s","detail":"%s"}\n' "$status" "$remediation" "$detail"
  fi
}

# Run a command with a timeout and capture stderr.
probe_binary() {
  local bin="$1"
  local tmperr
  tmperr="$(mktemp)"
  # --help is cheap; any failure here means the binary itself can't load.
  if timeout 10 "$bin" --help >/dev/null 2>"$tmperr"; then
    rm -f "$tmperr"
    return 0
  fi
  local rc=$?
  local err
  err="$(cat "$tmperr")"
  rm -f "$tmperr"
  printf '%s' "$err"
  return "$rc"
}

case "$dep" in
  mcp-browser)
    if ! command -v mcp-browser >/dev/null 2>&1; then
      emit "broken" \
        "null" \
        "mcp-browser binary not on PATH; the runner must be launched inside 'nix develop' so nix-mcp-debugkit is in scope. Re-launch the runner from a shell that ran 'nix develop' first."
      exit 0
    fi
    if err="$(probe_binary mcp-browser)"; then
      emit "working" "null" "mcp-browser responded to --help"
      exit 0
    fi
    # Playwright runtime dependencies are the most common fixable failure.
    if grep -qiE 'playwright|browser.*not.*found|chromium|missing.*dependencies' <<<"$err"; then
      emit "fixable" \
        "playwright install --with-deps chromium" \
        "mcp-browser imported but Playwright browser binaries missing: $err"
      exit 0
    fi
    if grep -qiE 'ModuleNotFoundError|ImportError' <<<"$err"; then
      emit "fixable" \
        "update nix-mcp-debugkit flake input: nix flake lock --update-input nix-mcp-debugkit" \
        "mcp-browser Python env is broken upstream: $err"
      exit 0
    fi
    emit "broken" "null" "mcp-browser crashed with unrecognized error: $err"
    ;;

  mcp-android)
    if ! command -v mcp-android >/dev/null 2>&1; then
      emit "broken" \
        "null" \
        "mcp-android binary not on PATH; the runner must be launched inside 'nix develop' so nix-mcp-debugkit is in scope. Re-launch the runner from a shell that ran 'nix develop' first."
      exit 0
    fi
    if err="$(probe_binary mcp-android)"; then
      emit "working" "null" "mcp-android responded to --help"
      exit 0
    fi
    # The specific pydantic_core crash that blocked T098 is upstream packaging.
    if grep -qE "No module named 'pydantic_core\._pydantic_core'" <<<"$err"; then
      emit "fixable" \
        "nix flake lock --update-input nix-mcp-debugkit" \
        "pydantic-core native extension missing in nix-mcp-debugkit-provided Python env. Upstream packaging issue; updating the flake input usually pulls a coherent pin. If still broken after update, this becomes 'broken' and needs an upstream fix."
      exit 0
    fi
    if grep -qiE 'ModuleNotFoundError|ImportError' <<<"$err"; then
      emit "fixable" \
        "nix flake lock --update-input nix-mcp-debugkit" \
        "mcp-android Python env is broken upstream: $err"
      exit 0
    fi
    # adb / emulator issues are runtime prereqs, not dep breakage.
    if grep -qiE 'adb|emulator|avd|kvm' <<<"$err"; then
      emit "fixable" \
        "start the Android emulator via test/e2e/setup.sh" \
        "mcp-android loaded but runtime prereq missing: $err"
      exit 0
    fi
    emit "broken" "null" "mcp-android crashed with unrecognized error: $err"
    ;;

  *)
    emit "broken" "null" "unknown dep: $dep"
    ;;
esac
