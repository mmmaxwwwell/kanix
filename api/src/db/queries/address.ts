import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { customerAddress } from "../schema/customer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewCustomerAddress {
  customerId: string;
  type: string;
  fullName: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  isDefault?: boolean;
}

export interface CustomerAddress {
  id: string;
  customerId: string;
  type: string;
  fullName: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Valid US state codes
// ---------------------------------------------------------------------------

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
  "PR",
  "VI",
  "GU",
  "AS",
  "MP",
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAddressFields(input: NewCustomerAddress): string | null {
  if (!input.fullName?.trim()) return "full_name is required";
  if (!input.line1?.trim()) return "line1 is required";
  if (!input.city?.trim()) return "city is required";
  if (!input.state?.trim()) return "state is required";
  if (!input.postalCode?.trim()) return "postal_code is required";

  const type = input.type;
  if (!type || !["shipping", "billing"].includes(type)) {
    return "type must be 'shipping' or 'billing'";
  }

  const country = input.country ?? "US";
  if (country !== "US") {
    return "Only US addresses are supported";
  }

  if (!US_STATE_CODES.has(input.state.toUpperCase())) {
    return `Invalid US state code: ${input.state}`;
  }

  // Validate US postal code format (5 digits or 5+4)
  if (!/^\d{5}(-\d{4})?$/.test(input.postalCode)) {
    return "Invalid US postal code format";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertAddress(
  db: PostgresJsDatabase,
  input: NewCustomerAddress,
): Promise<CustomerAddress> {
  // If this is set as default, unset any existing default of the same type
  if (input.isDefault) {
    await db
      .update(customerAddress)
      .set({ isDefault: false })
      .where(
        and(
          eq(customerAddress.customerId, input.customerId),
          eq(customerAddress.type, input.type),
          eq(customerAddress.isDefault, true),
        ),
      );
  }

  const [created] = await db
    .insert(customerAddress)
    .values({
      customerId: input.customerId,
      type: input.type,
      fullName: input.fullName,
      phone: input.phone ?? null,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      state: input.state.toUpperCase(),
      postalCode: input.postalCode,
      country: input.country ?? "US",
      isDefault: input.isDefault ?? false,
    })
    .returning();

  return created as CustomerAddress;
}

export async function findAddressesByCustomerId(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<CustomerAddress[]> {
  const rows = await db
    .select()
    .from(customerAddress)
    .where(eq(customerAddress.customerId, customerId))
    .orderBy(customerAddress.createdAt);
  return rows as CustomerAddress[];
}

export async function findAddressById(
  db: PostgresJsDatabase,
  id: string,
): Promise<CustomerAddress | undefined> {
  const [row] = await db.select().from(customerAddress).where(eq(customerAddress.id, id));
  return row as CustomerAddress | undefined;
}

export async function updateAddress(
  db: PostgresJsDatabase,
  id: string,
  customerId: string,
  updates: Partial<{
    type: string;
    fullName: string;
    phone: string | null;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    isDefault: boolean;
  }>,
): Promise<CustomerAddress | undefined> {
  // If setting as default, first get the address to know its type
  if (updates.isDefault) {
    const existing = await findAddressById(db, id);
    if (!existing || existing.customerId !== customerId) return undefined;

    const addrType = updates.type ?? existing.type;
    await db
      .update(customerAddress)
      .set({ isDefault: false })
      .where(
        and(
          eq(customerAddress.customerId, customerId),
          eq(customerAddress.type, addrType),
          eq(customerAddress.isDefault, true),
        ),
      );
  }

  const setData: Record<string, unknown> = {};
  if (updates.type !== undefined) setData.type = updates.type;
  if (updates.fullName !== undefined) setData.fullName = updates.fullName;
  if (updates.phone !== undefined) setData.phone = updates.phone;
  if (updates.line1 !== undefined) setData.line1 = updates.line1;
  if (updates.line2 !== undefined) setData.line2 = updates.line2;
  if (updates.city !== undefined) setData.city = updates.city;
  if (updates.state !== undefined) setData.state = updates.state.toUpperCase();
  if (updates.postalCode !== undefined) setData.postalCode = updates.postalCode;
  if (updates.isDefault !== undefined) setData.isDefault = updates.isDefault;

  if (Object.keys(setData).length === 0) return undefined;

  const [updated] = await db
    .update(customerAddress)
    .set(setData)
    .where(and(eq(customerAddress.id, id), eq(customerAddress.customerId, customerId)))
    .returning();

  return updated as CustomerAddress | undefined;
}

export async function deleteAddress(
  db: PostgresJsDatabase,
  id: string,
  customerId: string,
): Promise<boolean> {
  const result = await db
    .delete(customerAddress)
    .where(and(eq(customerAddress.id, id), eq(customerAddress.customerId, customerId)))
    .returning();
  return result.length > 0;
}
