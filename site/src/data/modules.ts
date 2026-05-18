export interface Product {
  name: string;
  url: string;
  // True if this product is *required* to use the module (e.g. the dump-bag
  // mount needs the actual dump bag). Anything without `required: true` is
  // implicitly optional. The legacy `recommended` flag was removed — the
  // loadout product list now derives "recommended vs optional" from
  // context (belt is always required; first product per module surfaces
  // first; etc.).
  required?: boolean;
  // Legacy: existing UI in module pages still surfaces a "✓ recommended"
  // marker. Kept so existing data renders, but new entries should not set
  // it — required: true is the new authoritative flag.
  recommended?: boolean;
}

// One concrete plate fixture (one grid x one belt-thickness combo).
export interface PlateVariant {
  grid: "2x2" | "3x2" | "4x2" | "2x3" | "3x3" | "4x3";
  thickness: 5.3 | 6.5 | 12;
  scadFile: string; // path under repo root, e.g. scad/plates/kanix_plate_3x3_52x12.scad
  stlFile: string; // path under site/public/models/, e.g. plates/kanix_plate_3x3_52x12.stl
}

// Belts a plate family can be paired with (drives the top-level selector and
// recommended Amazon links). 38mm = 1.5" duty, 52mm = 2" duty.
export interface BeltOption {
  height: 38 | 52;
  label: string; // "38mm — 1.5\" duty"
  description: string; // short explanation shown under the choice
  products: Product[]; // amazon links specific to this belt
}

// Optional variants block on the Module type. When present, the module page
// renders a multi-axis variant picker; when absent, the page falls back to
// the single-STL layout used by every other accessory.
export interface PlateVariants {
  belts: BeltOption[];
  variants: PlateVariant[];
  defaultGrid: PlateVariant["grid"];
  defaultBelt: BeltOption["height"];
  defaultThickness: PlateVariant["thickness"];
}

// Generic variant shape for non-plate modules. A module can have one or more
// "groups" of variants — e.g. a carabiner clip groups its sizes under
// "1×2 compact" and "1×3 full"; a holster with two belt-size variants has a
// single group containing both. The page renders one labeled section per
// group, each with a row of selectable chips.
export interface VariantOption {
  id: string; // stable key, used for default + ARIA
  label: string; // primary text on the chip (e.g. "38mm" or "Medium")
  sublabel?: string; // small caption under the label (e.g. "1.5\" duty" or "1×3 grid")
  scadFile: string; // path under repo root
  stlFile: string; // path under site/public/models/
}
export interface VariantGroup {
  label: string; // section header (e.g. "1×2 compact" or "Belt size")
  description?: string; // optional caption shown under the header
  options: VariantOption[];
}
export interface GenericVariants {
  groups: VariantGroup[];
  defaultId: string; // matches one VariantOption.id across all groups
}

export interface Module {
  slug: string;
  name: string;
  description: string;
  // Optional for description-only modules (e.g. a leash that's a real product
  // but has no 3D-printable component). When `noModel` is true the module
  // page skips the STL viewer and download/source buttons.
  scadFile?: string;
  stlFile?: string;
  noModel?: boolean;
  // How many M5×10 button-head cap screws this module needs to mount.
  // Counts the screws for the module itself; does *not* include the
  // screws used to fasten the plate to the belt (those are part of the
  // plate's hardware). 0 means no screws (e.g. a leash that loops around
  // the belt). Undefined means "unknown — figure out before adding to a
  // loadout."
  screwCount?: number;
  // Longer-form copy shown on the module page when there's no 3D viewer to
  // fill the visual real estate. Free-form markdown-ish lines.
  details?: string[];
  products?: Product[];
  // A module has at most one of these. PlateVariants drives the bespoke
  // 3-axis (belt × grid × thickness) picker; GenericVariants drives the
  // simpler grouped-chip picker used for everything else.
  variants?: PlateVariants;
  genericVariants?: GenericVariants;
}

export interface ComingSoonModule {
  slug: string;
  name: string;
  description: string;
  products?: Product[];
  // Same semantics as `Module.screwCount`.
  screwCount?: number;
}

