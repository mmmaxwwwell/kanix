export interface KitVariant {
  id: string;
  title: string;
  material: string;
  priceCents: number;
  inStock: boolean;
  quantityOnHand: number;
}

export interface KitProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  variants: KitVariant[];
}

export interface KitRequirement {
  productClassId: string;
  productClassName: string;
  quantity: number;
  products: KitProduct[];
}

export interface CatalogKit {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  requirements: KitRequirement[];
}

export function formatPrice(priceMinor: number, currency: string = "USD"): string {
  const amount = priceMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

export async function fetchKits(): Promise<CatalogKit[]> {
  const apiUrl = import.meta.env.PUBLIC_API_URL;
  if (!apiUrl) {
    console.warn("PUBLIC_API_URL not set — skipping kit catalog generation");
    return [];
  }

  try {
    const response = await fetch(`${apiUrl}/api/kits`);
    if (!response.ok) {
      console.error(`Failed to fetch kits: ${response.status} ${response.statusText}`);
      return [];
    }
    const data = (await response.json()) as { kits: CatalogKit[] };
    return data.kits;
  } catch (error) {
    console.error("Failed to fetch kits from API:", error);
    return [];
  }
}
