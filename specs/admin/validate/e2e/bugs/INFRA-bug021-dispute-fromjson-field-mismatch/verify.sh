#!/usr/bin/env bash
# Verifies INFRA-bug021 — same check as BUG-021.
set -eu
exec "$(dirname "$0")/../../BUG-021/verify.sh"
