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

export interface ComingSoonModule {
  slug: string;
  name: string;
  description: string;
  products?: Product[];
}

export const modules: Module[] = [
  {
    slug: "kanix-plate",
    name: "Kanix™ Plate",
    description:
      "The universal mounting plate. 3x3 bolt pattern with integrated hinge mechanism. The foundation every module attaches to.",
    scadFile: "scad/kanix-plate.scad",
    stlFile: "kanix-plate.stl",
  },
  {
    slug: "waste-bag-dispenser",
    name: "Waste Bag Dispenser",
    description:
      "Holds a standard roll of waste bags with a screw-in cap and front dispensing slit. Never fumble for a bag again.",
    scadFile: "scad/earth-rated-waste-bag-holder.scad",
    stlFile: "earth-rated-waste-bag-holder.stl",
    products: [
      {
        name: "Earth Rated Dog Waste Bags",
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
];

export const comingSoonModules: ComingSoonModule[] = [
  {
    slug: "dogtra-200c-202c-arc-holder",
    name: "E-Collar Holder (Dogtra 200C/202C/ARC)",
    description:
      "Compact holder for Dogtra 200C/202C series e-collar receivers. Keep your remote trainer secured on your belt for instant access during training sessions. Also fits the Dogtra 280C, Tom Davis 280C 2.0, and Dogtra ARC receivers.",
    products: [
      {
        name: "Dogtra 200C",
        url: "https://www.amazon.com/Dogtra-200C-Remote-Training-Collar/dp/B07FSG5V8C",
      },
      {
        name: "Dogtra 202C (2-Dog)",
        url: "https://www.amazon.com/Dogtra-202C-Remote-Training-Collar/dp/B07FSKBQ1L",
      },
      {
        name: "Dogtra 280C",
        url: "https://www.amazon.com/Dogtra-280C-Remote-Training-Collar/dp/B07FSLZCS8",
      },
      {
        name: "Dogtra ARC",
        url: "https://www.amazon.com/Dogtra-ARC-Remote-Training-Collar/dp/B00NXYXVU6",
      },
    ],
  },
  {
    slug: "dogtra-280x-arcx-holder",
    name: "E-Collar Holder (Dogtra 280X/ARC-X)",
    description:
      "Dual-purpose holder designed for the Dogtra 280X compact receiver and the slim ARC-X receiver. Two profiles, one module.",
    products: [
      {
        name: "Dogtra 280X",
        url: "https://www.amazon.com/Dogtra-280X-Stubborn-Waterproof-Vibration/dp/B0DBMW4YN9",
      },
      {
        name: "Dogtra ARC-X",
        url: "https://www.amazon.com/Dogtra-ARC-X-Collar-Dog-Training/dp/B0FC1LN2VW",
      },
    ],
  },
  {
    slug: "mini-educator-holder",
    name: "E-Collar Holder (Mini Educator)",
    description:
      "Purpose-built holder for the Mini Educator ET-300 receiver, the most popular remote trainer among professional dog trainers. Also fits the Educator ET-400 (identical receiver) and Micro Educator ME-300.",
    products: [
      {
        name: "Mini Educator ET-300",
        url: "https://www.amazon.com/Mini-Educator-Dog-Training-Collar/dp/B0190P0NG6",
      },
      {
        name: "Educator ET-400 (3/4 Mile)",
        url: "https://www.amazon.com/Educator-Collar-Training-Collar-System/dp/B07WXSMKGQ",
      },
      {
        name: "Micro Educator ME-300",
        url: "https://www.amazon.com/Collar-Waterproof-Educator-Vibration-Stimulation/dp/B07SK953K4",
      },
    ],
  },
  {
    slug: "pet-corrector-holster",
    name: "Pet Corrector Holster",
    description:
      "Quick-draw holster for the Pet Corrector compressed air spray. Interrupts unwanted behaviors with a short hiss — keep it on your belt so it's there when you need it. Also fits the PSSSTTT spray and other similarly sized aerosol trainers.",
    products: [
      {
        name: "Pet Corrector (50mL)",
        url: "https://www.amazon.com/Company-Animals-Pet-Corrector/dp/B0051GO5WM",
      },
      {
        name: "PSSSTTT Spray for Dogs",
        url: "https://www.amazon.com/PSSSTTT-Spray-Dogs-3-5-99g/dp/B0CGY2XQYB",
      },
    ],
  },
];
