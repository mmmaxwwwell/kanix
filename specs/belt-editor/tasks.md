# Tasks: Belt Editor

**Input**: Design documents from [specs/belt-editor/](.).
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, workflows.md (all present).

**Approach**: Fix-validate loop. Each phase: build → test → lint → security scan → read `test-logs/` failures → fix code → re-run until green. Phased ordering: SCAD prereqs → test infra → data model → core editor lib → palette/plate UI → belt UI → persistence/undo → import/export/share → collision worker → a11y → E2E hardening.

**Format**: `[ID] [P?] [Story?] Description [FR-xxx] [SC-xxx] [needs: ...] [produces/consumes: IC-xxx]`
- `[P]`: parallelizable with other `[P]` tasks (different files, no shared singleton).
- `[Story]`: which spec.md user story (US-1..US-9) this task implements.
- `Done when:` line is the agent's stop signal.

**Non-Goals reminder**: See spec.md `## Non-Goals`. Do NOT implement cloud sync, 3D editor view, checkout integration, auto-arrange, multi-user collaboration, or URL-published persistent configs.

---

## Phase 1: SCAD prerequisites (PREREQ-1..4)

These BLOCK all editor work. The editor can't render correct geometry until plate fixtures are real (not stubs) and BOSL2 anchors exist on every model.

- [ ] **T001** Rectangularize `kanix_plate` per PREREQ-1 / scad/CLAUDE.md Op 1. Modify `scad/lib/kanix-plate.scad` to accept `plate_w` + `plate_h` instead of `plate_size`. Update the 6 stubbed fixtures in `scad/plates/` to call `kanix_plate_from_presets(grid, belt)`. Delete `assert(plate_w == plate_h, …)`.
  - Done when: `openscad -o /tmp/check.stl scad/plates/kanix_plate_4x3_52x12.scad` succeeds and the output STL is a full hinged clip (not a placeholder); same for `3x2_38x5.3`, `4x2_38x5.3`, `2x3_52x6.5`, `2x3_52x12`, `4x3_52x6.5`. `scad/CLAUDE.md` plate matrix tables have ✓ for all 6 entries (no ⚠).

- [ ] **T002** Migrate accessories off legacy presets per PREREQ-2 / scad/CLAUDE.md Op 2. For each accessory (`clicker_holder`, `wuben-c3-holster`, `carabiner_clip`, `belt_clip`, others surfaced by `grep -l kanix_preset_ scad/`): rename the accessory's primary module to take `kanix_grid_*`, rename render fixtures (use `git mv`) per the suffix map in scad/CLAUDE.md. When all done, delete `kanix_preset_38x4` and `kanix_preset_52x65` blocks from `scad/lib/presets.scad`.
  - Done when: `grep -rl kanix_preset_ scad/` returns empty; `bash scripts/test-scad.sh` passes; `scad/CLAUDE.md` Op 2 accessory table shows all accessories as "done".

- [ ] **T003** Add BOSL2 named anchors per PREREQ-3 [FR-200]. Modify `scad/lib/mounting-plate.scad` and `scad/lib/kanix-plate.scad` to attach a named anchor at each bolt hole, naming them `bolt_<col>_<row>` (1-indexed, matching the convention in IC-001 and data-model.md HoleSpec.name). For BeltClip mounts, name belt-mount holes `belt_<n>`. Same for every accessory module with attachment-side bolts (carabiner_clip variants, holsters, etc.).
  - Done when: every editor-supported SCAD fixture, when processed by T009's extractor, produces a non-empty `HoleSpec[]` where every `name` matches the `bolt_<col>_<row>` or `belt_<n>` pattern.

