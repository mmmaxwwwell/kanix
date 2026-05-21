# Research: Belt Editor

This document captures every architectural decision for the belt-editor
feature, with rationale, rejected alternatives, and links to the spec
sections that constrain it. Downstream agents consult this file before
proposing alternatives to anything decided here.

---

## R1. UI framework: Preact + signals

**Decision**: Use Preact 10 (via `@astrojs/preact`) with
`@preact/signals` for the editor islands.

**Rationale**:
- The site is currently framework-less Astro + vanilla TypeScript +
  Three.js. No framework lock-in yet.
- Editor is a heavily stateful UI (palette, plate grid, belt canvas,
  per-cell validation). Hand-rolled DOM management would 3-5x the
  code volume vs a virtual-DOM framework.
- Preact at ~3KB gzipped is the smallest "real" framework. Inside the
  80KB editor budget (SC-013), every KB matters.
- Signals give cell-level reactivity (placement changed → just that
  cell re-renders) without React's full-tree re-render cost.
- First-class Astro integration: `client:load` and `client:idle`
  directives just work.

**Alternatives rejected**:
- **Vanilla TypeScript** — estimated 3-5x more code; harder to write a11y;
  drag-drop state synchronization becomes error-prone.
- **React** — ~40KB baseline; would blow SC-013's 80KB budget alone before
  any editor code.
- **Solid** — similar tradeoffs to Preact+signals but weaker Astro
  integration and smaller community.
- **Svelte** — runtime is small but Astro Svelte adds Vite plugins we'd
  otherwise avoid; also, Astro currently treats Svelte as an experimental
  integration, less stable than Preact's.
- **htmx + server-side** — feature is fundamentally client-side
  (localStorage, drag-drop, undo/redo). Server roundtrips would make
  drag UX laggy.

**Constraints this satisfies**: FR-651 (in-place hydration), SC-013
(bundle), SC-009 (a11y — Preact + dnd-kit have strong a11y stories).

---

## R2. State management: signals + EditorStore class

**Decision**: Top-level state lives in a singleton class
(`EditorStore`) that exposes Preact signals. UI components subscribe
via `useSignal()` or `computed()`. All mutations go through the action
algebra (R5).

**Rationale**:
- Signals avoid prop-drilling for a deeply nested editor.
- Singleton fits the per-page editor model (one editor per route).
- A class lets us keep "lifecycle" methods (hydrate from localStorage,
  hydrate from URL, attach worker) in one cohesive place.
- The action algebra gives us undo/redo for free (R5).

**Alternatives rejected**:
- **Zustand** — React-shaped API; would need an extra adapter for
  Preact; signals are simpler.
- **Redux Toolkit** — overkill; we're not multiplexing actions across
  features.
- **TanStack Store** — extra dependency for no win over native signals.
- **Pure signals (no class)** — easy to start, but hydration / worker /
  persistence wiring all need a place to live. A class is the right
  shape.

**Constraints this satisfies**: FR-503 (preset override resolution),
FR-800 series (undo/redo).

---

## R3. Drag-drop library: dnd-kit

**Decision**: Use `@dnd-kit/core` (~12KB gzipped) for desktop AND
touch drag.

**Rationale**:
- First-class touch support with configurable sensors. Long-press
  initiation (FR-303, ~400ms threshold) is a built-in sensor option.
- Keyboard accessibility (FR-304) is built-in via `KeyboardSensor`.
- Doesn't require a global wrapper; works inside Preact islands.
- Active maintenance, TypeScript-native, good docs.
- Has React peer-dep but works with Preact via the `preact/compat`
  alias (already standard Astro pattern).

**Alternatives rejected**:
- **HTML5 native DnD** — broken on touch; mobile UX is unacceptable;
  fights with scroll.
- **react-dnd** — requires manual HTML5/Touch backend switching;
  weaker a11y story.
- **dragula** — no TypeScript types; no touch sensor tuning; older.
- **Custom pointer-event handler** — would re-implement dnd-kit poorly;
  miss screen-reader announcements; sink weeks of UX tuning.

**Constraints this satisfies**: FR-302, FR-303, FR-304, FR-305, FR-751,
FR-752, FR-753.

---

