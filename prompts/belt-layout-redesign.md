# Belt Layout Panel — Redesign Prompt

## Context

You are working in `/home/max/git/kanix`, an Astro site that sells 3D-printable
dog handler gear. There is a component at
`site/src/components/BeltLayoutPanel.astro` that renders a top-down
schematic of a duty belt for each loadout (kit). The current
implementation is broken: it relies on pixel-counted constants
(`SLOT_Y_MIN`, `aspect-ratio: 5/4`, `RIGHT_X=198`, etc.) that the human
keeps having to nudge by hand because bubbles overlap, get clipped,
overflow into adjacent panels, and behave differently at different
viewport widths. **The root cause is that the layout is hand-coordinated
between an SVG viewBox and CSS pixel boxes.** That is a code smell. Stop
nudging the constants. Throw the whole thing out and rebuild it.

The goal of this prompt is to (a) give you the constraints in one place,
(b) hand you a self-iteration loop so you can test and refine without
asking the human between each tweak, and (c) end at a layout that holds
together at every viewport width from 320 px to 1600 px without manual
calibration.

## Where to find things

- Component being redesigned:
  `/home/max/git/kanix/site/src/components/BeltLayoutPanel.astro`
- Data model the component consumes:
  `/home/max/git/kanix/site/src/data/loadouts.ts` (loadouts and
  `resolveLoadout()`) and
  `/home/max/git/kanix/site/src/data/modules.ts` (module records,
  including the `genericVariants` chips that the panel deep-links to
  with URL hashes like `#small`).
- Pages that mount the panel:
  - `site/src/pages/loadouts/[slug].astro` — full panel under each
    loadout's description (`<BeltLayoutPanel loadout={loadout} />`).
  - `site/src/pages/index.astro` — compact preview of "The Pro" under
    the loadout list (`<BeltLayoutPanel loadout={previewLoadout}
    compact />`).
- Other existing 3D viewer for reference:
  `site/src/components/STLViewer.astro` (interactive STL viewer used
  on module detail pages; the belt panel reuses the same Three.js +
  STLLoader idea but auto-rotates and uses tiny per-module previews).
- Dev shell / build commands:
  - Always enter `nix develop` first (or use the project script
    `scripts/ci-local.sh`).
  - From `site/`: `npm run build` to verify everything still compiles
    and links. The site CI step in `scripts/ci-local.sh --only site`
    is the source of truth.
- The data on each `LoadoutModule` you care about:
  - `slug` (or `choices` + `groupLabel` for a "pick one of" group),
  - `plate` (STL filename — the plate this module bolts to; multiple
    modules with the same `plate` AND the same `angle` constitute one
    physical plate group, and the panel must visually wrap them in a
    single bubble),
  - `variant` (string or string[] — when an array, that's multiple
    instances of the same module on the shared plate),
  - `angle` (degrees: 0 = front/buckle, +90 = right hip, -90 = left
    hip, ±180 = back). The angle is the position around the belt.
    Entries without an `angle` are excluded from the diagram (they
    appear in an "unplaced" footer list).

The four loadouts you need to support cleanly today are
`walker`, `hiker`, `trainer`, `pro`. Pro is the hardest:

- Right side (positive sin angles): 5 modules across 4 plates —
  clicker + small carabiner share one plate at 22.5°, then treat-bag at
  45°, e-collar group at 67.5°, waste-bag at 90°.
- Left side (negative sin angles): 4 modules across 3 plates —
  flashlight + small carabiner share one plate at -135°, biothane heel
  at -146.25°, dump-bag at -157.5°.
- Total: 9 modules. The biothane heel lead has `noModel: true` so its
  preview cell renders an "N/A" placeholder rather than a Three.js
  STL viewer.

## Hard constraints (must hold without manual nudging)

1. **Mobile first.** The default layout targets viewports from
   320 px wide upward. Bigger viewports get a wider layout via
   responsive tweaks, not a different mental model.
