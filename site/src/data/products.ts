export interface CatalogMedia {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  variantId: string | null;
}

export interface CatalogVariant {
  id: string;
  sku: string;
  title: string;
  optionValuesJson: Record<string, string> | null;
  priceMinor: number;
  currency: string;
  weight: string | null;
  dimensionsJson: Record<string, unknown> | null;
  status: string;
  available: number;
  inStock: boolean;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  media: CatalogMedia[];
  variants: CatalogVariant[];
}

const MATERIAL_WARNINGS: Record<string, string> = {
  TPU: "TPU is flexible and durable but may deform under sustained heat above 60\u00B0C (140\u00B0F). Do not leave in direct sunlight inside a hot vehicle for extended periods.",
  TPC: "TPC offers excellent heat resistance up to 130\u00B0C (266\u00B0F) and superior chemical resistance. Suitable for demanding environments.",
  PLA: "PLA is rigid and easy to print but has low heat resistance. May warp or deform above 50\u00B0C (122\u00B0F). Not recommended for high-temperature environments.",
  PETG: "PETG offers good strength and moderate heat resistance up to 80\u00B0C (176\u00B0F). Good balance of durability and printability.",
  ABS: "ABS is impact-resistant with heat tolerance up to 100\u00B0C (212\u00B0F). Requires enclosed printer and good ventilation during printing.",
};

export function getMaterialWarning(material: string): string | null {
  return MATERIAL_WARNINGS[material.toUpperCase()] ?? null;
}

export function getMaterialsFromVariants(variants: CatalogVariant[]): string[] {
  const materials = new Set<string>();
  for (const variant of variants) {
    const material = variant.optionValuesJson?.material;
    if (material) {
      materials.add(material);
    }
  }
  return Array.from(materials);
}

export function formatPrice(priceMinor: number, currency: string): string {
  const amount = priceMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

export function getPriceRange(variants: CatalogVariant[]): {
  min: number;
  max: number;
  currency: string;
} | null {
  if (variants.length === 0) return null;
  const prices = variants.map((v) => v.priceMinor);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    currency: variants[0].currency,
  };
}

export function formatPriceRange(variants: CatalogVariant[]): string {
  const range = getPriceRange(variants);
  if (!range) return "";
  if (range.min === range.max) {
    return formatPrice(range.min, range.currency);
  }
  return `${formatPrice(range.min, range.currency)} - ${formatPrice(range.max, range.currency)}`;
}

export async function fetchProducts(): Promise<CatalogProduct[]> {
  const apiUrl = import.meta.env.PUBLIC_API_URL;
  if (!apiUrl) {
    console.warn(
      "PUBLIC_API_URL not set — skipping product catalog generation"
    );
    return [];
  }

  try {
    const response = await fetch(`${apiUrl}/api/products`);
    if (!response.ok) {
      console.error(
        `Failed to fetch products: ${response.status} ${response.statusText}`
      );
      return [];
    }
    const data = (await response.json()) as { products: CatalogProduct[] };
    return data.products;
  } catch (error) {
    console.error("Failed to fetch products from API:", error);
    return [];
  }
}

export async function fetchProduct(
  slug: string
): Promise<CatalogProduct | null> {
  const apiUrl = import.meta.env.PUBLIC_API_URL;
  if (!apiUrl) return null;

  try {
    const response = await fetch(`${apiUrl}/api/products/${slug}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { product: CatalogProduct };
    return data.product;
  } catch {
    return null;
  }
}