## R4. Schema validation: valibot

**Decision**: Use `valibot` (~1KB gzipped, tree-shakable) for
ExportBundle and per-entry validation on import + share-URL decode.

**Rationale**:
- ~8x smaller than Zod for the equivalent schema (~1KB vs ~8KB
  minified+gzipped).
- Tree-shakable: only the schema functions you use ship.
- API is comparable to Zod's, so authoring isn't slower.
- Bundle budget is tight (SC-013); every KB counts.

**Alternatives rejected**:
- **Zod** — ergonomically lovely but too large for our budget.
- **Hand-rolled** — error-prone; reading the export bundle is the
  single highest-stakes parsing job in the feature (untrusted input
  from share URLs).
- **AJV** — runtime JSON Schema; heavy; uses `eval`-like code-gen.

**Constraints this satisfies**: FR-554 (schema versioning), FR-604
(corrupted URL detection), FR-555 (newer-version refusal), security
notes in Enterprise Infrastructure section.

---

## R5. Undo/redo action algebra

**Decision**: Every undoable mutation is an instance of a discriminated
union `Action`, with two methods: `apply(state) -> state` and
`invert(state) -> Action`. The action log is the source of truth;
state is derived.

**Rationale**:
- Inverse-functions guarantee perfect undo even for complex mutations.
- The same `Action` type serializes to JSON (for the share URL — actions
  could be replayed at the receiving end, but in v1 we just send the
  serialized state).
- Testing is straightforward: `apply` and `invert` are pure functions.

**Alternatives rejected**:
- **Snapshot-based undo (full state copy per action)** — simpler but
  uses unbounded memory for large configs. With 50+ actions, snapshots
  dominate localStorage budget.
- **Diff-based undo** — middle ground; libraries like immer.js produce
  patches. Adds a dependency and runtime cost without much win.

**Constraints this satisfies**: FR-800, FR-801, FR-802, FR-803, SC-010.

---

## R6. SCAD bolt-hole extractor

**Decision**: `scripts/extract-holes.sh` shells out to
`openscad --export-format=csg <model>.scad`, then a small node script
(`scripts/parse-csg.mjs`) parses the CSG output to find BOSL2
`named_anchor()` calls and emit `<model>.holes.json`.

**Rationale**:
- OpenSCAD's CSG export is the only programmatic way to read BOSL2
  anchors. Anchors don't survive STL export (they're geometric
  annotations, not mesh features).
- The CSG format is text-based and reasonable to parse with a small
  Node script — no need for Python or a heavy library.
- Integrates cleanly with the existing `npm run render` pipeline,
  which already shells out to OpenSCAD per fixture.

**Alternatives rejected**:
- **Hand-author hole coordinates in TypeScript** — explicitly rejected
  by user in interview Round 2. Drift the moment a SCAD file changes.
- **Python parser** — adds Python to the build environment (not
  currently in `site/flake.nix`).
- **Direct STL parsing** — STL doesn't preserve anchor metadata.
- **CSG → AST library** — overkill; the parse is simple line-oriented.

**Constraints this satisfies**: FR-200, FR-201, FR-202, FR-203, FR-204,
SC-002, IC-001.

---

## R7. Collision worker: Three.js (reused) + three-mesh-bvh

**Decision**: A Web Worker imports the existing Three.js dependency +
`three-mesh-bvh` (~30KB gz) to perform mesh-vs-mesh BVH intersection
checks. The worker accepts pairs of MeshSpecs (STL URL + transform)
and returns collision results.

**Rationale**:
- Three.js is already a `site/` dependency (currently used by
  `STLViewer` and `BeltLayoutPanel` for STL rendering). Reuse instead
  of adding a separate geometry library.
- `three-mesh-bvh` is the canonical extension for accelerated
  intersection queries on Three.js meshes.
- Web Worker is necessary to keep the main thread responsive during
  bulk validation (FR-285).
- Vite/Astro auto-chunk the worker when imported via `new Worker(new
  URL('./worker.ts', import.meta.url))` — no manual config.
- Three.js is loaded into the worker as a separate bundle, not
  reloading the main-thread copy.

**Alternatives rejected**:
- **CANNON.js / Rapier** — full physics engines; massive overkill for
  static intersection.
