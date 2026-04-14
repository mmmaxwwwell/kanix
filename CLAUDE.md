# Kanix - Claude Code Instructions

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

- OpenSCAD with BOSL2 library for 3D models
- Astro site in `site/` with Three.js STL viewer
- Nix flake for dev environment
- `site/src/data/modules.ts` is the single source of truth for module registry
