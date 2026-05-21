# Feature Specification: Belt Editor

**Created**: 2026-05-21
**Status**: Draft
**Preset**: Enterprise (inherited from project)
**Input**: Interactive 2D editor for designing Kanix belts and modules, with
SSG-rendered default views, browser-only persistence, system-supplied
presets, file and URL export/import, and SCAD-extracted bolt-hole snap math.

---

## Overview

The Kanix public site currently renders each loadout as a static "PCB-trace"
top-down belt map with 3D module thumbnails. This feature turns those
loadouts into an interactive design experience while preserving the static
render for SEO/scrapers/no-JS visitors.

After this feature ships, a visitor can:

1. **Browse** static loadout pages (unchanged for crawlers and no-JS users —
   the same SSG-rendered belt map appears first).
2. **Edit** any loaded loadout in place once JavaScript hydrates: drag
   attachments from a palette onto a 3x2 / 4x2 / 3x3 / 4x3 plate (or a
   belt clip of the same grid), assemble Modules (plate or belt clip +
   ≥1 attachment), and place Modules around the belt at any angle.
3. **Save** their configuration to browser localStorage and **export** it
   as a JSON file or as a `?config=` share URL (gzip+base64url, ≤8KB).
4. **Import** a previously exported file or URL, choosing per-section
   (modules vs belts) which entries to load via checkbox.
5. **Reset** any edited system preset back to its bundled default.

The editor is **2D-only** in v1; the existing 3D-on-2D PCB-trace render
remains the visualization (it is generated server-side and never replaced
by a 3D editor canvas).

### Terminology (canonical for this spec and all downstream code)

| Term | Meaning |
|---|---|
| **Attachment** | A single 3D-printed accessory that bolts onto a Mount (e.g. carabiner clip, dump-bag mount, e-collar holster). What `site/src/data/modules.ts` calls a "Module" today. |
| **Mount** | The thing an Attachment bolts to. A discriminated union: `Plate \| BeltClip`. |
| **Plate** | A rectangular mounting plate with a regular bolt-hole grid. v1 editor-supported sizes (`<cols>×<rows>`, per [scad/CLAUDE.md](../../scad/CLAUDE.md)): **`3x2`, `4x2`** (38mm belt, 5.3mm thick) and **`3x3`, `4x3`** (52mm belt, 6.5mm or 12mm thick). 2-column plates (`2x2`, `2x3`) exist as legacy SCAD fixtures but are deprecated (too weak); not included in the editor palette. |
| **BeltClip** | A simpler mount used for lower-profile attachments. Same grid set as plates (`3x2, 4x2` for 38mm; `3x3, 4x3` for 52mm). Existing SCAD: `belt_clip_*.scad` (some currently mis-named per the Op 2 migration tracked in `scad/CLAUDE.md`). |
| **Module** | The assembled SKU a customer buys: `{ mount: Mount, attachments: AttachmentPlacement[] }`. Always has ≥1 attachment. |
| **Belt** | A belt strap (38mm or 52mm wide) plus zero or more Modules placed at angles around it. What `site/src/data/loadouts.ts` calls a "Loadout" today. The TypeScript type name is `Belt`. |
| **Loadout** | User-facing synonym for Belt. The public-facing pages stay at `/loadouts/<slug>/` for URL backwards compatibility. Internal/code identifier is `Belt`. |
| **Slot** | A placement of a Module on a Belt, with an angle 0–360° clockwise from buckle. |

This re-mapping is a refactor of the existing data layer; it is explicitly
in scope. See FR-100 series.

---

## User Scenarios & Testing

### User Story 1 — Visitor Reads a Preset Loadout (no JavaScript) (Priority: P1)

A crawler or no-JS visitor lands on `/loadouts/trainer/`. They see the
SSG-rendered PCB-trace belt map, the module list, the print/STL list, the
Amazon BOM, and the hardware list — all generated server-side from the
bundled preset.

**Why this priority**: SEO and accessibility-by-default. The site's
discoverability depends on scrapers seeing canonical content without
executing JS.

**Independent Test**: Disable JS in browser, load every preset page,
assert the rendered HTML contains the belt SVG, module list table, print
list, BOM, and hardware list. Run an HTML-only fetch (curl) to verify
the same content appears without any browser execution.

**Workflows**: W-ANON-1 (single preset), W-ANON-2 (every preset),
W-ANON-3 (gallery degrades), W-SYS-3 (curl-fetch SEO).

---

### User Story 2 — User Hydrates and Edits a Preset (Priority: P1)

A visitor with JS enabled lands on `/loadouts/trainer/`. The static belt
map renders immediately; within a few hundred ms the editor hydrates in
place (no layout shift; same component, now interactive). The visitor
drags a new attachment from the palette onto an existing plate, the
editor validates bolt-hole alignment (green dots on aligned holes, red
on misaligned), and the visitor saves. The page reloads and the edited
state is restored from localStorage.

**Why this priority**: Core value proposition. The entire feature exists
to enable this flow.

**Independent Test**: Open a preset page, wait for hydration, drag a
known-compatible attachment onto a plate, save, reload, assert the
attachment is still present. Then drag a known-incompatible attachment
(<2 bolts align), assert save is blocked with a clear error.

**Workflows**: W-USER-1 (happy path), W-USER-2 (touch), W-USER-3
(keyboard), W-USER-11 (snap validation), W-USER-17 (localStorage
corruption).

---

### User Story 3 — User Creates a Module from Scratch (Priority: P1)

A visitor opens `/belt-editor/`, sees the gallery of presets and saved
configs, clicks "New Module", picks a Mount (Plate or BeltClip) and a
grid (`3x2`, `4x2`, `3x3`, or `4x3`), and drags attachments from the
palette onto the Mount.
The editor enforces the ≥2-bolt snap rule. When saved, the Module
appears in the visitor's Module library and is available to drag onto
any belt.

**Why this priority**: Module authoring is the foundation; belts are
composed from Modules.

**Independent Test**: Open `/belt-editor/`, create a new `3x3` Plate
Module with two attachments, save, navigate to a belt, drag the new
Module onto the belt at 90°, save, reload, assert the Module appears on
the belt at the saved angle.

**Workflows**: W-USER-4 (Module creation flow), W-USER-12 (collision
detection on save).

---

### User Story 4 — User Composes a Belt by Dragging Modules (Priority: P1)

A visitor opens an empty belt (or a preset), drags saved Modules from
the Module library panel onto the belt at any angle 0–360°, rotates per
slot, and saves. The hardware list updates live as Modules are added
(bolts used to mount each Module's mount to the belt, bolts inside each
Module to mount its attachments).

**Why this priority**: This is the workflow that turns saved Modules
into a usable loadout.

**Independent Test**: Create two Modules, then open a new belt, drag
both Modules to specific angles, save, reload, assert both are present
at the saved angles. Verify the hardware list shows the correct bolt
counts.

**Workflows**: W-USER-5 (belt composition), W-USER-14 (live hardware
list).

---

### User Story 5 — User Exports and Re-imports a Config Bundle (Priority: P1)

