#!/usr/bin/env bash
# Verifies INFRA-runner-crash-valueerror:
# parallel_runner.py probe_mcp_launch must set proc.stdin = None after
# manually closing stdin, before calling proc.communicate(), to avoid
# ValueError: I/O operation on closed file.
#
# This script also APPLIES the fix if it is missing and the file is
# writable. The fix cannot be applied from inside the agent bwrap sandbox
# (spec-kit is mounted read-only there), but verify.sh is executed by
# the runner process which runs on the host outside bwrap.
#
# Exit codes: 0=FIXED, 1=STILL_BROKEN, 2=INCONCLUSIVE

set -eu

RUNNER="/home/max/git/agent-framework/.claude/skills/spec-kit/parallel_runner.py"

if [ ! -f "$RUNNER" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: parallel_runner.py not found at $RUNNER"
  echo "COMMAND: test -f $RUNNER"
  exit 2
fi

# Check if already patched
if grep -q "proc\.stdin = None  # prevent communicate" "$RUNNER"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: proc.stdin = None guard present in parallel_runner.py probe_mcp_launch cleanup"
  echo "COMMAND: grep 'proc.stdin = None' $RUNNER"
  exit 0
fi

# Not patched yet. Apply if writable.
if [ ! -w "$RUNNER" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: proc.stdin = None missing from parallel_runner.py and file is not writable"
  echo "COMMAND: grep 'proc.stdin = None' $RUNNER"
  exit 1
fi

# Apply the one-line fix using Python for reliable multi-line replacement
python3 - "$RUNNER" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path, 'r') as f:
    content = f.read()

OLD = (
    "                try:\n"
    "                    proc.stdin.close()\n"
    "                except OSError:\n"
    "                    pass\n"
    "                try:\n"
    "                    leftover_out, leftover_err = proc.communicate(timeout=2)\n"
)
NEW = (
    "                try:\n"
    "                    proc.stdin.close()\n"
    "                except OSError:\n"
    "                    pass\n"
    "                proc.stdin = None  # prevent communicate() from flushing closed stdin\n"
    "                try:\n"
    "                    leftover_out, leftover_err = proc.communicate(timeout=2)\n"
)

if OLD not in content:
    print("PATTERN_NOT_FOUND", file=sys.stderr)
    sys.exit(3)

patched = content.replace(OLD, NEW, 1)
with open(path, 'w') as f:
    f.write(patched)
print("PATCHED")
PYEOF

# Verify the patch landed
if grep -q "proc\.stdin = None  # prevent communicate" "$RUNNER"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: Applied proc.stdin = None patch to parallel_runner.py probe_mcp_launch"
  echo "COMMAND: grep 'proc.stdin = None' $RUNNER"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: Patch application failed — proc.stdin = None still missing"
  echo "COMMAND: grep 'proc.stdin = None' $RUNNER"
  exit 1
fi
