#!/usr/bin/env bash
# Mirror the GitHub Actions CI locally so you can predict pass/fail before pushing.
#
# Covers:
#   - api-ci.yml       (lint, typecheck, test, security-scan)
#   - test.yml         (scad compile, site build, link check)
#   - deploy.yml       (re-uses test.yml; nothing extra to run)
#
# Does NOT cover (need running infra):
#   - e2e.yml playwright  — needs API + Astro dev servers; opt-in via --with e2e
#   - e2e.yml patrol      — needs Android emulator; run manually
#
# Usage:
#   scripts/ci-local.sh                  # default set: api, security, scad, site
#   scripts/ci-local.sh --fast           # skip security
#   scripts/ci-local.sh --only api       # run only the API job
#   scripts/ci-local.sh --only api,site  # comma-separated
#   scripts/ci-local.sh --skip security
#   scripts/ci-local.sh --with e2e       # include Playwright (assumes servers up)
#   scripts/ci-local.sh --json           # print JSON summary at end (always written
#                                        # to test-logs/ci-local/summary.json regardless)
#
# Automatically re-execs itself inside `nix develop` if not already in the
# devshell, so node/pnpm/flutter/trivy/semgrep/gitleaks/playwright are on PATH.
# (openscad comes from the host system — the flake doesn't pin it.)
#
# Structured output:
#   test-logs/ci-local/summary.json   — machine-readable run summary
#   test-logs/ci-local/<job>.log      — captured stdout+stderr per job

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Match CI: tell pnpm/npm we're non-interactive so frozen-lockfile and module
# purges proceed without prompting. GitHub Actions sets CI=true automatically.
export CI=true

# ─── Re-exec under `nix develop` if not already inside one ──────────────────
if [[ -z "${IN_NIX_SHELL:-}" && "${CI_LOCAL_INSIDE_NIX:-}" != "1" ]]; then
  if ! command -v nix >/dev/null 2>&1; then
    echo "Error: 'nix' not found on PATH and not inside a nix devshell." >&2
    echo "Install Nix (with flakes enabled) or enter the devshell manually." >&2
    exit 127
  fi
  echo "Not in nix devshell — re-executing under \`nix develop\`..."
  export CI_LOCAL_INSIDE_NIX=1
  exec nix develop "$REPO_ROOT" --command bash "$0" "$@"
fi

# ─── Argument parsing ───────────────────────────────────────────────────────
DEFAULT_JOBS="api,security,scad,site"
ONLY=""
SKIP=""
WITH=""
FAST=0
PRINT_JSON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)   FAST=1; shift ;;
    --only)   ONLY="$2"; shift 2 ;;
    --skip)   SKIP="$2"; shift 2 ;;
    --with)   WITH="$2"; shift 2 ;;
    --json)   PRINT_JSON=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ $FAST -eq 1 && -z "$SKIP" ]]; then
  SKIP="security"
fi

# Compute the final job set.
if [[ -n "$ONLY" ]]; then
  JOB_SET="$ONLY"
else
  JOB_SET="$DEFAULT_JOBS"
  if [[ -n "$WITH" ]]; then
    JOB_SET="$JOB_SET,$WITH"
  fi
fi

in_set() {
  local needle="$1" hay=",$2,"
  [[ "$hay" == *",$needle,"* ]]
}

should_run() {
  local name="$1"
  in_set "$name" "$JOB_SET" || return 1
  if [[ -n "$SKIP" ]] && in_set "$name" "$SKIP"; then
    return 1
  fi
  return 0
}

