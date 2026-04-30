#!/usr/bin/env bash
# Verifies BUG-003 — _addPhoto() now uses real image picker instead of fake filenames
set -eu

WARRANTY="customer/lib/screens/warranty_screen.dart"
PUBSPEC="customer/pubspec.yaml"

# Check image_picker dependency is present
if ! grep -q "image_picker" "$PUBSPEC" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: image_picker not found in $PUBSPEC"
  echo "COMMAND: grep image_picker $PUBSPEC"
  exit 1
fi

# Check ImagePicker().pickImage is called (real picker, not stub)
if ! grep -q "ImagePicker" "$WARRANTY" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $WARRANTY does not use ImagePicker — stub still in place"
  echo "COMMAND: grep ImagePicker $WARRANTY"
  exit 1
fi

# Check the stub pattern is gone ('photo_' fake filename pattern)
if grep -q "'photo_\${_photoNames" "$WARRANTY" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $WARRANTY still contains stub pattern 'photo_N.jpg'"
  echo "COMMAND: grep photo_ $WARRANTY"
  exit 1
fi

echo "STATUS: FIXED"
echo "EVIDENCE: $PUBSPEC has image_picker; $WARRANTY uses ImagePicker().pickImage(); stub removed"
echo "COMMAND: grep -n 'ImagePicker' $WARRANTY; grep image_picker $PUBSPEC"
exit 0
