# Kanix™

A free, open-source modular belt system for dog handlers.

**Website:** [mmmaxwwwell.github.io/kanix](https://mmmaxwwwell.github.io/kanix)

## What is Kanix™?

Kanix™ is a modular mounting system that turns any 2" duty belt into a fully customized dog handling rig. Each module bolts onto a standard Kanix™ belt clip using a universal 3x3 bolt pattern (M5 hardware, 3/4" spacing), so you can rearrange your gear in seconds.

Whether you're a professional trainer, a dog walker, or an everyday owner, Kanix™ gives you a system that adapts to your workflow.

## Available Modules

| Module | Description | Compatible Product |
|--------|-------------|-------------------|
| **Poo Bag Dispenser** | Holds a standard roll of poo bags with a screw-in cap and front dispensing slit | [Earth Rated Dog Poo Bags](https://www.amazon.com/Earth-Rated-Leak-Proof-Extra-Thick-Unscented/dp/B0CS8GCYS1) |
| **First Aid Kit Mount** | Mounting plate with center cutout for strap pass-through | [Individual First Aid Kit](https://www.amazon.com/dp/B0F311WTPC) |
| **MK3 Canister Holder** | Holder for an MK-3 pepper spray canister | [Sabre Protector Dog Spray](https://www.amazon.com/dp/B00AU6J68Q) |
| **Slip Lead Wrap Post** | Post for securely wrapping a 5/8" x 5' slip lead | |
| **Treat Bag Mount** | Folding hinge mount for a treat pouch carabiner loop | [Wilderdog Treat Bag](https://www.amazon.com/Wilderdog-Training-Magnetic-Carabiner-Adjustable/dp/B0FCVFF9J9) |
| **Flashlight Holster (Wuben C3)** | Holster for the Wuben C3 flashlight | [Wuben C3](https://www.amazon.com/dp/B086WJBB7K) |
| **Flashlight Holster (Wuben G5)** | Holster for the Wuben G5 EDC flashlight | [Wuben G5](https://www.amazon.com/dp/B0DT6SS412) |
| **Kanix™ Plate** | Universal mounting plate with 3x3 bolt pattern and integrated hinge | |

## What You Need

- A **2" duty belt** - any rigid 2" (51mm) belt will work. We prototype with [this one](https://www.amazon.com/dp/B0FXRGCY7C).
- **M5 hardware** - M5 self-tapping screws for mounting modules to belt clips
- **A 3D printer**

## Getting Started

```bash
git clone https://github.com/mmmaxwwwell/kanix.git
cd kanix
```

All module designs are in the `scad/` directory. Open them in [OpenSCAD](https://openscad.org/) to view, modify, or export STL files for printing.

Some modules depend on the [BOSL2](https://github.com/BelfrySCAD/BOSL2) library. Install it to your OpenSCAD libraries directory before rendering.

### Printing Tips

- All modules are designed for FDM printing with no supports required
- Recommended material: hard TPU (64D Shore hardness) for impact resistance and flexibility
- 4+ walls, 1+mm floor/ceiling thickness
- 30% infill minimum for structural modules (holsters, spray mount)

## Development (Website)

The project website is built with [Astro](https://astro.build/) and lives in the `site/` directory. A Nix flake is provided for the dev environment.

```bash
nix develop
cd site
npm install
npm run dev
```

The build pipeline automatically renders all `.scad` files to `.stl` using OpenSCAD, then builds the Astro site with interactive 3D model viewers.

## Disclaimer

These designs are provided "as is" without warranty of any kind. The creator assumes no liability for injury, damage, or loss resulting from the use of these designs or any parts printed from them. You are solely responsible for ensuring that printed parts are suitable and safe for your intended use, including material selection, print quality, and structural integrity. 3D-printed parts can fail without warning — inspect your gear regularly and replace any parts showing signs of wear or damage. Use at your own risk.

## License

Licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Free for personal use. For commercial licensing, contact the project maintainer.
