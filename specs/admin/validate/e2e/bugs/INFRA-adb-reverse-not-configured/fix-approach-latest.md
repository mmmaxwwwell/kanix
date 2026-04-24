# Fix Approach: INFRA-adb-reverse-not-configured

Moved the `adb reverse` block out of the `if start-emulator` success branch in `test/e2e/setup.sh`.
Previously the block ran only when `start-emulator` returned 0 in the current run, so if the emulator
was already running from a prior session (and `start-emulator` was skipped or succeeded trivially),
the reverse rules were never re-applied — even though they don't persist across emulator restarts.

The fix restructures Step 6 so that after `start-emulator` runs (success or failure), the script
unconditionally checks `adb -s emulator-5554 get-state` and, if the emulator is reachable, applies
`adb reverse` for ports `PORT_API` and `PORT_SUPERTOKENS`. This ensures apps on the emulator can
always reach host services regardless of which setup.sh run originally booted the emulator.
