# Workflows — Belt Editor

This document is the test contract for the belt-editor feature. Each
workflow is one E2E test, exhaustively scripted at selector + network
granularity. The `tasks.md` E2E phase generates one task per workflow.

## Personas

- **Developer** (`W-DEV-*`): a human running `npm run dev` against the
  editor code locally; hot reload, debugging, profiling.
- **Sysadmin** (`W-SYS-*`): a human building and deploying the static
  Astro site to Cloudflare Pages (or similar).
- **Anonymous Visitor** (`W-ANON-*`): a human or crawler visiting
  loadout pages with JavaScript disabled or unavailable.
- **Editor User** (`W-USER-*`): a JS-enabled visitor using the
  interactive editor to design Modules and Belts, save to localStorage,
  and export/import bundles.
- **Site Author** (`W-AUTHOR-*`): a Kanix team member building a page
  that embeds a read-only belt visual (e.g. a product detail page for
  a kit).

## Coverage matrix

| Persona | Workflow count | Touches |
|---|---|---|
| Developer | 8 | plan.md DX + SC-013 |
| Sysadmin | 4 | FR-203, FR-650, SC-002, SC-007, SC-013 |
| Anonymous Visitor | 3 | US-1, FR-650, FR-653, SC-007 |
| Editor User | 17 | US-2..US-6, US-8, US-9, FR-300..FR-803, SC-003..SC-006, SC-009..SC-012, SC-014 |
| Site Author | 2 | US-7, FR-652, SC-008 |

---

## Developer workflows

### W-DEV-1 — Cold `npm run dev` produces a working editor

**Persona**: Developer
**Touches**: plan.md DX section
**Trigger**: `cd site && npm run dev` from a fresh clone (after
`nix develop` and `npm install`).
**Preconditions**: Node 22 available; SCAD models rendered (run
`npm run render` first to seed `.holes.json` files).
**Bypass paths**: no production env vars; no Stripe/auth services.

**Steps**:

1. **Action**: Run `cd site && npm run dev` and wait for "Local:" line.
   **Expected DOM**: console outputs `Local: http://localhost:4321/`
   within 10s.
   **Expected network**: none (server startup is local).
   **Negative assertions**: no `Error:` or `EADDRINUSE`; exit code is
   non-zero only if user Ctrl-Cs.

2. **Action**: Open `http://localhost:4321/loadouts/trainer/` in
   Chrome.
   **Expected DOM**: page contains:
   - `role="main"` landmark
   - An SVG belt visual with `role="img"` and accessible name
     containing "Trainer"
   - A `role="list"` of Modules with ≥1 `role="listitem"`
   - A `role="button"` with accessible name "Export" (after hydration)
   - A `role="button"` with accessible name "Save"
   - [CC-2] a Tailwind class on `body` has resolved computed style
     (e.g. background-color is not `rgba(0,0,0,0)`).
   **Expected network**: GET `/loadouts/trainer/` 200; GET for editor
   JS chunk; GET for STL preview file(s) referenced by the preset
   (200 each); NO GET to collision worker bundle (not loaded yet).
   **Negative assertions**: [CC-1] no console errors or warnings;
   no GET to `/api/*` (no API in v1).

3. **Action**: Edit `site/src/components/editor/Palette.tsx`, change a
   visible string, save.
   **Expected DOM**: page hot-reloads within 1s; new string visible.
   **Expected network**: WS frame from Vite HMR.
   **Negative assertions**: no full-page reload; editor state
   (e.g. currently-grabbed item) preserved if applicable.

**Edge cases**:
- E1: SCAD models not yet rendered → step 2 errors with "no
  `.holes.json` for <model>". Test asserts the error message contains
  the affected filename.
- E2: Port 4321 in use → step 1 fails with EADDRINUSE; Vite auto-picks
  next port. Test asserts the "Local:" URL uses the new port.

**Performance budget**: cold start to first interactive editor ≤10s on
a developer workstation.
**Test command**: manual + smoke via Playwright (`npm run test:e2e --
--grep W-DEV-1`).

---

### W-DEV-2 — Unit tests run and pass

**Persona**: Developer
**Touches**: plan.md Testing strategy
**Trigger**: `cd site && npm test` or `npm run test:unit`.
**Preconditions**: `npm install` complete.
**Bypass paths**: no E2E, no browser; pure Vitest.

**Steps**:

1. **Action**: Run `npm run test:unit`.
   **Expected DOM**: n/a (CLI).
   **Expected network**: none.
   **Negative assertions**: zero failed tests; exit 0.

**Performance budget**: full unit suite ≤30s on dev workstation.
**Test command**: `npm run test:unit`.

---

### W-DEV-3 — SCAD round-trip test passes

**Persona**: Developer
**Touches**: SC-003, FR-200..FR-204
**Trigger**: `npm run test:scad-round-trip`.
**Preconditions**: OpenSCAD on PATH (from `nix develop`); SCAD models
have BOSL2 anchors (PREREQ-3 complete).
**Bypass paths**: no UI; no browser.

**Steps**:

1. **Action**: Run the round-trip test for every registered Attachment.
   **Expected**: for each attachment, for each cardinal rotation, the
   editor's snap-math-computed bolt positions match the OpenSCAD-
   rendered positions to within ±0.5mm.
   **Negative assertions**: zero mismatches >0.5mm.

**Performance budget**: ≤2 minutes on dev workstation (slowest test).
**Test command**: `npm run test:scad-round-trip` or
`npm test -- --grep "scad-round-trip"`.

---