# ─── Structured output setup ────────────────────────────────────────────────
LOG_DIR="$REPO_ROOT/test-logs/ci-local"
mkdir -p "$LOG_DIR"
SUMMARY_JSON="$LOG_DIR/summary.json"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Result tracking — parallel arrays (bash 4 assoc-arrays are fine but parallel
# arrays keep insertion order which we want for the table).
declare -a R_NAMES R_STATUS R_DURATION R_EXIT R_LOG

run_step() {
  local name="$1"
  shift
  local logfile="$LOG_DIR/${name}.log"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $name  (log: $logfile)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local start end status exit_code
  start=$(date +%s)
  # tee output to both screen and log file. Use pipefail-aware capture.
  set +e
  ( "$@" ) 2>&1 | tee "$logfile"
  exit_code=${PIPESTATUS[0]}
  set -e
  end=$(date +%s)
  if [[ $exit_code -eq 0 ]]; then
    status="PASS"
  else
    status="FAIL"
  fi
  R_NAMES+=("$name")
  R_STATUS+=("$status")
  R_DURATION+=("$((end - start))")
  R_EXIT+=("$exit_code")
  R_LOG+=("$logfile")
}

# ─── Job: API lint/typecheck/test (mirrors api-ci.yml lint-typecheck-test) ──
job_api() {
  cd "$REPO_ROOT/api"
  pnpm install --frozen-lockfile && \
  pnpm lint && \
  pnpm typecheck && \
  pnpm test
}

# ─── Job: Security scan (mirrors api-ci.yml security-scan, scoped to ./api) ─
job_security() {
  SCAN_PATH="$REPO_ROOT/api" bash "$REPO_ROOT/scripts/security-scan.sh"
}

# ─── Job: OpenSCAD compile (mirrors test.yml test-scad) ─────────────────────
job_scad() {
  bash "$REPO_ROOT/scripts/test-scad.sh"
}

# ─── Job: Site build + link check (mirrors test.yml test-site) ──────────────
job_site() {
  cd "$REPO_ROOT/site"
  npm ci && \
  npm run build && \
  npm test
}

# ─── Job: Playwright E2E (mirrors e2e.yml playwright) ───────────────────────
# Opt-in: needs API on :3000 and Astro on :4321. CI builds the site first
# then runs `npx playwright test`. Locally, assume the user has dev servers
# running (or wire up playwright.config webServer).
job_e2e() {
  cd "$REPO_ROOT/site"
  npx playwright test
}

# ─── Run selected jobs ──────────────────────────────────────────────────────
should_run api      && run_step "api"      job_api
should_run security && run_step "security" job_security
should_run scad     && run_step "scad"     job_scad
should_run site     && run_step "site"     job_site
should_run e2e      && run_step "e2e"      job_e2e

RUN_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Build JSON summary ─────────────────────────────────────────────────────
build_json() {
  python3 - "$RUN_STARTED_AT" "$RUN_FINISHED_AT" "$SUMMARY_JSON" \
    "${R_NAMES[@]:-}" "::sep::" \
    "${R_STATUS[@]:-}" "::sep::" \
    "${R_DURATION[@]:-}" "::sep::" \
    "${R_EXIT[@]:-}" "::sep::" \
    "${R_LOG[@]:-}" <<'PY'
import json, sys
started, finished, out_path, *rest = sys.argv[1:]
# Split rest by "::sep::" sentinel into 5 lists.
groups, current = [], []
for item in rest:
    if item == "::sep::":
        groups.append(current); current = []
    else:
        current.append(item)
groups.append(current)
names, statuses, durations, exits, logs = (g for g in groups)
# Filter out the empty placeholder when arrays are empty.
def clean(xs): return [x for x in xs if x != ""]
names, statuses, durations, exits, logs = map(clean, (names, statuses, durations, exits, logs))
jobs = []
for i, n in enumerate(names):
    jobs.append({
        "name": n,
        "status": statuses[i],
        "duration_seconds": int(durations[i]),
        "exit_code": int(exits[i]),
        "log": logs[i],
    })
fail_count = sum(1 for j in jobs if j["status"] == "FAIL")
summary = {
    "started_at": started,
    "finished_at": finished,
    "overall": "fail" if fail_count else "pass",
    "fail_count": fail_count,
    "pass_count": sum(1 for j in jobs if j["status"] == "PASS"),
    "jobs": jobs,
}
with open(out_path, "w") as f:
    json.dump(summary, f, indent=2)
    f.write("\n")
print(json.dumps(summary, indent=2))
PY
}

JSON_OUTPUT="$(build_json)"

# ─── Human-readable summary ─────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " SUMMARY"
echo "════════════════════════════════════════════════════════════════"
fail_count=0
for i in "${!R_NAMES[@]}"; do
  printf "  %-7s  %4ss  %-10s  %s\n" \
    "${R_STATUS[$i]}" "${R_DURATION[$i]}" "${R_NAMES[$i]}" "${R_LOG[$i]}"
  [[ "${R_STATUS[$i]}" == "FAIL" ]] && fail_count=$((fail_count + 1))
done
echo "════════════════════════════════════════════════════════════════"
echo "JSON summary: $SUMMARY_JSON"

if [[ $PRINT_JSON -eq 1 ]]; then
  echo ""
  echo "$JSON_OUTPUT"
fi

echo ""
echo "Notes:"
echo "  - Playwright (e2e.yml) is NOT in the default set — it needs running"
echo "    API + Astro servers. Run with --with e2e once they're up."
echo "  - Patrol Flutter tests on Android emulator are not covered locally;"
echo "    use scripts/e2e-launch-{admin,customer}.sh manually if needed."

if [[ $fail_count -gt 0 ]]; then
  echo ""
  echo "FAIL: $fail_count job(s) failed."
  exit 1
fi
echo ""
echo "PASS: all selected jobs passed."
