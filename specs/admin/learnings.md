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

## T007 — process-compose.yml
- SuperTokens Main class resolves `config.yaml` relative to the install dir argument, NOT CWD — if you `cd` into the install dir and pass a relative path like `./.dev/...`, it becomes a double-nested path. Fix: resolve to absolute path with `$(cd ... && pwd)` before passing to Main.
- SuperTokens ignores CLI args like `postgresql_connection_uri=...` in DEV mode — must write settings to `config.yaml` instead.
- `pg_isready` without `-d` defaults to connecting to a database named after the current OS user — add `-d postgres` to avoid noisy "database does not exist" errors in readiness probes.

## T010 — api/ project initialization
- Vitest v3 exits with code 1 when no test files are found — set `passWithNoTests: true` in vitest config to allow `pnpm test` to succeed with no tests yet
- ESLint v9 flat config with `typescript-eslint` works out of the box — use `tseslint.config()` wrapper with `projectService: true` for type-aware linting

## T011 — Vitest custom reporter
- Vitest custom reporters can be specified as file paths in `vitest.config.ts` `reporters` array — use `["default", "./src/test-reporter.ts"]` to keep console output AND produce JSON
- The `Reporter` interface's `onFinished(files?)` receives the complete test tree — traverse `file.tasks` recursively to collect suite/test results (suites have nested `tasks`, tests have `result`)

## T012 — Config module
- ESLint `@typescript-eslint/no-non-null-assertion` rule is enabled — use `?? ""` fallback instead of `!` assertions even when validation guarantees presence
- Node 22 has `process.loadEnvFile()` but it modifies `process.env` directly — for layered precedence (defaults → .env → env vars) implement a custom parser

## T013 — Error hierarchy
- Straightforward module — no external dependencies needed. Prettier reformats constructor signatures with multiple params to single-line; run `pnpm format` before lint check

## T014 — Pino structured logging
- Pino v10 writes to stderr by default (good for structured logging). To capture output in tests, pass a `Writable` stream as `destination` option — pino's second constructor arg accepts `DestinationStream`
- ESLint `@typescript-eslint/no-require-imports` rule blocks `require()` in tests — use ESM `import` at module top and pass pino instances via `createLogger({ destination: stream })` instead of inline `require("pino")(opts, stream)`

## T015 — Graceful shutdown
- Module-level `shutdownInitiated` flag works for `/ready` endpoint integration but makes test isolation tricky — the flag persists across tests in the same Vitest run. Future: consider resetting via an exported `_resetForTesting()` if tests need to check `isShuttingDown() === false`
- Use `EventEmitter` as a fake `NodeJS.Process` for testing signal handlers — cast via `as unknown as NodeJS.Process` since only `.on()` and `.emit()` are needed

## T016 — Fastify server skeleton
- `createServer` registers shutdown signal handlers on `processRef` — in tests, MUST pass a fake `EventEmitter` process to avoid Vitest catching `process.exit(0)` calls as unhandled rejections during teardown
- Fastify `app.inject()` is the right way to test endpoints without opening a real port — use `PORT: 0` in test config and `app.ready()` instead of `start()`

## T017 — Security middleware (CORS, rate limiting, security headers)
- Fastify hooks execute in registration order — register CORS/rate-limit hooks before route handlers so they can short-circuit with 403/429 before the handler runs
- In-memory rate limiting with `Map<string, {count, resetTime}>` is sufficient for single-instance; use `setInterval` with `.unref()` for cleanup to avoid keeping the process alive
- Security headers must use `onSend` hook (not `onRequest`) to ensure they appear on ALL responses including error responses

## T018 — JSON schema validation plugin
- Fastify 5 accepts `ajv: { customOptions: { removeAdditional: true } }` in the constructor to strip extra fields — no need for a separate Ajv instance or `setValidatorCompiler`
- Validation errors on `FastifyError` have a `.validation` array with Ajv error objects; for "required" errors, `instancePath` is the parent and `params.missingProperty` contains the missing field name

## T019 — Global error handler
- Fastify supports only one `setErrorHandler` — the global error handler must unify validation errors, AppError subclasses, and unknown errors in a single handler. Moved `formatFieldPath` from validation.ts into error-handler.ts.
- Use `"validation" in error` check to detect Fastify validation errors (they have a `.validation` array), then `instanceof AppError` for typed errors, with unknown errors as the fallback.

## T020 — CI workflow
- `returntocorp/semgrep-action@v1` has limited control over SARIF output path — using `pip install semgrep` + CLI directly gives better control over `--sarif --output` flags
- `gitleaks/gitleaks-action@v2` doesn't support custom `args` input — install gitleaks CLI directly for SARIF output control via `--report-format sarif --report-path`
- Security scan steps should use `|| true` or `if: always()` to avoid blocking the pipeline on findings while still uploading SARIF results

## T021 — Security scanner script
- Gitleaks `detect` writes an empty JSON array `[]` (not empty file) when no secrets found — parse with `len(data) if isinstance(data, list)` to handle both cases
- All four scanners (trivy, semgrep, gitleaks, npm audit) are available from the Nix devshell — no installation needed in the script

## T022 — CLAUDE.md development section
- No UI_FLOW.md exists in the project yet — task mentions it but there's nothing to reference until a future task creates it
- CLAUDE.md is loaded into Claude Code context automatically — keep it concise to avoid context window bloat

## T023 — Smoke test: server boots and responds
- `createShutdownManager` defaults `exitFn` to `process.exit.bind(process)` (the real process, not `processRef`) — smoke tests that trigger SIGTERM shutdown must `vi.spyOn(process, "exit").mockImplementation(...)` to prevent Vitest from catching the real `process.exit(0)` call
- Use `fetch()` against the real address returned by `server.start()` for true smoke tests; `app.inject()` bypasses the network stack