### W-DEV-4 — Bundle size budget enforced locally

**Persona**: Developer
**Touches**: SC-013, FR-281
**Trigger**: `npm run size-check` after `npm run build`.
**Preconditions**: `npm run build` succeeded.
**Bypass paths**: no runtime; analyzes static artifacts.

**Steps**:

1. **Action**: Run `npm run build && npm run size-check`.
   **Expected**: size-limit CLI reports core editor chunk ≤80KB
   gzipped AND collision lib chunk ≤250KB gzipped.
   **Negative assertions**: exit 0; no entry over budget.

**Edge cases**:
- E1: A new dependency pushes core over 80KB → size-limit fails with
  diff. Test asserts the failure output includes the chunk name and
  byte overage.

**Performance budget**: build + size-check ≤90s on dev workstation.
**Test command**: `npm run size-check`.

---

### W-DEV-5 — A11y scan passes locally

**Persona**: Developer
**Touches**: SC-009, FR-750..FR-756
**Trigger**: `npm run test:a11y`.
**Preconditions**: `npm run dev` running OR `npm run build && npm run
preview` running.
**Bypass paths**: no manual screen-reader testing; automated only.

**Steps**:

1. **Action**: Run `npm run test:a11y`.
   **Expected**: axe-core scans every editor route; reports 0 serious
   and 0 critical violations.
   **Negative assertions**: no fail; if minor/moderate found, they
   appear as warnings (not failures).

**Edge cases**:
- E1: A new component lacks an accessible name → axe reports a
  serious violation; test fails with the offending selector.

**Performance budget**: ≤45s on dev workstation.
**Test command**: `npm run test:a11y`.

---

### W-DEV-6 — Hole extractor runs and produces JSON for every model

**Persona**: Developer
**Touches**: FR-200..FR-204, SC-002
**Trigger**: `npm run render` (which now includes the extractor).
**Preconditions**: OpenSCAD on PATH; SCAD models have BOSL2 anchors.
**Bypass paths**: no rendering of stub or deprecated models.

**Steps**:

1. **Action**: `cd site && npm run render`.
   **Expected**: for every registered model in `attachments.ts`,
   `plates.ts`, `belt-clips.ts`, a `<model>.holes.json` exists with
   non-empty `anchors[]`.
   **Negative assertions**: no `.scad` registered without `.holes.json`;
   no `.holes.json` with empty `anchors`; build exits non-zero on
   either.

**Edge cases**:
- E1: A new attachment SCAD has no anchors → extractor warns + step
  fails with model name.

**Performance budget**: ≤60s for all models on dev workstation.
**Test command**: `npm run render && bash scripts/verify-holes.sh`.

---

### W-DEV-7 — Editor hydrates without console errors

**Persona**: Developer
**Touches**: FR-651, [CC-1]
**Trigger**: open editor in dev mode with DevTools console.
**Preconditions**: dev server running.

**Steps**:

1. **Action**: Open `/loadouts/trainer/` with empty console;
   wait 3s post-load.
   **Expected DOM**: editor toolbar present and interactive.
   **Negative assertions**: console.errors === 0, console.warnings ===
   0 (hydration phase included).

**Performance budget**: hydration ≤500ms (SC-012 target on dev
workstation, more permissive than CI device profile).
**Test command**: covered by W-USER-1's CC-1 cross-cutting assertion.

---

### W-DEV-8 — Pre-PR gate passes

**Persona**: Developer
**Touches**: plan.md Pre-PR gate
**Trigger**: `npm run pre-pr`.
**Preconditions**: clean working tree.

**Steps**:

1. **Action**: Run `npm run pre-pr`.
   **Expected**: runs (in order): typecheck → lint → test:unit →
   test:scad-round-trip → verify-holes → build → test:e2e →
   size-check. All pass. Final line: "Pre-PR gate: PASS".
   **Negative assertions**: any failure aborts subsequent stages.

**Performance budget**: ≤8 minutes total on dev workstation.
**Test command**: `npm run pre-pr`.

---

## Sysadmin workflows

### W-SYS-1 — `npm run build` succeeds and produces deployable artifact

**Persona**: Sysadmin
**Touches**: FR-650, SC-007, plan.md deployment shape
**Trigger**: `cd site && npm run build`.
**Preconditions**: `npm install`; OpenSCAD available (for `npm run
render` invoked by build).
**Bypass paths**: no live deployment; static output only.

**Steps**:

1. **Action**: Run `npm run build`.
   **Expected**:
   - Exit 0
   - `site/dist/` exists with `index.html` and per-route HTML
   - `site/dist/loadouts/trainer/index.html` exists
   - HTML for every preset contains:
     - `<svg>` with the belt visual
     - `<table>` or `<ul>` listing Modules
     - Print List / BOM / Hardware List sections (text searchable for
       "Print", "BOM", "Hardware")
     - No `<script>`-required content for the static visual
   - Editor JS chunks present in `_astro/`
   - Collision lib chunk present as separate file in `_astro/`
   - Each chunk ≤ its budget (verified by size-check, W-DEV-4)
   **Negative assertions**: no `<script src="">` (missing href); no
   broken `<a href="">` (verified by check-links).

**Performance budget**: ≤3 minutes on CI runner.
**Test command**: `npm run build && bash scripts/check-links.sh`.

---

### W-SYS-2 — Built artifact serves the same UI as dev

**Persona**: Sysadmin
**Touches**: FR-650, FR-651
**Trigger**: `npm run build && npm run preview`.
**Preconditions**: build succeeded.

