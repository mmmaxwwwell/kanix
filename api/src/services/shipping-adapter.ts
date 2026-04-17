// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShippingRateAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface ShippingRateItem {
  /** Weight in ounces. */
  weightOz: number;
  quantity: number;
}

export interface ShippingRateResult {
  /** Shipping cost in minor units (cents). */
  shippingAmountMinor: number;
  /** Carrier name (e.g. "USPS"). */
  carrier: string;
  /** Service level (e.g. "Priority"). */
  service: string;
  /** EasyPost rate ID for label purchase. Null in stub mode. */
  rateId: string | null;
}

export interface ShippingPackage {
  /** Weight in ounces. */
  weightOz: number;
  /** Length in inches. */
  lengthIn?: number;
  /** Width in inches. */
  widthIn?: number;
  /** Height in inches. */
  heightIn?: number;
}

export interface CarrierRate {
  /** EasyPost rate ID. */
  rateId: string;
  /** Carrier name (e.g. "USPS", "UPS", "FedEx"). */
  carrier: string;
  /** Service level (e.g. "Priority", "Ground"). */
  service: string;
  /** Rate in minor units (cents). */
  amountMinor: number;
  /** Estimated delivery days (if available). */
  estimatedDays: number | null;
}

export interface GetRatesResult {
  /** EasyPost shipment ID (needed for buyLabel). */
  shipmentId: string;
  /** Available carrier rates sorted by price ascending. */
  rates: CarrierRate[];
}

export interface BuyLabelResult {
  /** Tracking number assigned by the carrier. */
  trackingNumber: string;
  /** URL to download the shipping label. */
  labelUrl: string;
  /** EasyPost tracker ID for tracking updates. */
  trackerId: string;
  /** Carrier name. */
  carrier: string;
  /** Service level. */
  service: string;
}

export interface TrackingEvent {
  /** Event status (e.g. "in_transit", "delivered"). */
  status: string;
  /** Human-readable description. */
  description: string;
  /** When the event occurred. */
  occurredAt: string;
  /** City where the event occurred (if available). */
  city: string | null;
  /** State where the event occurred (if available). */
  state: string | null;
}

export interface TrackingResult {
  /** Current tracking status. */
  status: string;
  /** Estimated delivery date (if available). */
  estimatedDeliveryDate: string | null;
  /** Tracking events in chronological order. */
  events: TrackingEvent[];
}

export interface ShippingAdapter {
  /**
   * Calculate the cheapest shipping rate for the given items and destination.
   */
  calculateRate(
    fromAddress: ShippingRateAddress,
    toAddress: ShippingRateAddress,
    items: ShippingRateItem[],
  ): Promise<ShippingRateResult>;

  /**
   * Get all available carrier rates for the given shipment.
   */
  getRates(
    fromAddress: ShippingRateAddress,
    toAddress: ShippingRateAddress,
    packages: ShippingPackage[],
  ): Promise<GetRatesResult>;

  /**
   * Purchase a shipping label for the given rate.
   */
  buyLabel(shipmentId: string, rateId: string): Promise<BuyLabelResult>;

  /**
   * Get current tracking status and events for a tracker.
   */
  getTracking(trackerId: string): Promise<TrackingResult>;

  /**
   * Void (refund) a shipping label. Only valid before the carrier picks up.
   */
  voidLabel(shipmentId: string): Promise<{ refunded: boolean }>;
}

// ---------------------------------------------------------------------------
// Stub adapter (returns flat-rate shipping)
// ---------------------------------------------------------------------------

let stubCounter = 0;

export function createStubShippingAdapter(): ShippingAdapter {
  return {
    async calculateRate(): Promise<ShippingRateResult> {
      return {
        shippingAmountMinor: 599,
        carrier: "USPS",
        service: "Priority",
        rateId: null,
      };
    },

    async getRates(): Promise<GetRatesResult> {
      stubCounter++;
      const shipmentId = `shp_stub_${stubCounter}_${Date.now()}`;
      return {
        shipmentId,
        rates: [
          {
            rateId: `rate_stub_priority_${stubCounter}`,
            carrier: "USPS",
            service: "Priority",
            amountMinor: 599,
            estimatedDays: 3,
          },
          {
            rateId: `rate_stub_express_${stubCounter}`,
            carrier: "USPS",
            service: "Express",
            amountMinor: 1299,
            estimatedDays: 1,
          },
        ],
      };
    },

    async buyLabel(): Promise<BuyLabelResult> {
      stubCounter++;
      return {
        trackingNumber: `STUB${stubCounter}${Date.now()}`,
        labelUrl: `https://stub-labels.example.com/label_${stubCounter}.png`,
        trackerId: `trk_stub_${stubCounter}_${Date.now()}`,
        carrier: "USPS",
        service: "Priority",
      };
    },

    async getTracking(): Promise<TrackingResult> {
      return {
        status: "in_transit",
        estimatedDeliveryDate: null,
        events: [
          {
            status: "in_transit",
            description: "Package in transit",
            occurredAt: new Date().toISOString(),
            city: "Austin",
            state: "TX",
          },
        ],
      };
    },

    async voidLabel(): Promise<{ refunded: boolean }> {
      return { refunded: true };
    },
  };
}