2. **No hand-tuned pixel constants for layout.** If you find yourself
   writing `aspect-ratio: 5/4` or `SLOT_Y_MIN = 13`, stop. The slot
   positions must be derived from content (number of modules per side,
   row height) rather than baked numbers. The only "magic numbers"
   that survive are visual ones (bubble border radius, the belt
   ellipse's radii, etc.).
3. **One viewBox / pixel system, not two.** The current bug is that
   labels live in CSS pixels while dots and connector lines live in
   the SVG viewBox, with a brittle conversion in the runtime script.
   Pick one. The most natural choice is: lay out everything in CSS,
   in the document flow; let the belt drawing be a *sized* SVG that
   sits between the two label columns and uses the same pixel grid.
   Then connector lines become SVG overlays positioned in stage
   pixels at runtime — but the conversion is trivial because there's
   no viewBox aspect mismatch to manage.
4. **Bubbles never overlap.** Vertical spacing between bubbles is
   driven by their actual measured heights plus a fixed gap (e.g.
   `gap-3`). The page grows as tall as it needs to.
5. **Bubbles never clip.** No content gets cut off at the panel edge.
   The panel's overflow stays visible (or the panel is sized to fit).
6. **Connector lines stay attached to their dot and their bubble.**
   When the page reflows (resize, font-load, image-load, STL-load),
   lines update. Use a `ResizeObserver` on the stage and the bubbles,
   not a fragile one-shot recalc.
7. **Plate grouping is visible.** When two modules share a plate
   (same `plate` AND same `angle`), they appear inside one rounded
   bubble. Each module still gets its own row (preview + name).
   There's exactly one connector line per *plate* (not per row),
   running from the bubble's inner edge to the single dot on the belt
   that represents that plate.
8. **Dot stays on the belt at the authored angle.** Slot reordering
   never moves a dot. The dot's position is the truth — slots only
   move the *label*.
9. **Specific Pro arrangement (when there's space — desktop layout):**
   - Right column, top → bottom, in order:
     1. Clicker + small carabiner (plate at 22.5°)
     2. Treat-bag (45°)
     3. E-Collar group (67.5°)
     4. Waste-bag (90°)
   - Left column, top → bottom, in order:
     1. Flashlight + small carabiner (plate at -135°)
     2. Biothane heel lead (-146.25°)
     3. Dump-bag (-157.5°)
   That order corresponds to "front of the wearer is at the top of
   the diagram"; back-of-belt modules sit lower in their column.
10. **Mobile dual-belt mode.** Below the mobile breakpoint (`md`?
    pick a sensible Tailwind breakpoint and stick with it), the
    single belt with two label columns becomes **two stacked
    diagrams**:
    - Top diagram: belt + right-side labels only (mounted on the
      right of the belt, with connectors to the right-side dots).
    - Bottom diagram: belt + left-side labels only.
    The left side of the top diagram and the right side of the
    bottom diagram are blank. This avoids cramming both columns into
    a 320 px width.
11. **Variant deep-links survive.** Module name links in each row
    still go to `/modules/<slug>/#<variant-id>` for variants that
    exist in `genericVariants`. (The module page reads the hash and
    pre-selects the chip — that part already works; don't break it.)
12. **STL previews auto-rotate.** Each row has a small Three.js
    preview that spins on its Z-axis with no controls. When
    off-screen, pause via `IntersectionObserver` so a page with many
    previews stays cheap. Coming-soon modules / `noModel: true`
    modules show an "N/A" placeholder.
13. **Header section was already removed.** Do not re-add a "Belt
    layout — top-down" caption above the panel. The loadout page
    context is enough.

## Suggested architecture (sketch — feel free to deviate if you find better)

Mental model: think of the panel as a CSS grid:

```
┌──────────────────────────────────────────────────────────┐
│   left column          belt-svg          right column    │
│   (flex-col,           (rigid           (flex-col,        │
│    bubbles flow,        rectangle,       bubbles flow,    │
│    gap-3,               width=clamp(),   gap-3,           │
│    justify-content      drawn at full    justify-content  │
│    by per-side                            by per-side     │
│    angle order)                            angle order)   │
└──────────────────────────────────────────────────────────┘
```

- Tailwind grid: `grid grid-cols-[1fr_auto_1fr]` on desktop; on mobile
  switch to two stacked single-column layouts (right column with belt
  above, then left column with belt below).
- Each column is a `flex-col gap-3` of bubble cards. Cards lay out by
  the normal document flow — no absolute positioning of the cards.
- Card order within a column = sort by belt angle (front-first for
  the top of the column). For Pro, that gives exactly the order in
  constraint 9.
- Cards align horizontally to the inner edge of their column (right
  column cards are `items-start` of the flex container next to the
  belt; left column cards mirror).
- The belt SVG is in the middle grid track. It has a defined
  *visible* size (a `width` and `aspect-ratio: 1/1` — the belt
  *itself* is round). It does **not** stretch to match the column
  heights; instead the SVG sits inside an `align-self: stretch`
  wrapper, and the actual `<svg>` element is centered inside that
  wrapper (or pinned, depending on aesthetics).
- Dots on the belt are positioned via the SVG's own viewBox, which
  is intrinsic to the belt drawing (e.g. `viewBox="0 0 100 100"` with
  belt ellipse `cx=50 cy=50`). No coordination with the columns
  needed because the belt is just a self-contained image.
- Connector lines are SVG overlays placed in an absolutely-positioned
  `<svg>` covering the whole stage. The runtime script reads each
  bubble's `getBoundingClientRect()` and the belt SVG's
  `getBoundingClientRect()`, computes the bubble's inner-edge anchor
  and the dot's pixel position on the belt, and draws the line in
  stage-pixel coordinates. Because there's no viewBox aspect
  mismatch in the overlay (its viewBox matches the stage's pixel
  box), the math is trivial.
- On mobile, render two `<section>`s, each with the structure
  `[left|belt]` (right-side modules only) or `[belt|right]` (left-side
  modules only) but inverted so the modules sit on the side opposite
  the empty space. Or, just render the same grid twice with
  side-filtered cluster lists — your choice, as long as it works.

The point of the grid + flex approach: **the browser does the
layout**. No JavaScript ever computes a bubble's y position. The
script's only job is drawing connector lines, which is purely a
function of measured DOM rects.

## Self-iteration loop

You have permission to iterate on the implementation autonomously
until the constraints are satisfied. Do this:

1. **Make a change.** Edit `BeltLayoutPanel.astro` (and only that
   file, plus tiny edits to the two consumers if you need new props
   like a `direction` to support the mobile dual-belt mode). Do not
   touch `loadouts.ts` data — the angles authored there are correct.
2. **Build.** From `site/`:
   `nix develop /home/max/git/kanix --command npm run build`. Build
   must complete cleanly. If there's a TypeScript error or template
   error, the build will tell you; fix it before moving on.
3. **Render the output.** Use the
   [Playwright MCP](https://playwright.dev/) (or `puppeteer` via
   `npx`, or the headless Chrome you already have access to) to
   screenshot four URLs at four widths:
   - `/loadouts/pro/`
   - `/loadouts/walker/`
   - `/loadouts/hiker/`
   - `/loadouts/trainer/`
   And one bonus: the homepage `/` (where the compact Pro preview
   sits, must also work). Widths: 360 px, 768 px, 1024 px, 1440 px.
   Save screenshots under `/tmp/belt-layout-iter-<n>/` so you can
   diff them. If you don't have a browser tool available, you can
   start the Astro dev server with `npm run dev` and capture with
   `playwright codegen` style scripting; if even that's not
   available, fall back to manually inspecting the built HTML for
   structural correctness (no overlap is harder to verify without
   layout, but compute-from-CSS-rules is doable).
4. **Check.** For each screenshot:
   - No bubble overlaps another.
   - No bubble's content is clipped by the panel border.
   - Every dot has exactly one line to exactly one bubble (or zero
     lines if you decided to drop lines for visual clarity — but
     dots without lines are confusing, so prefer lines).
   - On the 360 px screenshot, the mobile dual-belt layout is in
     effect.
   - On the 1024+ screenshots, the desktop single-belt layout is in
     effect.
   - The Pro right-column order matches constraint 9.
   - The Pro left-column order matches constraint 9.
   - No constants like `aspect-ratio: 5/4` or `LEFT_X = 2` remain in
     the source. (The `flake.nix`, `tsconfig`, and similar are out
     of scope.)
5. **Iterate.** If any check fails, fix the root cause (not the
   symptom) and loop. Don't ask the human between iterations. Aim
   for 3–6 iterations to converge.
6. **Stop conditions.** Stop when:
   - All five URLs pass all checks at all four widths, OR
   - You hit an obstacle you genuinely cannot resolve without more
     information (e.g. a tool you don't have). Then summarize the
     blocker for the human and stop. Do not keep guessing.

## What to send back when you're done

A short message (under 200 words) summarizing:

- Which constraints from this prompt are satisfied (and how
  you verified).
- Any constraint you couldn't fully satisfy and why.
- Where the constants live now (if any survived). Why they survived.
- One or two screenshots (paths to files) so the human can spot-check.

## Tone

Don't be defensive. The previous attempt was bad — say so if you find
specific reasons it was bad, and explain what you changed
structurally. The human is happy to hear "I threw out X because Y";
they are unhappy to hear "I tweaked X by 5px hoping it would fix Y."

## File you are editing

`/home/max/git/kanix/site/src/components/BeltLayoutPanel.astro`

Good luck.
