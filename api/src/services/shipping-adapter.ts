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

export interface ShippingAdapter {
  /**
   * Calculate the cheapest shipping rate for the given items and destination.
   */
  calculateRate(
    fromAddress: ShippingRateAddress,
    toAddress: ShippingRateAddress,
    items: ShippingRateItem[],
  ): Promise<ShippingRateResult>;
}

// ---------------------------------------------------------------------------
// Stub adapter (returns flat-rate shipping)
// ---------------------------------------------------------------------------

function createStubShippingAdapter(): ShippingAdapter {
  return {
    async calculateRate(): Promise<ShippingRateResult> {
      return {
        shippingAmountMinor: 599,
        carrier: "USPS",
        service: "Priority",
        rateId: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// EasyPost adapter (uses dynamic import since @easypost/api may not be installed)
// ---------------------------------------------------------------------------

function createEasyPostShippingAdapter(apiKey: string): ShippingAdapter {
  return {
    async calculateRate(
      fromAddress: ShippingRateAddress,
      toAddress: ShippingRateAddress,
      items: ShippingRateItem[],
    ): Promise<ShippingRateResult> {
      // Dynamic import — @easypost/api is only required at runtime if EASYPOST_API_KEY is set
      const mod = await import(/* webpackIgnore: true */ "@easypost/api" as string);
      const EasyPost = mod.default;
      const client = new EasyPost(apiKey);

      const totalWeightOz = items.reduce((sum, item) => sum + item.weightOz * item.quantity, 0);

      const shipment = await client.Shipment.create({
        from_address: {
          street1: fromAddress.line1,
          street2: fromAddress.line2 ?? "",
          city: fromAddress.city,
          state: fromAddress.state,
          zip: fromAddress.postalCode,
          country: fromAddress.country,
        },
        to_address: {
          street1: toAddress.line1,
          street2: toAddress.line2 ?? "",
          city: toAddress.city,
          state: toAddress.state,
          zip: toAddress.postalCode,
          country: toAddress.country,
        },
        parcel: {
          weight: totalWeightOz,
        },
      });

      if (!shipment.rates || shipment.rates.length === 0) {
        throw Object.assign(new Error("No shipping rates available"), {
          code: "ERR_NO_SHIPPING_RATES",
        });
      }

      const sorted = [...shipment.rates].sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      const cheapest = sorted[0];

      return {
        shippingAmountMinor: Math.round(parseFloat(cheapest.rate) * 100),
        carrier: cheapest.carrier,
        service: cheapest.service,
        rateId: cheapest.id,
      };
    },
  };
}

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