- **2D silhouette overlap from STL extents** — initial spec considered;
  user explicitly chose full 3D in Phase 3 clarify round.
- **Main-thread collision** — would jank the UI; fails FR-285.
- **Server-side collision (Cloudflare Worker)** — round-trip latency;
  introduces network dependency for a client-side feature.

**Constraints this satisfies**: FR-280, FR-281, FR-282, FR-283, FR-284,
FR-285, SC-014.

---

## R8. Bundle structure & code-splitting

**Decision**: Three logical bundles per loadout page:
1. **SSG HTML/CSS** — no JS required (FR-650, FR-653).
2. **Core editor chunk** — Preact + signals + dnd-kit + valibot +
   editor lib + Attachment metadata. ≤80KB gz (SC-013).
3. **Collision worker chunk** — Worker entry + Three.js + three-mesh-bvh
   + STL loader. ≤250KB gz (SC-013).

The existing `BeltLayoutPanel.astro` (which currently imports Three.js
eagerly for the static belt visual) is refactored to split:
- A pure-CSS / SVG static belt visual (no JS) used for SSG.
- A separate `BeltVisualizerIsland.tsx` that hydrates only if/when 3D
  module thumbnails are needed in the editor.

This means loadout pages can render statically without Three.js at all;
Three.js loads only when (a) the editor's collision worker is invoked,
or (b) the user opens the 3D-thumbnail preview (a v2 toggle, not v1).

**Rationale**:
- Today's loadout pages pay the Three.js cost on every load (BeltLayout-
  Panel imports it). Splitting it out improves baseline perf for
  read-only visitors.
- The 80KB / 250KB split aligns with realistic gzipped sizes for the
  chosen libraries.

**Alternatives rejected**:
- **Single bundle** — would push past 200KB+ for the editor alone;
  hydration on slow connections breaks SC-012.
- **All-Three.js eager** — current pattern; perpetuates the Three.js
  cost for visitors who only browse.

**Constraints this satisfies**: SC-013, SC-012, FR-651, FR-652.

---

## R9. Persistence layer

**Decision**: `persistence.ts` is a typed `KV<T>` wrapper around
`localStorage` with corruption-safe read, quota-safe write, and a
"safe mode" that disables writes during SSR.

**Rationale**:
- localStorage is the spec (FR-500, FR-501); no library needed.
- All quota and corruption paths must be tested (per spec edge cases)
  — wrapping it makes those paths testable.

**Alternatives rejected**:
- **IndexedDB** — overkill for ≤500KB user data; async API complicates
  every read.
- **Cookies** — 4KB limit per cookie; trivial to exceed.
- **localforage** — abstracts over IDB/localStorage but adds a runtime
  for no benefit at our scale.

**Constraints this satisfies**: FR-500, FR-501, FR-505.

---

## R10. URL share encoding

**Decision**: `gzip(JSON.stringify(bundle))` via the native
`CompressionStream('gzip')` API, then `base64url` encoded. Hard size
limit 8KB encoded.

**Rationale**:
- `CompressionStream` is ES2022, supported in all target browsers.
- Avoids `pako` (~40KB) — that would blow the core editor budget.
- 8KB is below most CDN/proxy URL limits and well within browser limits.

**Alternatives rejected**:
- **pako** — ~40KB; budget killer.
- **lz-string** — base64-safe but produces longer outputs than gzip on
  JSON; ~10KB itself.
- **No compression** — JSON-only URLs blow the 8KB budget for any
  non-trivial config.
