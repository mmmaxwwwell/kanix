#!/usr/bin/env bash
# e2e-install-apks.sh — Build and install admin + customer Flutter debug APKs on the running emulator
#
# App package IDs:
#   Admin:    com.kanix.kanix_admin
#   Customer: com.kanix.kanix_customer
#
# Usage: scripts/e2e-install-apks.sh [--skip-build]
#   --skip-build  Skip Flutter build step; install pre-built APKs only
#
# Idempotent: safe to run multiple times. Uses `adb install -r` to replace existing installs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

ADMIN_APK="$ROOT_DIR/admin/build/app/outputs/flutter-apk/app-debug.apk"
CUSTOMER_APK="$ROOT_DIR/customer/build/app/outputs/flutter-apk/app-debug.apk"

# Verify adb is available
if ! command -v adb >/dev/null 2>&1; then
  echo "FAIL: adb not found in PATH."
  echo "Ensure the Android SDK platform-tools are available (provided by the Nix devshell)."
  exit 1
fi

# Verify at least one device/emulator is connected
DEVICE_COUNT=$(adb devices | grep -c -E '\t(device|emulator)' || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "FAIL: No connected Android device or emulator found."
  echo "Start an emulator first (managed by the spec-kit runner's PlatformManager)."
  echo ""
  echo "Connected devices:"
  adb devices
  exit 1
fi

echo "=== E2E APK Install ==="
echo "Detected $DEVICE_COUNT device(s)/emulator(s)."
echo ""

# Build debug APKs
if [ "$SKIP_BUILD" = false ]; then
  echo "Building admin debug APK..."
  (cd "$ROOT_DIR/admin" && flutter build apk --debug)
  echo ""

  echo "Building customer debug APK..."
  (cd "$ROOT_DIR/customer" && flutter build apk --debug)
  echo ""
else
  echo "Skipping build (--skip-build)."
  echo ""
fi

# Verify APKs exist
for apk_path in "$ADMIN_APK" "$CUSTOMER_APK"; do
  if [ ! -f "$apk_path" ]; then
    echo "FAIL: APK not found at $apk_path"
    echo "Run without --skip-build to build APKs first."
    exit 1
  fi
done

# Install APKs (replace existing)
echo "Installing admin APK..."
adb install -r "$ADMIN_APK"
echo ""

echo "Installing customer APK..."
adb install -r "$CUSTOMER_APK"
echo ""

echo "=== APK Install Complete ==="
echo "Installed packages:"
echo "  Admin:    com.kanix.kanix_admin"
echo "  Customer: com.kanix.kanix_customer"
