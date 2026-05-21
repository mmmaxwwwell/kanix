# Interview Notes — Belt Editor

**Preset**: enterprise (inherited from existing project)
**Nix available**: yes
**Date**: 2026-05-21
**Feature slug**: `belt-editor`
**Status**: interview in progress

## Foundational decisions (Round 1)

### Feature slug
`belt-editor` — short, action-oriented.

### Persistence model (v1)
- Browser-only: localStorage + file export/import (JSON).
- System-supplied presets baked into the app at build time (the existing
  `loadouts.md` → `loadouts.ts` pipeline becomes the source of presets).
- No backend, no accounts, no cloud sync for v1.
- **Non-Goal (v1)**: cross-device sync, server-side persistence, sharing via
  URL/cloud. Document as planned v2 follow-up.

### Bolt-hole coordinate source
- **SCAD-extracted via BOSL2 anchors.**
- Each `.scad` model gets named anchor points (e.g. `bolt_hole_a`,
  `bolt_hole_b`) using BOSL2's `anchor()` system.
- A new `scad/extract-holes.sh` (or similar) emits a sidecar JSON per model
  (`<model>.holes.json`) listing `{name, x, y, z, normal, bolt_size}` per
  hole. Runs during the existing STL render step.
- Single source of truth — survives model edits without manual TS updates.
- Applies to BOTH modules and plates (plates also have hole grids).

### Editor UI (v1)
- **2D for both plate authoring and belt assembly.** No 3D editing.
- The existing 3D-on-2D PCB-trace belt map continues to exist as the
  **display** mode (SSG-rendered for scrapers; hydrated for interactive
  display). The **editor** mode is pure 2D top-down.
- Plate editor: grid of cells (2x3 or 3x3) with bolt-hole circles overlaid;
  drag modules from a palette onto cells; rotation by stepped angles.
- Belt editor: top-down belt outline with snap-to-angle slots; drag plates
  (or bare modules) into slots; rotate per slot.
- Rationale: cheaper to ship, easier to use on mobile, doesn't gate on
  Three.js drag-drop UX work.

## Foundational decisions (Round 2)

### Module rotation on a plate
- **4-step only**: 0°, 90°, 180°, 270°.
- Discrete cardinal rotations only — keeps bolt-hole snap math trivial,
  matches how MOLLE/PALS gear actually mounts.

### Snap rule for module → plate
- A module placement is valid iff **at least 2 of its bolt holes align
  with plate holes**.
- "Aligned" means: module is placed on the integer plate grid, rotated to
  a cardinal angle, and ≥2 of the module's bolt holes (post-rotation)
  coincide with plate bolt-hole positions to within tolerance.
- Saves are blocked while any placement has <2 aligned bolts.
- Editor surfaces aligned/unaligned holes visually (green vs red dots).

### Belt placement angles
- **Continuous 0–360°**, free placement. Matches the existing
  `loadouts.ts` `angle` field semantics (degrees clockwise from buckle).
- No PALS-slot snapping in v1. User can place plates and bare modules at
  any angle around the belt.