- **Fragment URL (#)** — same encoded-size constraints; doesn't gain us
  anything over query string.

**Constraints this satisfies**: FR-600, FR-601, FR-602, FR-604.

---

## R11. Hydration directive

**Decision**: `client:idle` for editor islands on loadout pages.
`client:load` when `?config=` is present in the URL.

**Rationale**:
- `client:idle` defers the editor JS until the browser is idle,
  improving Time to Interactive for visitors who just want to read.
- `client:load` for `?config=` ensures the shared config renders
  immediately (the visitor came specifically for the shared content).
- `client:visible` was considered but would defer hydration if the
  loadout pages are tall — the editor is above the fold, so idle is
  better.

**Alternatives rejected**:
- **`client:load` always** — penalizes read-only visitors.
- **No hydration directive, manual `onload`** — Astro idiom is the
  directive; deviating loses Astro tooling support.

**Constraints this satisfies**: FR-651, SC-012.

---

## R12. Testing infrastructure

**Decision**: Vitest as primary unit/integration runner; existing
Playwright stays for e2e. Vitest is added with `vitest`, `@vitest/ui`
(optional dev), and `jsdom` for DOM-touching tests. axe-core via
`@axe-core/playwright` for a11y scans. `size-limit` via the
`size-limit` CLI + `@size-limit/preset-small-lib` (no react-specific
preset; we use the manual entry-point config).

**Rationale**:
- Vitest is faster than Jest, ESM-native, integrates with Vite (which
  Astro uses), and shares config with the build.
- axe-core is the gold standard for automated a11y scans.
- size-limit is simple, framework-agnostic, and has good CI output.

**Alternatives rejected**:
- **Jest** — slower, ESM is still painful, mismatched with Vite.
- **uvu / node:test** — minimal but no good DOM story.
- **Pa11y** — replaced by axe; axe has better Playwright integration.
- **bundlewatch** — older, less mature than size-limit.

**Constraints this satisfies**: SC-003, SC-004 through SC-014.

---

## R13. User preferences and pushbacks (auto-unblocking context)

From interview rounds + clarify, the following user-stated constraints
override default agent behavior. Implementing agents check these
before proposing alternatives.

| Preference | Source | Implication |
|---|---|---|
| Editor is 2D only (no 3D editor view) | Round 1 + Non-Goals | Do not propose Three.js-based editor canvases. 3D only in (a) static rendering and (b) collision worker. |
| No cloud sync v1 | Round 1 | Do not propose Firestore, Supabase, custom backends. |
| Share URLs are pure client-side (encoded payload) | Round 6 | Do not propose short-URL services or server-side config storage. |
| Editor produces lists, not orders | Non-Goals | Do not wire editor to commerce API. |
| 4-step rotation only | Round 2 | Do not propose free rotation or per-attachment overrides. |
| ≥2-bolt-alignment snap rule | Round 2 | Do not weaken to 1-bolt or strengthen to all-holes. |
| Continuous belt angles | Round 2 | Do not snap belt placement to PALS slots. |
| 2-wide plates deprecated | Round 7 | Do not register `2x2`, `2x3` plates. |
| Belt widths are 38 + 52 (not 51) | Round 8 / Clarify | Use 52 in code; "51" is alias-only in conversation. |
| BeltClip is a distinct Mount type | Round 6 / Clarify | Do not unify BeltClip and Plate under one type. |
| Belt-hung (plate-less) attachments NOT allowed | Round 7 / Clarify | Carabiner clips become Attachments on BeltClip mounts. |
| 3D mesh collision (not 2D silhouette) | Clarify | Do not propose silhouette-based overlap check. |
| Lazy-load Three.js for collision | Clarify | Do not eagerly include collision lib in core editor bundle. |
| Explicit TS plate registry | Clarify | Do not auto-generate plates.ts from filenames. |

These constraints are MANDATORY for implementing agents. Violations
will fail review.

---

## R14. Open questions for future iterations (out of v1 scope)

Not blockers for v1, but worth recording for v2 planning:

- **Mobile-first vs desktop-first layout** — the spec mandates mobile
  drag-drop. v1 builds responsive but doesn't optimize layout density
  for tablet/phone. v2 may want a dedicated mobile UI.
- **Real-time collaboration** — multi-user editing is a Non-Goal;
  if needed in v2, requires CRDT or OT (not just localStorage sync).
- **Custom attachment authoring** — v1 attachments come from
  `attachments.ts`. A v2 could let users upload custom STLs +
  hole-coordinate sidecars to use their own attachments.
- **Belt-overlap-with-belt** (Module wraps around buckle) — not
  modeled in v1; angles are continuous but the renderer doesn't
  prevent angle wrap-around overlap.
- **Variant pricing per loadout** — v1 hardware list uses default
  bolt lengths. v2 could let users pick longer bolts and recompute.
