#!/usr/bin/env bash
# Runs security scanners (trivy, semgrep, gitleaks, npm audit) with JSON output.
# Produces test-logs/security/summary.json with per-scanner findings and pass/fail.
# Exits non-zero if any critical findings are detected.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/test-logs/security"

mkdir -p "$OUTPUT_DIR"

# Track per-scanner results
declare -A FINDINGS
declare -A STATUSES
CRITICAL_FOUND=0

# ─── Trivy filesystem scan ──────────────────────────────────────────────────
echo "Running trivy filesystem scan..."
if command -v trivy &>/dev/null; then
  trivy fs --format json --output "$OUTPUT_DIR/trivy.json" \
    --severity CRITICAL,HIGH,MEDIUM,LOW \
    --scanners vuln,secret,misconfig \
    "$REPO_ROOT" 2>/dev/null
  TRIVY_EXIT=$?

  if [ -f "$OUTPUT_DIR/trivy.json" ]; then
    TRIVY_COUNT=$(python3 -c "
import json, sys
try:
    data = json.load(open('$OUTPUT_DIR/trivy.json'))
    results = data.get('Results', [])
    total = sum(len(r.get('Vulnerabilities', [])) + len(r.get('Secrets', [])) + len(r.get('Misconfigurations', [])) for r in results)
    critical = sum(1 for r in results for v in r.get('Vulnerabilities', []) if v.get('Severity') == 'CRITICAL')
    critical += sum(1 for r in results for s in r.get('Secrets', []) if s.get('Severity') == 'CRITICAL')
    critical += sum(1 for r in results for m in r.get('Misconfigurations', []) if m.get('Severity') == 'CRITICAL')
    print(f'{total},{critical}')
except Exception:
    print('0,0')
" 2>/dev/null)
    TRIVY_TOTAL="${TRIVY_COUNT%%,*}"
    TRIVY_CRITICAL="${TRIVY_COUNT##*,}"
  else
    TRIVY_TOTAL=0
    TRIVY_CRITICAL=0
  fi

  FINDINGS[trivy]=$TRIVY_TOTAL
  if [ "$TRIVY_CRITICAL" -gt 0 ]; then
    STATUSES[trivy]="fail"
    CRITICAL_FOUND=1
  else
    STATUSES[trivy]="pass"
  fi
  echo "  trivy: $TRIVY_TOTAL findings ($TRIVY_CRITICAL critical)"
else
  echo "  trivy: not found, skipping"
  FINDINGS[trivy]=0
  STATUSES[trivy]="skip"
fi

# ─── Semgrep scan ────────────────────────────────────────────────────────────
echo "Running semgrep scan..."
if command -v semgrep &>/dev/null; then
  semgrep scan --config auto --json --output "$OUTPUT_DIR/semgrep.json" \
    "$REPO_ROOT" 2>/dev/null
  SEMGREP_EXIT=$?

  if [ -f "$OUTPUT_DIR/semgrep.json" ]; then
    SEMGREP_COUNT=$(python3 -c "
import json, sys
try:
    data = json.load(open('$OUTPUT_DIR/semgrep.json'))
    results = data.get('results', [])
    total = len(results)
    critical = sum(1 for r in results if r.get('extra', {}).get('severity', '').upper() == 'ERROR')
    print(f'{total},{critical}')
except Exception:
    print('0,0')
" 2>/dev/null)
    SEMGREP_TOTAL="${SEMGREP_COUNT%%,*}"
    SEMGREP_CRITICAL="${SEMGREP_COUNT##*,}"
  else
    SEMGREP_TOTAL=0
    SEMGREP_CRITICAL=0
  fi

  FINDINGS[semgrep]=$SEMGREP_TOTAL
  if [ "$SEMGREP_CRITICAL" -gt 0 ]; then
    STATUSES[semgrep]="fail"
    CRITICAL_FOUND=1
  else
    STATUSES[semgrep]="pass"
  fi
  echo "  semgrep: $SEMGREP_TOTAL findings ($SEMGREP_CRITICAL critical)"
else
  echo "  semgrep: not found, skipping"
  FINDINGS[semgrep]=0
  STATUSES[semgrep]="skip"
fi

# ─── Gitleaks scan ───────────────────────────────────────────────────────────
echo "Running gitleaks scan..."
if command -v gitleaks &>/dev/null; then
  gitleaks detect --source "$REPO_ROOT" --report-format json \
    --report-path "$OUTPUT_DIR/gitleaks.json" 2>/dev/null
  GITLEAKS_EXIT=$?

  if [ -f "$OUTPUT_DIR/gitleaks.json" ]; then
    GITLEAKS_COUNT=$(python3 -c "
import json, sys
try:
    data = json.load(open('$OUTPUT_DIR/gitleaks.json'))
    total = len(data) if isinstance(data, list) else 0
    print(total)
except Exception:
    print(0)
" 2>/dev/null)
  else
    GITLEAKS_COUNT=0
  fi

  FINDINGS[gitleaks]=$GITLEAKS_COUNT
  # Any gitleaks finding (leaked secret) is critical
  if [ "$GITLEAKS_COUNT" -gt 0 ]; then
    STATUSES[gitleaks]="fail"
    CRITICAL_FOUND=1
  else
    STATUSES[gitleaks]="pass"
  fi
  echo "  gitleaks: $GITLEAKS_COUNT findings"
else
  echo "  gitleaks: not found, skipping"
  FINDINGS[gitleaks]=0
  STATUSES[gitleaks]="skip"
fi

# ─── npm audit ───────────────────────────────────────────────────────────────
echo "Running npm audit..."
if [ -f "$REPO_ROOT/api/package.json" ]; then
  (cd "$REPO_ROOT/api" && npm audit --json > "$OUTPUT_DIR/npm-audit.json" 2>/dev/null) || true

  if [ -f "$OUTPUT_DIR/npm-audit.json" ]; then
    NPM_COUNT=$(python3 -c "
import json, sys
try:
    data = json.load(open('$OUTPUT_DIR/npm-audit.json'))
    meta = data.get('metadata', {}).get('vulnerabilities', {})
    total = meta.get('total', 0)
    critical = meta.get('critical', 0) + meta.get('high', 0)
    print(f'{total},{critical}')
except Exception:
    print('0,0')
" 2>/dev/null)
    NPM_TOTAL="${NPM_COUNT%%,*}"
    NPM_CRITICAL="${NPM_COUNT##*,}"
  else
    NPM_TOTAL=0
    NPM_CRITICAL=0
  fi

  FINDINGS[npm_audit]=$NPM_TOTAL
  if [ "$NPM_CRITICAL" -gt 0 ]; then
    STATUSES[npm_audit]="fail"
    CRITICAL_FOUND=1
  else
    STATUSES[npm_audit]="pass"
  fi
  echo "  npm audit: $NPM_TOTAL findings ($NPM_CRITICAL critical/high)"
else
  echo "  npm audit: no api/package.json found, skipping"
  FINDINGS[npm_audit]=0
  STATUSES[npm_audit]="skip"
fi

# ─── Write summary ──────────────────────────────────────────────────────────
echo ""
echo "Writing summary to $OUTPUT_DIR/summary.json"

python3 -c "
import json

summary = {
    'scanners': {
        'trivy': {
            'findings': ${FINDINGS[trivy]},
            'status': '${STATUSES[trivy]}'
        },
        'semgrep': {
            'findings': ${FINDINGS[semgrep]},
            'status': '${STATUSES[semgrep]}'
        },
        'gitleaks': {
            'findings': ${FINDINGS[gitleaks]},
            'status': '${STATUSES[gitleaks]}'
        },
        'npm_audit': {
            'findings': ${FINDINGS[npm_audit]},
            'status': '${STATUSES[npm_audit]}'
        }
    },
    'overall': 'fail' if ${CRITICAL_FOUND} else 'pass'
}

with open('$OUTPUT_DIR/summary.json', 'w') as f:
    json.dump(summary, f, indent=2)
    f.write('\n')

print(json.dumps(summary, indent=2))
"

# ─── Exit code ───────────────────────────────────────────────────────────────
if [ "$CRITICAL_FOUND" -gt 0 ]; then
  echo ""
  echo "FAIL: Critical findings detected."
  exit 1
else
  echo ""
  echo "PASS: No critical findings."
  exit 0
fi