- [ ] **T004** [P] Add `belt_clip_4x2_38mm.scad` and `belt_clip_4x3_52x6.5.scad` (and `_52x12.scad`) per PREREQ-4. Author by analogy to the existing `belt_clip_3x2_38mm.scad` (after T002's rename).
  - Done when: the three new fixtures exist, render successfully via `openscad -o /tmp/check.stl <fixture>`, and `bash scripts/test-scad.sh` passes.

**Phase 1 checkpoint**: All SCAD prerequisites land. Plate and belt-clip fixtures for the editor's v1 grid set render real clips. Every fixture has BOSL2-named bolt anchors.

---

## Phase 2: Test infrastructure & CI gates

Set up Vitest, axe-core, size-limit, and the new CI gates before any feature work so the fix-validate loop can use them from Phase 3 onward.

- [ ] **T005** Add Vitest to `site/package.json`. Install `vitest`, `@vitest/ui` (dev), `jsdom` (dev), `@vitest/coverage-v8` (dev). Create `site/vitest.config.ts` with jsdom env and project structure (`test/unit/**/*.test.ts`, `test/integration/**/*.test.ts`).
  - Done when: `cd site && npx vitest run --reporter=verbose` exits 0 with "No tests found" (no tests yet); `npm run test:unit` script added that invokes Vitest.

- [ ] **T006** [P] Install `@axe-core/playwright` in `site/package.json` (devDep). Add `npm run test:a11y` script that runs Playwright with a tag-filter `@a11y`.
  - Done when: `cd site && npm run test:a11y` runs successfully with 0 tests; `import { AxeBuilder } from '@axe-core/playwright'` works in a Playwright test.

- [ ] **T007** [P] Install `size-limit` + `@size-limit/preset-small-lib` (devDep). Create `site/size-limit.json` with two entries: core editor chunk (target ≤80KB gz) and collision lib chunk (target ≤250KB gz). Add `npm run size-check` script.
  - Done when: `cd site && npm run size-check` runs (will fail until bundles exist; that's OK — gate is configured).

- [ ] **T008** Create `site/scripts/verify-holes.sh` per FR-203. Iterates every model referenced from `attachments.ts`, `plates.ts`, `belt-clips.ts`; asserts a `<model>.holes.json` exists and contains `anchors[]` with at least one entry. Exits non-zero on first failure with the offending filename.
  - Done when: `bash site/scripts/verify-holes.sh` runs (will fail until registries + extractor exist; expected at this phase); the script is invokable from CI.

- [ ] **T009** Implement SCAD hole extractor per FR-201, FR-202, FR-204 [produces: IC-001]. Create `scad/extract-holes.sh` that, for each `.scad` model referenced from the registries, shells out to `openscad --export-format=csg <model>.scad`, then invokes `site/scripts/parse-csg.mjs` (also new) to parse the CSG output for BOSL2 `named_anchor()` calls and emit `<model>.holes.json` **next to the source `.scad` file** (e.g. `scad/dump-bag-mount.holes.json` next to `scad/dump-bag-mount.scad`) with the schema in IC-001. Wire the extractor into `npm run render` so `.holes.json` files are produced alongside `.stl` files.
  - Done when: running `cd site && npm run render` produces a non-empty `<model>.holes.json` next to every registered `.scad` source (in `scad/` for accessories, in `scad/plates/` for plates); the JSON schema matches IC-001 (model + anchors[] with name/x/y/z/normal/boltSize).

- [ ] **T010** Update `.gitignore` to include `site/test-logs/` and `site/.size-snapshot.json` if applicable. Ensure `.holes.json` files (in `scad/` and `scad/plates/`) ARE committed — they're inputs to the build, not generated artifacts of the dev environment.
  - Done when: `.gitignore` updated; `git status` after `npm run render` shows `scad/**/*.holes.json` files as tracked changes (committable, NOT ignored).

**Phase 2 checkpoint**: Test infrastructure ready. Hole extractor produces JSON sidecars. CI gates configured (will pass once feature code lands).

---

## Phase 3: Data model migration (FR-100, FR-900 series)

Migrate `modules.ts` → `attachments.ts` and `loadouts.ts` → emits Belt records. Create new `plates.ts` and `belt-clips.ts` registries.

- [ ] **T011** Create `site/src/lib/editor/types.ts` exporting every type from data-model.md: `HoleSpec`, `AttachmentVariant`, `Attachment`, `AttachmentCategory`, `Plate`, `BeltClip`, `Mount`, `AttachmentPlacement`, `Module`, `SingleSlot`, `GroupSlot`, `Slot`, `Belt`, `ExportBundle`, `ImportSelection`. Use `interface` for object shapes and `type` for unions [FR-100, FR-101, FR-102, FR-103, FR-104, FR-105, FR-106, FR-107, FR-108, FR-109, FR-110, FR-111, FR-112].
  - Done when: `tsc --noEmit` passes; every type in data-model.md is exported; no `any` types.

- [ ] **T012** Migrate `site/src/data/modules.ts` → `site/src/data/attachments.ts` per FR-901, FR-903. Rename `Module` → `Attachment`, `ComingSoonModule` → `ComingSoonAttachment`. Add `category` field to every entry per FR-301 (assign from current names + manual review; default to `'other'` and flag entries needing review with a TODO comment). Update EVERY call site in the codebase that imports from `modules.ts` (grep first; update imports + type names). **Public URLs MUST remain stable per FR-903**: `/modules/<slug>/`, `/coming-soon/<slug>/` continue to resolve — only the internal type names and source file paths change.
  - Done when: `modules.ts` no longer exists (`git rm`); `attachments.ts` exists; `tsc --noEmit` passes across `site/`; `cd site && npm run build` succeeds.

- [ ] **T013** Create `site/src/data/plates.ts` registry per FR-104, FR-154, FR-904. One entry per editor-supported plate grid × thickness: `3x2_38x5.3`, `4x2_38x5.3`, `3x3_52x6.5`, `3x3_52x12`, `4x3_52x6.5`, `4x3_52x12`. Each entry references its SCAD file and STL file; the `holes` and `beltMountHoles` arrays are inlined at build time from `<model>.holes.json` via a small build helper (`site/src/lib/build/load-holes.ts`). Deprecated `2x2`, `2x3` grids per FR-904 are explicitly NOT registered (SCAD files remain on disk but no editor reference).
  - Done when: `plates.ts` exports a `plates: Plate[]` with 6 entries; `tsc --noEmit` passes; `npm run build` produces correct inlined holes arrays.

- [ ] **T014** [P] Create `site/src/data/belt-clips.ts` registry per FR-105, FR-154. One entry per editor-supported belt-clip grid: `3x2_38`, `4x2_38`, `3x3_52`, `4x3_52`. Same inlining pattern as T013.
  - Done when: `belt-clips.ts` exports `beltClips: BeltClip[]` with 4 entries; `npm run build` succeeds.

- [ ] **T015** Implement legacy Loadout → Belt migrator per FR-900, FR-902. Create `site/scripts/regen-loadouts.mjs` that reads `loadouts.md` (the authoring source) and the existing `loadouts.ts`, and emits a new `loadouts.ts` that exports `belts: Belt[]`. Apply the field mapping in FR-902 exactly. Synthesize Module IDs as `mod-<beltSlug>-<index>`.
  - Done when: running `node site/scripts/regen-loadouts.mjs` produces a new `loadouts.ts` where every existing Loadout entry has an equivalent Belt; `tsc --noEmit` passes; `npm run build` succeeds; existing loadout pages render visually equivalent content (manual smoke test).

- [ ] **T016** [P] [SC-001] Vitest unit tests for types module: schema invariants per data-model.md (e.g. Module.attachments.length >= 1 enforced via valibot at runtime).
  - Done when: `npm run test:unit` passes with tests for every invariant in data-model.md's "Validation rules" table.

- [ ] **T017** [SC-011] Vitest integration test: load the pre-migration `loadouts.ts` snapshot (committed to `test/fixtures/legacy-loadouts-golden.json`), run the migrator, assert every entry becomes an equivalent Belt (same modules at same angles, same variants, same groups).
  - Done when: `npm run test:integration -- migration.test.ts` passes for every preset.

**Phase 3 checkpoint**: Data model migrated. Existing loadout pages still render (they now consume Belt instead of Loadout). Type system + invariants tested.

---

## Phase 4: Core editor lib (no UI yet)

Pure TypeScript: snap math, hardware list, print list, BOM, action algebra, persistence, migrations, share URL encoding/decoding, valibot schemas.

- [ ] **T018** Install Preact + signals + dnd-kit + valibot per plan R1-R4. Add to `site/package.json`: `preact`, `@preact/signals`, `@dnd-kit/core`, `valibot`. Configure `@astrojs/preact` integration in `astro.config.mjs`.
  - Done when: `npm install` succeeds; `astro.config.mjs` registers the Preact integration; a trivial `*.tsx` file under `src/components/editor/` compiles.

- [ ] **T019** Implement `site/src/lib/editor/snap.ts` per FR-250 (≥2 bolt alignment, ±0.5mm tolerance). Pure function: `(attachment: Attachment, variant: AttachmentVariant | null, mount: Mount, originCell, rotation) => SnapResult`. Includes coordinate transforms (rotation about anchor hole; grid → mm conversion).
  - Done when: unit tests in `test/unit/snap.test.ts` pass: known 2-hole attachment at every cardinal rotation produces correct aligned/unaligned hole sets within tolerance; deliberately misaligned placement returns ≥2 unaligned.

- [ ] **T020** [SC-003] Vitest + OpenSCAD subprocess round-trip test in `test/integration/scad-round-trip.test.ts`. For every Attachment in `attachments.ts`, for every cardinal rotation, render the placement in OpenSCAD (compose plate + attachment in declared transform), then compare the computed bolt-hole world coordinates against the OpenSCAD-rendered geometry to within ±0.5mm.
  - Done when: test passes for every Attachment; new attachments without anchors fail the test (forcing PREREQ-3 to be honored).

- [ ] **T021** Implement `site/src/lib/editor/hardware-list.ts` per FR-702, FR-703. Takes a Belt; returns a rolled-up table `{ boltSize: string, lengthMm: number, used: number, unused: number, total: number }[]`. For each Module: count in-use (≥2-bolt-aligned) and unused mount holes; for each Slot: add belt-mount bolts. Group slots use worst-case (max-bolts) candidate per FR-703. Bolt-length defaults from the FR-702 table.
  - Done when: unit tests pass with hand-authored fixture Belt; output matches expected per FR-702 examples.

- [ ] **T022** [P] Implement `site/src/lib/editor/print-list.ts` per FR-700, FR-453 and `bom.ts` per FR-701, FR-454. Both consume Belt; both roll up by STL filename / Product url respectively. Group slots emit all candidates under one header (FR-453, FR-454). Both generators are also consumed by the SSG render path per FR-704 (single shared implementation; no duplicate logic between editor and Astro page).
  - Done when: unit tests pass; group slots correctly emit all candidates; the same generator produces identical output whether called from the editor or from the Astro page (verified by snapshot test).

- [ ] **T023** Implement `site/src/lib/editor/actions.ts` per FR-800 series — the action algebra. Define `Action` discriminated union per FR-802; each variant implements `apply(state) => state` and `invert(state) => Action`. Include: placeAttachment, removeAttachment, rotateAttachment, swapVariant, moveAttachment, addModule, removeModule, placeSlot, removeSlot, changeSlotAngle, createGroup, dissolveGroup.
  - Done when: unit tests pass: round-trip every action through `apply` then via the inverted action through `apply` again; final state byte-equals starting state.

- [ ] **T024** [SC-010] Vitest unit test: 50-step random action sequence (seeded RNG) applied forward, then undone via inverse chain, then redone — final state byte-equals direct application.
  - Done when: `test/unit/undo-redo.test.ts` passes for 100+ seeded runs.

- [ ] **T025** Implement `site/src/lib/editor/persistence.ts` per FR-500, FR-501, FR-505 [produces: IC-002]. `KV<T>` wrapper around localStorage with try/catch on read/write, typed errors (`StorageError`).
  - Done when: unit tests pass: read of corrupted JSON returns null + logs warning; write that exceeds quota throws StorageError; safe-mode disables writes entirely.

- [ ] **T026** Implement `site/src/lib/editor/store.ts` — top-level `EditorStore` class exposing signals for state [FR-502, FR-503]. Subscribes to action dispatches; updates signals reactively; orchestrates persistence (debounced save on every action via configurable autosave; manual save commits immediately). System-supplied presets MUST be available without any localStorage entry (loaded from bundled `loadouts.ts` at init time, per FR-502). System Modules are derived from bundled Belt presets — any Module referenced by a bundled Belt is in the library as read-only.
  - Done when: integration test creates a store, dispatches actions, asserts signal updates fire; reload-from-localStorage path restores last saved state; first-load (empty localStorage) renders bundled presets.

- [ ] **T027** Implement migration framework in `site/src/lib/migrations/index.ts` per FR-554, FR-555. Registry: `Record<number, (bundle: unknown) => unknown>`. Export `migrate(bundle): ExportBundle` that walks the chain; throws `MigrationError` if a version has no migrator. Initial state: empty MIGRATIONS map (current version is 1, no migrations needed). Bundles with `schemaVersion > CURRENT` are refused per FR-555.
  - Done when: unit test passes: bundle with `schemaVersion: 1` round-trips; bundle with `schemaVersion: 2` throws MigrationError (since 2 isn't defined yet, simulates the FR-555 "newer version" rejection).

- [ ] **T028** [P] Implement `site/src/lib/share/encode.ts` and `decode.ts` per FR-601, FR-604 [produces: IC-004]. Encode: `JSON.stringify` → `CompressionStream('gzip')` → `base64url`. Decode: reverse + valibot validate. Max 8KB encoded; throws `EncodingError` if exceeded.
  - Done when: unit tests pass: round-trip preserves data; bit-flipped payload throws EncodingError; >8KB payload throws sized error.

- [ ] **T029** Define valibot schemas for `Attachment`, `Module`, `Belt`, `ExportBundle` in `site/src/lib/editor/schemas.ts`. Includes the security limits from spec Enterprise Infrastructure: max string length per field 1KB; max bundle size after decompression 256KB.
  - Done when: unit tests pass: valid bundles parse; oversized strings reject; over-quota bundles reject.

**Phase 4 checkpoint**: Editor core compiles and is unit-tested. No UI yet — every public API has a test. SC-003 and SC-010 land here.

---

## Phase 5: Palette + Plate Editor UI (US-3, FR-300, FR-330, FR-350 series)

- [ ] **T030** [US-3, US-2] Implement `site/src/components/editor/Palette.tsx` per FR-300, FR-301, FR-751. ARIA `role="listbox"` of `role="option"` children (FR-751); options grouped by category (FR-301). Searchable filter input. Each AttachmentVariant is its own option (FR-300). Uses `useSignal` for filter state.
  - Done when: unit tests pass: rendering with empty/full attachment set; keyboard navigation between options (Tab/arrow keys); filter input narrows visible options.

- [ ] **T031** [US-3] Implement `site/src/components/editor/PlateEditor.tsx` per FR-302, FR-303, FR-304, FR-305, FR-350, FR-351, FR-352, FR-752. Renders a Mount's grid as ARIA `role="grid"` with `role="gridcell"` cells (FR-752). Shows bolt-hole circles per Mount hole (FR-350). Wires dnd-kit `useDroppable` per cell with sensors for mouse (FR-302), touch with 400ms long-press (FR-303), and keyboard (FR-304). Hit targets are ≥44×44 CSS pixels (FR-305). On drag-over, computes live alignment preview (green/red dots per FR-251, FR-351). On drop, dispatches `placeAttachment` action; placement is added to `Module.attachments[]` with declared rotation (FR-352).
  - Done when: integration test (Vitest + jsdom) passes: mounting the component, simulating a drag from a palette item to a cell, asserting the action was dispatched.

- [ ] **T032** [US-3] Implement attachment rotation/removal/variant-swap UI: `R` key rotates focused attachment per FR-353; Delete/Backspace removes per FR-354; click opens a per-placement edit panel with variant dropdown per FR-355. Hardware list updates live (FR-356).
  - Done when: integration test passes for each interaction.

- [ ] **T033** [US-3] Implement `site/src/components/editor/Gallery.tsx` for `/belt-editor/`. Lists bundled Belt presets + user-saved Modules + user-saved Belts (FR-330). "New Module" button per FR-332 opens a dialog (Mount kind + grid + thickness picker, compatibility-filtered per FR-150, FR-151, FR-152). "New Belt" button per FR-331.
  - Done when: integration test passes for opening each dialog and creating fresh entries.

- [ ] **T034** [US-3] Implement Save Module + Save Belt + Delete actions per FR-333, FR-334, FR-335. Re-open / edit-in-place existing entries per FR-336 (bundled preset edit creates a `<name> (copy)` user entry).
  - Done when: integration test passes; localStorage `kanix.modules.v1` / `kanix.belts.v1` reflect the saved entries.

- [ ] **T035** [P] [US-3] Astro route `site/src/pages/belt-editor/index.astro` and `site/src/pages/belt-editor/new.astro`. Routes render the Gallery / new-entry editor with `client:load` directives.
  - Done when: navigating to `/belt-editor/` in `npm run dev` shows the gallery; refreshing preserves URL-encoded selections.

**Phase 5 checkpoint**: User can author Modules in isolation. US-3 complete.

---

## Phase 6: Belt editor UI (US-4, FR-400 series, FR-450 series)

- [ ] **T036** [US-4] Implement `site/src/components/editor/BeltEditor.tsx` per FR-400, FR-753. Top-down belt canvas SVG with angle scale (FR-400); reuses the existing PCB-trace style from `BeltLayoutPanel.astro`. Renders each Slot as a positioned Module thumbnail at its angle. Placed slots expose ARIA `role="button"` with accessible name `"<Module name> at <angle>°"` per FR-753; arrow-key navigation walks slots in angular order.
  - Done when: integration test renders a Belt with 3 slots at angles 0°, 90°, 270°; visual snapshot matches expected.

- [ ] **T037** [US-4] Implement Module library panel on the belt editor per FR-153, FR-401. Drag handle per Module; drag-and-drop to belt via dnd-kit `useDraggable` + canvas-level `useDroppable`. On drop, prompts for angle (numeric input + visual snap) per FR-402. Enforce mount↔belt compatibility per FR-153: any Module whose `mount.beltWidth` differs from the current Belt's `width` is rejected on drop with a clear error citing the mismatch (FR-150, FR-151, FR-152 form the compat matrix).
  - Done when: integration test: drag a Module from the library, drop at 90°, assert the slot exists at that angle.

- [ ] **T038** [US-4] Implement slot angle adjustment (drag along belt or type exact value, FR-403), slot removal (FR-404), and live hardware total (FR-405).
  - Done when: integration tests pass for each interaction.

- [ ] **T039** [US-9] Implement "Pick One Of" group creation per FR-450, FR-451, FR-452, FR-455. Multi-select 2+ Modules from library → "Group as alternatives" action (FR-451) → enter label + angle → GroupSlot stored per FR-450 → rendered as a single visual slot showing first candidate with "pick 1 of N" badge per FR-452. Hardware list rollup for group slots uses worst-case (max-bolts) candidate per FR-455. (Print/BOM emission per FR-453/454 is implemented in T022.)
  - Done when: integration test: create group, assert GroupSlot in editor state; print list emits both candidates as alternatives; hardware list uses worst-case bolt count.

- [ ] **T040** [US-2, US-4] [FR-650, FR-651, FR-652, FR-653, FR-704] Refactor existing `site/src/components/BeltLayoutPanel.astro` to consume `Belt` (not `Loadout`). The static SSG render stays in this Astro component (FR-650); an `EditorIsland.tsx` hydrates in place over it with `client:idle` (or `client:load` if `?config=` is present, per R11) — no layout shift (FR-651). The same component without a hydration directive is the read-only embed mode (FR-652). When JS fails, the static view stays functional (FR-653). The Astro page calls the SAME print-list / BOM / hardware-list generators from T021 and T022 — no duplicate logic between editor render and SSG render (FR-704).
  - Done when: loadout pages render statically (verifiable via curl with JS disabled — W-ANON-1 passes) AND editor hydrates over them with no layout shift; existing visual style preserved; rendering the same component without `client:*` produces an embed-mode page with no editor JS fetched (W-AUTHOR-1 setup).

**Phase 6 checkpoint**: User can author Belts. US-2, US-4 complete (modulo lazy collision validation, deferred to Phase 8).

---

## Phase 7: Persistence + undo/redo (FR-500 series, FR-800 series)

- [ ] **T041** Wire `EditorStore` to persistence (T025). Autosave on every action with a 500ms debounce; explicit Save commits immediately. Preset-override resolution per FR-503 (localStorage wins over bundled when slugs match).
  - Done when: integration test: edit → wait 500ms → reload → state restored; manual save commits within 50ms.

- [ ] **T042** Implement "Reset to Original" per FR-504. Confirmation dialog; on confirm, remove localStorage entry; reload renders bundled default.
  - Done when: W-USER-8 e2e test (Phase 11) passes.

- [ ] **T043** Wire keyboard shortcuts for undo/redo per FR-801. Global handler at the editor root: Ctrl-Z / Cmd-Z → undo; Ctrl-Shift-Z / Cmd-Shift-Z → redo. On-screen buttons mirror.
  - Done when: integration test: dispatch 3 actions, press Ctrl-Z 3 times, assert state matches initial; redo restores final state.

- [ ] **T044** Surface destructive-operation confirmations per FR-803. Reset to Original / Save / Import / Delete / Clear localStorage each prompt; none push to undo stack.
  - Done when: integration test: each destructive action shows confirm dialog; cancel preserves state; confirm commits.

**Phase 7 checkpoint**: Edits persist; undo/redo works. US-8 and SC-010 fully covered.

---

## Phase 8: Import/Export + Share URL (US-5, US-6, FR-550 series, FR-600 series)

- [ ] **T045** [US-5] Implement `site/src/components/editor/ImportExportDialog.tsx` per FR-550, FR-551 [produces: IC-004]. Per-entry checkbox UI (one section for Modules, one for Belts); export produces JSON file download in the wire format defined by IC-004 (content-type application/json, suggested filename `kanix-belt-<slug>-<date>.json`).
  - Done when: integration test: with N saved entries, export with subset checked produces a JSON file matching ExportBundle shape with only the selected entries.

- [ ] **T046** [US-5] Implement import flow per FR-552, FR-553, FR-554, FR-555, FR-556 [consumes: IC-004]. File picker → parse JSON per IC-004 → valibot validate → display per-entry checkboxes with conflict UI (Replace/Skip/Save-as-new). Per-entry failure does not abort rest.
  - Done when: integration test: import valid file with mix of new/conflicting entries; user resolves; resulting localStorage matches expected.

- [ ] **T047** [US-6] Implement `site/src/components/editor/ShareLinkDialog.tsx` per FR-600..FR-605. Generates URL via encode.ts; 8KB cap (FR-602) disables button with tooltip when exceeded; warning text per FR-605.
  - Done when: integration test: dialog opens, URL is in expected shape; oversized config disables button.

- [ ] **T048** [US-6] Implement URL hydration [consumes: IC-004]: on page load, if `?config=` present, decode via decode.ts; render in editor with prompt to save per FR-603. Corruption: banner + "Clear" action per FR-604.
  - Done when: integration test: load page with `?config=<known-good>`, assert state matches; load with bit-flipped, assert corruption banner.

- [ ] **T049** [SC-005] [P] Vitest integration: full export → import round-trip. Save 2 Modules + 1 Belt → export with all checked → clear → import → assert deep-equal restoration. Then export with selective checkboxes → import → assert only selected entries restore.
  - Done when: test passes.

- [ ] **T050** [SC-006] [P] Vitest integration: share URL round-trip. Encode a Belt → URL string → decode → assert deep-equal. Tampered URL → throws EncodingError. Oversized payload → encode refuses.
  - Done when: test passes.

**Phase 8 checkpoint**: Bundle import/export works; share URLs work. US-5, US-6, SC-005, SC-006 complete.

---

## Phase 9: Collision worker (FR-280 series, SC-014)

Lazy-loaded chunk. Editor remains usable without it.

- [ ] **T051** Implement `site/src/lib/collision/worker.ts` — the Web Worker entry [FR-280, FR-284, FR-285]. Imports Three.js + three-mesh-bvh + STLLoader from the existing three.js install. Accepts `{ type: 'check', id, pairs }` messages per IC-003; for each pair, fetches the STLs (with in-worker cache), builds `MeshBVH` once per geometry, applies transforms, runs intersectsGeometry, returns `{ type: 'result', id, collisions, indeterminate }` with bbox per FR-284. Async per FR-285; 5s timeout per pair → indeterminate.
  - Done when: SC-014 test passes — a SCAD-overlapping pair reports collision; a non-overlapping pair reports none.

- [ ] **T052** Install `three-mesh-bvh` (`npm install three-mesh-bvh`). Verify it tree-shakes into the worker chunk only (not the core editor chunk).
  - Done when: `npm run build && npm run size-check`: core editor chunk does NOT contain three-mesh-bvh symbols (verify via Vite's chunks report); worker chunk does.

- [ ] **T053** Implement `site/src/lib/collision/lazy-loader.ts` per FR-281. Wraps `new Worker(new URL('./worker.ts', import.meta.url))` in a lazy promise; exposes `validateCollisions(belt): Promise<Result>`.
  - Done when: integration test: first call triggers worker fetch (verifiable via network mock); subsequent calls reuse the same worker.

- [ ] **T054** Wire collision lib into Save flow per FR-252, FR-253, FR-282. A Module is valid for save iff every placement passes the snap rule (FR-250) AND the collision worker reports no overlaps (FR-280). When user clicks Save: if lib loaded → run validation inline; if not loaded → show "Loading collision validator…" toast; on completion, dispatch validation (FR-282 (a) default). User can opt into "save without validation" per FR-282 (b); Module gets `validatedCollisions: false`. Block save of an invalid Module with a clear error citing the offending placement(s) per FR-253.
  - Done when: integration test: first Save triggers lazy load; subsequent Saves reuse loaded lib; "save anyway" path marks the entry correctly.

- [ ] **T055** [P] Implement "Validate now" action on gallery entries per FR-283. Marks entries with `validatedCollisions: false` visibly; "Validate now" re-runs the worker and updates the flag.
  - Done when: integration test passes.

- [ ] **T056** Implement worker timeout per FR-285 (5s per pair). Pair times out → "indeterminate" report; placement allowed with warning.
  - Done when: unit test: mock a slow geometry; assert timeout fires; result includes the pair in `indeterminate`.

- [ ] **T057** [SC-014] Author SCAD fixtures `test/fixtures/overlap.scad` (intentional intersect) and `test/fixtures/no-overlap.scad`. Vitest integration test exercises the worker with the corresponding STLs.
  - Done when: test passes; overlap → collision; no-overlap → none.

**Phase 9 checkpoint**: Collision detection works. SC-014 lands. Core editor bundle size unaffected (collision lib is lazy).

---

## Phase 10: A11y polish (FR-750 series, SC-009)

- [ ] **T058** Audit every editor component for WCAG 2.1 AA per FR-750..FR-756. Fix focus order (FR-756), add aria-live announcements on every placement / rotation / validation event (FR-754 with exact example strings from the spec), ensure shape+color distinction on aligned/unaligned holes (FR-755).
  - Done when: visual review confirms aria-live announcements fire; keyboard-only walkthrough of W-USER-3 succeeds.

- [ ] **T059** [SC-009] Wire axe-core scan into Playwright per W-DEV-5. Scan every editor route (`/loadouts/<slug>/` for every preset + `/belt-editor/` + `/belt-editor/new/`). CI gate: 0 serious + 0 critical.
  - Done when: `npm run test:a11y` passes; CI gate added to `.github/workflows/test.yml`.

**Phase 10 checkpoint**: A11y target met. SC-009 lands.

---

## Phase 11: E2E hardening (one task per workflow)

Each task implements the workflow exactly as scripted in workflows.md. Task description references the workflow ID; the workflow file is the spec.

- [ ] **T060** [P] Implement E2E for W-DEV-1 per workflows.md. `npm run dev` produces working editor; HMR works.
  - Done when: Playwright test `--grep W-DEV-1` passes.

- [ ] **T061** [P] Implement E2E for W-DEV-2, W-DEV-3, W-DEV-4, W-DEV-5, W-DEV-6, W-DEV-7, W-DEV-8 (one Playwright test case per workflow, grouped under `test/e2e/dev/*.spec.ts`). Each workflow becomes one test case; the test's name includes the workflow id so `--grep "W-DEV-N"` selects it.
  - Done when: `npm run test:e2e -- --grep "W-DEV-"` passes (7 tests, one per workflow id W-DEV-2 through W-DEV-8); individual `--grep "W-DEV-3"` (and every other id) selects exactly one test.

- [ ] **T062** [P] Implement E2E for W-SYS-1, W-SYS-2, W-SYS-3, W-SYS-4 (one Playwright test case per workflow, grouped under `test/e2e/sys/*.spec.ts`).
  - Done when: `npm run test:e2e -- --grep "W-SYS-"` passes (4 tests, one per workflow id W-SYS-1 through W-SYS-4); individual `--grep "W-SYS-3"` (and every other id) selects exactly one test.

- [ ] **T063** [P] [US-1, SC-007] Implement E2E for W-ANON-1, W-ANON-2, W-ANON-3 (JS-disabled / crawler).
  - Done when: `npm run test:e2e -- --grep "W-ANON-"` passes (3 tests).

- [ ] **T064** [US-2, SC-004, SC-012] Implement E2E for W-USER-1 (hydrate + edit + save + reload). Includes hydration perf measurement per SC-012 using CDP perf trace.
  - Done when: Playwright test `--grep W-USER-1` passes; hydration <500ms in CI.

- [ ] **T065** [US-2] Implement E2E for W-USER-2 (touch drag on phone emulation).
  - Done when: `npm run test:e2e:mobile -- --grep W-USER-2` passes.

- [ ] **T066** [US-2] Implement E2E for W-USER-3 (keyboard-only).
  - Done when: Playwright test passes.

- [ ] **T067** [US-3] Implement E2E for W-USER-4 (create Module from scratch).
  - Done when: Playwright test passes.

- [ ] **T068** [US-4] Implement E2E for W-USER-5 (compose Belt).
  - Done when: Playwright test passes.

- [ ] **T069** [US-5, SC-005] Implement E2E for W-USER-6 (export + import round-trip).
  - Done when: Playwright test passes.

- [ ] **T070** [US-6, SC-006] Implement E2E for W-USER-7 (share URL round-trip).
  - Done when: Playwright test passes.

- [ ] **T071** [US-8] Implement E2E for W-USER-8 (reset preset).
  - Done when: Playwright test passes.

- [ ] **T072** [US-9] Implement E2E for W-USER-9 ("pick one of" group).
  - Done when: Playwright test passes.

- [ ] **T073** [SC-010] Implement E2E for W-USER-10 (undo/redo sequence).
  - Done when: Playwright test passes.

- [ ] **T074** [SC-003] Implement E2E for W-USER-11 (snap math rejection).
  - Done when: Playwright test passes.

- [ ] **T075** [SC-014] Implement E2E for W-USER-12 (collision detection blocks save).
  - Done when: Playwright test passes.

- [ ] **T076** [SC-009] Implement E2E for W-USER-13 (axe scan); covered by T059's `test:a11y` script. This task wires it into the workflow-tagged suite.
  - Done when: `npm run test:e2e -- --grep W-USER-13` runs the axe scan.

- [ ] **T077** Implement E2E for W-USER-14 (hardware list live update).
  - Done when: Playwright test passes.

- [ ] **T078** [SC-011] Implement E2E for W-USER-15 (migration golden snapshot).
  - Done when: Playwright test passes for every preset.

- [ ] **T079** [SC-012] Implement E2E for W-USER-16 (hydration perf budget). Covered by T064's CDP measurement; this is a no-op confirmation task.
  - Done when: T064 includes the explicit budget assertion.

- [ ] **T080** Implement E2E for W-USER-17 (localStorage corruption recovery).
  - Done when: Playwright test passes.

- [ ] **T081** [US-7, SC-008] Implement E2E for W-AUTHOR-1, W-AUTHOR-2 (read-only embed).
  - Done when: Playwright tests pass; W-AUTHOR-1's network-request filter confirms zero editor JS chunk fetched.

- [ ] **T082** Declare `test:e2e` script in `site/package.json` if not already (it is, but audit; ensure it picks up all workflow tests).
  - Done when: `cd site && npm run test:e2e` runs every workflow test.

- [ ] **T083** [SC-013] Wire `npm run size-check` into CI as a gate.
  - Done when: `.github/workflows/test.yml` runs `npm run size-check` and fails the job on budget breach.

- [ ] **T084** [SC-002] Wire `bash scripts/verify-holes.sh` into CI as a gate.
  - Done when: CI workflow runs verify-holes; fails on missing/empty `.holes.json`.

- [ ] **T085** [SC-003] Wire `npm run test:scad-round-trip` into CI as a gate.
  - Done when: CI workflow runs the round-trip test; fails on any mismatch.

- [ ] **T086** Author and ship `npm run pre-pr` per plan Pre-PR gate. Runs typecheck → lint → test:unit → test:scad-round-trip → verify-holes → build → test:e2e → size-check in sequence.
  - Done when: `cd site && npm run pre-pr` runs and exits 0 on a green branch.

**Phase 11 checkpoint**: Every workflow has a passing E2E. Every SC is bound to at least one test that gates CI.

---

## Phase 12: Polish, docs, and release prep

- [ ] **T087** Update [README.md](../../README.md) with belt-editor features and link to `/belt-editor/`.
  - Done when: README has a new "Interactive Belt Editor" section; links to the gallery work.

- [ ] **T088** Update [CLAUDE.md](../../CLAUDE.md) with editor-relevant agent guidance (e.g. "When adding a new attachment: 1) author SCAD with BOSL2 anchors, 2) add entry to attachments.ts, 3) run npm run render, 4) editor picks it up automatically"). Replace the "Loadouts: edit the markdown, not the TypeScript" section with the new authoring instructions (loadouts.md still the source; new schema documented).
  - Done when: CLAUDE.md reflects the new model; the existing "Loadouts: edit the markdown" section is updated for the new shape.

- [ ] **T089** [P] Update [loadouts.md](../../loadouts.md) "Instructions for Claude" section to emit Belt + Module records per the new schema (instead of LoadoutModule).
  - Done when: a Claude agent reading loadouts.md can regenerate `loadouts.ts` to the new shape without losing fidelity.

- [ ] **T090** Visual-regression smoke test: load every preset before + after editor work; compare screenshots; flag pixel diffs >5%.
  - Done when: smoke test passes (or any diffs explained in PR description).

- [ ] **T091** Final pre-PR run of every CI gate; fix any non-passing.
  - Done when: `npm run pre-pr` exits 0; CI dashboard green on the PR branch.

---

## Dependency graph

```
Phase 1 (SCAD prereqs) ──┐
                         ├──> Phase 3 (data model) ──> Phase 4 (editor lib)
Phase 2 (test infra) ────┘                                  │
                                                            ├──> Phase 5 (palette/plate UI) ──┐
                                                            ├──> Phase 6 (belt UI) ───────────┤
                                                            └──> Phase 9 (collision) ─────────┤
                                                                                              ├──> Phase 7 (persistence/undo) ──> Phase 8 (import/export) ──┐
                                                                                              │                                                              │
                                                                                              └──> Phase 10 (a11y) ──────────────────────────────────────────┤
                                                                                                                                                             ├──> Phase 11 (E2E hardening) ──> Phase 12 (polish)
```

Phases 5, 6, 9 can be done in parallel by separate agents after Phase 4 lands. Phase 10 also parallel after Phases 5+6.

## Parallelization summary

- T004 [P] with T001..T003 (different SCAD files).
- T006, T007 [P] with T005 (different config files).
- T014 [P] with T013 (separate registries).
- T016 [P] with T011 (test vs implementation can land same PR).
- T022 [P] with T021 (different files).
- T028 [P] (share encode/decode independent of store).
- T035 [P] (Astro routes independent of components).
- T049, T050 [P] (test files).
- T055 [P] (gallery "Validate now" is a small standalone feature).
- T060..T063, T081 [P] (each E2E task is a different test file).
- T089 [P] (loadouts.md doc update).

## Traceability summary

- Every FR in spec.md is touched by ≥1 task above.
- Every SC in spec.md has its validating task tagged `[SC-xxx]`.
- Every workflow in workflows.md has its E2E task in Phase 11.
- Every IC in plan.md has `[produces/consumes]` tags on relevant tasks.
- Every PREREQ in spec.md is a Phase 1 task.

## Out of scope (Non-Goals reminder)

Tasks NOT to generate, per spec.md Non-Goals:
- No cloud-sync tasks (no backend, no auth, no Firestore/Supabase).
- No 3D-editor-view tasks (collision is in a worker, not a render).
- No checkout-integration tasks (BOM exists, ordering is a v2 feature).
- No auto-arrange / assistant tasks.
- No multi-user collaboration tasks.
- No server-stored share-link tasks.