**Steps**:

1. **Action**: Open `http://localhost:4321/loadouts/trainer/` (preview
   server).
   **Expected DOM**: identical to W-DEV-1 step 2's DOM assertions
   (same role/name/structure).
   **Expected network**: GET for prebuilt HTML + GET for editor JS
   chunk(s) (200); NO GET to collision worker (lazy).
   **Negative assertions**: no Vite HMR WebSocket (preview is
   prod-shaped).

**Performance budget**: page interactive ≤2s.
**Test command**: Playwright `--grep W-SYS-2`.

---

### W-SYS-3 — Curl-fetch of preset returns full static content

**Persona**: Sysadmin (verifying SEO)
**Touches**: FR-650, FR-653, SC-007
**Trigger**: `curl https://kanix.example/loadouts/trainer/`.
**Preconditions**: deployed.

**Steps**:

1. **Action**: `curl -s https://<host>/loadouts/trainer/` and parse the
   HTML.
   **Expected**:
   - Response 200; content-type text/html.
   - Body contains:
     - The belt visual SVG
     - All Module names from the preset (regex match by text)
     - Print List + BOM + Hardware List as inline content
   - No `<noscript>` apology banner suggesting JS is required.
   **Negative assertions**: no AJAX placeholder ("Loading…"); no
   client-rendered-only content missing from raw HTML.

**Performance budget**: response ≤500ms TTFB on CDN.
**Test command**: a small bash test: `bash scripts/test-no-js-content.sh`.

---

### W-SYS-4 — Editor survives stale localStorage from a prior schema version

**Persona**: Sysadmin (handling user reports)
**Touches**: FR-503, FR-554, FR-555
**Trigger**: User loads the site after the schema version was bumped.
**Preconditions**: localStorage contains `kanix.belts.v0` data (legacy);
the deployed site is `schemaVersion: 1`.

**Steps**:

1. **Action**: Seed localStorage with a synthetic v0 payload, load
   `/loadouts/trainer/`.
   **Expected DOM**: editor renders; a banner says "Migrating saved
   data from older format…" briefly, then "Migration complete".
   Saved belts visible in the gallery.
   **Expected network**: none (migration is pure client-side).
   **Negative assertions**: no white screen; no unhandled exception;
   no data loss (every original entry present post-migration).

**Edge cases**:
- E1: Migration fails for an entry → that entry shows in the gallery
  with a "Could not migrate" badge and a "Delete" affordance; other
  entries migrate normally.

**Performance budget**: migration ≤200ms for 10 saved belts.
**Test command**: Playwright `--grep W-SYS-4`.

---

## Anonymous Visitor workflows

### W-ANON-1 — Crawler sees full preset content

**Persona**: Anonymous Visitor
**Touches**: US-1, FR-650, FR-653, SC-007
**Trigger**: bot (Googlebot-style fetch with JS disabled) hits
`/loadouts/<slug>/`.
**Preconditions**: site deployed; preset bundled.
**Bypass paths**: no JS engine in the fetcher.

**Steps**:

1. **Action**: Playwright loads `/loadouts/trainer/` with JS disabled
   (`page.setJavaScriptEnabled(false)`).
   **Expected DOM**:
   - `role="main"` landmark
   - SVG belt visual with `role="img"` and accessible name
   - Module list (`role="list"` of `role="listitem"`)
   - Print List heading + content
   - BOM heading + content
   - Hardware List heading + content
   - [CC-2] body background-color is non-transparent
   **Expected network**: GET HTML 200; GET CSS 200; NO JS GETs (JS
   disabled).
   **Negative assertions**:
   - No `Loading…` / `Hydrating…` placeholder text
   - No "JavaScript required" banner
   - No `role="alert"`
   - No empty `<table>` / `<ul>` skeletons

**Performance budget**: full HTML response ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-ANON-1`.

---

### W-ANON-2 — All preset loadout pages render statically

**Persona**: Anonymous Visitor
**Touches**: FR-650
**Trigger**: Playwright iterates every preset slug.

**Steps**:

1. **Action**: For each preset slug in `loadouts.ts`, repeat W-ANON-1's
   step 1.
   **Expected**: every preset passes the same assertions.
   **Negative assertions**: zero pages with broken layout.

**Performance budget**: ≤30s for all presets.
**Test command**: parameterized Playwright test.

---

### W-ANON-3 — User configs and `/belt-editor/` gallery degrade gracefully

**Persona**: Anonymous Visitor
**Touches**: FR-330, FR-653
**Trigger**: Crawler hits `/belt-editor/`.
**Preconditions**: site deployed.

**Steps**:

1. **Action**: Playwright loads `/belt-editor/` with JS disabled.
   **Expected DOM**:
   - `role="main"` landmark
   - A static list of every bundled Belt preset (since these are SSG-
     known; user-saved presets are NOT visible since they require JS
     to read localStorage)
   - A static message: "Saved presets require JavaScript" or similar
   - Links to each bundled preset (`/loadouts/<slug>/`)
   **Negative assertions**: no Loading skeleton; no broken empty area.

**Performance budget**: response ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-ANON-3`.

---

## Editor User workflows

### W-USER-1 — Hydrate preset and edit a Module

**Persona**: Editor User
**Touches**: US-2, FR-300..FR-356, FR-500, FR-503, SC-004, SC-012
**Trigger**: User visits `/loadouts/trainer/` with JS enabled.
**Preconditions**: clean localStorage.
**Bypass paths**: no collision validation (single attachment placement
not yet finalized).

**Steps**:

