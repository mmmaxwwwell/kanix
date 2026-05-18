# Kanix Loadouts — Source

This file is the **authoring source** for the loadouts shown at
`/loadouts/<slug>/` on the Kanix site. The actual data file the site reads
from is [site/src/data/loadouts.ts](site/src/data/loadouts.ts).

**Workflow:** edit this markdown, then ask Claude to regenerate
`loadouts.ts` from it. The markdown is *only* read by humans and AI — there
is no build-time parser. The TypeScript file is what the site renders.

---

## Instructions for Claude (regeneration protocol)

When the user asks to "regenerate the loadouts" (or similar), do this:

1. **Read this file end-to-end first** — every section below is part of one
   coherent dataset.
2. **Validate module slugs against [site/src/data/modules.ts](site/src/data/modules.ts).**
   Every slug listed under a loadout's "Modules" must exist in the `modules`
   export. If one is missing, stop and ask — don't invent or fuzzy-match.
3. **Generate `loadouts.ts`** by translating each `## Loadout: …` section
   into a `Loadout` object. Preserve order — the order in this file is the
   order of the cards on the homepage.
4. **Map fields exactly:**
   - `### Slug` → `slug`
   - `### Name` → `name`
   - `### Tagline` → `tagline`
   - `### Description` → `description` (single paragraph; collapse any
     line breaks into spaces)
   - `### Belt` → `belt` (must be `'1.5"'` or `'2"'`)
   - `### Belt note` → `beltNote`
   - `### Belt product` → `beltProduct` (optional). Two lines:
     - Line 1: the product name.
     - Line 2: the Amazon URL.
     Omit this whole field for loadouts that don't use a duty belt (e.g.
     Freeform, which mounts via belt clips on a regular pants belt).
   - `### Modules` → `modules` array. Each line has this form:
     `- slug [mount-stl-filename] {variant=id} — note`
     Each line becomes `{ slug, plate, variant, note }`. The `[…]` block is
     the mount STL filename (a plate or belt clip — see *Mount references*
     below). The `{variant=id}` block is optional and references a
     `VariantOption.id` under the module's `genericVariants` (e.g. the
     carabiner-clip's `small` / `large` / `strong`).
     - For **multiple module instances on one plate** (e.g. two carabiner
       clips on a 2×3 plate), use a comma-separated list:
       `{variant=tiny,small}` → emits `variant: ["tiny", "small"]`. The
       module-list row shows each variant as its own chip; the plate is
       still printed once; each variant's STL is added to the print list.
     The em-dash `—` separates the metadata from the note; if there is
     no note, omit the em-dash.
   - **The `[…]` bracket is optional** for modules that don't bolt to a
     mount — today that's only the BioThane heel lead (`noModel: true`),
     which loops around the belt directly. Write the line as just
     `- slug — note` (no brackets).
   - **"Pick one of" groups** — when the user picks among several modules
     (e.g. an e-collar holster that depends on the receiver they own),
     write a multi-line block like this:
     ```
     - group "E-Collar Holster" [plates/kanix_plate_3x3_52x6.5.stl] — note
         description: One-paragraph description shown on the group card.
         choices: mini-educator-holder, dogtra-200ncpt-202c-arc-holder, dogtra-280x-arcx-holder
     ```
     The first line has a leading `group "<label>"` (in quotes) instead
     of a slug. The two indented sub-lines are required: `description:`
     and `choices: comma,separated,slugs`. The mount in brackets is still
     printed once; the modules inside the group are not added to the
     print list (the user picks one). All candidate modules' products
     surface in the bottom "Products for this loadout" section as a
     "Pick one of" cluster.
5. **Mount references.** The bracketed filename must be one of the
   already-generated STL paths under `site/public/models/`. A module's
   "mount" is the plate or belt clip it bolts to.
   - Plates (under `plates/`):
     - `plates/kanix_plate_2x2_38x5.3.stl`
     - `plates/kanix_plate_3x2_38x5.3.stl`
     - `plates/kanix_plate_4x2_38x5.3.stl`
     - `plates/kanix_plate_2x3_52x6.5.stl`
     - `plates/kanix_plate_2x3_52x12.stl`
     - `plates/kanix_plate_3x3_52x6.5.stl`
     - `plates/kanix_plate_3x3_52x12.stl`
     - `plates/kanix_plate_4x3_52x6.5.stl`
     - `plates/kanix_plate_4x3_52x12.stl`
   - Belt clips (no `plates/` prefix):
     - `belt_clip_2x2_38mm.stl`
     - `belt_clip_3x2_38mm.stl`
     - `belt_clip_3x3_38mm.stl`
   Validate every bracketed value against this list before writing
   `loadouts.ts`. If a value isn't on the list, stop and ask.
