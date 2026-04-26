# Kanix™

A free, open-source modular belt system for dog handlers.

**Website:** [mmmaxwwwell.github.io/kanix](https://mmmaxwwwell.github.io/kanix)

## What is Kanix™?

Kanix™ is a modular mounting system that turns any 2" duty belt into a fully customized dog handling rig. Each module bolts onto a standard Kanix™ belt clip using a universal 3x3 bolt pattern (M5 hardware, 3/4" spacing), so you can rearrange your gear in seconds.

Whether you're a professional trainer, a dog walker, or an everyday owner, Kanix™ gives you a system that adapts to your workflow.

## Available Modules

| Module | Description | Compatible Product |
|--------|-------------|-------------------|
| **Kanix™ Plate** | Universal mounting plate with 3x3 bolt pattern and integrated hinge | |
| **Waste Bag Dispenser** | Holds a standard roll of waste bags with a screw-in cap and front dispensing slit | [Earth Rated Dog Waste Bags](https://www.amazon.com/Earth-Rated-Leak-Proof-Extra-Thick-Unscented/dp/B0CS8GCYS1) |
| **First Aid Kit Mount** | Mounting plate with center cutout for strap pass-through | [Individual First Aid Kit](https://www.amazon.com/dp/B0F311WTPC) |
| **MK3 Canister Holder** | Holder for an MK-3 pepper spray canister | [Sabre Protector Dog Spray](https://www.amazon.com/dp/B00AU6J68Q) |
| **Slip Lead Wrap Post** | Post for securely wrapping a 5/8" x 5' slip lead | [Mendota Products Slip Lead](https://www.amazon.com/dp/B086WMV7G7) |
| **Treat Bag Mount** | Folding hinge mount for a treat pouch carabiner loop | [Wilderdog Treat Bag](https://www.amazon.com/Wilderdog-Training-Magnetic-Carabiner-Adjustable/dp/B0FCVFF9J9) |
| **Flashlight Holster (Wuben C3)** | Holster for the Wuben C3 flashlight | [Wuben C3](https://www.amazon.com/dp/B086WJBB7K) |
| **Flashlight Holster (Wuben G5)** | Holster for the Wuben G5 EDC flashlight | [Wuben G5](https://www.amazon.com/dp/B0DT6SS412) |
| **Pepper Spray Holster (Dual)** | Side-by-side holster for two compact pepper spray canisters | [Guard Dog Security Pepper Spray](https://www.amazon.com/Guard-Dog-Security-Pepper-Spray/dp/B0CCZ1D6YQ) |
| **E-Collar Holder (Dogtra 200C/202C/ARC)** *(coming soon)* | Holder for Dogtra 200C/202C/ARC series e-collar receivers | [Dogtra 200C](https://www.amazon.com/Dogtra-200C-Remote-Training-Collar/dp/B07FSG5V8C), [Dogtra 202C](https://www.amazon.com/Dogtra-202C-Remote-Training-Collar/dp/B07FSKBQ1L), [Dogtra ARC](https://www.amazon.com/Dogtra-ARC-Remote-Training-Collar/dp/B00NXYXVU6) |
| **E-Collar Holder (Dogtra 280X/ARC-X)** *(coming soon)* | Holder for Dogtra 280X and ARC-X e-collar receivers | [Dogtra 280X](https://www.amazon.com/Dogtra-280X-Stubborn-Waterproof-Vibration/dp/B0DBMW4YN9), [Dogtra ARC-X](https://www.amazon.com/Dogtra-ARC-X-Collar-Dog-Training/dp/B0FC1LN2VW) |
| **E-Collar Holder (Mini Educator)** *(coming soon)* | Holder for Mini Educator ET-300 e-collar receiver | [Mini Educator ET-300](https://www.amazon.com/Mini-Educator-Dog-Training-Collar/dp/B0190P0NG6), [Educator ET-400](https://www.amazon.com/Educator-Collar-Training-Collar-System/dp/B07WXSMKGQ) |
| **Pet Corrector Holster** *(coming soon)* | Quick-draw holster for Pet Corrector compressed air spray | [Pet Corrector](https://www.amazon.com/Company-Animals-Pet-Corrector/dp/B0051GO5WM), [PSSSTTT Spray](https://www.amazon.com/PSSSTTT-Spray-Dogs-3-5-99g/dp/B0CGY2XQYB) |

## What You Need

- A **2" duty belt** - any rigid 2" (51mm) belt will work. We prototype with [this one](https://www.amazon.com/dp/B0FXRGCY7C).
- **[M5x10 button head cap screws](https://www.amazon.com/dp/B08DS7XJN8)** - used to mount most modules to belt clips
- **A 3D printer**

## Getting Started

```bash
git clone https://github.com/mmmaxwwwell/kanix.git
cd kanix
```

All module designs are in the `scad/` directory. Open them in [OpenSCAD](https://openscad.org/) to view, modify, or export STL files for printing.

Some modules depend on the [BOSL2](https://github.com/BelfrySCAD/BOSL2) library. Install it to your OpenSCAD libraries directory before rendering.

### Printing Tips

- Recommended material: hard TPU (64D Shore hardness) for impact resistance and flexibility
- 4+ walls, 1+mm floor/ceiling thickness, as the walls give these parts their strength, not the infill
- 15% gyroid infill
- Some modules may require supports depending on your printer and orientation

## Development (Website)

The project website is built with [Astro](https://astro.build/) and lives in the `site/` directory. A Nix flake is provided for the dev environment.

```bash
nix develop
cd site
npm install
npm run dev
```

The build pipeline automatically renders all `.scad` files to `.stl` using OpenSCAD, then builds the Astro site with interactive 3D model viewers.

## Contributions Model

Kanix™ rewards open-source contributors who design new modules. See the full details on the [Contributions Model](https://mmmaxwwwell.github.io/kanix/contributions/) page.

| Milestone | Threshold | Reward |
|-----------|-----------|--------|
| **PR Accepted** | First design merged | 2 plates + 2 modules of your choice |
| **Royalty Activation** | 25 units sold | 10% royalty, retroactive to unit 1 |
| **Starter Kit** | 50 units sold | Complete Kanix™ starter kit |

Contributors can also opt to donate royalties to a 501(c)(3) charity at double the rate (20%). All contributors must sign a [Contributor License Agreement (CLA)](https://mmmaxwwwell.github.io/kanix/contributions/#contributor-license-agreement-cla) when opening their first pull request.

## Disclaimer

These designs are provided "as is" without warranty of any kind. The creator assumes no liability for injury, damage, or loss resulting from the use of these designs or any parts printed from them. You are solely responsible for ensuring that printed parts are suitable and safe for your intended use, including material selection, print quality, and structural integrity. 3D-printed parts can fail without warning, so inspect your gear regularly and replace any parts showing signs of wear or damage. Use at your own risk.

## License

Licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Free for personal use. For commercial licensing, contact the project maintainer.
