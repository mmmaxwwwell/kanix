# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T001 — Root flake.nix
- Nix daemon runs but `/nix/var/nix/db/big-lock` is owned by `nobody` — must use `NIX_REMOTE=daemon` for all nix commands (flake check, develop, eval, etc.) to avoid "Permission denied" errors
- `~/.config/nix/nix.conf` with `experimental-features = nix-command flakes` needed; no system nix.conf exists
- All required packages (nodejs_22, pnpm, flutter, opentofu, liquibase, postgresql, process-compose, openscad-unstable, trivy, semgrep, gitleaks) are available in nixpkgs unstable without extra overlays
