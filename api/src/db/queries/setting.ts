import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { adminSetting } from "../schema/setting.js";

// ---------------------------------------------------------------------------
// Shipping settings types
// ---------------------------------------------------------------------------

export interface ShippingSettings {
  defaultCarrier: string;
  serviceLevels: string[];
  labelFormat: string;
  labelSize: string;
  requireSignature: boolean;
}

const SHIPPING_SETTINGS_KEY = "shipping";

const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = {
  defaultCarrier: "USPS",
  serviceLevels: ["Priority", "Express", "Ground"],
  labelFormat: "PDF",
  labelSize: "4x6",
  requireSignature: false,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getShippingSettings(db: PostgresJsDatabase): Promise<ShippingSettings> {
  const [row] = await db
    .select()
    .from(adminSetting)
    .where(eq(adminSetting.key, SHIPPING_SETTINGS_KEY));

  if (!row) {
    return { ...DEFAULT_SHIPPING_SETTINGS };
  }

  return row.valueJson as ShippingSettings;
}

export async function updateShippingSettings(
  db: PostgresJsDatabase,
  updates: Partial<ShippingSettings>,
): Promise<ShippingSettings> {
  const current = await getShippingSettings(db);
  const merged: ShippingSettings = { ...current, ...updates };

  await db
    .insert(adminSetting)
    .values({
      key: SHIPPING_SETTINGS_KEY,
      valueJson: merged,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: adminSetting.key,
      set: {
        valueJson: merged,
        updatedAt: new Date(),
      },
    });

  return merged;
}