1. **Action**: Navigate to `/loadouts/trainer/`.
   **Expected DOM**:
   - SVG belt visual (per W-ANON-1)
   - After hydration (≤500ms post-load): a `role="region"` with
     accessible name "Editor toolbar"; buttons "Export", "Share Link",
     "Save", "Reset to Original", "Add Module"
   - Palette `role="listbox"` accessible name "Attachments"; ≥10
     `role="option"` children
   - [CC-2] body uses Tailwind utility, computed background-color is
     a defined color (not transparent)
   **Expected network**: GET HTML 200; GET editor JS chunk 200; GET
   any inlined attachment thumbnails (≤2 per attachment).
   **Negative assertions**: [CC-1] zero console errors/warnings; no
   collision worker fetch; no localStorage `kanix.*` keys read yet
   (visible via `localStorage.getItem` poll).

2. **Action**: Click any Module in the static belt visual.
   **Expected DOM**: a `role="dialog"` opens showing the Module's
   plate grid with `role="grid"`, cells `role="gridcell"`; each
   AttachmentPlacement appears as a `role="img"` inside its cell with
   accessible name including the attachment name.
   **Negative assertions**: no overlay full-page modal that traps focus
   incorrectly.

3. **Action**: From the Palette, drag the first attachment onto an
   empty cell on the plate grid (mouse drag for desktop).
   **Expected DOM**:
   - Cells under the drag preview show alignment dots (green for
     aligned, red for unaligned). At least 2 should be green at the
     drop target before drop is allowed.
   - On drop: the attachment renders in the cell; a status line
     reads "<n> of <m> bolts aligned, valid".
   **Expected network**: none (purely client-side).
   **Negative assertions**: no errors; the placement is reflected in
   the editor state (verified via subsequent step).