A visitor uses the "Export" menu, chooses which Modules and which Belts
to include via checkboxes, downloads a JSON file. Later they (or a
friend) use "Import", upload the file, see per-section checkboxes
listing each Module and Belt found in the bundle, select the ones to
load, and the imported entries appear in their library. Conflicts (same
slug already exists) are flagged with merge/replace/skip choices.

**Why this priority**: Sharing and portability are the v1 substitute for
cloud sync.

**Independent Test**: Save 2 Modules + 1 Belt to library, export both
via the file flow with all checkboxes selected, clear localStorage,
import the file, assert all 3 entries restore. Then export with only
Modules selected, clear, import — assert only Modules restore and Belt
is absent.

**Workflows**: W-USER-6 (export + import round-trip).

---

### User Story 6 — User Shares a Belt via URL (Priority: P2)

A visitor finishes a belt, clicks "Share Link", copies a URL containing
the encoded config. They send it to a friend. The friend opens the URL,
sees the belt rendered in editor mode (the URL is decoded and the
editor hydrates with the shared config), and is prompted to save it to
their localStorage if they want to edit further.

**Why this priority**: Enables shareability without server infrastructure.

**Independent Test**: Encode a small Belt config (under 8KB encoded),
open the share URL in a fresh browser context, assert the belt renders
correctly. Encode a too-large config, assert the UI surfaces the
"too large for a link" fallback and offers file export instead.

**Workflows**: W-USER-7 (share URL round-trip).

---

### User Story 7 — Read-Only Embed in Another Page (Priority: P2)

A future product detail page for a kit needs to show the included
loadout's belt without offering edit affordances. The page renders the
same `<BeltLayout>` Astro component with `client:load` (or equivalent
hydration directive) omitted. The static belt visual appears; no
editor JS is shipped for that page; no drag handles, no palette.

**Why this priority**: Lets the same renderer be reused across the site
without duplicating render code.

**Independent Test**: Create a minimal test page that embeds a `Belt`
without hydration. Load with JS enabled and confirm: the belt renders,
no editor toolbar appears, no editor JS bundle is fetched (verify in
network panel), the rendered HTML is identical to the JS-disabled load
of an editor page.

**Workflows**: W-AUTHOR-1 (embed), W-AUTHOR-2 (parity with no-JS).

---

### User Story 8 — User Resets an Edited Preset to Original (Priority: P2)

A visitor edits the bundled `trainer` preset, saves, comes back later,
and wants to start over. They click "Reset to Original". The
localStorage override is removed and the bundled default is restored.

**Why this priority**: Recoverable mistakes are table stakes for an
editor.

**Independent Test**: Edit a preset, save, reload to confirm edit
persists, click Reset, reload, assert the bundled default is shown.

**Workflows**: W-USER-8 (reset preset).

---

### User Story 9 — User Authors a "Pick One Of" Group (Priority: P3)

A visitor adds a "pick one of" group to a belt: a single slot that
contains 2+ candidate Modules. At view/print time the group displays as
one item with a picker so the user (or buyer) decides which candidate
they actually want.

**Why this priority**: Preserves existing loadouts.md semantics (e-collar
holster variants are already a "pick one of" group).

**Independent Test**: Author a belt with a 2-candidate group at 90°,
save, reload, assert the group appears as one slot with both candidates
listed. Verify the print list shows alternatives, the BOM lists products
for both candidates, and the hardware list uses worst-case bolt count.

**Workflows**: W-USER-9 (group authoring).

---

## Edge Cases & Failure Modes

### Hydration & SSG
- **JS fails to load** → static SSG view remains; no broken editor; an
  inline `<noscript>`-equivalent banner (rendered server-side) explains
  the static view is read-only.
- **Hydration race / FOUC** → the editor MUST hydrate in place without
  visual layout shift. Hydration directive: `client:idle` is acceptable;
  `client:visible` is preferred for off-screen loadouts.