### Plate variants
- User picks plate grid in the editor when adding a plate.
- **Belt-width ↔ plate-grid compatibility table**:
  - 38mm (1.5") belt → 2×3 and 2×4 plates only
  - 51mm (2") belt → 3×3 and 3×4 plates only
  - **51mm and 52mm are the same dimension** (used interchangeably in
    docs/data — spec normalizes to 51mm). Existing `4x2`, `2x2`, `4x3`
    variants in `modules.ts` need to be reconciled with the 2×3/2×4/
    3×3/3×4 set above — spec must list authoritative grid set and migrate
    or deprecate the others.
- Belt-thickness (the plate's `thickness` field: 5.3 / 6.5 / 12 mm) is
  auto-derived from belt choice OR also user-selectable — TBD.
- The editor also supports **bare-module placement** on the belt (no
  plate) for modules like carabiner clips that hang directly from the
  belt. (See loadouts.md examples — these need explicit angle too.)

## Foundational decisions (Round 3)

### Plate thickness
- **User picks per plate; defaults match the belt width.**
- Compatible thickness dropdown shown when adding a plate; pre-selected
  to the canonical pairing for the belt.
- Lets advanced users specify a thicker plate for heavy modules.
- Plate thickness is stored on the PlateConfig.

### Module variant selection
- **Each variant is its own palette item.**
- The palette lists e.g. `carabiner-clip / tiny`, `carabiner-clip / small`
  as distinct draggable entries (filtered/searched per variant).
- Simpler editor logic; longer palette but with grouping/filtering it's
  manageable.
- ModuleConfig stores `{ moduleSlug, variantId? }` per placement.

### Export/import schema
- **Versioned schema with on-import migration.**
- Every export bundle includes `schemaVersion: N`.
- Imports run through a migration chain (e.g. v1→v2→v3) so old exports
  keep working forever.
- Initial version: `schemaVersion: 1`. Spec must include the migration
  framework design (registry of migration functions, fall-through chain).

### Editor outputs (v1 — no ordering)
- The editor save view produces THREE artifacts derived from the config:
  1. **Print list** — Kanix-manufactured STLs to print (plates +
     module bodies; counted per unique file, with quantity).
  2. **Amazon BOM** — third-party products linked from each module's
     `products[]` field, with quantity. Belt itself counts as one item.
  3. **Hardware list** — every fastener consumed by the saved config:
     - Bolts that secure each module to its plate (count = number of
       aligned bolt holes used per module placement, *not* the total
       holes available; only the ≥2 that participate in the snap).
       Bolt size derived from the hole's `bolt_size` metadata
       (extracted from BOSL2 anchors).
     - Bolts that secure each plate to the belt (count = plate's
       belt-mount hole count, e.g. 2 per plate).
     - "Fill them all" — for each plate, the editor also reports
       UNUSED bolt holes (so the user can buy enough bolts to fill
       every hole on the plate, not just the ones in use). Reported
       as a separate sub-tally: `bolts in use` + `bolts to fill rest`.
     - Output rolls up by bolt size: e.g. `M3 × 8mm: 14 used, 6 unused, 20 total`.
- No checkout/ordering integration in v1; this is informational.
- Existing loadout-detail page logic (which renders print/BOM lists)
  becomes the consumer/reference for this output — the same generator
  feeds both built-in presets and user-edited configs.

## Foundational decisions (Round 4)

### SSG → interactive hydration
- **Same page; editor auto-hydrates as soon as JS loads.**
- Loadout detail pages render statically with the existing PCB-trace 3D
  belt map (scrapers + no-JS users see the preset).
- On hydration, the static view is replaced by the interactive editor.
- Editor JS is shipped with every loadout detail page (no opt-in click
  needed). Trade-off accepted: every visitor pays the JS cost.
- Spec MUST address: JS bundle size budget; behavior during the
  hydration race (no flash of unstyled/broken editor); behavior when JS
  fails (graceful fallback to the static view).

### Mobile/touch
- **Drag-drop on both desktop AND mobile, long-press to grab on touch.**
- Touch drag with long-press initiation (~400ms threshold).
- Drag handle/grab feedback must be distinct from page scroll.
- Spec MUST address: scroll-vs-drag disambiguation; drag preview on
  touch; cancel-drag gesture (drag off the canvas?); minimum target
  size (44×44pt per Apple HIG / 48×48dp per Material).

### Accessibility (WCAG 2.1 AA)
- **Full keyboard navigation AND screen-reader announcements.**
- Keyboard: Tab between palette items / placed modules / cells;
  arrow keys to move within the plate grid or around the belt;
  Space/Enter to grab/drop; Escape to cancel.
- Screen reader: ARIA live regions announce placement events
  ("Carabiner clip placed at front-right hip, rotated 90°, 4 bolts
  aligned, valid"), validation errors, and palette filter results.
- Roles: palette is a `listbox` of `option`s; plate is a `grid` of
  `gridcell`s; belt is a custom widget with documented keyboard model.
- Spec MUST include functional requirements with concrete
  announcement text examples (per `reference/traceability.md` — these
  ARE the clarification for visual behavior).

### System preset vs user-edited
- **System presets are editable in place with "Reset to original".**
- Default state for any preset: the bundled version from
  `loadouts.md`/`loadouts.ts` (loaded at build time, no localStorage
  read).
- First edit: write to localStorage under the preset's slug; subsequent
  page loads prefer localStorage over the bundled default.
- "Reset to original" button: removes the localStorage entry, falls
  back to bundled default.
- User-created (non-preset) configs: stored under user-chosen names in
  the same localStorage namespace.
- Spec MUST define: storage namespace + key format, conflict between
  bundled preset rename/removal and saved overrides, localStorage
  quota handling.

## Foundational decisions (Round 5)

### "Pick one of" groups
- **Editor supports user-authored groups.**
- Authoring UI: an "Add group" action creates a container that holds
  multiple module candidates. The group has a label and description.
- Group placement on belt: a group sits in one belt slot with a single
  angle, like any other entry; the viewer/print list shows the group
  with a picker so the user (or buyer) decides which candidate they
  actually want.
- Print list / Amazon BOM behavior: groups roll up under one header
  with each candidate's products listed as alternatives.
- Hardware list behavior: hardware count assumes ONE of the candidates
  is selected — the editor must either pick the worst-case (max bolts)
  or surface a per-candidate breakdown. (Spec must decide; lean
  worst-case.)

### Data layer migration
- **`loadouts.md` is migrated to emit PlateConfig/BeltConfig directly.**
- `loadouts.ts` is regenerated against the new schema (the GENERATED
  comment header is updated accordingly).
- Existing loadout detail pages re-render against the new types (the
  static PCB-trace belt map now reads BeltConfig).
- Net effect: BeltConfig becomes the single internal data model;
  exports/imports use the same shape (just wrapped in
  `ExportBundle { schemaVersion, belts, plates }`).
- Spec MUST include the migration: how `Loadout.modules[].angle/plate/
  variant` maps onto `BeltConfig.slots[] / PlateConfig.modules[]`.

### Bolt-hole extraction policy
- **Hard gate: build fails if any module is missing extractable holes.**
- Every module entry in `modules.ts` must have a matching SCAD file
  with BOSL2 anchors that the extractor can read.
- CI workflow includes a "verify holes" step that fails the build if
  any model's `<model>.holes.json` is empty/missing/malformed.
- Exception: modules with `noModel: true` (e.g. BioThane heel lead) are
  exempt from hole extraction since they don't bolt to anything.
- Migration story: before merging this spec's implementation, every
  current module's SCAD file must be annotated with anchors. This is
  itself a sub-task of the implementation phase.

### Undo/redo
- **Unbounded undo/redo within a session.**
- Keyboard shortcuts: Ctrl-Z / Cmd-Z (undo), Ctrl-Shift-Z / Cmd-Shift-Z
  (redo). On-screen buttons mirror these.
- History is in-memory only; cleared on page navigation/reload.
- Architecture: every mutation goes through a command/action layer
  (Action → apply/revert). State derives from the action log.
- Spec MUST define which operations are undoable (placement, removal,
  rotation, variant swap, group creation, plate add/remove, belt-slot
  add/remove) and which are NOT (preset reset, save, import — destructive
  operations that wipe history).

## Foundational decisions (Round 6)

### Non-Goals (v1) — confirmed
- **No cloud sync / cross-device persistence.** localStorage only.
- **No 3D editor view.** Editor is 2D-only; the 3D-on-2D PCB-trace
  belt map remains read-only/static.
- **No checkout / ordering integration.** Editor produces lists; pushing
  those into a cart on the commerce platform is v2+.
- **No auto-arrange / "fill my belt for me" assistant.** No suggestion
  algorithm; user-driven only.

Sharing via URL is explicitly NOT a Non-Goal — see below.

### Sharing via URL (export-then-share)
- **User configs DO get a stable URL via export-then-share.**
- The export flow produces a URL containing the config base64-encoded
  in the path (or query string — TBD).
- The URL renders client-side from the encoded data (the page is
  statically built; the editor hydrates and decodes the config).
- Privacy note: anyone with the URL sees the config. Must be surfaced
  in the UI when copying ("anyone with this link can see your loadout").
- Spec MUST address: URL size budget (long configs may exceed common
  URL length limits — fall back to "too long, please use file export"),
  the schema-version encoding (must be in the URL so old links can
  migrate), and how a URL-loaded config interacts with the user's
  localStorage (does it auto-save? prompt to save?).

### Navigation & rendering modes
- **Three render modes** (one component family, three entry points):
  1. **Editor mode** (default on `/loadouts/<slug>/` and `/belt-editor/`)
     — interactive; auto-hydrates on JS load; supports all editing
     gestures.
  2. **Gallery mode** at `/belt-editor/` — a top-level landing page
     listing all bundled presets AND user-saved configs (read from
     localStorage on the client). Each card opens its editor.
  3. **Read-only render** — **literally the SSG render with no
     hydration**. Same Astro markup that the editor mode boots from,
     but the editor JS isn't shipped for that page (or the hydration
     directive is omitted on the island). No drag handles, no palette,
     no Save/Export because no JS runs.
- This means there's only ONE renderer for the static belt visual; the
  difference between "editor" and "read-only" is purely whether the
  client island hydrates. Same component, two consumption modes.
- The read-only mode is important: it lets a "belt" appear inside a
  larger page (e.g. a kit product page) showing the included loadout
  without offering edit affordances.

### **TERMINOLOGY CORRECTION (critical)**

The existing project vocabulary needs to be re-aligned with what
customers actually buy:

| Old name (in code today) | New name (in spec) | Meaning |
|---|---|---|
| `Module` (`modules.ts`) | **Attachment** | A single 3D-printed accessory that bolts onto a plate (e.g. carabiner clip, dump-bag mount, e-collar holster). |
| (no current concept) | **Module** | The assembled unit a customer buys: **one plate + one or more attachments mounted on it.** This is the SKU-level thing in the storefront. |
| `Loadout` (`loadouts.ts`) | **Belt** (or "Belt Loadout") | A belt strap + a set of modules placed at angles around it. The thing a complete kit assembles into. |

This re-mapping is the spec's job to make consistent end-to-end. The
existing `modules.ts` file gets renamed/repurposed as
`attachments.ts`; a new `Module` type emerges as
`{ plate: PlateConfig, attachments: AttachmentConfig[] }`; the existing
`Loadout` type becomes `BeltConfig` with slots that reference
**Modules** (not attachments directly).

This also clarifies the user-buying flow: customers buy **modules**
(plate-plus-attachment assemblies), not individual attachments. A kit
in the storefront is a set of modules + a belt.

Implication for the editor: the **attachment palette** is what you
drag from. Dropping an attachment onto an empty plate creates a new
Module. Saving a Module to your library makes it available to drag
onto the belt in the belt view. Modules can also be placed directly on
the belt (i.e. the bare-attachment + belt clip combos like the
carabiner are "modules" too — just with a minimal plate or no plate
where appropriate). [NEEDS CLARIFICATION: are there ever 0-plate
modules, or does everything that hangs off the belt have a plate? The
existing data has carabiner clips with `noModel: true` — those would
become 0-plate modules.]

### Testing infrastructure
- **Unit (Vitest) + e2e (Playwright via mcp-browser) + SCAD-anchor
  round-trip test.**
- The round-trip test:
  1. Take a known SCAD model with BOSL2 anchors.
  2. Run the hole extractor → produces `<model>.holes.json`.
  3. Load that JSON into the editor's snap math.
  4. Place the attachment on a plate at every cardinal rotation.
  5. For each placement, render the resulting OpenSCAD output (plate
     + attachment in their declared positions) and verify the bolt
     holes line up physically (via a small SCAD assertion or by
     comparing computed hole positions).
- This is the critical integration test — catches silent drift between
  extractor and editor.
- Plus Playwright e2e covering: load preset → edit → export → re-import
  → save → reload page → restore state.

## Foundational decisions (Round 7 — final)

### Module composition rules
- **A Module always has ≥1 attachment.** Empty plates are in-progress
  editor state, never a saved Module.
- **A Module always has a mount.** An attachment must sit on either a
  plate or a belt clip — never bare on the belt.

### Belt clip — a separate Mount entity
- The mount type is a discriminated union: `Mount = Plate | BeltClip`.
- **Plate**: grid (2×3, 2×4, 3×3, 3×4) + thickness + a regular hole grid.
- **BeltClip**: a smaller mounting backbone (likely 2 belt-mount holes
  + a small attachment-hole pattern, dimensions per actual SCAD model).
- The Module type becomes `{ mount: Mount, attachments: AttachmentPlacement[] }`.
- The belt editor displays Modules placed at angles; each Module's
  mount determines its visual footprint.

### Attachment ↔ mount compatibility
- **"If it fits, I sits" — inferred entirely from bolt-hole alignment.**
- No explicit `compatibleMounts` list on attachments.
- The 2-bolt-aligned snap rule IS the compatibility check.
- Pro: minimal authoring overhead; SCAD anchors are the single source
  of truth for what fits where.
- Con: if SCAD anchors drift, weird configs may become silently valid
  or invalid. The SCAD-anchor round-trip test mitigates this.

### Bolt-hole snap tolerance
- **±0.5mm.** Allows for floating-point and extractor noise while still
  catching real misalignments. Same tolerance for plate↔attachment
  alignment AND plate↔belt-clip-derived attachment patterns.

### Share URL encoding
- **`?config=` query string, value = `base64url(gzip(JSON))`.**
- Soft limit: 8KB encoded. Over that → UI says "this config is too
  large for a link, please use file export."
- Schema version is part of the encoded JSON (not a separate URL
  param) — same migration path as file imports.
- UI warning when copying a share link: "anyone with this link can see
  your loadout."
- Loaded-from-URL configs: prompt the user to save to localStorage (so
  they can edit and re-share); do NOT auto-save.

---

## Summary of all rounds — ready to draft spec

All interview topics resolved except those flagged `[NEEDS CLARIFICATION]`
inline in the spec (to be cleaned up in Phase 3/4).

Spec structure follows the existing `specs/admin/spec.md` house style:
Overview → User Scenarios (with Independent Test field) → Functional
Requirements (FR-xxx) → Success Criteria (SC-xxx) → Edge Cases → Testing
→ Non-Goals → Enterprise Infrastructure decisions.

## Phase 3 (Clarify) — resolutions

All six initial `CLARIFY-xx` items resolved with follow-up questions; an
additional grounding pass against `scad/CLAUDE.md` corrected several
data-model assumptions in the first spec draft:

- **CLARIFY-01 → editor grid set is `3x2, 4x2` (38mm) + `3x3, 4x3`
  (52mm).** 2-wide plates deprecated as too weak. SCAD files for `2x2`
  and `2x3` remain on disk but are not registered.
- **CLARIFY-02 → STL-based 3D mesh-vs-mesh collision detection** via
  Three.js + three-mesh-bvh in a Web Worker, lazy-loaded. Adds FR-280
  series; SC-013 bundle budget split (core ≤80KB; collision lib chunk
  ≤250KB).
- **CLARIFY-03 → canonical belt widths are 38 and 52.** "51" is a
  conversational alias only. No SCAD file renames needed.
- **CLARIFY-04 → BeltClips exist** (scad/belt_clip_*.scad). Several
  are mis-named per the Op 2 migration tracked in scad/CLAUDE.md.
  Editor uses the corrected/renamed set; PREREQ-2 captures the work.
- **CLARIFY-05 → no plate-less attachments.** Carabiner-clip-style
  items become Attachments on a BeltClip Mount under the new model.
- **CLARIFY-06 → thickness defaults**: 38mm belt → 5.3mm plate only.
  52mm belt → 6.5mm (default) or 12mm.

## Prerequisite work surfaced during clarification

Reading `scad/CLAUDE.md` revealed two scoped-but-incomplete migration
operations that BLOCK the belt-editor implementation. These are now
captured in the spec as PREREQ-1 through PREREQ-4:

- **PREREQ-1 (Op 1)**: Rectangularize `kanix_plate` (currently
  square-only; stubs out 6 of 9 plate fixtures).
- **PREREQ-2 (Op 2)**: Migrate accessories off legacy `kanix_preset_*`
  naming to `kanix_grid_*`.
- **PREREQ-3**: Add named BOSL2 anchors at every bolt hole in
  mounting-plate / kanix-plate / accessory modules so the hole
  extractor (FR-201) has names to read.
- **PREREQ-4**: Add `4x2` / `4x3` BeltClip SCAD fixtures if missing.

These are infrastructure work that the implementation phase MUST cover
(or that must complete in a separate PR before this feature ships).

- Data model schema — PlateConfig, ModuleConfig, BeltConfig, ExportBundle
- SSG vs hydration boundary — what renders server-side, what JS hydrates
- Module palette — what modules show up, filtering, search, categories
- Plate variants — 2x3, 3x3 (per `PlateVariant`), do plates have their own
  configurable orientation? Material/thickness selection in the editor?
- Module orientation — discrete rotations (0/90/180/270) or continuous?
  Per-bolt-hole snap vs free placement?
- Conflict detection — what counts as an invalid plate config (overlap,
  no bolt-hole alignment, etc.)?
- Belt angle granularity — continuous degrees or snap-to-PALS-slot?
- Export/import schema — per-section checkboxes (plates only, belts only,
  both), versioning, schema migration on import
- Preset management — read-only system presets vs user-editable copies
- Print/order integration — does the editor produce a print list / kit?
- Mobile UX — touch drag, long-press, pinch-zoom
- Accessibility — keyboard navigation, screen reader announcements
- "Pick one of" groups (existing loadout concept) — how do these work in
  the editor?
- Variant modules (carabiner-clip sizes, e-collar holster variants) — how
  does the user pick a variant when dragging?