export const modules: Module[] = [
  {
    slug: "kanix-plate",
    name: "Kanix™ Plate",
    description:
      "The hinged belt clip every module bolts onto. Pick your duty belt and how wide a footprint you want.",
    // Default fixture surfaced on the page before the user picks: 3x3 / 52mm / 6.5mm
    // (most common configuration — 12mm is only needed for the buckle area).
    scadFile: "scad/plates/kanix_plate_3x3_52x6.5.scad",
    stlFile: "plates/kanix_plate_3x3_52x6.5.stl",
    variants: {
      defaultBelt: 52,
      defaultGrid: "3x3",
      defaultThickness: 6.5,
      belts: [
        {
          height: 38,
          label: '38mm — 1.5"',
          description:
            "A plain 1.5\" duty belt. Single 5.3mm thickness — these belts don't double back on themselves.",
          products: [
            {
              name: 'IDOGEAR SPORTS Tactical Ratchet Belt',
              url: "https://www.amazon.com/dp/B0FJDMN78R",
              recommended: true,
            },
          ],
        },
        {
          height: 52,
          label: '52mm — 2"',
          description:
            "A standard 2\" duty belt. Default plate thickness is 6.5mm — only print the 12mm version for sections where the belt doubles over itself (e.g. behind the buckle).",
          products: [
            {
              name: 'IDOGEAR SPORTS Tactical 2" Heavy-Duty MOLLE Belt',
              url: "https://www.amazon.com/dp/B0G2PTBGF2",
              recommended: true,
            },
            {
              name: 'Heavy Duty 2 inch duty belt',
              url: "https://www.amazon.com/dp/B0FXRGCY7C",
            },
          ],
        },
      ],
      variants: [
        // 38mm / 1.5" duty — 2-row grids, one thickness
        {
          grid: "2x2",
          thickness: 5.3,
          scadFile: "scad/plates/kanix_plate_2x2_38x5.3.scad",
          stlFile: "plates/kanix_plate_2x2_38x5.3.stl",
        },
        {
          grid: "3x2",
          thickness: 5.3,
          scadFile: "scad/plates/kanix_plate_3x2_38x5.3.scad",
          stlFile: "plates/kanix_plate_3x2_38x5.3.stl",
        },
        {
          grid: "4x2",
          thickness: 5.3,
          scadFile: "scad/plates/kanix_plate_4x2_38x5.3.scad",
          stlFile: "plates/kanix_plate_4x2_38x5.3.stl",
        },
        // 52mm / 2" duty — 3-row grids, two thicknesses
        {
          grid: "2x3",
          thickness: 6.5,
          scadFile: "scad/plates/kanix_plate_2x3_52x6.5.scad",
          stlFile: "plates/kanix_plate_2x3_52x6.5.stl",
        },
        {
          grid: "2x3",
          thickness: 12,
          scadFile: "scad/plates/kanix_plate_2x3_52x12.scad",
          stlFile: "plates/kanix_plate_2x3_52x12.stl",
        },
        {
          grid: "3x3",
          thickness: 6.5,
          scadFile: "scad/plates/kanix_plate_3x3_52x6.5.scad",
          stlFile: "plates/kanix_plate_3x3_52x6.5.stl",
        },
        {
          grid: "3x3",
          thickness: 12,
          scadFile: "scad/plates/kanix_plate_3x3_52x12.scad",
          stlFile: "plates/kanix_plate_3x3_52x12.stl",
        },
        {
          grid: "4x3",
          thickness: 6.5,
          scadFile: "scad/plates/kanix_plate_4x3_52x6.5.scad",
          stlFile: "plates/kanix_plate_4x3_52x6.5.stl",
        },
        {
          grid: "4x3",
          thickness: 12,
          scadFile: "scad/plates/kanix_plate_4x3_52x12.scad",
          stlFile: "plates/kanix_plate_4x3_52x12.stl",
        },
      ],
    },
  },
  {
    slug: "waste-bag-dispenser",
    name: "Waste Bag Dispenser",
    description:
      "Holds a standard roll of waste bags with a screw-in cap and front dispensing slit. Never fumble for a bag again.",
    scadFile: "scad/earth-rated-waste-bag-holder.scad",
    stlFile: "earth-rated-waste-bag-holder.stl",
    screwCount: 6,
    products: [
      {
        name: "Earth Rated Dog Waste Bags",
        url: "https://www.amazon.com/Earth-Rated-Leak-Proof-Extra-Thick-Unscented/dp/B0CS8GCYS1",
        required: true,
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
    screwCount: 6,
    products: [
      {
        name: "Sabre Protector Dog Spray (MK-3)",
        url: "https://www.amazon.com/dp/B00AU6J68Q",
        required: true,
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
    slug: "quick-detach-biothane-heel-lead",
    name: "Quick-Detach BioThane Heel Lead",
    description:
      "A hands-free, belt-mounted heel lead. Long enough to keep the dog in heel, short enough to stay out of the way. Quick-detach Cobra buckle at the belt, dual-action carabiner at the collar.",
    noModel: true,
    screwCount: 0,
    details: [
      "Hands-free belt-mounted lead — keeps both hands available for training, gear, or another dog.",
      "Cut to a heel-position length: long enough for the dog to walk at your hip, short enough that there's no slack to manage.",
      "Cobra buckle quick-release at the belt — instant detach when you need it, no fumbling with snap hooks.",
      "Dual-action carabiner at the collar end — both hands required to open, so it can't release accidentally if it brushes against gear or the dog's coat.",
      "BioThane construction — coated webbing that doesn't absorb water, mud, or saliva, and wipes clean.",
      "500 lb working load — built to take the worst-case hit (a lunge, a bolt) without failing.",
    ],
  },
  {
    slug: "treat-bag-mount",
    name: "Treat Bag Mount",
    description:
      "Folding hinge mount that hooks onto a treat pouch carabiner loop. Designed for Wilderdog treat bags.",
    scadFile: "scad/wilderdog-treat-bag-mount.scad",
    stlFile: "wilderdog-treat-bag-mount.stl",
    screwCount: 4,
    products: [
      {
        name: "Wilderdog Treat Bag",
        url: "https://www.amazon.com/Wilderdog-Training-Magnetic-Carabiner-Adjustable/dp/B0FCVFF9J9",
        required: true,
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
    screwCount: 6,
    products: [
      {
        name: "Wuben C3 Flashlight",
        url: "https://www.amazon.com/dp/B086WJBB7K",
        required: true,
      },
    ],
    genericVariants: {
      defaultId: "52mm",
      groups: [
        {
          label: "Belt size",
          options: [
            {
              id: "38mm",
              label: "38mm",
              sublabel: '1.5" belt — 2×2 grid',
              scadFile: "scad/wuben-c3-holster-2x2.scad",
              stlFile: "wuben-c3-holster-2x2.stl",
            },
            {
              id: "52mm",
              label: "52mm",
              sublabel: '2" belt — 3×3 grid',
              scadFile: "scad/wuben-c3-holster.scad",
              stlFile: "wuben-c3-holster.stl",
            },
          ],
        },
      ],
    },
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
    slug: "clicker-holder",
    name: "Clicker Holder",
    description:
      "Always-ready slot for a training clicker. Pick the variant matching your belt size.",
    scadFile: "scad/clicker_holder_52x65.scad",
    stlFile: "clicker_holder_52x65.stl",
    screwCount: 6,
    products: [
      {
        name: "Training Clicker",
        url: "https://www.amazon.com/dp/B0GRWPSYSD",
        required: true,
      },
    ],
    genericVariants: {
      defaultId: "52mm",
      groups: [
        {
          label: "Belt size",
          options: [
            {
              id: "38mm",
              label: "38mm",
              sublabel: '1.5" belt — 2×2 grid',
              scadFile: "scad/clicker_holder_38x4.scad",
              stlFile: "clicker_holder_38x4.stl",
            },
            {
              id: "52mm",
              label: "52mm",
              sublabel: '2" belt — 3×3 grid',
              scadFile: "scad/clicker_holder_52x65.scad",
              stlFile: "clicker_holder_52x65.stl",
            },
          ],
        },
      ],
    },
  },
  {
    slug: "carabiner-clip",
    name: "Carabiner Clip",
    description:
      "Bolt-on carabiner loop for clipping leashes, keys, or gear to the side of your belt. Five sizes across two grid widths.",
    scadFile: "scad/carabiner_clip_1x3_52x65_medium.scad",
    stlFile: "carabiner_clip_1x3_52x65_medium.stl",
    screwCount: 2,
    genericVariants: {
      defaultId: "medium",
      groups: [
        {
          label: "1×2 (compact)",
          description:
            "Two-bolt mount. Smaller footprint — best for the back of the belt where space is tight.",
          options: [
            {
              id: "tiny",
              label: "Tiny",
              sublabel: "1×2 grid",
              scadFile: "scad/carabiner_clip_1x2_52x65_tiny.scad",
              stlFile: "carabiner_clip_1x2_52x65_tiny.stl",
            },
            {
              id: "small",
              label: "Small",
              sublabel: "1×2 grid",
              scadFile: "scad/carabiner_clip_1x2_52x65_small.scad",
              stlFile: "carabiner_clip_1x2_52x65_small.stl",
            },
          ],
        },
        {
          label: "1×3 (full)",
          description:
            "Three-bolt mount. Stronger purchase for heavier loads.",
          options: [
            {
              id: "medium",
              label: "Medium",
              sublabel: "1×3 grid",
              scadFile: "scad/carabiner_clip_1x3_52x65_medium.scad",
              stlFile: "carabiner_clip_1x3_52x65_medium.stl",
            },
            {
              id: "large",
              label: "Large",
              sublabel: "1×3 grid",
              scadFile: "scad/carabiner_clip_1x3_52x65_large.scad",
              stlFile: "carabiner_clip_1x3_52x65_large.stl",
            },
            {
              id: "strong",
              label: "Strong",
              sublabel: "1×3 grid — heavy duty",
              scadFile: "scad/carabiner_clip_1x3_52x65_strong.scad",
              stlFile: "carabiner_clip_1x3_52x65_strong.stl",
            },
          ],
        },
      ],
    },
  },
  {
    slug: "dump-bag-mount",
    name: "Dump Bag Mount",
    description:
      "Mount for a tactical dump pouch — handy for stashing a 6-foot leash, emergency slip lead, wipes, or whatever extras you pick up on the go.",
    scadFile: "scad/dump-bag-mount.scad",
    stlFile: "dump-bag-mount.stl",
    screwCount: 4,
    products: [
      {
        name: "LIVANS Tactical Molle Dump Pouch",
        url: "https://www.amazon.com/dp/B07Y7CCJDK",
        required: true,
      },
      {
        name: "Aurora Pet Wipes — 60-Count Travel Pack",
        url: "https://www.amazon.com/dp/B0BCPL4B1B",
      },
      {
        name: "Mendota Products Slip Lead",
        url: "https://www.amazon.com/dp/B086WMV7G7",
      },
      {
        name: '5\'×3/4" BioThane Leash with Carabiner Clip',
        url: "https://www.amazon.com/dp/B0GZ23MDW4",
      },
    ],
  },
  {
    slug: "belt-clip",
    name: "Belt Clip (no duty belt required)",
    description:
      "An alternate mounting system — clips directly onto a regular pants belt and exposes a standard Kanix™ bolt grid. Any Kanix™ accessory bolts on. Pick this if you don't want to run a dedicated duty belt.",
    scadFile: "scad/belt_clip_3x3_38mm.scad",
    stlFile: "belt_clip_3x3_38mm.stl",
    genericVariants: {
      defaultId: "3x3",
      groups: [
        {
          label: "Grid",
          description:
            'All three sizes fit a 1.5" (38mm) belt. Pick the bolt grid that matches the accessory you want to mount.',
          options: [
            {
              id: "2x2",
              label: "2×2",
              sublabel: "compact",
              scadFile: "scad/belt_clip_2x2_38mm.scad",
              stlFile: "belt_clip_2x2_38mm.stl",
            },
            {
              id: "3x2",
              label: "3×2",
              sublabel: "wider, 2 rows",
              scadFile: "scad/belt_clip_3x2_38mm.scad",
              stlFile: "belt_clip_3x2_38mm.stl",
            },
            {
              id: "3x3",
              label: "3×3",
              sublabel: "standard full grid",
              scadFile: "scad/belt_clip_3x3_38mm.scad",
              stlFile: "belt_clip_3x3_38mm.stl",
            },
          ],
        },
      ],
    },
  },
];

export const comingSoonModules: ComingSoonModule[] = [
  {
    slug: "dogtra-200c-202c-arc-holder",
    name: "E-Collar Holder (Dogtra 200C/202C/ARC)",
    description:
      "Compact holder for Dogtra 200C/202C series e-collar receivers. Keep your remote trainer secured on your belt for instant access during training sessions. Also fits the Dogtra 280C, Tom Davis 280C 2.0, and Dogtra ARC receivers.",
    screwCount: 6,
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
    screwCount: 6,
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
    screwCount: 6,
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
