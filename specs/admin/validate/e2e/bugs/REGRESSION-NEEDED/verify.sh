#!/usr/bin/env bash
# REGRESSION-NEEDED — requires a full E2E run to validate contributor dashboard happy path
# BUG-034 and BUG-035 are now fixed; APK rebuild + device re-run of steps 4-11 is required.
# Exit 2 (inconclusive) — let runner spawn a verify agent.
echo "STATUS: INCONCLUSIVE"
echo "EVIDENCE: BUG-034 and BUG-035 fixed; regression spec requires E2E APK rebuild and device run (steps 4-11)"
echo "COMMAND: cd customer && flutter clean && flutter build apk --debug && adb install -r build/app/outputs/flutter-apk/app-debug.apk"
exit 2
