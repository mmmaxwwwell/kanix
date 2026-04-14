export interface Product {
  name: string;
  url: string;
}

export interface Module {
  slug: string;
  name: string;
  description: string;
  scadFile: string;
  stlFile: string;
  products?: Product[];
}

export const modules: Module[] = [
  {
    slug: "poo-bag-dispenser",
    name: "Poo Bag Dispenser",
    description:
      "Holds a standard roll of poo bags with a screw-in cap and front dispensing slit. Never fumble for a bag again.",
    scadFile: "scad/earth-rated-poo-bag-holder.scad",
    stlFile: "earth-rated-poo-bag-holder.stl",
    products: [
      {
        name: "Earth Rated Dog Poo Bags",
        url: "https://www.amazon.com/Earth-Rated-Leak-Proof-Extra-Thick-Unscented/dp/B0CS8GCYS1",
      },
    ],
  },
  {
    slug: "first-aid-kit-mount",
    name: "First Aid Kit Mount",
    description:
      "Minimal mounting plate with a center cutout for strap pass-through. Attach your individual first aid kit exactly where you need it.",
    scadFile: "scad/first-aid-kit-mount.scad",
    stlFile: "first-aid-kit-mount.stl",
    products: [
      {
        name: "Individual First Aid Kit",
        url: "https://www.amazon.com/dp/B0F311WTPC",
      },
    ],
  },
  {
    slug: "mk3-canister-holder",
    name: "MK3 Canister Holder",
    description:
      "Purpose-built holder for an MK-3 pepper spray canister. Quick-draw access when you need it most.",
    scadFile: "scad/mk3-canister-holder.scad",
    stlFile: "mk3-canister-holder.stl",
    products: [
      {
        name: "Sabre Protector Dog Spray (MK-3)",
        url: "https://www.amazon.com/dp/B00AU6J68Q",
      },
    ],
  },
  {
    slug: "slip-lead-wrap-post",
    name: "Slip Lead Wrap Post",
    description:
      'A post for securely wrapping a 5/8" x 5\' slip lead. Keeps your lead tidy and instantly accessible.',
    scadFile: "scad/slip-lead-wrap-post.scad",
    stlFile: "slip-lead-wrap-post.stl",
    products: [
      {
        name: "Mendota Products Slip Lead",
        url: "https://www.amazon.com/dp/B086WMV7G7",
      },
    ],
  },
  {
    slug: "treat-bag-mount",
    name: "Treat Bag Mount",
    description:
      "Folding hinge mount that hooks onto a treat pouch carabiner loop. Designed for Wilderdog treat bags.",
    scadFile: "scad/wilderdog-treat-bag-mount.scad",
    stlFile: "wilderdog-treat-bag-mount.stl",
    products: [
      {
        name: "Wilderdog Treat Bag",
        url: "https://www.amazon.com/Wilderdog-Training-Magnetic-Carabiner-Adjustable/dp/B0FCVFF9J9",
      },
    ],
  },
  {
    slug: "flashlight-holster-c3",
    name: "Flashlight Holster (Wuben C3)",
    description:
      "Snug-fit holster for the Wuben C3 flashlight. Illuminate your path on early morning or late night walks.",
    scadFile: "scad/wuben-c3-holster.scad",
    stlFile: "wuben-c3-holster.stl",
    products: [
      {
        name: "Wuben C3 Flashlight",
        url: "https://www.amazon.com/dp/B086WJBB7K",
      },
    ],
  },
  {
    slug: "flashlight-holster-g5",
    name: "Flashlight Holster (Wuben G5)",
    description:
      "Compact holster for the Wuben G5 EDC flashlight. Tiny but bright, always within reach.",
    scadFile: "scad/wuben-g5-holster.scad",
    stlFile: "wuben-g5-holster.stl",
    products: [
      {
        name: "Wuben G5 EDC Flashlight",
        url: "https://www.amazon.com/dp/B0DT6SS412",
      },
    ],
  },
  {
    slug: "pepper-spray-holster",
    name: "Pepper Spray Holster (Dual)",
    description:
      "Side-by-side holster for two compact pepper spray canisters. Quick-draw access to personal protection.",
    scadFile: "scad/pepper-spray-holster.scad",
    stlFile: "pepper-spray-holster.stl",
    products: [
      {
        name: "Guard Dog Security Pepper Spray",
        url: "https://www.amazon.com/Guard-Dog-Security-Pepper-Spray/dp/B0CCZ1D6YQ",
      },
    ],
  },
  {
    slug: "kanix-plate",
    name: "Kanix™ Plate",
    description:
      "The universal mounting plate. 3x3 bolt pattern with integrated hinge mechanism. The foundation every module attaches to.",
    scadFile: "scad/kanix-plate.scad",
    stlFile: "kanix-plate.stl",
  },
];