4. **Action**: Click "Save".
   **Expected DOM**:
   - A `role="status"` (toast) shows "Saved".
   - The Save button returns to its idle label.
   - If collision lib not yet loaded: "Loading collision validator…"
     appears briefly; on completion, "Saved".
   **Expected network**: lazy load of the collision worker chunk (one
   GET for the worker .js file, status 200); subsequent worker
   messages (no HTTP).
   **Negative assertions**: no save if collision reports overlap (in
   this case there's only one new placement, so no collision possible).
   localStorage `kanix.belts.v1` now contains the updated Belt with
   the edited Module.

5. **Action**: Reload the page (F5).
   **Expected DOM**: editor re-renders with the edited Module
   reflecting the saved change.
   **Negative assertions**: no flicker showing the original preset
   first; no Loading shimmer >200ms.

**Edge cases**:
- E1: Dropping an attachment where <2 holes align → drop is refused;
  status line says "Need at least 2 aligned bolts to place. Try
  rotating or moving."
- E2: localStorage quota exceeded mid-save → toast says "Storage
  unavailable; export to file instead"; Save button stays clickable;
  state is preserved in-memory.
- E3: Collision lib fails to load → toast says "Could not load
  collision validator; saved without collision validation." The Module
  is marked `validatedCollisions: false`; gallery shows a warning
  badge.
- E4: User holds Shift while dragging → no special behavior (no
  multi-select in v1); behave as single drag.

**Performance budget**: hydration ≤500ms (SC-012); drop response ≤16ms
(60 fps); save ≤300ms (including first-time collision lib load on
cached connection).
**Test command**: `npm run test:e2e -- --grep W-USER-1`.

---

### W-USER-2 — Touch user drags attachment on a phone

**Persona**: Editor User (mobile)
**Touches**: FR-303, FR-305
**Trigger**: User on iPhone Safari opens `/loadouts/trainer/` and
edits.
**Preconditions**: Playwright emulating iPhone 14 viewport + touch.

**Steps**:

1. **Action**: Navigate to `/loadouts/trainer/` in touch-emulated
   Playwright.
   **Expected DOM**: same as W-USER-1 step 1.

2. **Action**: Long-press (≥400ms) on a Palette `role="option"`, then
   drag to a plate cell.
   **Expected DOM**: a drag preview follows the touch point; the page
   does NOT scroll vertically during the drag. On release: drop
   completes as in W-USER-1 step 3.
   **Expected network**: none.
   **Negative assertions**: tap-without-long-press does NOT initiate
   drag (verified by quick-tap which selects/opens the item instead);
   page scroll resumes after release.

3. **Action**: Tap "Save".
   (Same as W-USER-1 step 4.)

**Edge cases**:
- E1: Long-press triggered mid-scroll → drag wins; scroll cancels;
  scroll resumes on drag end.
- E2: Drag off the canvas → drop is canceled; status returns to idle.

**Performance budget**: drag response ≤16ms; long-press threshold
400ms±50ms.
**Test command**: `npm run test:e2e:mobile -- --grep W-USER-2`.

---

### W-USER-3 — Keyboard-only user places an attachment

**Persona**: Editor User (keyboard-only)
**Touches**: FR-304, FR-750, FR-754, SC-009
**Trigger**: User navigates the editor entirely via keyboard.
**Preconditions**: editor hydrated.

**Steps**:

1. **Action**: Press Tab from the address bar until the first Palette
   `option` has focus.
   **Expected DOM**: focused element has visible focus indicator
   (outline width ≥2px, contrast ratio ≥3:1 vs background).
   **Negative assertions**: no focus trap; no `outline: none` without
   replacement.

2. **Action**: Arrow Down to navigate to the desired attachment;
   press Space to grab.
   **Expected DOM**: aria-live region announces "<attachment>
   grabbed. Use arrow keys to move; Space to drop; Escape to cancel."
   **Expected network**: none.

3. **Action**: Tab to the plate grid; arrow keys to cell (2, 1);
   press Space to drop.
   **Expected DOM**: attachment placed; aria-live announces "<name>
   placed at row 2 column 1, rotated 0°, <n> of <m> bolts aligned,
   valid."
   **Negative assertions**: no error; placement reflected in editor
   state.

4. **Action**: With the placement focused, press R to rotate.
   **Expected DOM**: rotation cycles 0→90; aria-live announces
   "Rotated to 90°, <n> of <m> bolts aligned."

5. **Action**: Press Ctrl-Z.
   **Expected DOM**: rotation undoes to 0°; aria-live announces "Undid
   rotation."

6. **Action**: Press Ctrl-Z again.
   **Expected DOM**: placement is removed; aria-live announces "Undid
   placement."

**Edge cases**:
- E1: Press Escape mid-grab → drag cancels; aria-live announces "Drag
  canceled."
- E2: Press Tab during grab → focus moves OUT of palette/grid; grab
  remains active; pressing arrow keys still moves the grabbed item.

**Performance budget**: keystroke response ≤50ms.
**Test command**: `npm run test:e2e -- --grep W-USER-3`.

---

### W-USER-4 — Create a new Module from scratch

**Persona**: Editor User
**Touches**: US-3, FR-330..FR-336
**Trigger**: User opens `/belt-editor/` and clicks "New Module".
**Preconditions**: clean localStorage.

**Steps**:

1. **Action**: Navigate to `/belt-editor/`.
   **Expected DOM**: gallery `role="region"` with accessible name
   "Belt Editor"; cards for each bundled preset; "New Belt" and
   "New Module" buttons.

2. **Action**: Click "New Module".
   **Expected DOM**: `role="dialog"` "Choose Mount" with radio group
   `role="radiogroup"` for Plate/BeltClip and a select `role="combobox"`
   for grid (`3x2`, `4x2`, `3x3`, `4x3`).

3. **Action**: Pick Plate + `3x3`; click Continue.
   **Expected DOM**: thickness picker appears (`6.5mm`, `12mm` for
   52mm belt); default 6.5mm selected.

4. **Action**: Click Create.
   **Expected DOM**: empty plate editor opens at a synthetic route
   (URL contains `?id=<temp>`); plate grid visible; palette visible;
   "Save Module" button visible.

5. **Action**: Drag 2 attachments onto the plate per W-USER-1 step 3.

6. **Action**: Click "Save Module"; in the dialog, enter name "My
   trainer kit"; click Save.
   **Expected DOM**: toast "Module saved"; user is navigated back to
   gallery; the new Module appears under "My Modules".
   **Negative assertions**: localStorage `kanix.modules.v1` now
   contains the new entry.

**Edge cases**:
- E1: User picks `3x3` plate, then changes to a Belt with width 38mm
  → on the belt drop, FR-153 blocks placement with "incompatible mount
  size" error.
- E2: User clicks "Save Module" with 0 attachments → save blocked;
  inline error "Add at least one attachment."

**Performance budget**: dialog open ≤200ms; save ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-USER-4`.

---

### W-USER-5 — Compose a Belt by dragging Modules

**Persona**: Editor User
**Touches**: US-4, FR-400..FR-405
**Trigger**: User clicks "New Belt" in gallery.
**Preconditions**: ≥2 user-saved Modules in localStorage.

**Steps**:

1. **Action**: Click "New Belt" → pick width 52mm.
   **Expected DOM**: empty belt editor opens; Module library panel
   shows user's saved Modules + bundled preset Modules; angle scale
   shown around the belt.

2. **Action**: Drag a Module from the library onto the belt at the
   90° position (right hip).
   **Expected DOM**: angle picker `role="slider"` or numeric input
   appears showing 90°; Module preview at that position.
   On confirm: Module placed; angle locked.

3. **Action**: Drag a second Module to 270° (left hip).

4. **Action**: Hover the first Module; drag it to 100°.
   **Expected DOM**: angle updates live; aria-live "Module moved to
   100°".

5. **Action**: Click "Save Belt"; enter name; Save.
   **Expected DOM**: toast "Belt saved"; gallery now shows the new
   Belt.

**Edge cases**:
- E1: Drag a Module whose mount.beltWidth !== Belt.width → drop
  refused; error "This Module needs a <width>mm belt."
- E2: Two Modules at the same angle → no overlap detection in v1 at
  the belt level (collision worker handles attachment-vs-attachment
  on plate; belt-level needs the same worker but with Module STLs
  transformed by their angle).

**Performance budget**: drop response ≤16ms; save ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-USER-5`.

---

### W-USER-6 — Export and re-import a bundle

**Persona**: Editor User
**Touches**: US-5, FR-550..FR-556, SC-005
**Trigger**: User clicks "Export" with 2 Modules + 1 Belt in library.
**Preconditions**: localStorage has 2 Modules + 1 Belt.

**Steps**:

1. **Action**: Click "Export".
   **Expected DOM**: dialog with two collapsible sections "Modules
   (2)" and "Belts (1)"; each entry has a checkbox; default all
   checked.

2. **Action**: Uncheck the second Module; click "Download".
   **Expected**: a file download is triggered with content-type
   application/json; filename like `kanix-belt-<date>.json`.
   File contents: `ExportBundle` with `modules: [Module1]` and
   `belts: [Belt1]` (Belt1 references both modules but Module2 is
   omitted — import will flag the missing reference).

3. **Action**: Clear localStorage via DevTools or in-app "Clear all
   saved data".

4. **Action**: Click "Import" → choose the exported file.
   **Expected DOM**: dialog shows "Modules (1)" and "Belts (1)" with
   checkboxes (all checked); Belt entry has a warning "References 1
   missing Module — will be shown as placeholder."

5. **Action**: Click "Import Selected".
   **Expected DOM**: toast "Imported 1 Module, 1 Belt (1 placement
   missing)"; gallery now shows them.
   Belt's missing-module reference renders as a placeholder slot in
   the editor.

