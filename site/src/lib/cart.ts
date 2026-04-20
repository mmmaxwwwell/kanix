/**
 * Client-side cart store using localStorage for cart_token persistence.
 * Communicates with the API using X-Cart-Token header.
 */

const CART_TOKEN_KEY = "kanix_cart_token";

export interface CartLineItem {
  id: string;
  variantId: string;
  sku: string;
  variantTitle: string;
  quantity: number;
  unitPriceMinor: number;
  currentPriceMinor: number;
  lineTotalMinor: number;
  available: number;
  inStock: boolean;
  priceChanged: boolean;
  insufficientStock: boolean;
}

export interface Cart {
  id: string;
  token: string;
  customerId: string | null;
  status: string;
  currency: string;
  items: CartLineItem[];
  subtotalMinor: number;
  itemCount: number;
}

function getApiUrl(): string {
  return import.meta.env.PUBLIC_API_URL || "";
}

export function getCartToken(): string | null {
  return localStorage.getItem(CART_TOKEN_KEY);
}

export function setCartToken(token: string): void {
  localStorage.setItem(CART_TOKEN_KEY, token);
}

export function clearCartToken(): void {
  localStorage.removeItem(CART_TOKEN_KEY);
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error("API URL not configured");

  const token = getCartToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["X-Cart-Token"] = token;
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error?.message || `API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

export async function createCart(): Promise<Cart> {
  const data = await apiRequest<{ cart: Cart }>("/api/cart", {
    method: "POST",
    body: JSON.stringify({}),
  });
  setCartToken(data.cart.token);
  return data.cart;
}

export async function getCart(): Promise<Cart | null> {
  const token = getCartToken();
  if (!token) return null;

  try {
    const data = await apiRequest<{ cart: Cart }>("/api/cart");
    return data.cart;
  } catch {
    return null;
  }
}

export async function addToCart(
  variantId: string,
  quantity: number = 1
): Promise<Cart> {
  let token = getCartToken();
  if (!token) {
    await createCart();
    token = getCartToken();
  }

  const data = await apiRequest<{ item: CartLineItem; cart: Cart }>(
    "/api/cart/items",
    {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, quantity }),
    }
  );
  return data.cart;
}

export async function removeFromCart(itemId: string): Promise<Cart> {
  const data = await apiRequest<{ cart: Cart }>(`/api/cart/items/${itemId}`, {
    method: "DELETE",
  });
  return data.cart;
}

export interface KitSelection {
  product_class_id: string;
  variant_id: string;
}

export interface AddKitToCartResult {
  kit: {
    cartLineId: string;
    kitDefinitionId: string;
    kitPriceMinor: number;
    individualTotalMinor: number;
    savingsMinor: number;
    selections: Array<{
      productClassId: string;
      variantId: string;
      variantTitle: string;
      individualPriceMinor: number;
    }>;
  };
  cart: Cart;
}

export async function addKitToCart(
  kitDefinitionId: string,
  selections: KitSelection[]
): Promise<AddKitToCartResult> {
  let token = getCartToken();
  if (!token) {
    await createCart();
    token = getCartToken();
  }

  return apiRequest<AddKitToCartResult>("/api/cart/kits", {
    method: "POST",
    body: JSON.stringify({
      kit_definition_id: kitDefinitionId,
      selections,
    }),
  });
}

export interface CheckoutRequest {
  cart_token: string;
  email: string;
  shipping_address: {
    full_name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

export interface CheckoutResponse {
  order: {
    id: string;
    order_number: string;
    email: string;
    status: string;
    payment_status: string;
    subtotal_minor: number;
    tax_minor: number;
    shipping_minor: number;
    total_minor: number;
  };
  client_secret: string;
}

export async function checkout(
  request: CheckoutRequest
): Promise<CheckoutResponse> {
  return apiRequest<CheckoutResponse>("/api/checkout", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function formatPrice(priceMinor: number, currency: string = "USD"): string {
  const amount = priceMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

/** Dispatch a custom event so other islands can react to cart changes */
export function emitCartUpdate(cart: Cart): void {
  window.dispatchEvent(
    new CustomEvent("kanix:cart-update", { detail: cart })
  );
}

/** US states for address validation */
export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

/** Validate US postal code format */
export function isValidUSPostalCode(code: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(code);
}