- **localStorage disabled / quota exceeded** → editor still works for
  the session; save attempts surface a clear error ("Storage is
  unavailable; export your config to a file instead"); export still
  works.
- **Bundled preset removed/renamed between visits** → if a stored
  override exists for a now-removed preset slug, the editor surfaces it
  in the gallery as an orphan with "Original preset no longer exists"
  and offers Save As / Delete.

### Plate & module composition
- **Empty plate save attempt** → save blocked; UI shows "Add at least
  one attachment".
- **Attachment with <2 aligned bolts** → save blocked; misaligned
  attachment's holes shown in red; tooltip explains.
- **Attachment overlaps another attachment** → detected by the
  lazy-loaded collision worker (FR-280). When the worker reports a
  collision, save is blocked and the colliding pair is highlighted
  with the bounding boxes returned by FR-284. While the worker is
  loading, behavior follows FR-282.
- **Bolt-hole tolerance** → ±0.5mm. Holes within tolerance count as
  aligned. Tolerance is a constant; not user-configurable.
- **Rotation** → 0°, 90°, 180°, 270° only. Other angles cannot be
  entered via UI or accepted via import (import migrates illegal
  rotations to the nearest cardinal with a warning).

### Belt composition
- **Module placed at angle that overlaps another Module** → detected
  by the lazy-loaded collision worker (FR-280 series). The Modules'
  STL meshes are positioned at their respective Mount + slot
  transforms; mesh-vs-mesh BVH check reports collisions. If the
  collision lib is not yet loaded at save time, the user is offered
  the choice from FR-282.
- **Belt width changed after Modules are placed** → mounts incompatible
  with the new width are flagged invalid (e.g. a `4x3` Plate on a
  38mm belt — `4x3` is 3-row, requires 52mm per FR-151); save blocked
  until the user removes or swaps them.

### Variant selection
- **Attachment variant removed from `attachments.ts`** → on load, the
  editor surfaces the affected placement with an "unknown variant"
  marker; offers swap to default variant or remove.
- **Variant pricing/products change** → BOM and hardware list always
  recompute from current `attachments.ts`; saved configs only store
  the variant ID, not its data.

### Import / export
- **Bundle schemaVersion newer than client** → import refused with
  "This config was created with a newer site version; please update".
- **Bundle schemaVersion older** → migration chain runs; per-step
  migrations are pure functions with their own tests; if migration
  fails for an entry, that entry is shown in the import UI as
  un-importable with the reason.
- **Bundle contains an attachment slug that doesn't exist** → entry is
  flagged in the import UI; user can choose to skip or accept (the
  placement becomes a "missing attachment" placeholder).
- **URL too long** → "Share link" UI says "Too large; please use file
  export" and offers the file-export action instead.
- **URL config has been tampered with (gzip fails / JSON invalid)** →
  show "This share link is corrupted" and offer to clear the URL param
  and start fresh.

### SCAD anchors & build
- **Module SCAD missing BOSL2 anchors** → CI build fails with
  "<model>.scad: no extractable bolt-hole anchors found".
- **Anchors present but extract produces no holes** → CI build fails.
- **Anchor coordinates outside reasonable bounds (e.g. negative beyond
  -1000mm)** → extractor warns; build fails if any anchor is implausible.

### Accessibility
- **Screen reader user wants to place an attachment** → grab via Space/
  Enter from focused palette item; arrow keys move focus to target
  cell; Space/Enter drops; live region announces "<attachment name>
  placed at row 2 column 3, rotated 90°, 4 bolts aligned, valid".
- **High-contrast / forced-colors mode** → editor maintains visual
  distinction between aligned (green) and misaligned (red) holes using
  shape (filled vs outline) as well as color.

### Undo/redo
- **Page navigation / reload** → action history is cleared; nothing
  persisted.
- **Action history during import** → import is a single undoable action
  (undoing reverts the entire import).
- **Destructive operations** → preset reset, Save (commit to
  localStorage), Import, and Delete are explicit confirmations and DO
  NOT push to the undo stack; the user is warned they cannot be undone.

---

## Functional Requirements

Requirements are grouped by area. Every requirement has a unique FR-xxx ID.

### Data model (FR-100 series)

- **FR-100**: System MUST define a canonical TypeScript module
  (`site/src/data/types.ts` or similar) exporting the following types:
  `Attachment`, `Mount`, `Plate`, `BeltClip`, `Module`, `Belt`,
  `AttachmentPlacement`, `Slot`, `ExportBundle`, `ImportSelection`.
- **FR-101**: `Attachment` MUST replace the existing `Module` concept in
  `site/src/data/modules.ts`. The file is renamed/migrated to
  `attachments.ts`; the existing `modules.ts` is removed (with all
  callers updated).
  Example: `export interface Attachment { slug: string; name: string; ... scadFile: string; holes: HoleSpec[]; products: Product[]; ... }`
- **FR-102**: `Belt` MUST replace the existing `Loadout` concept in
  `site/src/data/loadouts.ts`. The file is regenerated to emit `Belt`
  records; the public URL path (`/loadouts/<slug>/`) is unchanged for
  backwards compatibility.
- **FR-103**: `Mount` MUST be a discriminated union `Plate | BeltClip`
  with a `kind: "plate" | "belt-clip"` field.
- **FR-104**: `Plate` MUST have fields `{ kind: "plate", grid: "3x2" |
  "4x2" | "3x3" | "4x3", thickness: 5.3 | 6.5 | 12, scadFile, stlFile,
  holes: HoleSpec[], beltMountHoles: HoleSpec[] }`. Per
  [scad/CLAUDE.md](../../scad/CLAUDE.md), `<grid>` is always
  `<cols>x<rows>` (width × height); 2-row grids are 38mm belt, 3-row grids
  are 52mm belt.
- **FR-105**: `BeltClip` MUST have fields `{ kind: "belt-clip", grid:
  "3x2" | "4x2" | "3x3" | "4x3", scadFile, stlFile, holes: HoleSpec[],
  beltMountHoles: HoleSpec[] }`. Same grid set as Plate.
- **FR-106**: `Module` MUST have fields `{ id: string, name: string,
  mount: Mount, attachments: AttachmentPlacement[] }`. Constraint:
  `attachments.length >= 1`.
- **FR-107**: `AttachmentPlacement` MUST have fields `{ attachmentSlug:
  string, variantId?: string, originCell: { row: number, col: number },
  rotation: 0 | 90 | 180 | 270 }`. `originCell` is the Mount-grid cell
  the Attachment's **anchor hole** sits in after rotation; the anchor
  hole is the first entry in the Attachment's `holes: HoleSpec[]` array
  (i.e. `holes[0]`). Mount grid cells are 0-indexed with row 0 at the
  +Y edge (up the belt) and col 0 at the −X edge (per the SCAD
  coordinate convention documented in [scad/CLAUDE.md](../../scad/CLAUDE.md)).
- **FR-108**: `Slot` MUST be a discriminated union tagged by `kind`:
  - `{ kind: "single", moduleId: string, angleDeg: number }`
  - `{ kind: "group", label: string, candidateModuleIds: string[],
    angleDeg: number, groupDescription?: string }`

  `angleDeg` is in `[0, 360)` measured clockwise from the belt's buckle.
- **FR-109**: `Belt` MUST have fields `{ slug: string, name: string,
  width: 38 | 52, slots: Slot[], beltProducts?: Product[] }`. `width`
  matches the canonical values in FR-112.
- **FR-110**: `ExportBundle` MUST have fields `{ schemaVersion: number,
  modules: Module[], belts: Belt[] }`.
- **FR-111**: `HoleSpec` MUST have fields `{ name: string, x: number,
  y: number, z: number, normal: [number, number, number], boltSize:
  string }` where `boltSize` is a string like `"M3"` or `"M5"`.
- **FR-112**: Belt widths in the data model are **`38` and `52`** (matches
  existing SCAD and `presets.scad`). The user-facing strings "1.5\"
  duty" and "2\" duty" map to 38mm and 52mm respectively. `51` is an
  informal alias used in conversation but is NOT a valid value of the
  `width` field.

### Plate ↔ belt compatibility (FR-150 series)

- **FR-150**: A `Plate` or `BeltClip` with `grid` in `{"3x2", "4x2"}`
  (2-row) MAY be placed only on a Belt with `width === 38`.
- **FR-151**: A `Plate` or `BeltClip` with `grid` in `{"3x3", "4x3"}`
  (3-row) MAY be placed only on a Belt with `width === 52`.
- **FR-152**: Plate-thickness compatibility per belt:
  - `width === 38` → only `thickness === 5.3` is supported.
  - `width === 52` → `thickness === 6.5` (default) or `thickness === 12`.
  - BeltClips have a fixed plate-thickness per grid (see
    `presets.scad`); the editor does not expose a thickness chooser for
    BeltClips.
- **FR-153**: Editor MUST block placement of any Module whose mount is
  incompatible with the current belt's width or thickness and surface a
  clear error.
- **FR-154**: The editor's mount registry MUST be loaded from explicit
  TS files: `site/src/data/plates.ts` and `site/src/data/belt-clips.ts`.
  Each entry references its SCAD/STL files; the bolt hole layout is
  pulled in at build time from the corresponding `.holes.json`.

### SCAD bolt-hole extraction (FR-200 series)

- **FR-200**: Every `.scad` file referenced from `attachments.ts` or the
  plate/belt-clip registry MUST declare its bolt holes via BOSL2 named
  anchors. (Exception: attachments with `noModel: true`, which are
  exempt from the editor entirely.)
- **FR-201**: System MUST provide a build-time extractor
  (`scad/extract-holes.sh` or equivalent) that runs OpenSCAD and emits
  a sidecar JSON file `<model>.holes.json` containing a `HoleSpec[]`
  for each anchored model.
- **FR-202**: Extractor MUST be invoked as part of the existing
  STL-render pipeline (`site/npm run render`).
  Example: running `npm run render` produces both `*.stl` and
  `*.holes.json` for every model; a removed anchor causes the next
  render to emit a JSON without that hole.
- **FR-203**: CI MUST fail if any model in the registry is missing its
  `.holes.json` or the JSON contains zero holes.
- **FR-204**: Extractor output is loaded by Astro at build time and
  embedded into `attachments.ts` / `plates.ts` / `belt-clips.ts`. The
  editor never fetches `.holes.json` at runtime.

### Snap math (FR-250 series)

- **FR-250**: An AttachmentPlacement on a Mount is *valid* iff, after
  applying its rotation, at least 2 of the Attachment's bolt holes
  coincide with Mount bolt holes within ±0.5mm tolerance on the X and
  Y axes.
  Example: a 2-hole attachment at rotation 90 lands such that both its
  holes' rotated `(x, y)` coordinates are within ±0.5mm of distinct
  Mount hole positions → valid.
- **FR-251**: Editor MUST visually surface, for each AttachmentPlacement:
  (a) each hole that is aligned to a Mount hole (rendered green/filled),
  (b) each hole that is unaligned (rendered red/outline), (c) the
  count "<aligned>/<total> bolts aligned".
- **FR-252**: A Module is *valid for save* iff every AttachmentPlacement
  in it is individually valid AND no two AttachmentPlacements collide
  per FR-280 (full 3D mesh-vs-mesh check, lazy-loaded).
- **FR-253**: Editor MUST block save of an invalid Module with a clear
  error citing the offending placement(s).

### Collision detection (FR-280 series — lazy-loaded subsystem)

- **FR-280**: System MUST provide 3D mesh-vs-mesh collision detection
  for attachment placements (attachment ↔ attachment on a plate) and
  for Module placements (Module ↔ Module on a belt). Implementation:
  Three.js + `three-mesh-bvh` running in a Web Worker, loaded
  lazily on first save attempt or on user-triggered "Validate".
- **FR-281**: Collision lib bundle (Three.js + three-mesh-bvh + STL
  loader + worker glue) MUST be code-split from the core editor bundle
  and downloaded on demand. Editor must remain usable without it
  (placement, rotation, hardware-list computation all work without
  collision validation).
- **FR-282**: When the collision lib is not yet loaded and the user
  initiates an action that requires it (Save, Validate), the editor
  MUST surface a "Loading collision validator…" indicator and either:
  (a) defer the action until the lib loads, or (b) save with a flag
  `validatedCollisions: false` on the saved Module/Belt (user choice
  in settings; default = wait).
- **FR-283**: A Module or Belt that was saved without collision
  validation MUST be re-validatable later via a "Validate now" action,
  and MUST be visually marked as un-validated in the gallery.
- **FR-284**: Collision check input: the involved STL meshes positioned
  per the editor's placement transforms (translation, rotation). Output:
  a boolean per pair; for failures, the colliding mesh-pair identities
  and bounding boxes for visualization.
- **FR-285**: Collision check MUST run asynchronously in a Web Worker
  so the main thread stays responsive. Timeout per check: 5 seconds
  per pair; if exceeded, the pair is reported as "indeterminate" and
  the placement is allowed with a warning.

### Editor — palette & drag-drop (FR-300 series)

- **FR-300**: The editor MUST display a palette of Attachments. Each
  variant of a multi-variant attachment appears as a separate palette
  item (e.g. `carabiner-clip / tiny`, `carabiner-clip / small` are
  distinct palette entries).
- **FR-301**: Palette MUST support text-based filtering and category
  grouping. Categories are sourced from the `category` field on each
  `Attachment` entry in `attachments.ts` (e.g. `leash`, `carabiner`,
  `holster`, `pouch`); the field is added during the modules.ts →
  attachments.ts migration if not already present.
- **FR-302**: Desktop interaction model MUST support mouse drag-drop
  from palette → Mount cell.
- **FR-303**: Touch interaction model MUST support long-press
  (≥400ms) to grab + drag-drop. Scroll-vs-drag disambiguation:
  long-press initiates grab and disables scroll until the grab is
  released; tap-without-long-press does not initiate drag.
- **FR-304**: Editor MUST support keyboard interaction equivalent to
  drag-drop: Tab into palette, arrow keys between palette items, Space/
  Enter to grab, Tab to target Mount, arrow keys to choose target cell,
  Space/Enter to drop, Escape to cancel.
- **FR-305**: Hit targets (palette items, Mount cells, drag handles)
  MUST be at minimum 44×44 CSS pixels.

### Editor entry points & library actions (FR-330 series)

- **FR-330**: The `/belt-editor/` gallery MUST list:
  (a) every bundled Belt preset (from `loadouts.ts`),
  (b) every user-saved Belt from `kanix.belts.v1` (FR-501), and
  (c) every user-saved Module from `kanix.modules.v1` (FR-500).
  Bundled and user entries are visually distinguished (e.g. badge,
  border).
- **FR-331**: "New Belt" action in the gallery MUST create a blank
  Belt with the user-chosen width (38 or 52), empty `slots`, and
  open it in the editor at a synthetic route (e.g.
  `/belt-editor/new/?id=<temp>`).
- **FR-332**: "New Module" action in the gallery MUST prompt for
  Mount type (`plate` / `belt-clip`) and grid (compatible with the
  currently active Belt's width if any; otherwise all 4 grids), then
  open an empty Module in the editor.
- **FR-333**: "Save Module" action in the plate editor MUST commit
  the current Module (with user-supplied name) to `kanix.modules.v1`
  and add it to the library.
- **FR-334**: "Save Belt" action in the belt editor MUST commit the
  current Belt (with user-supplied name) to `kanix.belts.v1`. For
  bundled-preset edits, the saved entry uses the preset's slug as key
  (per FR-503); for new Belts, the user supplies a new slug.
- **FR-335**: "Delete" action on a user-saved Module or Belt MUST
  prompt for confirmation, then remove the entry from localStorage.
  Bundled presets cannot be deleted (only Reset to Original per
  FR-504).
- **FR-336**: User MUST be able to re-open any user-saved or
  preset-supplied Module from the library for further editing. Edits
  to user-saved Modules update the existing entry in
  `kanix.modules.v1`. Edits to a Module that came from a bundled
  preset are saved as a user copy with an auto-suffixed name
  (`<name> (copy)`) — the bundled preset is not mutated.

### Editor — plate authoring (FR-350 series)

- **FR-350**: Plate editor MUST display the chosen plate grid with one
  visible bolt-hole circle per Mount hole.
- **FR-351**: When an Attachment is being dragged over the plate, the
  editor MUST live-preview alignment (green/red dots) at the current
  drop position.
- **FR-352**: After drop, the Attachment renders in its declared
  rotation and the placement is added to the Module's
  `attachments[]` array.
- **FR-353**: Placed attachments MAY be rotated via a button or `R`
  key (cycles 0 → 90 → 180 → 270 → 0).
- **FR-354**: Placed attachments MAY be removed via a delete button or
  Delete/Backspace key.
- **FR-355**: Placed attachments MAY be swapped with a different
  variant via a per-placement edit panel.
- **FR-356**: Plate editor MUST surface the current Module's hardware
  count live (bolts in use, unused holes).

### Editor — belt assembly (FR-400 series)

- **FR-400**: Belt editor MUST display the belt as a top-down outline
  with an angle scale (0° at buckle, 90° at right hip, 180° at small
  of back, 270° at left hip) using the existing PCB-trace visual
  style.
- **FR-401**: Module library panel MUST list all Modules accessible to
  the user (system-supplied + user-saved + URL-imported) with
  search/filter.
- **FR-402**: User MUST be able to drag a Module from the library
  onto the belt; on drop, the user is prompted for the angle (or the
  angle is set to the cursor's angular position). Continuous 0–360°.
- **FR-403**: Placed slots MAY have their angle adjusted by drag-along-
  belt or by typing an exact value.
- **FR-404**: Placed slots MAY be removed via a delete button or
  Delete/Backspace key.
- **FR-405**: Belt editor MUST surface the full hardware total live
  (bolts inside each Module + bolts attaching each Module's mount to
  the belt).

### "Pick one of" groups (FR-450 series)

- **FR-450**: A `Slot` MAY be a group with `candidateModuleIds: string[]`.
- **FR-451**: User MUST be able to create a group by selecting 2+
  existing Modules from the library and choosing "Group as alternatives".
- **FR-452**: A group renders on the belt as a single visual slot
  showing a representative Module (the first candidate) with a "pick 1
  of N" badge.
- **FR-453**: Print list MUST list all candidates in a group under one
  header.
- **FR-454**: BOM MUST list products for all candidates as alternatives.
- **FR-455**: Hardware list MUST use the worst-case (max-bolts)
  candidate when reporting bolts for a group slot.

### Persistence & state (FR-500 series)

- **FR-500**: Saved Modules MUST be persisted to browser localStorage
  under key `kanix.modules.v1` as a JSON-serialized `Module[]`.
- **FR-501**: Saved Belts MUST be persisted to browser localStorage
  under key `kanix.belts.v1` as a JSON-serialized `Belt[]`.
- **FR-502**: System-supplied Belt presets MUST be available without any
  localStorage entry (loaded from the bundled `loadouts.ts` at build
  time). System-supplied **Modules** are derived from the presets: any
  `Module` referenced by a bundled `Belt` is automatically included in
  the user's Module library as a read-only entry, addressable by
  the Module's `id`. There is no separate `system-modules.ts` file in
  v1; Modules exist only inside Belts.
- **FR-503**: If a localStorage entry exists for a preset slug, it
  takes precedence over the bundled default when rendering the editor
  for that slug.
- **FR-504**: "Reset to Original" button MUST remove the localStorage
  entry for the current preset, causing the bundled default to render
  on next load.
- **FR-505**: localStorage write failures (quota exceeded, storage
  disabled) MUST be reported in-UI with a clear message and a
  suggestion to use file export.

### Export & import (FR-550 series)

- **FR-550**: "Export" UI MUST present a list of all saved Modules and
  Belts with a checkbox per entry. User selects which to include in
  the bundle.
- **FR-551**: "Export" MUST produce a downloadable JSON file
  conforming to the `ExportBundle` shape (FR-110).
- **FR-552**: "Import" UI MUST accept a JSON file via file picker and
  display its contents as per-entry checkboxes (one section for
  Modules, one for Belts). User selects which entries to import.
- **FR-553**: Per-entry conflict resolution: if an imported entry's
  slug or ID matches an existing entry, the UI offers Replace,
  Skip, or "Save as new (auto-suffix)".
- **FR-554**: Schema versioning: every `ExportBundle` includes
  `schemaVersion`; imports run through a migration chain registered
  with the editor. Initial version: `1`.
- **FR-555**: Import of a `schemaVersion` higher than the client
  supports MUST be refused with a clear "newer site version required"
  message.
- **FR-556**: Per-entry import failure (missing dependency, unknown
  attachment slug, etc.) MUST be reported with the specific reason and
  MUST NOT abort the rest of the import.

### Share URL (FR-600 series)

- **FR-600**: "Share Link" action MUST produce a URL of the form
  `<origin>/loadouts/<slug>/?config=<encoded>` (or equivalent path on
  `/belt-editor/`).
- **FR-601**: `<encoded>` MUST be `base64url(gzip(JSON.stringify(
  ExportBundle)))` containing exactly the current Belt and its
  referenced Modules.
- **FR-602**: Encoded size limit: 8KB. If the encoded payload exceeds
  this, the UI MUST refuse to produce a URL and offer the file-export
  flow instead.
- **FR-603**: On page load, if `?config=` is present and parses, the
  editor MUST decode it and hydrate with the shared content, prompting
  the user to save to localStorage (NOT auto-saving).
- **FR-604**: If decoding fails (bad base64, gzip failure, JSON
  invalid, schema migration fails), the UI MUST show a "this share
  link is corrupted" message and offer to clear the URL param and
  start fresh.
- **FR-605**: Share Link UI MUST display a warning that anyone with
  the link can see the loadout.

### Hydration & rendering modes (FR-650 series)

- **FR-650**: Loadout detail pages (`/loadouts/<slug>/`) MUST render
  the full belt visual, module list, print list, BOM, and hardware
  list server-side. No content depends on JS execution.
- **FR-651**: Editor JS MUST hydrate the static view in place without
  visual layout shift.
- **FR-652**: A read-only embed mode MUST be possible by rendering the
  same Astro component without a hydration directive. No editor JS is
  loaded for that page.
- **FR-653**: When JS fails to load or is disabled, the static view
  MUST remain functional for browsing (it is the same content that
  scrapers see).

### Outputs — print, BOM, hardware (FR-700 series)

- **FR-700**: Editor MUST compute a **Print List**: a quantity-rolled-up
  table of all Kanix STL files required to physically build the
  current Belt (plates, belt clips, attachment bodies).
- **FR-701**: Editor MUST compute an **Amazon BOM**: a quantity-rolled-
  up list of all third-party `Product` entries referenced by the
  Belt's Modules' Attachments, plus the belt itself.
- **FR-702**: Editor MUST compute a **Hardware List** rolled up by
  bolt size:
  - For each Module, count bolts that participate in the ≥2-bolt
    snap for each AttachmentPlacement (the "in use" count). A bolt is
    "in use" iff a Mount hole position is within ±0.5mm of an
    Attachment-hole position from any AttachmentPlacement on that Mount.
  - For each Module's Mount, count Mount holes that are NOT "in use"
    per the above (the "unused / fill the rest" count). The sum of
    in-use and unused equals the Mount's total hole count.
  - For each Slot, count bolts attaching the Module's Mount to the
    belt (using the length of the Mount's `beltMountHoles` array).
  - Roll up by bolt size: `M3 × 8mm: 14 used, 6 unused, 20 total`.
  - Bolt length is not modeled in v1 (only diameter via `boltSize` in
    HoleSpec). The output lists "× <default_length>" using this
    per-bolt-size default table baked into the output generator:
    `M2 → 6mm, M2.5 → 8mm, M3 → 8mm, M4 → 10mm, M5 → 12mm, M6 → 14mm`.
    If a hole's `boltSize` isn't in the table, it falls back to
    `× ?mm` and a warning is logged at build time. The user is
    expected to verify actual lengths against the physical hardware.
- **FR-703**: For a "pick one of" group slot, the hardware list uses
  the candidate with the MAX bolt count (worst case).
- **FR-704**: All three outputs MUST be rendered both in the editor
  UI AND in the SSG-rendered static loadout page (computed at build
  time from the bundled preset). The output generator is one shared
  module consumed by both consumers.

### Accessibility (FR-750 series)

- **FR-750**: Editor MUST meet WCAG 2.1 AA for keyboard navigation,
  contrast, focus visibility, and screen reader support.
- **FR-751**: Palette is an ARIA `listbox` of `option` elements.
- **FR-752**: Plate grid is an ARIA `grid` of `gridcell` elements with
  arrow-key navigation.
- **FR-753**: Belt assembly canvas exposes placed slots as ARIA
  `button` elements labelled `"<Module name> at <angle>°"`; arrow-key
  navigation walks slots in angular order.
- **FR-754**: A polite ARIA live region MUST announce all placement,
  rotation, and validation events.
  Example announcements:
  - "Carabiner clip placed at row 1 column 2, rotated 0°, 4 of 4
    bolts aligned, valid"
  - "Cannot place dump-bag mount: only 1 of 3 bolts aligns; try
    rotating or moving"
  - "Module 'Trainer kit' placed at 90 degrees on belt"
- **FR-755**: Aligned vs misaligned holes MUST be distinguishable
  without color (use shape/fill in addition to color) per WCAG 1.4.1.
- **FR-756**: Focus order MUST be: palette → plate cells (row-major) →
  placed attachments → action buttons → save → palette (cycle).

### Undo / redo (FR-800 series)

- **FR-800**: Editor MUST support unbounded in-memory undo/redo within
  a session (no persistence of history across reloads).
- **FR-801**: Keyboard shortcuts: Ctrl-Z / Cmd-Z (undo), Ctrl-Shift-Z /
  Cmd-Shift-Z (redo). On-screen buttons mirror.
- **FR-802**: Undoable operations: attachment place, attachment remove,
  attachment rotate, attachment variant swap, attachment cell move,
  Module add to library, Module remove from library, slot place on
  belt, slot remove, slot angle change, group create, group dissolve.
- **FR-803**: Non-undoable (destructive, require explicit confirmation):
  Reset to Original, Import, Save (commit to localStorage), Delete
  saved entry, Clear localStorage. Import is per-entry per FR-556 —
  successful entries land, failed entries are reported; "undo" cannot
  reverse the import. A user wanting to undo an import should explicitly
  delete the imported entries.

### Migration of existing data (FR-900 series)

- **FR-900**: Every existing entry in `loadouts.md` MUST be re-emitted
  by the regeneration step as a valid `Belt` referencing `Module`
  records. The migration is one-time; the `loadouts.md` authoring
  protocol updates to produce the new shapes.
- **FR-901**: Every existing entry in `site/src/data/modules.ts` MUST be
  migrated to `site/src/data/attachments.ts`. The TypeScript type
  formerly named `Module` (and `ComingSoonModule`) is renamed to
  `Attachment` (and `ComingSoonAttachment`) throughout the codebase
  and at every call site. The migration is a single PR; no shim
  re-exports.
  Sub-step: each migrated entry gains a `category` field (one of
  `leash`, `carabiner`, `holster`, `pouch`, `light`, `clicker`,
  `bag-mount`, `other`) used by the palette grouping in FR-301. The
  migrator assigns categories from current naming + manual review;
  unassigned entries default to `other` and are flagged for human
  review.
- **FR-902**: Existing `LoadoutModule` field mapping into the new model:
  - `LoadoutModule.slug` → resolved to an `Attachment`. A `Module` is
    synthesized: `{ id: <auto-generated, e.g. "mod-<beltSlug>-<index>">,
    name: <Attachment.name or LoadoutModule.note>, mount: <derived
    from LoadoutModule.plate STL filename>, attachments: [{
    attachmentSlug: <slug>, variantId: <variant>, originCell: { row: 0,
    col: 0 }, rotation: 0 }] }`.
  - `LoadoutModule.plate` (STL filename) → parsed by the migrator to
    determine `Mount.kind` (`plate` or `belt-clip`) and `Mount.grid`
    from the filename pattern (`kanix_plate_<grid>_*.stl` →
    `Plate`, `belt_clip_<grid>_*.stl` → `BeltClip`).
  - `LoadoutModule.angle` → `Slot.angleDeg`.
  - `LoadoutModule.variant` (string OR string[]) → string becomes one
    AttachmentPlacement; string[] becomes multiple AttachmentPlacements
    in a single Module sharing one mount (matching the existing
    "multiple variants on one plate" semantics).
  - `LoadoutModule.choices` / `groupLabel` / `groupDescription` → a
    group `Slot` with `kind: "group"`, `label: groupLabel`,
    `candidateModuleIds: [...]` (one synthesized Module per choice).
  - Entries with `noModel: true` and no `plate` are handled per FR-105
    (BeltClip) or skipped if the attachment is purely belt-worn
    (e.g. BioThane heel lead): in that case the migration drops the
    entry from the `Belt.slots` and surfaces a warning so the
    author can decide where to place it manually.
- **FR-903**: Existing public URLs (`/loadouts/<slug>/`, `/modules/<slug>/`,
  `/coming-soon/<slug>/`) MUST continue to resolve. Internal data may be
  re-keyed but URL routes remain stable.
- **FR-904**: Existing `PlateVariant` entries are reconciled against the
  editor's authoritative set (`3x2`, `4x2`, `3x3`, `4x3`):
  - **Kept and editor-supported**: `3x2`, `4x2` (38mm × 5.3mm); `3x3`,
    `4x3` (52mm × 6.5mm and 52mm × 12mm).
  - **Deprecated (legacy SCAD files remain, NOT registered)**: `2x2`,
    `2x3` (2-wide plates are too weak for production use).
  - No new plate SCAD models are needed for plates (the existing 6
    SCAD plate fixtures cover the editor's grid set once PREREQ-1
    rectangularizes `kanix_plate`).

---

## Success Criteria

- **SC-001**: All FR-100 series (data model) types are exported from a
  single TypeScript module with no `any` types. `tsc --noEmit` passes.
  [validates FR-100 through FR-112]
- **SC-002**: Every model file referenced from the three new mount/
  attachment registries (`attachments.ts`, `plates.ts`, `belt-clips.ts`
  — created by this feature per FR-101 and FR-154) has a valid
  `.holes.json` generated by the extractor. CI fails the build
  otherwise.
  [validates FR-200 through FR-204]
- **SC-003**: The SCAD-anchor round-trip Vitest test passes for every
  Attachment in `attachments.ts`: for every cardinal rotation, the
  editor's computed alignment matches a sample SCAD-rendered placement
  to within ±0.5mm.
  [validates FR-250, FR-251, FR-252]
- **SC-004**: Playwright e2e test "preset → edit → save → reload"
  passes for every bundled preset.
  [validates FR-300 series, FR-500 through FR-505]
- **SC-005**: Playwright e2e test "export → import" round-trip restores
  identical Modules and Belts.
  [validates FR-550 through FR-556]
- **SC-006**: Playwright e2e test "share URL round-trip" produces a URL,
  opens it in a fresh context, restores the same Belt.
  [validates FR-600 through FR-605]
- **SC-007**: Static site builds with JS disabled; HTML-fetch (curl) of
  every `/loadouts/<slug>/` returns the full belt visual + lists in
  the raw HTML.
  [validates FR-650, FR-653]
- **SC-008**: Read-only embed test page loads without fetching the
  editor JS bundle (verified in Playwright via network requests).
  [validates FR-652]
- **SC-009**: axe-core a11y scan of `/loadouts/<slug>/` (editor active)
  reports zero serious or critical violations.
  [validates FR-750 through FR-756]
- **SC-010**: Undo/redo test: 50-step random action sequence produces
  the same final state when fully undone+redone as when applied
  directly.
  [validates FR-800 through FR-803]
- **SC-011**: Migration test: every existing `Loadout` entry from the
  current `loadouts.ts` is successfully converted to a `Belt` with
  identical visible content (same modules at same angles, same
  variants, same groups).
  [validates FR-900 through FR-904]
- **SC-012**: Hydration performance budget: editor hydrates in <500ms
  on a mid-range Android device for the largest bundled preset
  (measured via Playwright + CDP performance trace).
  [validates FR-651]
- **SC-013**: JS bundle size budgets enforced via size-limit in CI:
  - **Core editor bundle** (gzipped, on a loadout page): ≤80KB.
    Includes palette, drag-drop, snap math, hardware-list rollup,
    persistence, undo/redo. EXCLUDES collision lib.
    [validates FR-651]
  - **Collision lib bundle** (gzipped, lazy-loaded chunk): ≤250KB.
    Three.js + three-mesh-bvh + STL loader + worker.
    [validates FR-281]
- **SC-014**: Collision detection round-trip test: for a known pair of
  attachments with intentional 3D overlap (authored as a SCAD union
  that visibly intersects), the collision worker reports collision.
  For a non-overlapping pair, it reports no collision. Runs in
  Vitest with a real Three.js + three-mesh-bvh setup (jsdom or
  headless browser).
  [validates FR-280, FR-284]

---

## Non-Goals

Things this feature deliberately does NOT do in v1:

- **No cloud sync / cross-device persistence.** Configs live in
  localStorage only. *Rationale*: avoids auth, server schema, conflict
  resolution; deferred to v2 when user accounts exist.
- **No 3D editor view.** The editor is 2D-only; the existing 3D-on-2D
  PCB-trace render is read-only. *Rationale*: 3D drag-and-drop UX is
  hard to get right on mobile and would weeks-delay v1; the 2D editor
  is sufficient for buildable configs.
- **No checkout/ordering integration.** The editor produces lists
  (print/BOM/hardware) but does not push them into a cart on the
  commerce platform. *Rationale*: commerce platform is itself in
  progress (see `specs/admin/`); this integration is a separate v2
  feature once both exist.
- **No auto-arrange / "fill my belt for me" assistant.** No suggestion
  algorithm that places modules based on goals (e.g. "bite-work
  loadout"). *Rationale*: not validated as user need; user-driven
  editing is the v1 contract.
- **No multi-user collaboration.** Two users cannot edit the same
  config concurrently. *Rationale*: out of scope for a localStorage-
  backed editor; deferred indefinitely.
- **No URL-published persistent configs.** Share URLs encode the
  config directly; there are no server-stored "published" configs with
  short URLs. *Rationale*: pure client-side; v2 follow-up.

---

## Testing

### Integration testing philosophy

Tests follow the project constitution (Article III): real servers,
real databases, no mocks at system boundaries. For this feature
specifically:

- **No mocked SCAD extractor**: the round-trip test runs the real
  extractor against real BOSL2-anchored SCAD files.
- **No mocked browser**: Playwright drives a real Chromium via
  `mcp-browser`. Mobile drag tests run Playwright with touch emulation.
- **No mocked storage**: localStorage tests use real browser storage
  via Playwright.

### Test categories

- **Unit (Vitest, `site/`)**: snap math, hole-alignment computation,
  rotation transforms, hardware list rollup, schema migration chain,
  URL encode/decode, action/inverse-action algebra (undo/redo).
- **Integration (Vitest, `site/`)**: load preset → mutate → serialize →
  deserialize → assert deep-equal. Migration test: load every legacy
  Loadout → assert equivalent Belt.
- **SCAD round-trip (Vitest + OpenSCAD subprocess)**: for each
  Attachment, for each cardinal rotation, render the placement in
  OpenSCAD and assert bolt-hole alignment in the rendered geometry
  matches the editor's snap math.
- **E2E (Playwright via mcp-browser)**: full user stories. Mobile
  touch flows tested via Playwright's touch emulation. Includes a
  no-JS test (Playwright with JS disabled) verifying SSG render.
- **A11y (axe-core via Playwright)**: every editor route scanned
  on each release; zero serious or critical violations gate the
  build.
- **Bundle size (size-limit)**: core editor JS gzipped ≤80KB; lazy
  collision-lib chunk gzipped ≤250KB. Both gates enforced in CI per
  SC-013.

### Per-story Independent Tests

Each user story above has an "Independent Test" line. Those are the
acceptance gates per story.

---

## Operational workflows

(This feature is a frontend editor; "operational" workflows are
build-time and developer-facing rather than runtime ops.)

### Day-1 setup (developer)
1. `nix develop` → all tools available (Node, pnpm, OpenSCAD, etc.).
2. `cd site && npm install`.
3. `cd .. && npm run render` (or `cd site && npm run render`) →
   generates `.stl` and `.holes.json` for every model.
4. `cd site && npm run dev` → editor available at
   `http://localhost:4321/loadouts/trainer/`.

### Day-2 ops (adding a new Attachment)
1. Author the `.scad` file in `scad/` with the CC BY-NC-ND license
   header and BOSL2 named anchors for every bolt hole.
2. Add the Attachment entry to `site/src/data/attachments.ts`
   referencing the SCAD file.
3. `npm run render` → produces `.stl` and `.holes.json` for the new
   model.
4. Run `npm run build` → CI's "verify holes" step passes if the
   anchors were declared correctly.
5. Refresh the editor → new Attachment appears in the palette.

### Failure recovery
- **Extractor produces empty `.holes.json`** → author missed adding
  BOSL2 anchors; build fails with the missing-model name; fix the
  `.scad` file.
- **Snap math reports never-valid placements** → run the SCAD
  round-trip test for that attachment to isolate extractor-vs-editor
  disagreement.
- **localStorage corrupted in user browser** → user can manually
  clear via DevTools or use the in-app "Clear all saved data" action.

---

## Enterprise infrastructure decisions

This feature inherits the project-level decisions from
`specs/admin/spec.md` (Astro for SSG, Vitest for unit, Playwright for
e2e, GitHub Actions for CI, Nix for environment). Feature-specific
notes:

- **Logging (browser)**: minimal `console.log/warn/error` for v1; no
  remote logging. (The editor is client-side only.)
- **Error handling**: typed error hierarchy for editor failures
  (`EditorError` → `SnapValidationError`, `MigrationError`,
  `StorageError`, `EncodingError`). Surfaced as in-UI banners with
  recovery actions.
- **Config**: no runtime config; build-time only (bundled presets,
  Astro environment).
- **Auth**: none (out of scope for this feature; see Non-Goals).
- **CORS**: N/A (no cross-origin requests in v1).
- **Security**:
  - Share URL config payload is sanitized: any string field longer
    than 1KB is rejected on decode.
  - Imported files are size-limited (≤256KB after decompression) to
    prevent quadratic-time decode/migration DoS.
  - All user-supplied strings are escape-rendered (Astro / React
    default).
- **Rate limiting**: N/A.
- **Observability**: the site has no existing client-side error
  reporting (verified via grep for Sentry / window.onerror / etc.).
  This spec does NOT introduce a new error reporting system; editor
  errors surface as in-UI banners only. A future v2 may add error
  reporting once the commerce platform stands up its observability
  stack (see `specs/admin/`).
- **Migration & versioning**:
  - `ExportBundle.schemaVersion` with a registered migration chain in
    `site/src/lib/migrations/`.
  - SCAD anchor schema is implicitly versioned by the extractor; the
    extractor and editor must release together.
- **Branching strategy**: feature branch `feature/belt-editor` per
  spec-kit default (matches project convention).
- **CI/CD**: GitHub Actions; gates added by this feature:
  - `verify-holes` (FR-203)
  - `bundle-size` (SC-013)
  - `axe-a11y` (SC-009)
  - `scad-round-trip` (SC-003)
- **Health checks**: N/A (client-side).
- **DX**: `npm run render`, `npm run dev`, `npm run build`, `npm test`
  unchanged; new `npm run holes:verify` script wraps the CI check for
  local use.

---

## Prerequisite work (must complete before Belt Editor implementation)

The editor depends on SCAD infrastructure migrations already scoped in
[scad/CLAUDE.md](../../scad/CLAUDE.md). These MUST land before — or be
included as part of — Phase 7 (implement) of this spec.

### PREREQ-1: Rectangularize `kanix_plate` (scad/CLAUDE.md Op 1)

Currently `kanix_plate` only supports square plates (`2x2`, `3x3`). The
editor needs all four v1 grids to render properly: `3x2`, `4x2` (38mm),
`3x3`, `4x3` (52mm). Three of these (`3x2`, `4x2`, `4x3`) are
non-square and only render as placeholder stubs today; `3x3` is the
one square v1 grid that already works.

Without this op, the editor cannot ship: even if its TypeScript and UI
were complete, the three non-square plate fixtures would render
incorrectly in the existing static loadout pages and in the editor's
plate preview, and `.holes.json` extraction would extract holes from a
stub plate, not the real geometry.

Acceptance: every plate fixture used by the editor's v1 grid set
(`3x2`, `4x2`, `3x3`, `4x3`, across both supported thicknesses for
52mm grids) renders a full hinged clip matching the existing square
`3x3` style. Per `scad/CLAUDE.md`, this means flipping the ⚠ marker
to ✓ for the 6 currently-stubbed fixtures.

### PREREQ-2: Migrate accessories off legacy presets (scad/CLAUDE.md Op 2)

Several accessory fixtures still reference legacy `kanix_preset_*`
names (e.g. `kanix_preset_38x4`, `kanix_preset_52x65`) rather than the
canonical `kanix_grid_*` names. The editor's mount-vs-attachment snap
math reads `kanix_grid_*` hole coordinates; legacy-named fixtures will
produce inconsistent `.holes.json`.

Required: complete the per-accessory work listed in `scad/CLAUDE.md` Op
2 (clicker_holder, wuben-c3-holster, carabiner_clip, belt_clip, any
others). When `grep -l kanix_preset_ scad/` is empty, delete the
legacy aliases from `lib/presets.scad`.

### PREREQ-3: Add BOSL2 named anchors for bolt holes

The current `lib/mounting-plate.scad` and `lib/kanix-plate.scad` drill
bolt holes from a position calculation but do not place named BOSL2
anchors at each hole. The hole extractor (FR-201) needs named anchors
to emit `HoleSpec[]`.

Required:
- Modify `lib/mounting-plate.scad` and `lib/kanix-plate.scad` to
  attach a named anchor (`anchor_pos(...)` or `named_anchor(...)`)
  at each bolt hole, naming them `bolt_<col>_<row>` (1-indexed).
- Same for every accessory module that has its own attachment-side
  bolt pattern (carabiner_clip variants, holsters, etc.).
- For BeltClip mounts, name the belt-mount holes `belt_<n>`.

Acceptance: running the extractor against every fixture produces a
non-empty `HoleSpec[]` where every entry has a `name` matching the
documented pattern.

### PREREQ-4: Add 4xN BeltClip SCAD fixtures (if missing)

The user's spec'd v1 includes `4x2` and `4x3` BeltClip variants. Check
whether `belt_clip_4x2_*.scad` and `belt_clip_4x3_*.scad` exist; if
not, add them by analogy to the existing `belt_clip_3x2_38mm.scad` (and
correctly-named successors per PREREQ-2).

---

## Clarifications resolved

All initial `[NEEDS CLARIFICATION]` items resolved in Round 7 + Round 8
of the interview. Summary:

- **CLARIFY-01 (plate grid set)** — Editor supports `3x2, 4x2` (38mm)
  and `3x3, 4x3` (52mm). 2-column grids (`2x2, 2x3`) deprecated: SCAD
  files remain on disk but are excluded from the editor registry. See
  FR-104, FR-150, FR-151.
- **CLARIFY-02 (overlap detection)** — Full 3D mesh-vs-mesh collision
  detection via Three.js + three-mesh-bvh, lazy-loaded in a Web Worker.
  See FR-280 series.
- **CLARIFY-03 (belt widths)** — Canonical: `38` and `52`. "51mm" is
  a conversational alias only. See FR-112.
- **CLARIFY-04 (BeltClips)** — Exist as SCAD fixtures
  (`scad/belt_clip_*.scad`) but several are mis-named per the Op 2
  migration in `scad/CLAUDE.md`. Editor uses the corrected/renamed
  set. See FR-105, PREREQ-2.
- **CLARIFY-05 (plate-less modules)** — Carabiner-clip-style
  attachments become `Attachment` on a `BeltClip` mount under the new
  data model. No "belt-hung" slot type; everything bolts to something.
  See FR-103, FR-105, FR-106.
- **CLARIFY-06 (thickness defaults)** — `38mm` belt → `5.3mm` plate
  only. `52mm` belt → `6.5mm` (default) or `12mm`. See FR-152.

No further `[NEEDS CLARIFICATION]` tags remain in the spec body.

---

## MANDATORY checklist verification

- [x] Every requirement has a unique `FR-xxx` ID
- [x] Ambiguous FRs have inline `Example:` showing concrete input/output
- [x] Non-Goals section lists intentional omissions with rationale
- [x] Testing section with functional requirements for integration tests
- [x] Edge Cases & Failure Modes section with expected behavior
- [x] Every setup flow is idempotent (extract is re-runnable; localStorage
      writes are last-writer-wins; imports are explicit per-entry)
- [x] Enterprise infrastructure decisions documented
- [x] UI flow requirements included (interspersed in FR-300, FR-350,
      FR-400 series + accessibility FR-750 series); full UI_FLOW.md to be
      generated in Phase 5.5 (workflows)
- [x] Operational workflows documented (developer-facing, since this is
      a client-side feature)
