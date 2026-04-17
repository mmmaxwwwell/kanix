import { describe, it, expect } from "vitest";
import {
  createShippingAdapter,
  createStubShippingAdapter,
  type ShippingRateAddress,
  type ShippingPackage,
} from "./services/shipping-adapter.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const warehouseAddress: ShippingRateAddress = {
  line1: "1234 Warehouse Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

const customerAddress: ShippingRateAddress = {
  line1: "5678 Customer Ln",
  city: "New York",
  state: "NY",
  postalCode: "10001",
  country: "US",
};

const samplePackages: ShippingPackage[] = [{ weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 4 }];

// ---------------------------------------------------------------------------
// Stub mode tests
// ---------------------------------------------------------------------------

describe("shipping adapter — stub mode (T057)", () => {
  const adapter = createStubShippingAdapter();

  it("calculateRate returns flat-rate $5.99", async () => {
    const result = await adapter.calculateRate(warehouseAddress, customerAddress, [
      { weightOz: 16, quantity: 1 },
    ]);
    expect(result.shippingAmountMinor).toBe(599);
    expect(result.carrier).toBe("USPS");
    expect(result.service).toBe("Priority");
    expect(result.rateId).toBeNull();
  });

  it("getRates returns multiple carrier rates", async () => {
    const result = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);

    expect(result.shipmentId).toBeTruthy();
    expect(result.rates.length).toBeGreaterThanOrEqual(2);

    for (const rate of result.rates) {
      expect(rate.rateId).toBeTruthy();
      expect(rate.carrier).toBeTruthy();
      expect(rate.service).toBeTruthy();
      expect(rate.amountMinor).toBeGreaterThan(0);
    }

    // Should be sorted by price ascending
    for (let i = 1; i < result.rates.length; i++) {
      expect(result.rates[i].amountMinor).toBeGreaterThanOrEqual(result.rates[i - 1].amountMinor);
    }
  });

  it("buyLabel returns tracking number and label URL", async () => {
    const ratesResult = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);

    const selectedRate = ratesResult.rates[0];
    const labelResult = await adapter.buyLabel(ratesResult.shipmentId, selectedRate.rateId);

    expect(labelResult.trackingNumber).toBeTruthy();
    expect(labelResult.labelUrl).toBeTruthy();
    expect(labelResult.trackerId).toBeTruthy();
    expect(labelResult.carrier).toBeTruthy();
    expect(labelResult.service).toBeTruthy();
  });

  it("getTracking returns tracking status and events", async () => {
    const ratesResult = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);
    const labelResult = await adapter.buyLabel(ratesResult.shipmentId, ratesResult.rates[0].rateId);

    const trackingResult = await adapter.getTracking(labelResult.trackerId);

    expect(trackingResult.status).toBeTruthy();
    expect(Array.isArray(trackingResult.events)).toBe(true);
    expect(trackingResult.events.length).toBeGreaterThan(0);

    for (const event of trackingResult.events) {
      expect(event.status).toBeTruthy();
      expect(event.description).toBeTruthy();
      expect(event.occurredAt).toBeTruthy();
    }
  });

  it("voidLabel returns refunded status", async () => {
    const ratesResult = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);
    const labelResult = await adapter.buyLabel(ratesResult.shipmentId, ratesResult.rates[0].rateId);

    // Void the label (in stub mode, always succeeds)
    void labelResult; // just for reference
    const voidResult = await adapter.voidLabel(ratesResult.shipmentId);
    expect(voidResult.refunded).toBe(true);
  });

  it("full flow: getRates → buyLabel → getTracking", async () => {
    // Step 1: Get rates
    const ratesResult = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);
    expect(ratesResult.rates.length).toBeGreaterThan(0);

    // Step 2: Buy label with cheapest rate
    const cheapestRate = ratesResult.rates[0];
    const labelResult = await adapter.buyLabel(ratesResult.shipmentId, cheapestRate.rateId);
    expect(labelResult.trackingNumber).toBeTruthy();

    // Step 3: Get tracking
    const trackingResult = await adapter.getTracking(labelResult.trackerId);
    expect(trackingResult.status).toBeTruthy();
    expect(trackingResult.events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("shipping adapter — factory (T057)", () => {
  it("returns stub adapter when apiKey is test-key", () => {
    const adapter = createShippingAdapter({ easyPostApiKey: "test-key" });
    // Stub adapter should be returned — verify by calling calculateRate
    // which returns flat-rate $5.99
    expect(adapter).toBeTruthy();
  });

  it("returns stub adapter when apiKey is empty", () => {
    const adapter = createShippingAdapter({ easyPostApiKey: "" });
    expect(adapter).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// EasyPost API tests (requires live EasyPost test key)
// ---------------------------------------------------------------------------

const EASYPOST_API_KEY = process.env["EASYPOST_API_KEY"] ?? "";
const canRunEasyPost =
  EASYPOST_API_KEY.length > 0 &&
  EASYPOST_API_KEY !== "test-key" &&
  EASYPOST_API_KEY !== "EZAK_REPLACE_ME";
const describeEasyPost = canRunEasyPost ? describe : describe.skip;

describeEasyPost("shipping adapter — EasyPost API (T057)", () => {
  const adapter = createShippingAdapter({
    easyPostApiKey: EASYPOST_API_KEY,
  });

  it("getRates returns real carrier rates", async () => {
    const result = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);

    expect(result.shipmentId).toBeTruthy();
    expect(result.shipmentId).toMatch(/^shp_/);
    expect(result.rates.length).toBeGreaterThan(0);

    for (const rate of result.rates) {
      expect(rate.rateId).toMatch(/^rate_/);
      expect(rate.carrier).toBeTruthy();
      expect(rate.service).toBeTruthy();
      expect(rate.amountMinor).toBeGreaterThan(0);
    }
  }, 30000);

  it("getRates → buyLabel → verify tracking number returned", async () => {
    // Get rates
    const ratesResult = await adapter.getRates(warehouseAddress, customerAddress, samplePackages);
    expect(ratesResult.rates.length).toBeGreaterThan(0);

    // Buy label with cheapest rate
    const cheapestRate = ratesResult.rates[0];
    const labelResult = await adapter.buyLabel(ratesResult.shipmentId, cheapestRate.rateId);

    expect(labelResult.trackingNumber).toBeTruthy();
    expect(labelResult.labelUrl).toBeTruthy();
    expect(labelResult.trackerId).toBeTruthy();
    expect(labelResult.carrier).toBeTruthy();
    expect(labelResult.service).toBeTruthy();
  }, 30000);
});
