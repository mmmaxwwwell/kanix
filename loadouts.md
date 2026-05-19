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

## Loadout: The Walker

### Slug

walker

### Name

The Walker

### Tagline

Hands-free for the daily neighborhood loop.

### Description

Three Kanix™ modules on a 1.5" duty belt plus a hands-free BioThane heel lead — the lead loops straight onto the belt so you never have to hold a leash on the daily loop. Wuben C3 flashlight stacks with a tiny attachment loop on one module, waste bags on another, two more attachment loops share the third. Light enough to disappear under everyday clothing.

### Belt

1.5"

### Belt note

A 1.5" duty belt is plenty for a light loadout and tucks under everyday clothing better than a 2" belt.

### Belt product

IDOGEAR SPORTS Tactical Ratchet Belt (1.5")
https://www.amazon.com/dp/B0FJDMN78R

### Modules

- flashlight-holster-c3 [plates/kanix_plate_3x2_38x5.3.stl] {variant=38mm} — Wuben C3 (38mm 2×2 variant) shares its 3×2 plate with a tiny attachment loop for clipping keys or a phone tether.
- carabiner-clip [plates/kanix_plate_3x2_38x5.3.stl] {variant=tiny} — Tiny attachment loop stacked on the C3's plate — clip your own carabiner, snap hook, or D-clip to it.
- quick-detach-biothane-heel-lead — BioThane lead, used here as a slip lead. Loops directly around the belt — no plate.
- waste-bag-dispenser [plates/kanix_plate_3x2_38x5.3.stl]
- carabiner-clip [plates/kanix_plate_3x2_38x5.3.stl] {variant=small,small} — Two of the larger 1×2 attachment loops on one 3×2 plate — clip a second leash, water bottle, or anything that needs more than a tiny loop.

---

## Loadout: The Hiker

### Slug

hiker

### Name

The Hiker

### Tagline

Configured for trails, long days, and the unexpected.

### Description

Five Kanix™ modules on a 2" MOLLE belt for full-day outings where you might be hours from a vehicle: first aid kit, MK3 spray for off-leash encounters, Wuben C3 flashlight for dawn-and-dusk legs, waste bags, and an attachment loop for tethering keys or a second leash. Covers the terrain hazards (other dogs, wildlife, dim light) without weighing you down.

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
- mk3-canister-holder [plates/kanix_plate_3x3_52x6.5.stl] — Off-leash dog encounters are most likely on shared trails.
- flashlight-holster-c3 [plates/kanix_plate_3x3_52x6.5.stl] — Dawn starts and dusk returns — bring real light.
- carabiner-clip [plates/kanix_plate_3x3_52x6.5.stl] {variant=tiny} — Tether keys, a multitool, or a second leash.

---

## Loadout: The Trainer

### Slug

trainer

### Name

The Trainer

### Tagline

A purpose-built marker-training rig for handlers running real reward-based programs.

### Description

Five Kanix™ modules on a 1.5" duty belt for people who train every day and are done improvising — pros doing 1:1 marker sessions, sport handlers prepping for trials, and dedicated owners working through structured plans with a real instructor. Clicker and Wilderdog treat pouch sit dominant-hand for sub-second reinforcement; waste bags, a dump pouch for the catch-all stuff, and a pair of attachment loops stay out of the way until you reach for them. A setup that stays put session after session instead of sliding around a soft training belt.

### Belt

1.5"

### Belt note

A 1.5" duty belt is plenty for a training loadout and tucks under everyday clothing better than a 2" belt.

### Belt product

IDOGEAR SPORTS Tactical Ratchet Belt (1.5")
https://www.amazon.com/dp/B0FJDMN78R

### Modules

- clicker-holder [plates/kanix_plate_3x2_38x5.3.stl] — Clicker on a 3×2 plate, dominant-hand side for fast marker work.
- treat-bag-mount [plates/kanix_plate_3x2_38x5.3.stl] — Wilderdog treat pouch — fastest possible reinforcement.
- waste-bag-dispenser [plates/kanix_plate_3x2_38x5.3.stl]
- dump-bag-mount [plates/kanix_plate_3x2_38x5.3.stl] — Catch-all storage — backup leash, wipes, treats refill, whatever else you pick up on a session.
- carabiner-clip [plates/kanix_plate_3x2_38x5.3.stl] {variant=small,small} — Two of the larger 1×2 attachment loops on one 3×2 plate — clip a second leash, water bottle, or anything that needs more than a tiny loop.

---

## Loadout: The Pro

### Slug

pro

### Name

The Pro

### Tagline

Everything The Trainer and The Walker carry, plus an e-collar and dump bag.

### Description

Seven Kanix™ modules on a 1.5" duty belt plus a hands-free BioThane heel lead — the lead loops directly onto the belt so both hands stay free for marker work, e-collar timing, and gear. Every Kanix™ module from The Trainer and The Walker, plus an e-collar holster for whichever receiver you run and a dump bag for the catch-all stuff. Clicker, treat pouch, e-collar, waste bags, C3 flashlight, dump bag, and three attachment loops (one tiny, two small) — all on 3×2 38mm plates. You don't have to wear them all every day: each Kanix™ module is a hinged belt clip that snaps on and off in seconds without tools, so a Trainer-day kit becomes a Walker-day kit on the way out the door.

### Belt

1.5"

### Belt note

A 1.5" duty belt keeps the loadout compact even with the full Pro kit, and tucks under everyday clothing better than a 2" belt.

### Belt product

IDOGEAR SPORTS Tactical Ratchet Belt (1.5")
https://www.amazon.com/dp/B0FJDMN78R

### Modules

- clicker-holder [plates/kanix_plate_3x2_38x5.3.stl] — Clicker on a 3×2 plate, dominant-hand side for fast marker work.
- treat-bag-mount [plates/kanix_plate_3x2_38x5.3.stl] — Wilderdog treat pouch — fastest possible reinforcement.
- group "E-Collar Holster" [plates/kanix_plate_3x2_38x5.3.stl] — Pick the holster that matches the e-collar receiver you already own.
    description: Pick the holster that matches the e-collar receiver you already own. On a 1.5" duty belt the holster's 3×3 hole pattern mounts to a 3×2 plate — the top row of holes is unused.
    choices: mini-educator-holder, dogtra-200ncpt-202c-arc-holder, dogtra-280x-arcx-holder
- quick-detach-biothane-heel-lead — BioThane lead, used as a heel/slip lead. Loops directly around the belt — no plate.
- waste-bag-dispenser [plates/kanix_plate_3x2_38x5.3.stl]
- flashlight-holster-c3 [plates/kanix_plate_3x2_38x5.3.stl] {variant=38mm} — Wuben C3 (38mm 2×2 variant) shares its 3×2 plate with a tiny attachment loop for clipping keys or a phone tether.
- carabiner-clip [plates/kanix_plate_3x2_38x5.3.stl] {variant=tiny} — Tiny attachment loop stacked on the C3's plate — clip your own carabiner, snap hook, or D-clip to it.
- dump-bag-mount [plates/kanix_plate_3x2_38x5.3.stl] — Catch-all storage — backup leashes, wipes, extras you pick up on a session.
- carabiner-clip [plates/kanix_plate_3x2_38x5.3.stl] {variant=small,small} — Two of the larger 1×2 attachment loops on one 3×2 plate — clip a second leash, water bottle, or anything that needs more than a tiny loop.
