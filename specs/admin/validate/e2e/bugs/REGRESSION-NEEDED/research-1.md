# Research: REGRESSION-NEEDED — Regression spec cannot be produced until BUG-031/032/033 fixed

## Root cause analysis

The contributor dashboard happy path could not be validated in any executor spawn because:
- BUG-031 blocked navigation (no link to /contributor)
- BUG-032 blocked access (wrong gate logic)
- BUG-033 blocked data display (model/API mismatch → all zeros)

These three bugs must be fixed before a regression test can verify correct behavior.

## Evidence

Executor iteration 2, spawn 3: steps 4-11 skipped across two spawns; no happy path reached.
Expected state: totalSales=26, royalty~$51.75, royalty_activation milestone reached, 1 design listed.

## Recommended fix strategy

This item has no code fix. Once BUG-031/032/033 are fixed:
1. Rebuild APK: `cd customer && flutter clean && flutter build apk --debug && adb install -r build/app/outputs/flutter-apk/app-debug.apk`
2. Re-run executor steps 4-11
3. Write regression spec based on actual validated behavior

The verify.sh for REGRESSION-NEEDED will exit 2 (inconclusive) since it requires a full E2E run.

## What NOT to do

- Don't write a regression spec against the broken behavior.
- Don't skip this — the verify agent needs to confirm the happy path once unblocked.

## Confidence

High — this is a tracking item, not a code fix. Confidence in the plan is high; execution depends on BUG-031/032/033 fixes landing correctly.
