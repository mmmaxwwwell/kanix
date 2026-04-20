# Kanix - Claude Code Instructions

## Quick Start

```bash
# 1. Enter the Nix dev shell (provides Node 22, pnpm, Flutter, PostgreSQL, etc.)
nix develop

# 2. Set up environment variables
cp .env.example .env
# Edit .env with real values (Stripe keys, DB URL, etc.)

# 3. Install API dependencies
cd api && pnpm install && cd ..

# 4. Start all services (PostgreSQL, SuperTokens, etc.)
process-compose up

# 5. Run the API dev server (in a separate terminal, from api/)
cd api && pnpm dev
```

## Project Structure

```
kanix/
├── api/             # Fastify + TypeScript backend (pnpm)
├── site/            # Astro marketing site with Three.js STL viewer
├── admin/           # Flutter admin dashboard app
├── customer/        # Flutter customer-facing app
├── scad/            # OpenSCAD 3D models (BOSL2 library)
├── deploy/          # NixOS + OpenTofu deployment configs
├── scripts/         # Dev scripts (security scan, SuperTokens setup, etc.)
├── stl/             # Rendered STL files
├── process-compose.yml  # Local dev orchestration (Postgres, SuperTokens)
├── flake.nix        # Root Nix flake (dev environment)
└── .env.example     # Environment variable template
```

## Available Scripts

### API (`api/`)

| Command               | Description                              |
|------------------------|------------------------------------------|
| `pnpm dev`            | Start dev server with hot reload (tsx)   |
| `pnpm build`          | Compile TypeScript to `dist/`            |
| `pnpm start`          | Run compiled server from `dist/`         |
| `pnpm test`           | Run Vitest tests                         |
| `pnpm test:watch`     | Run Vitest in watch mode                 |
| `pnpm test:coverage`  | Run tests with coverage                  |
| `pnpm lint`           | ESLint + Prettier check                  |
| `pnpm lint:fix`       | Auto-fix lint + format issues            |
| `pnpm format`         | Format code with Prettier                |
| `pnpm typecheck`      | Type-check without emitting              |
| `pnpm db:migrate`     | Run Liquibase DB migrations              |
| `pnpm db:rollback`    | Rollback last migration                  |

### Site (`site/`)

| Command           | Description                              |
|--------------------|------------------------------------------|
| `npm run dev`     | Start Astro dev server                   |
| `npm run build`   | Render STLs + build Astro site           |
| `npm run render`  | Render OpenSCAD models to STL            |
| `npm run test`    | Run link checker                         |
| `npm run preview` | Preview production build                 |

### Flutter Apps (`admin/`, `customer/`)

| Command              | Description                          |
|-----------------------|--------------------------------------|
| `flutter test`       | Run widget/unit tests                |
| `flutter run`        | Launch app on connected device       |
| `flutter build web`  | Build for web                        |
| `flutter analyze`    | Run Dart static analysis             |

### Root Scripts

| Command                        | Description                                  |
|---------------------------------|----------------------------------------------|
| `scripts/security-scan.sh`     | Run trivy, semgrep, gitleaks, npm audit       |
| `scripts/setup-supertokens.sh` | Download and configure SuperTokens locally    |
| `scripts/test-scad.sh`         | Test OpenSCAD models                          |
| `process-compose up`           | Start all local services (Postgres, SuperTokens) |

## Environment Setup

1. Copy `.env.example` to `.env`: `cp .env.example .env`
2. Fill in real values for services you need:
   - **DATABASE_URL** — PostgreSQL connection string (default works with `process-compose up`)
   - **STRIPE_SECRET_KEY** — from Stripe dashboard (`sk_test_…`)
   - **PUBLIC_STRIPE_PUBLISHABLE_KEY** — from Stripe dashboard (`pk_test_…`); `site/.env` is auto-synced from root `.env` by [scripts/sync-env.sh](scripts/sync-env.sh)
   - **STRIPE_WEBHOOK_SECRET** — managed by the listener scripts (see E2E section below); don't set manually
   - **STRIPE_TAX_ENABLED** — `true` or `false` for Stripe Tax
   - **SUPERTOKENS_API_KEY** / **SUPERTOKENS_CONNECTION_URI** — auth service
   - **EASYPOST_API_KEY** — shipping integration
   - **GITHUB_OAUTH_CLIENT_ID** / **GITHUB_OAUTH_CLIENT_SECRET** — contributor login
   - **LOG_LEVEL** — `DEBUG`, `INFO`, `WARN`, `ERROR`, or `FATAL`
   - **PORT** — API server port (default: 3000)

## Test Commands

| Platform    | Command                         | Working Directory |
|-------------|----------------------------------|-------------------|
| API         | `pnpm test`                     | `api/`            |
| API (watch) | `pnpm test:watch`               | `api/`            |
| Site        | `npm test`                      | `site/`           |
| Admin app   | `flutter test`                  | `admin/`          |
| Customer app| `flutter test`                  | `customer/`       |
| OpenSCAD    | `bash scripts/test-scad.sh`     | root              |
| Security    | `bash scripts/security-scan.sh` | root              |

## E2E Tests with Stripe

Tests that drive real Stripe payments (T096, T097, T104c, T104f) need a
`stripe listen` process forwarding webhooks to `localhost:3000/webhooks/stripe`.
Agents manage the listener lifecycle explicitly:

```bash
# Start (idempotent). Prints JSON {pid, secret, forward_to, log, reused}.
# Writes STRIPE_WEBHOOK_SECRET to root .env — restart the API after.
pnpm --dir api stripe:listen:start

# Stop (safe when nothing is running).
pnpm --dir api stripe:listen:stop
```

First-time setup:
1. Get test keys at https://dashboard.stripe.com/test/apikeys and set
   `STRIPE_SECRET_KEY` + `PUBLIC_STRIPE_PUBLISHABLE_KEY` in root `.env`.
2. Run `stripe login` once (opens a browser to pair the CLI with your account).

See [test/e2e/README.md](test/e2e/README.md) for the full agent workflow.

## Adding a New Module Checklist

1. Create the `.scad` file in `scad/` with the CC BY-NC 4.0 license header
2. Add the module entry to `site/src/data/modules.ts` (slug, name, description, scadFile, stlFile, optional products)
3. Add a row to the "Available Modules" table in `README.md`
4. Render STLs: `cd site && npm run render`
5. Verify the site builds: `cd site && npm run build`
6. Run link checker: `cd site && npm test`

## Pre-Push Checklist

1. All `.scad` files in `scad/` have a matching entry in `site/src/data/modules.ts`
2. All modules in `modules.ts` have a matching row in the `README.md` table
3. STLs are rendered and present in `site/public/models/`
4. Site builds without errors
5. Link checker passes

## Tech Stack

- **API**: Fastify + TypeScript with Pino logging, Vitest tests
- **Site**: Astro with Tailwind CSS and Three.js STL viewer
- **Admin/Customer**: Flutter (Dart)
- **3D Models**: OpenSCAD with BOSL2 library
- **Database**: PostgreSQL with Liquibase migrations
- **Auth**: SuperTokens
- **Payments**: Stripe
- **Shipping**: EasyPost
- **Dev Environment**: Nix flake with process-compose for local services
- `site/src/data/modules.ts` is the single source of truth for module registry
