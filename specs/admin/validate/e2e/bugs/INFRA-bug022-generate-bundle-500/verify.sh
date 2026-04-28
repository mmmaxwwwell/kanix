#!/usr/bin/env bash
# Verifies INFRA-bug022 — same check as BUG-022.
set -eu
exec "$(dirname "$0")/../../BUG-022/verify.sh"
