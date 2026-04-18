#!/usr/bin/env bash
# e2e-check-prereqs.sh — Verify KVM + CPU virtualization prerequisites for Android emulator
# The Android emulator itself is managed by the spec-kit runner's PlatformManager,
# but this script ensures the host has the required hardware virtualization support.
set -euo pipefail

ERRORS=0

echo "=== E2E Prerequisite Check ==="
echo ""

# Check 1: CPU supports hardware virtualization (vmx for Intel, svm for AMD)
echo "Checking CPU virtualization extensions..."
VMX_COUNT=$(grep -E -c '(vmx|svm)' /proc/cpuinfo 2>/dev/null || echo "0")
if [ "$VMX_COUNT" -gt 0 ]; then
  echo "  OK: CPU virtualization supported (${VMX_COUNT} cores with vmx/svm)"
else
  echo "  FAIL: No CPU virtualization extensions found (vmx/svm)."
  echo "        Hardware virtualization must be enabled in BIOS/UEFI."
  echo "        The Android emulator requires KVM for acceptable performance."
  ERRORS=$((ERRORS + 1))
fi

# Check 2: KVM is available and accessible
echo "Checking KVM availability..."
if command -v kvm-ok >/dev/null 2>&1; then
  if kvm-ok >/dev/null 2>&1; then
    echo "  OK: kvm-ok passed — KVM acceleration available"
  else
    echo "  FAIL: kvm-ok reports KVM is NOT available."
    echo "        Ensure KVM kernel modules are loaded (kvm, kvm_intel or kvm_amd)."
    echo "        Try: sudo modprobe kvm_intel  (or kvm_amd for AMD CPUs)"
    ERRORS=$((ERRORS + 1))
  fi
elif [ -e /dev/kvm ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    echo "  OK: /dev/kvm exists and is accessible (kvm-ok not installed, using fallback)"
  else
    echo "  FAIL: /dev/kvm exists but is not readable/writable by current user."
    echo "        Add your user to the 'kvm' group: sudo usermod -aG kvm \$USER"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  FAIL: /dev/kvm does not exist."
  echo "        KVM kernel modules may not be loaded."
  echo "        Try: sudo modprobe kvm_intel  (or kvm_amd for AMD CPUs)"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: ${ERRORS} prerequisite check(s) failed."
  echo "The Android emulator requires KVM hardware acceleration."
  exit 1
else
  echo "All prerequisite checks passed."
  exit 0
fi
