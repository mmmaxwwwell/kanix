#!/usr/bin/env bash
# Verifies INFRA-runner-crash-timeoutexpired — adb logcat TimeoutExpired crash in parallel_runner.py.
# The fix must be applied to agent-framework (read-only mount in agent sandbox).
# Cannot scripted-verify without running the E2E loop — exit 2 (inconclusive).
echo "STATUS: INCONCLUSIVE"
echo "EVIDENCE: Fix requires patching parallel_runner.py line 14822-14825 in agent-framework (ro mount); re-run T101 E2E loop to confirm no TimeoutExpired crash"
echo "COMMAND: grep -n 'TimeoutExpired' /home/max/git/agent-framework/.claude/skills/spec-kit/parallel_runner.py | grep -A2 'logcat'"
exit 2