// ---------------------------------------------------------------------------
// EasyPost adapter (uses dynamic import since @easypost/api may not be installed)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function toEasyPostAddress(addr: ShippingRateAddress) {
  return {
    street1: addr.line1,
    street2: addr.line2 ?? "",
    city: addr.city,
    state: addr.state,
    zip: addr.postalCode,
    country: addr.country,
  };
}

async function getEasyPostClient(apiKey: string): Promise<any> {
  const mod = await import(/* webpackIgnore: true */ "@easypost/api" as string);
  const EasyPost = mod.default;
  return new EasyPost(apiKey);
}

function createEasyPostShippingAdapter(apiKey: string): ShippingAdapter {
  return {
    async calculateRate(
      fromAddress: ShippingRateAddress,
      toAddress: ShippingRateAddress,
      items: ShippingRateItem[],
    ): Promise<ShippingRateResult> {
      const client = await getEasyPostClient(apiKey);

      const totalWeightOz = items.reduce((sum, item) => sum + item.weightOz * item.quantity, 0);

      const shipment = await client.Shipment.create({
        from_address: toEasyPostAddress(fromAddress),
        to_address: toEasyPostAddress(toAddress),
        parcel: {
          weight: totalWeightOz,
        },
      });

      if (!shipment.rates || shipment.rates.length === 0) {
        throw Object.assign(new Error("No shipping rates available"), {
          code: "ERR_NO_SHIPPING_RATES",
        });
      }

      const sorted = [...shipment.rates].sort(
        (a: any, b: any) => parseFloat(a.rate) - parseFloat(b.rate),
      );
      const cheapest = sorted[0];

      return {
        shippingAmountMinor: Math.round(parseFloat(cheapest.rate) * 100),
        carrier: cheapest.carrier,
        service: cheapest.service,
        rateId: cheapest.id,
      };
    },

    async getRates(
      fromAddress: ShippingRateAddress,
      toAddress: ShippingRateAddress,
      packages: ShippingPackage[],
    ): Promise<GetRatesResult> {
      const client = await getEasyPostClient(apiKey);

      // Use the first package for parcel dimensions (EasyPost supports one parcel per shipment)
      const totalWeightOz = packages.reduce((sum, pkg) => sum + pkg.weightOz, 0);
      const firstPkg = packages[0];

      const parcel: Record<string, number> = {
        weight: totalWeightOz,
      };
      if (firstPkg?.lengthIn) parcel.length = firstPkg.lengthIn;
      if (firstPkg?.widthIn) parcel.width = firstPkg.widthIn;
      if (firstPkg?.heightIn) parcel.height = firstPkg.heightIn;

      const shipment = await client.Shipment.create({
        from_address: toEasyPostAddress(fromAddress),
        to_address: toEasyPostAddress(toAddress),
        parcel,
      });

      if (!shipment.rates || shipment.rates.length === 0) {
        throw Object.assign(new Error("No shipping rates available"), {
          code: "ERR_NO_SHIPPING_RATES",
        });
      }

      const rates: CarrierRate[] = [...shipment.rates]
        .sort((a: any, b: any) => parseFloat(a.rate) - parseFloat(b.rate))
        .map((r: any) => ({
          rateId: r.id,
          carrier: r.carrier,
          service: r.service,
          amountMinor: Math.round(parseFloat(r.rate) * 100),
          estimatedDays: r.est_delivery_days ? Number(r.est_delivery_days) : null,
        }));

      return {
        shipmentId: shipment.id,
        rates,
      };
    },

    async buyLabel(shipmentId: string, rateId: string): Promise<BuyLabelResult> {
      const client = await getEasyPostClient(apiKey);

      const shipment = await client.Shipment.buy(shipmentId, rateId);

      const trackingNumber = shipment.tracking_code;
      const labelUrl = shipment.postage_label?.label_url ?? shipment.label_url ?? "";
      const trackerId = shipment.tracker?.id ?? "";

      return {
        trackingNumber,
        labelUrl,
        trackerId,
        carrier: shipment.selected_rate?.carrier ?? "",
        service: shipment.selected_rate?.service ?? "",
      };
    },

    async getTracking(trackerId: string): Promise<TrackingResult> {
      const client = await getEasyPostClient(apiKey);

      const tracker = await client.Tracker.retrieve(trackerId);

      const events: TrackingEvent[] = (tracker.tracking_details ?? []).map((detail: any) => ({
        status: detail.status ?? "unknown",
        description: detail.message ?? detail.description ?? "",
        occurredAt: detail.datetime ?? new Date().toISOString(),
        city: detail.tracking_location?.city ?? null,
        state: detail.tracking_location?.state ?? null,
      }));

      return {
        status: tracker.status ?? "unknown",
        estimatedDeliveryDate: tracker.est_delivery_date ?? null,
        events,
      };
    },

    async voidLabel(shipmentId: string): Promise<{ refunded: boolean }> {
      const client = await getEasyPostClient(apiKey);

      const refund = await client.Shipment.refund(shipmentId);

      // EasyPost returns refund_status: "submitted" or "refunded"
      return {
        refunded: refund.refund_status === "submitted" || refund.refund_status === "refunded",
      };
    },
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateShippingAdapterOptions {
  easyPostApiKey: string;
}

export function createShippingAdapter(options: CreateShippingAdapterOptions): ShippingAdapter {
  if (options.easyPostApiKey && options.easyPostApiKey !== "test-key") {
    return createEasyPostShippingAdapter(options.easyPostApiKey);
  }
  return createStubShippingAdapter();
}
