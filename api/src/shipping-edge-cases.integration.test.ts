import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
} from "./db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { cartLine } from "./db/schema/cart.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
} from "./db/schema/fulfillment.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import {
  createShipment,
  buyShipmentLabel,
  transitionShipmentStatus,
  voidShipmentLabel,
  findShipmentById,
  handleTrackingUpdate,
  storeShipmentEvent,
} from "./db/queries/shipment.js";
import {
  createStubShippingAdapter,
  type ShippingAdapter,
} from "./services/shipping-adapter.js";
import { createAdminAlertService } from "./services/admin-alert.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createZeroTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_ship_edge_${piCounter}_${Date.now()}`,
        clientSecret: `pi_ship_edge_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_ship_edge_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ADDRESS = {
  full_name: "Shipping Edge Test",
  line1: "456 Oak Ave",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

async function createCartWithItem(
  app: FastifyInstance,
  variantId: string,
  quantity = 1,
): Promise<string> {
  const cartRes = await app.inject({
    method: "POST",
    url: "/api/cart",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const cartData = JSON.parse(cartRes.body);
  const token = cartData.cart.token as string;
  await app.inject({
    method: "POST",
    url: "/api/cart/items",
    headers: { "content-type": "application/json", "x-cart-token": token },
    body: JSON.stringify({ variant_id: variantId, quantity }),
  });
  return token;
}

function checkoutBody(
  cartToken: string,
  addressOverrides: Record<string, unknown> = {},
) {
  return {
    cart_token: cartToken,
    email: "ship-edge@example.com",
    shipping_address: { ...VALID_ADDRESS, ...addressOverrides },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shipping edge cases (T234 — T066d)", () => {
  // =========================================================================
  // Section A: HTTP-level address + rate edge cases via checkout endpoint
  // =========================================================================

  describe("checkout address + rate validation", () => {
    let ts_: TestServer;
    let app: FastifyInstance;
    let dbConn: DatabaseConnection;

    const ts = Date.now();
    let variantId = "";
    let locationId = "";

    // Will hold a fresh cart token per test that needs one
    async function freshCart(): Promise<string> {
      return createCartWithItem(app, variantId);
    }

    beforeAll(async () => {
      ts_ = await createTestServer({
        skipListen: true,
        serverOverrides: {
          taxAdapter: createZeroTaxAdapter(),
          shippingAdapter: createStubShippingAdapter(),
          paymentAdapter: createStubPaymentAdapter(),
        },
      });
      app = ts_.app;
      dbConn = ts_.dbConn;
      const db = dbConn.db;

      // Seed product + variant
      const [prod] = await db
        .insert(product)
        .values({
          slug: `ship-edge-prod-${ts}`,
          title: `Ship Edge Product ${ts}`,
          status: "active",
        })
        .returning();

      const [v] = await db
        .insert(productVariant)
        .values({
          productId: prod.id,
          sku: `SHIP-EDGE-${ts}`,
          title: `Ship Edge Variant ${ts}`,
          priceMinor: 2500,
          status: "active",
          weight: "16",
        })
        .returning();
      variantId = v.id;

      // Inventory
      const existingBalances = await db.select().from(inventoryBalance);
      if (existingBalances.length > 0) {
        locationId = existingBalances[0].locationId;
      } else {
        const existingLocs = await db.select().from(inventoryLocation);
        if (existingLocs.length > 0) {
          locationId = existingLocs[0].id;
        } else {
          const [loc] = await db
            .insert(inventoryLocation)
            .values({
              name: `Ship Edge WH ${ts}`,
              code: `SE-WH-${ts}`,
              type: "warehouse",
            })
            .returning();
          locationId = loc.id;
        }
      }

      await db.insert(inventoryBalance).values({
        variantId,
        locationId,
        onHand: 100,
        reserved: 0,
        available: 100,
      });
    });

    afterAll(async () => {
      await stopTestServer(ts_);
    });

    // --- Missing address fields -----------------------------------------

    it("returns 400 ERR_VALIDATION when full_name is missing", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { full_name: "" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("full_name");
    });

    it("returns 400 ERR_VALIDATION when line1 is missing", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { line1: "" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("line1");
    });

    it("returns 400 ERR_VALIDATION when city is missing", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { city: "" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("city");
    });

    it("returns 400 ERR_VALIDATION when state is missing", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { state: "" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("state");
    });

    it("returns 400 ERR_VALIDATION when postal_code is missing", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { postal_code: "" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("postal_code");
    });

    // --- International address rejection --------------------------------

    it("rejects non-US country with ERR_NON_US_ADDRESS", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { country: "CA" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_NON_US_ADDRESS");
      expect(body.message).toContain("US");
    });

    it("rejects international country codes (GB, DE, JP)", async () => {
      for (const country of ["GB", "DE", "JP"]) {
        const token = await freshCart();
        const res = await app.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checkoutBody(token, { country })),
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_NON_US_ADDRESS");
      }
    });

    // --- PO Box rejection -----------------------------------------------

    it("rejects PO Box in line1", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { line1: "PO Box 123" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_PO_BOX_NOT_ALLOWED");
      expect(body.message).toContain("PO Box");
      expect(body.message).toContain("physical street address");
    });

    it("rejects P.O. Box variations in line1", async () => {
      const variations = ["P.O. Box 456", "P O Box 789", "P.O.Box 101"];
      for (const line1 of variations) {
        const token = await freshCart();
        const res = await app.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checkoutBody(token, { line1 })),
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_PO_BOX_NOT_ALLOWED");
      }
    });

    it("rejects Post Office Box in line1", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkoutBody(token, { line1: "Post Office Box 55" }),
        ),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_PO_BOX_NOT_ALLOWED");
    });

    it("rejects PO Box in line2", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkoutBody(token, {
            line1: "100 Main St",
            line2: "PO Box 200",
          }),
        ),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_PO_BOX_NOT_ALLOWED");
    });

    // --- Invalid postal code format -------------------------------------

    it("rejects malformed postal code", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { postal_code: "ABCDE" })),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain("postal code");
    });

    it("accepts valid 5+4 postal code", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkoutBody(token, { postal_code: "78701-1234" }),
        ),
      });
      // Should pass validation (may fail later for other reasons, but NOT 400 for postal code)
      if (res.statusCode === 400) {
        const body = JSON.parse(res.body);
        expect(body.message).not.toContain("postal code");
      }
    });

    // --- State code normalization ---------------------------------------

    it("normalizes lowercase state code to uppercase", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { state: "tx" })),
      });
      // Should not fail on state validation — normalization converts "tx" → "TX"
      if (res.statusCode === 400) {
        const body = JSON.parse(res.body);
        expect(body.message).not.toContain("state");
      }
    });

    it("normalizes mixed-case state code", async () => {
      const token = await freshCart();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(token, { state: "Ny" })),
      });
      // Should not reject for state normalization issues
      if (res.statusCode === 400) {
        const body = JSON.parse(res.body);
        expect(body.message).not.toContain("state");
      }
    });

    // --- No-rates-available path ----------------------------------------

    it("returns 400 ERR_NO_SHIPPING_RATES when adapter has no rates", async () => {
      const noRateAdapter: ShippingAdapter = {
        ...createStubShippingAdapter(),
        async calculateRate(): Promise<never> {
          throw Object.assign(new Error("No shipping rates available"), {
            code: "ERR_NO_SHIPPING_RATES",
          });
        },
      };

      // Need a separate server with the failing adapter
      const noRateServer = await createTestServer({
        skipListen: true,
        serverOverrides: {
          taxAdapter: createZeroTaxAdapter(),
          shippingAdapter: noRateAdapter,
          paymentAdapter: createStubPaymentAdapter(),
        },
      });

      try {
        const noRateApp = noRateServer.app;

        // Seed a variant with inventory for this server's DB connection
        const db = noRateServer.dbConn.db;
        const [prod2] = await db
          .insert(product)
          .values({
            slug: `no-rate-prod-${ts}`,
            title: `No Rate Product ${ts}`,
            status: "active",
          })
          .returning();
        const [v2] = await db
          .insert(productVariant)
          .values({
            productId: prod2.id,
            sku: `NO-RATE-${ts}`,
            title: `No Rate Variant ${ts}`,
            priceMinor: 1500,
            status: "active",
            weight: "8",
          })
          .returning();

        // Reuse the existing location from the shared DB
        const balances = await db.select().from(inventoryBalance);
        const locId = balances[0]?.locationId ?? locationId;
        await db.insert(inventoryBalance).values({
          variantId: v2.id,
          locationId: locId,
          onHand: 50,
          reserved: 0,
          available: 50,
        });

        const token = await createCartWithItem(noRateApp, v2.id);
        const res = await noRateApp.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checkoutBody(token)),
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_NO_SHIPPING_RATES");
        expect(body.message).toContain("No shipping rates");

        // No variant/product cleanup — checkout creates orders + movements
        // referencing the variant, which makes FK-safe deletion impractical.
        // Test data uses unique timestamps so collisions are impossible.
      } finally {
        await stopTestServer(noRateServer);
      }
    });
  });

  // =========================================================================
  // Section B: Address validation (query-level) via validateAddressFields
  // =========================================================================

  describe("validateAddressFields", () => {
    // Import is at the module level
    let validateAddressFields: typeof import("./db/queries/address.js").validateAddressFields;

    beforeAll(async () => {
      const mod = await import("./db/queries/address.js");
      validateAddressFields = mod.validateAddressFields;
    });

    it("returns null for a valid US address", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Jane Doe",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      });
      expect(result).toBeNull();
    });

    it("rejects missing full_name", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
      });
      expect(result).toBe("full_name is required");
    });

    it("rejects missing line1", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
      });
      expect(result).toBe("line1 is required");
    });

    it("rejects missing city", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "",
        state: "TX",
        postalCode: "78701",
      });
      expect(result).toBe("city is required");
    });

    it("rejects missing state", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "",
        postalCode: "78701",
      });
      expect(result).toBe("state is required");
    });

    it("rejects missing postal_code", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "",
      });
      expect(result).toBe("postal_code is required");
    });

    it("rejects non-US country", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Maple Rd",
        city: "Toronto",
        state: "ON",
        postalCode: "M5V3L9",
        country: "CA",
      });
      expect(result).toBe("Only US addresses are supported");
    });

    it("rejects invalid state code", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Fakeville",
        state: "ZZ",
        postalCode: "78701",
      });
      expect(result).toContain("Invalid US state code");
      expect(result).toContain("ZZ");
    });

    it("accepts lowercase state code (case-insensitive match)", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "tx",
        postalCode: "78701",
      });
      expect(result).toBeNull();
    });

    it("rejects invalid postal code format", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "7870",
      });
      expect(result).toBe("Invalid US postal code format");
    });

    it("accepts 5+4 postal code format", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "shipping",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701-1234",
      });
      expect(result).toBeNull();
    });

    it("rejects invalid address type", () => {
      const result = validateAddressFields({
        customerId: "00000000-0000-0000-0000-000000000001",
        type: "pickup",
        fullName: "Test",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
      });
      expect(result).toBe("type must be 'shipping' or 'billing'");
    });
  });

  // =========================================================================
  // Section C: Shipment-level edge cases (DB layer — existing tests, hardened)
  // =========================================================================

  describe("shipment-level edge cases", () => {
    let dbConn: DatabaseConnection;
    const ts = Date.now();
    let testOrderId = "";
    let testOrderLineId = "";
    let shipTestVariantId = "";
    let shipTestProductId = "";
    const createdShipmentIds: string[] = [];

    beforeAll(async () => {
      const { createDatabaseConnection } = await import("./db/connection.js");
      const { requireDatabaseUrl } = await import("./test-helpers.js");
      dbConn = createDatabaseConnection(requireDatabaseUrl());
      const db = dbConn.db;

      // Create a real product + variant (order_line FK requires it)
      const [prod] = await db
        .insert(product)
        .values({
          slug: `ship-edge-ol-${ts}`,
          title: `Ship Edge OL Product ${ts}`,
          status: "active",
        })
        .returning();
      shipTestProductId = prod.id;

      const [v] = await db
        .insert(productVariant)
        .values({
          productId: prod.id,
          sku: `SHIP-OL-${ts}`,
          title: `Ship Edge OL Variant ${ts}`,
          priceMinor: 5000,
          status: "active",
          weight: "16",
        })
        .returning();
      shipTestVariantId = v.id;

      const [newOrder] = await db
        .insert(order)
        .values({
          orderNumber: `KNX-T234-${ts}`,
          email: `t234-${ts}@test.kanix.dev`,
          status: "confirmed",
          paymentStatus: "paid",
          fulfillmentStatus: "queued",
          shippingStatus: "not_shipped",
          subtotalMinor: 5000,
          taxMinor: 250,
          shippingMinor: 599,
          totalMinor: 5849,
          placedAt: new Date(),
        })
        .returning();
      testOrderId = newOrder.id;

      const [line] = await db
        .insert(orderLine)
        .values({
          orderId: testOrderId,
          variantId: shipTestVariantId,
          skuSnapshot: "KNX-EDGE-234",
          titleSnapshot: "Test Edge Case Part T234",
          quantity: 1,
          unitPriceMinor: 5000,
          totalMinor: 5000,
        })
        .returning();
      testOrderLineId = line.id;
    });

    afterAll(async () => {
      if (dbConn) {
        const db = dbConn.db;
        // Disable immutability triggers to allow evidence_record cleanup
        await db.execute(
          sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`,
        );
        try {
          for (const sid of createdShipmentIds) {
            await db
              .delete(evidenceRecord)
              .where(eq(evidenceRecord.shipmentId, sid));
            await db
              .delete(shipmentEvent)
              .where(eq(shipmentEvent.shipmentId, sid));
            await db
              .delete(shippingLabelPurchase)
              .where(eq(shippingLabelPurchase.shipmentId, sid));
            await db
              .delete(shipmentLine)
              .where(eq(shipmentLine.shipmentId, sid));
            await db
              .delete(shipmentPackage)
              .where(eq(shipmentPackage.shipmentId, sid));
            await db.delete(shipment).where(eq(shipment.id, sid));
          }
          if (testOrderId) {
            await db
              .delete(evidenceRecord)
              .where(eq(evidenceRecord.orderId, testOrderId));
            await db
              .delete(orderStatusHistory)
              .where(eq(orderStatusHistory.orderId, testOrderId));
            await db
              .delete(orderLine)
              .where(eq(orderLine.orderId, testOrderId));
            await db.delete(order).where(eq(order.id, testOrderId));
          }
        } finally {
          await db.execute(
            sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`,
          );
        }
        await dbConn.close();
      }
    });

    // --- FR-E025: Label purchase failure --------------------------------

    describe("label purchase failure (FR-E025)", () => {
      it("returns ERR_LABEL_PURCHASE_FAILED and keeps shipment in label_pending", async () => {
        const db = dbConn.db;

        const failingAdapter: ShippingAdapter = {
          ...createStubShippingAdapter(),
          async buyLabel(): Promise<never> {
            throw new Error(
              "EasyPost API error: address verification failed",
            );
          },
        };

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 10 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        await expect(
          buyShipmentLabel(
            db,
            {
              shipmentId: created.id,
              providerShipmentId: "shp_fail_t234",
              rateId: "rate_fail_t234",
            },
            failingAdapter,
          ),
        ).rejects.toMatchObject({
          code: "ERR_LABEL_PURCHASE_FAILED",
          message: "EasyPost API error: address verification failed",
          shipmentStatus: "label_pending",
        });

        const after = await findShipmentById(db, created.id);
        expect(after).not.toBeNull();
        expect(after!.status).toBe("label_pending");
      });

      it("keeps shipment in label_pending when rate expired", async () => {
        const db = dbConn.db;

        const failingAdapter: ShippingAdapter = {
          ...createStubShippingAdapter(),
          async buyLabel(): Promise<never> {
            throw new Error("Rate expired");
          },
        };

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 10 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        await transitionShipmentStatus(db, created.id, "label_pending");

        await expect(
          buyShipmentLabel(
            db,
            {
              shipmentId: created.id,
              providerShipmentId: "shp_expired_t234",
              rateId: "rate_expired_t234",
            },
            failingAdapter,
          ),
        ).rejects.toMatchObject({
          code: "ERR_LABEL_PURCHASE_FAILED",
          shipmentStatus: "label_pending",
        });

        const after = await findShipmentById(db, created.id);
        expect(after!.status).toBe("label_pending");
      });
    });

    // --- FR-E026: Delivery exception + recovery -------------------------

    describe("delivery exception alert (FR-E026)", () => {
      it("fires admin alert on delivery_exception event", async () => {
        const db = dbConn.db;
        const adapter = createStubShippingAdapter();
        const alertService = createAdminAlertService();

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 14 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        await buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: `shp_exc_t234_${ts}`,
            rateId: `rate_exc_t234_${ts}`,
          },
          adapter,
        );
        await transitionShipmentStatus(db, created.id, "ready");
        await transitionShipmentStatus(db, created.id, "shipped");
        await transitionShipmentStatus(db, created.id, "in_transit");

        const shipmentRecord = await findShipmentById(db, created.id);
        expect(shipmentRecord).not.toBeNull();
        expect(shipmentRecord!.status).toBe("in_transit");

        await storeShipmentEvent(db, {
          shipmentId: created.id,
          providerEventId: `exc-event-t234-${ts}`,
          status: "failure",
          description: "Package damaged in transit",
          occurredAt: new Date(),
          rawPayloadJson: { status: "failure" },
        });

        const result = await handleTrackingUpdate(
          db,
          shipmentRecord!,
          "failure",
          alertService,
        );
        expect(result.shipmentTransitioned).toBe(true);

        const afterException = await findShipmentById(db, created.id);
        expect(afterException!.status).toBe("exception");

        const alerts = alertService.getAlerts();
        expect(alerts.length).toBeGreaterThanOrEqual(1);

        const exceptionAlert = alerts.find(
          (a) => a.type === "delivery_exception",
        );
        expect(exceptionAlert).toBeDefined();
        expect(exceptionAlert!.orderId).toBe(testOrderId);
        expect(exceptionAlert!.message).toContain("Delivery exception");
        expect(exceptionAlert!.details).toHaveProperty(
          "shipmentId",
          created.id,
        );
        expect(exceptionAlert!.details).toHaveProperty(
          "easypostStatus",
          "failure",
        );
      });

      it("supports exception → in_transit recovery transition", async () => {
        const db = dbConn.db;
        const adapter = createStubShippingAdapter();
        const alertService = createAdminAlertService();

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 11 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        await buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: `shp_rcvr_t234_${ts}`,
            rateId: `rate_rcvr_t234_${ts}`,
          },
          adapter,
        );
        await transitionShipmentStatus(db, created.id, "ready");
        await transitionShipmentStatus(db, created.id, "shipped");
        await transitionShipmentStatus(db, created.id, "in_transit");
        await transitionShipmentStatus(db, created.id, "exception");

        const inException = await findShipmentById(db, created.id);
        expect(inException!.status).toBe("exception");

        const result = await handleTrackingUpdate(
          db,
          inException!,
          "in_transit",
          alertService,
        );
        expect(result.shipmentTransitioned).toBe(true);

        const recovered = await findShipmentById(db, created.id);
        expect(recovered!.status).toBe("in_transit");

        const alerts = alertService.getAlerts();
        const exceptionAlerts = alerts.filter(
          (a) => a.type === "delivery_exception",
        );
        expect(exceptionAlerts.length).toBe(0);
      });
    });

    // --- FR-E027: Void-label cost credit --------------------------------

    describe("void-label cost credit (FR-E027)", () => {
      it("credits label cost when voiding a purchased label", async () => {
        const db = dbConn.db;
        const adapter = createStubShippingAdapter();

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 9 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        const buyResult = await buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: `shp_credit_t234_${ts}`,
            rateId: `rate_credit_t234_${ts}`,
          },
          adapter,
        );
        expect(buyResult.purchase.costMinor).toBe(599);

        const result = await voidShipmentLabel(db, created.id, adapter);

        expect(result.shipment.status).toBe("voided");
        expect(result.refunded).toBe(true);
        expect(result.refundedCostMinor).toBe(599);
        expect(result.labelCostCredited).toBe(true);
      });

      it("does not credit when voiding a draft (no label purchased)", async () => {
        const db = dbConn.db;
        const adapter = createStubShippingAdapter();

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 7 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        const result = await voidShipmentLabel(db, created.id, adapter);

        expect(result.shipment.status).toBe("voided");
        expect(result.refunded).toBe(false);
        expect(result.refundedCostMinor).toBeNull();
        expect(result.labelCostCredited).toBe(false);
      });

      it("credits label cost when voiding from ready state", async () => {
        const db = dbConn.db;
        const adapter = createStubShippingAdapter();

        const { shipment: created } = await createShipment(db, {
          orderId: testOrderId,
          packages: [{ weight: 13 }],
          lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
        });
        createdShipmentIds.push(created.id);

        await buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: `shp_rdycr_t234_${ts}`,
            rateId: `rate_rdycr_t234_${ts}`,
          },
          adapter,
        );
        await transitionShipmentStatus(db, created.id, "ready");

        const result = await voidShipmentLabel(db, created.id, adapter);

        expect(result.shipment.status).toBe("voided");
        expect(result.refunded).toBe(true);
        expect(result.refundedCostMinor).toBe(599);
        expect(result.labelCostCredited).toBe(true);
      });
    });
  });
});