6. **Keep the `resolveLoadout()` helper and `ResolvedLoadoutModule` type
   in `loadouts.ts` unchanged** — they're consumed by the page template.
7. **Do not modify [site/src/data/modules.ts](site/src/data/modules.ts)**
   during a regeneration. Loadout slugs may reference entries in either
   `modules` (the printable list) or `comingSoonModules` (e.g. the e-collar
   mounts). `resolveLoadout` falls back to `comingSoonModules` and the page
   renders those entries with a "Coming Soon" badge.
8. **Run `cd site && npm run build`** (inside `nix develop`) after writing
   `loadouts.ts` to verify the loadout pages still build.

### What does *not* belong in a loadout's module list

- **`kanix-plate`** — the plate is the substrate every accessory module
  bolts to. It's specified per-module via the bracketed plate reference,
  not as a module entry.
- **`belt-clip`** — same reasoning for loadouts that use belt clips
  instead of duty-belt plates. The clip is the substrate, encoded as the
  bracketed reference on each module entry.

If you want to *add* a new loadout, append a `## Loadout: …` section here
first, then regenerate. Don't edit `loadouts.ts` directly — it'll drift
from this file and the next regeneration will silently undo your change.

---

## Loadout: The Trainer

### Slug

trainer

### Name

The Trainer

### Tagline

Built for people who work with dogs all day.

### Description

A working setup for professional and amateur trainers, laid out for a 2" MOLLE duty belt. Clockwise from the top: clicker, treat bag, e-collar, MK3 spray, waste bags, flashlight, dump bag, heel lead, and a carabiner. Everything is exactly where your hand expects it.

### Belt

2"

### Belt note

Built around the IDOGEAR SPORTS 2" MOLLE duty belt. The extra MOLLE webbing carries the non-Kanix gear (water, radio) that doesn't bolt to a plate.

### Belt product

IDOGEAR SPORTS Tactical 2" Heavy-Duty MOLLE Belt
https://www.amazon.com/dp/B0G2PTBGF2

### Modules

- clicker-holder [plates/kanix_plate_3x3_52x12.stl] — Clicker rides on the 12mm plate behind the buckle where the belt doubles over.
- treat-bag-mount [plates/kanix_plate_3x3_52x6.5.stl] — Wilderdog treat bag on your dominant-hand side — fastest possible reinforcement.
- mini-educator-holder [plates/kanix_plate_3x3_52x6.5.stl] — Use whichever e-collar mount fits the receiver you already own — Mini Educator, Dogtra, ARC, ARC-X, 280X, and others all have their own Kanix mount (or are coming soon). They all use the same 3×3 / 52mm / 6.5mm plate.
- mk3-canister-holder [plates/kanix_plate_3x3_52x6.5.stl] — Off-leash dog approach — the most likely emergency on a session.
- waste-bag-dispenser [plates/kanix_plate_3x3_52x6.5.stl]
- flashlight-holster-c3 [plates/kanix_plate_3x3_52x6.5.stl] — Wuben C3 — early-morning and late-evening sessions.
- dump-bag-mount [plates/kanix_plate_3x3_52x6.5.stl] — Catch-all storage — backup leashes, wipes, extras you pick up on a session.
- quick-detach-biothane-heel-lead — BioThane heel lead. Loops directly around the belt — no plate.
- carabiner-clip [plates/kanix_plate_2x3_52x6.5.stl] {variant=tiny,small} — Two 1×2 carabiner clips share one plate — a tiny clip and a small clip stacked. Clip on a second leash, keys, or a water bottle without burning a full module slot.

---

## Loadout: The Walker

### Slug

walker

### Name

The Walker