**Edge cases**:
- E1: Imported JSON is malformed → toast "Could not parse file"; no
  partial import.
- E2: schemaVersion > current → toast "This config was created with
  a newer site version; please update."
- E3: schemaVersion < current → migration runs silently; toast says
  "Imported (migrated from v0)."
- E4: A Module slug collides with an existing one → conflict UI shows
  "Replace / Skip / Save as new" per entry.

**Performance budget**: export ≤200ms; import (10 entries) ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-USER-6`.

---

### W-USER-7 — Share a Belt via URL

**Persona**: Editor User
**Touches**: US-6, FR-600..FR-605, SC-006
**Trigger**: User clicks "Share Link" on a saved Belt.
**Preconditions**: Belt + its referenced Modules in library.

**Steps**:

1. **Action**: Open the Belt in editor; click "Share Link".
   **Expected DOM**: dialog shows a URL `https://<host>/loadouts/<slug>/
   ?config=<encoded>`; a "Copy" button; warning "Anyone with this
   link can see your loadout."

2. **Action**: Copy the URL; open it in a fresh browser context
   (Playwright `browser.newContext()`).
   **Expected DOM**: editor renders the shared Belt; prompt
   `role="dialog"` "Save this loadout to your library?" with Save /
   Discard buttons.
   **Negative assertions**: localStorage in the fresh context is
   empty initially; only Save writes to it.

3. **Action**: Click Save; reload.
   **Expected DOM**: Belt now in library; URL still has `?config=` but
   editor uses the saved version (localStorage wins; URL still parses
   for safety but does not overwrite).

**Edge cases**:
- E1: Encoded payload > 8KB → "Share Link" button is disabled with a
  tooltip "Too large; use file export".
- E2: URL is corrupted (bit-flipped base64) → editor decodes step
  fails; banner "This share link is corrupted" + "Clear" button.
- E3: URL contains schemaVersion older than current → migration runs;
  banner "Loaded from older format."

**Performance budget**: URL generation ≤100ms; decode + render ≤300ms.
**Test command**: `npm run test:e2e -- --grep W-USER-7`.

---

### W-USER-8 — Reset edited preset to original

**Persona**: Editor User
**Touches**: US-8, FR-504
**Trigger**: User edited `trainer` preset; clicks "Reset to Original".
**Preconditions**: localStorage `kanix.belts.v1` contains an edited
`trainer` entry.

**Steps**:

1. **Action**: Navigate to `/loadouts/trainer/`; click "Reset to
   Original".
   **Expected DOM**: confirm dialog "Discard your changes and restore
   the bundled trainer preset? This cannot be undone."

2. **Action**: Click "Reset".
   **Expected DOM**: editor re-renders with the bundled preset; toast
   "Restored to original."
   **Negative assertions**: localStorage `kanix.belts.v1` no longer
   contains `trainer` entry.

**Edge cases**:
- E1: User clicks "Cancel" in confirm → no change; editor stays in
  edited state.

**Performance budget**: reset ≤200ms.
**Test command**: `npm run test:e2e -- --grep W-USER-8`.

---

### W-USER-9 — Create a "pick one of" group

**Persona**: Editor User
**Touches**: US-9, FR-450..FR-455
**Trigger**: User wants to offer alternatives for a slot.
**Preconditions**: ≥2 Modules in library.

**Steps**:

1. **Action**: In belt editor, select 2 Modules from the library (e.g.
   shift-click).
   **Expected DOM**: a contextual menu offers "Group as alternatives".

2. **Action**: Click "Group as alternatives"; enter label "Holster
   options"; pick angle 90°; Confirm.
   **Expected DOM**: a group slot appears on the belt at 90° with a
   "pick 1 of 2" badge; tooltip lists both candidates.

3. **Action**: Click "Save Belt".

4. **Action**: Reload; open the Belt; inspect the print list.
   **Expected DOM**: print list shows group header "Holster options"
   with both Modules' STLs listed as alternatives; hardware list uses
   the worst-case bolt count between the two.

**Edge cases**:
- E1: User selects only 1 Module → "Group as alternatives" disabled
  with tooltip "Select at least 2".
- E2: User dissolves a group → revert to per-Module slots at the same
  angle (FR-802).

**Performance budget**: group creation ≤100ms.
**Test command**: `npm run test:e2e -- --grep W-USER-9`.

---

### W-USER-10 — Undo and redo a long action sequence

**Persona**: Editor User
**Touches**: FR-800..FR-803, SC-010
**Trigger**: User edits a Module with many actions, then undoes
everything.

**Steps**:

1. **Action**: In a fresh Module editor, place 4 attachments, rotate
   2 of them, swap a variant.
   **Expected DOM**: 4 placements visible.

2. **Action**: Press Ctrl-Z 7 times.
   **Expected DOM**: editor returns to empty plate; aria-live
   announces each undo.

3. **Action**: Press Ctrl-Shift-Z 7 times.
   **Expected DOM**: editor returns to the post-step-1 state, byte-
   identical to the editor state at end of step 1 (assert via state
   snapshot comparison in test code).
   **Negative assertions**: no stack overflow; no state divergence.

**Edge cases**:
- E1: Press Ctrl-Z when undo stack is empty → no-op (no error toast).
- E2: User saves between step 1 and step 2 → undo still works for
  in-memory actions; the save itself is NOT undoable (FR-803).

**Performance budget**: each undo/redo ≤50ms.
**Test command**: `npm run test:e2e -- --grep W-USER-10` (mirrors
the Vitest SC-010 unit test against the DOM).

---

### W-USER-11 — Attachment placement requires ≥2 aligned bolts (snap math)

**Persona**: Editor User
**Touches**: FR-250..FR-253, SC-003
**Trigger**: User drops an attachment where bolt alignment fails.

**Steps**:

1. **Action**: Drag a 4-hole attachment to a cell where only 1 hole
   would align.
   **Expected DOM**: alignment dots show 1 green / 3 red; drop
   preview shows status "1 of 4 bolts aligned — need at least 2"; on
   drop attempt: drop is canceled with status "Cannot place: only 1
   bolt aligns. Try rotating or moving."
   **Negative assertions**: no placement added to state.

2. **Action**: Press R while drag is active (or after a preview
   placement); the rotation cycles and the alignment count updates
   live.
   **Expected DOM**: green count changes; at some rotation ≥2 holes
   align; status updates to "valid".

3. **Action**: Drop at the valid rotation.
   **Expected DOM**: placement added with the chosen rotation.

**Edge cases**:
- E1: All 4 rotations have <2 aligned bolts → attachment cannot be
  placed at this cell; tooltip "Try a different cell or attachment."

**Performance budget**: alignment update during drag ≤16ms.
**Test command**: `npm run test:e2e -- --grep W-USER-11`.

---

### W-USER-12 — Collision detection blocks overlapping attachments

**Persona**: Editor User
**Touches**: FR-280..FR-285, SC-014
**Trigger**: User places 2 attachments whose 3D meshes overlap.

**Steps**:

1. **Action**: Place attachment A at cell (0,0) rotated 0°.
2. **Action**: Place attachment B at cell (0,1) rotated 0° such that
   their meshes interpenetrate (test fixture set up to ensure this).
3. **Action**: Click "Save Module".
   **Expected DOM**: "Loading collision validator…" toast (first
   time); on completion: dialog "Collision detected: <A> and <B>
   overlap. Save anyway?"
   **Expected network**: lazy GET of collision worker chunk.
4. **Action**: Click "Cancel"; remove attachment B or rotate it 180°.
5. **Action**: Click "Save Module" again.
   **Expected DOM**: toast "Saved"; Module persists.

**Edge cases**:
- E1: User picks "Save anyway" → Module saves with
  `validatedCollisions: false`; warning badge in gallery.
- E2: Collision worker times out (>5s per pair) → toast "Validation
  inconclusive for <pair>; allowed with warning." Module saves with
  validatedCollisions: false.
- E3: Worker fails to load (network blip) → toast "Could not load
  validator; save without validation?"

**Performance budget**: worker load ≤2s on cached connection;
collision check ≤5s per pair (FR-285).
**Test command**: `npm run test:e2e -- --grep W-USER-12`.

---

### W-USER-13 — A11y conformance scan passes for editor

**Persona**: Editor User (via axe-core)
**Touches**: FR-750..FR-756, SC-009
**Trigger**: axe-core scan during E2E run.

**Steps**:

1. **Action**: Load every editor route (`/loadouts/<slug>/` for every
   preset, `/belt-editor/`, `/belt-editor/new/`); run axe-core.
   **Expected**: zero `serious` and zero `critical` violations.
   `moderate` and `minor` permitted but logged.
   **Negative assertions**: no detected issues with role labeling,
   contrast, focus, or ARIA.

**Performance budget**: scan ≤30s for all routes.
**Test command**: `npm run test:a11y`.

---

### W-USER-14 — Cross-cutting: hardware list recomputes live

**Persona**: Editor User
**Touches**: FR-356, FR-702
**Trigger**: User adds/removes attachments; observes hardware list.

**Steps**:

1. **Action**: Open empty plate; hardware list shows "0 used, <N>
   unused, <N> total" where N = plate hole count.
2. **Action**: Place 2-hole attachment (M3 holes).
   **Expected DOM**: hardware list updates to "M3 × 8mm: 2 used,
   <N-2> unused, <N> total"; plate-to-belt: "M4 × 10mm: 2 used"
   (assuming 2 belt-mount holes).
3. **Action**: Rotate attachment so 4 holes align (if possible).
   **Expected DOM**: hardware list M3 count adjusts to "4 used,
   <N-4> unused."
4. **Action**: Remove attachment.
   **Expected DOM**: hardware list returns to step 1's state.

**Performance budget**: recompute ≤16ms.
**Test command**: `npm run test:e2e -- --grep W-USER-14`.

---

### W-USER-15 — Migration: legacy Loadout → Belt renders identically

**Persona**: Editor User (regression)
**Touches**: FR-900..FR-904, SC-011
**Trigger**: A user loads a preset that was migrated from the legacy
Loadout shape.

**Steps**:

1. **Action**: For every preset in `loadouts.ts`, load the page; take
   a snapshot of the rendered module list (text, order, angles).
2. **Action**: Compare against a pre-migration golden snapshot
   (committed in `test/fixtures/legacy-loadouts-golden.json`).
   **Expected**: every preset matches the golden snapshot exactly
   (same modules at same angles, same variants, same groups).
   **Negative assertions**: zero differences.

**Performance budget**: ≤30s for all presets.
**Test command**: `npm run test:e2e -- --grep W-USER-15`.

---

### W-USER-16 — Performance: hydration meets SC-012

**Persona**: Editor User (perf)
**Touches**: SC-012
**Trigger**: Playwright + CDP measures hydration latency.

**Steps**:

1. **Action**: Playwright emulates mid-range Android (slow 4G, 4x CPU
   throttle); loads `/loadouts/trainer/`.
2. **Action**: Measure time from `DOMContentLoaded` to first editor
   button being clickable (e.g. via
   `await page.locator('[aria-label="Save"]').click({ trial: true })`).
   **Expected**: ≤500ms.

**Performance budget**: ≤500ms hydration on slow 4G + 4x CPU throttle.
**Test command**: `npm run test:e2e -- --grep W-USER-16`.

---

### W-USER-17 — localStorage corruption recovery

**Persona**: Editor User
**Touches**: FR-505
**Trigger**: localStorage entry is malformed JSON (manually corrupted
or partially written).

**Steps**:

1. **Action**: Seed localStorage `kanix.belts.v1` with `"{ "broken":
   not-json`; load `/loadouts/trainer/`.
   **Expected DOM**: editor still loads; bundled preset is shown;
   toast "Some saved data could not be loaded and was skipped." A
   "Show details" link reveals the malformed key.
   **Negative assertions**: no white screen; no unhandled exception;
   the corrupted entry is NOT silently rewritten on save (user must
   explicitly Clear or accept the loss).

**Performance budget**: load ≤300ms.
**Test command**: `npm run test:e2e -- --grep W-USER-17`.

---

## Site Author workflows

### W-AUTHOR-1 — Embed a read-only belt in another Astro page

**Persona**: Site Author
**Touches**: US-7, FR-652, SC-008
**Trigger**: Author imports the BeltLayout component without a
hydration directive into a new page.

**Steps**:

1. **Action**: Author writes a minimal test page at
   `site/src/pages/_test-embed.astro` containing:
   ```astro
   ---
   import BeltLayoutPanel from '../components/BeltLayoutPanel.astro';
   import { belts } from '../data/loadouts';
   const trainer = belts.find(b => b.slug === 'trainer')!;
   ---
   <BeltLayoutPanel belt={trainer} />
   ```
   No `client:*` directive.
2. **Action**: `npm run build && npm run preview`; Playwright loads
   `/_test-embed/`.
   **Expected DOM**: belt visual + module list + hardware list render
   exactly as the static portion of W-USER-1 step 1.
   **Expected network**: ZERO requests for editor JS chunks (verify
   in Playwright via `page.on('request')` filter). CSS + image
   requests OK.
   **Negative assertions**: no editor toolbar; no palette; no Save
   button; no console errors.

**Performance budget**: page interactive ≤500ms.
**Test command**: `npm run test:e2e -- --grep W-AUTHOR-1`.

---

### W-AUTHOR-2 — Verify embed mode HTML matches no-JS loadout page

**Persona**: Site Author
**Touches**: FR-650, FR-652
**Trigger**: Compare the HTML output of an embedded BeltLayout vs the
JS-disabled loadout page.

**Steps**:

1. **Action**: Curl-fetch `/_test-embed/` and `/loadouts/trainer/` with
   JS disabled.
   **Expected**: the rendered belt visual + module list HTML is byte-
   identical (modulo wrapping page chrome).

**Performance budget**: ≤500ms each fetch.
**Test command**: `npm run test:e2e -- --grep W-AUTHOR-2`.

---

## Cross-cutting assertions

Referenced by `[CC-N]` from individual steps:

- **CC-1**: Throughout each workflow, `console.error` and
  `console.warn` counts are 0. Verified by Playwright
  `page.on('console')` listener accumulating into a list asserted at
  test end.
- **CC-2**: At least one Tailwind/CSS utility class on the first
  rendered editor page has a resolved computed style. Verified by
  picking one known class (e.g. `bg-neutral-950` on `body`) and
  asserting `getComputedStyle(body).backgroundColor !== 'rgba(0, 0,
  0, 0)'`.
- **CC-3**: No network requests fire to `/api/error`, `/api/*` (no
  API in v1), or any URL returning 4xx/5xx (except the deliberate
  404 test in W-USER-17 — exempted there).
- **CC-4**: Every workflow that mutates localStorage verifies the
  expected key/value before and after the mutation via
  `page.evaluate(() => localStorage.getItem(...))`.

---

## Spec.md user story → workflow mapping

| User Story | Primary Workflow(s) |
|---|---|
| US-1 (no-JS preset render) | W-ANON-1, W-ANON-2 |
| US-2 (hydrate + edit preset) | W-USER-1 |
| US-3 (create Module from scratch) | W-USER-4 |
| US-4 (compose Belt by dragging Modules) | W-USER-5 |
| US-5 (export + re-import bundle) | W-USER-6 |
| US-6 (share Belt via URL) | W-USER-7 |
| US-7 (read-only embed) | W-AUTHOR-1, W-AUTHOR-2 |
| US-8 (reset preset to original) | W-USER-8 |
| US-9 ("pick one of" group) | W-USER-9 |

(spec.md User Story sections will get a `**Workflows**: W-X` line
appended in the spec.md update step — see Phase 5.5 process step 7.)
