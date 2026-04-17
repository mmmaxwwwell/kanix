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

## T004 — api/ sub-flake
- `jdk21_headless` and `postgresql_16` are available in nixpkgs unstable — no need for version-specific overlays
- `nix flake check` needs `--extra-experimental-features 'nix-command flakes'` if nix.conf isn't configured (or use `NIX_REMOTE=daemon` per T001 learning)

## T005 — admin/ and customer/ Flutter sub-flakes
- nixpkgs flutter package ships `flutter_tester` binary without execute permission — `flutter test` fails with "lacked sufficient permissions to execute". Workaround: set `FLUTTER_ROOT` env var to a symlink-farm copy where only `flutter_tester` is a real file with `+x`. The flutter wrapper binary uses `setenv("FLUTTER_ROOT", ..., 0)` (no-overwrite), so a pre-set `FLUTTER_ROOT` takes precedence.
- When building the symlink-farm, each directory level must be `mkdir -p` then symlink children selectively (excluding the next level down). Don't `mkdir -p` the full path first then symlink siblings — `ln -sf` can't replace a real directory with a symlink.
- `.flutter-patched/` directories should be gitignored; they're created per-project by the shellHook on first `nix develop`.

## T006 — deploy/ sub-flake
- `nginx` package is available in nixpkgs unstable — no special overlay needed
- Simplest sub-flakes (deploy, site, api) all follow the same pattern: nixpkgs + flake-utils, single `mkShell` with `packages`