### Tagline

Hands-free for the daily neighborhood loop.

### Description

The minimal everyday carry: waste bags, treats, and a flashlight for early or late walks. No bulk, no extras — just what you reach for on every walk.

### Belt

1.5"

### Belt note

A 1.5" duty belt is plenty for a light loadout and tucks under everyday clothing better than a 2" belt.

### Belt product

IDOGEAR SPORTS Tactical Ratchet Belt (1.5")
https://www.amazon.com/dp/B0FJDMN78R

### Modules

- waste-bag-dispenser [plates/kanix_plate_2x2_38x5.3.stl]
- treat-bag-mount [plates/kanix_plate_2x2_38x5.3.stl] — A small reward stash for everyday training opportunities.
- flashlight-holster-g5 [plates/kanix_plate_2x2_38x5.3.stl] — Compact EDC light for the dark side of the daily loop.
- carabiner-clip [plates/kanix_plate_2x2_38x5.3.stl] — Clip keys or a phone tether so they're not in your pocket.

---

## Loadout: The Hiker

### Slug

hiker

### Name

The Hiker

### Tagline

Configured for trails, long days, and the unexpected.

### Description

Built for full-day outings where you might be hours from a vehicle. Carries everything from a backup leash to a first aid kit, plus options for terrain hazards (other dogs, wildlife, dim light). The dump pouch handles whatever you pick up on the trail — extra layers, gloves, a packed-out poop bag — so it isn't living in your hand.

### Belt

2"

### Belt note

A 2" duty belt distributes weight better on long days and keeps the loadout from bouncing on technical terrain.

### Belt product

IDOGEAR SPORTS Tactical 2" Heavy-Duty MOLLE Belt
https://www.amazon.com/dp/B0G2PTBGF2

### Modules

- first-aid-kit-mount [plates/kanix_plate_3x3_52x6.5.stl] — Hours from a trailhead — first aid is non-negotiable.
- waste-bag-dispenser [plates/kanix_plate_3x3_52x6.5.stl]
- slip-lead-wrap-post [plates/kanix_plate_3x3_52x6.5.stl] — Backup leash in case the primary fails on the trail.
- dump-bag-mount [plates/kanix_plate_3x3_52x6.5.stl] — Stash a packed-out bag, gloves, a layer, or extras you pick up on the trail.
- mk3-canister-holder [plates/kanix_plate_3x3_52x6.5.stl] — Off-leash dog encounters are most likely on shared trails.
- flashlight-holster-c3 [plates/kanix_plate_3x3_52x6.5.stl] — Dawn starts and dusk returns — bring real light.
- carabiner-clip [plates/kanix_plate_3x3_52x6.5.stl] — Tether keys, a multitool, or a second leash.

---

## Loadout: The Freeform

### Slug

freeform

### Name

The Freeform

### Tagline

Mix and match — build the belt that fits how you actually work.

### Description

There's no single "right" Kanix™ setup. The Freeform is the open invitation: pick the modules you actually reach for, arrange them where your hands expect them, and skip the rest. This is a starting point for handlers whose workflow doesn't match the Trainer, Walker, or Hiker profiles — multi-dog handlers, kennel staff, sport competitors, anyone whose gear list is their own.

### Belt

1.5"

### Belt note

Built around the Kanix™ belt clip adapter — no duty belt required. Clip each module onto a regular pants belt; mix grid sizes as needed.

### Modules

- waste-bag-dispenser [belt_clip_2x2_38mm.stl]
- treat-bag-mount [belt_clip_3x2_38mm.stl] — Always-useful, regardless of workflow.
- clicker-holder [belt_clip_2x2_38mm.stl] — Add if you're doing any marker-based training.
- slip-lead-wrap-post [belt_clip_2x2_38mm.stl] — Backup leash that fits any handler's worst-case.
- flashlight-holster-c3 [belt_clip_3x3_38mm.stl] — Pick C3 (or swap to G5 below) based on how much throw you want.
- carabiner-clip [belt_clip_3x3_38mm.stl] — Multipurpose: keys, second leash, water bottle clip.
- dump-bag-mount [belt_clip_3x3_38mm.stl] — Catch-all storage for whatever you end up carrying on a given day.
