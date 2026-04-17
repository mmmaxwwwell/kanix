# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T001 — Root flake.nix
- Nix daemon runs but `/nix/var/nix/db/big-lock` is owned by `nobody` — must use `NIX_REMOTE=daemon` for all nix commands (flake check, develop, eval, etc.) to avoid "Permission denied" errors
- `~/.config/nix/nix.conf` with `experimental-features = nix-command flakes` needed; no system nix.conf exists
- All required packages (nodejs_22, pnpm, flutter, opentofu, liquibase, postgresql, process-compose, openscad-unstable, trivy, semgrep, gitleaks) are available in nixpkgs unstable without extra overlays

## T002 — scad/ sub-flake
- `inputsFrom` in `mkShell` merges `buildInputs`/`nativeBuildInputs` but does NOT propagate custom env vars (like `OPENSCADPATH`) — must set them explicitly in the consuming shell
- BOSL2 can be fetched as a non-flake GitHub input (`flake = false`) and packaged via `stdenvNoCC.mkDerivation` — just copy `*.scad` into `$out/BOSL2/`
- New `.nix` files in a git repo must be `git add`'d before `nix flake check` can see them (untracked files are invisible to Nix)

## T003 — site/ sub-flake
- Simple sub-flakes (just packages, no custom derivations) need only nixpkgs + flake-utils — no special packaging logic required
- pnpm from nixpkgs works directly with existing `package.json` that was using npm — `pnpm install` migrates seamlessly (moves npm-installed modules to `.ignored`)
