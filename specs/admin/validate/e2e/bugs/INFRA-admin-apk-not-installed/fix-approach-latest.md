# Fix Approach: INFRA-admin-apk-not-installed

Added Step 6c to `test/e2e/setup.sh` that builds and installs the admin APK whenever
`E2E_WANT_EMULATOR=1` and the emulator (`emulator-5554`) is reachable via adb.

Previously, `setup.sh` ran the Gradle SDK overlay trigger for both `customer/` and `admin/`
(Step 6b) but never called `flutter build apk --debug` or `adb install` for the admin app.
As a result `com.kanix.kanix_admin` was absent from the emulator's package list, blocking all
E2E tests that interact with the admin Flutter UI.

The new step runs `flutter pub get` (idempotent), then `flutter build apk --debug` in `admin/`,
and installs the resulting APK with `adb -s emulator-5554 install -r`. Build output is logged to
`$STATE_DIR/admin-build.log`. The step is gated behind `adb get-state` so it silently skips when
the emulator is not up (e.g. API-only runs).
