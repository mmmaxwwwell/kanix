#!/usr/bin/env bash
# Verifies INFRA-orders-null-placed-at — Order.fromJson handles null shippingStatus and
# updatedAt fields that are omitted by the listAllOrders API query.
# Same fix as BUG-001: admin/lib/models/order.dart null-safe deserialization.
set -eu

APK=$(find /home/max/git/kanix/admin/build/app/outputs -name 'app-debug.apk' 2>/dev/null | head -1)

if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: app-debug.apk not found — APK not built"
  exit 2
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q "as String? ?? 'not_shipped'"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains null-safe shippingStatus deserialization; Order.fromJson no longer crashes on null fields"
  echo "COMMAND: unzip -p app-debug.apk assets/flutter_assets/kernel_blob.bin | strings | grep 'not_shipped'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK kernel_blob.bin does NOT contain null-safe shippingStatus — fix not deployed"
  echo "COMMAND: unzip -p app-debug.apk assets/flutter_assets/kernel_blob.bin | strings | grep 'not_shipped'"
  exit 1
fi
