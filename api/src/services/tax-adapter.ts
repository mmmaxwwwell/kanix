import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxLineItem {
  /** Amount in minor units (cents). */
  amount: number;
  /** Human-readable reference (e.g. product title or variant SKU). */
  reference: string;
  /** Quantity of this line item. */
  quantity: number;
  /** Stripe Tax code (optional — defaults to general tangible goods). */
  taxCode?: string;
}

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface TaxCalculationResult {
  /** Total tax in minor units (cents). */
  taxAmountMinor: number;
  /** The Stripe Tax calculation ID (for PaymentIntent metadata). Null in stub mode. */
  calculationId: string | null;
}

export interface TaxAdapter {
  /**
   * Calculate tax for the given line items and shipping address.
   *
   PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
   * - When STRIPE_TAX_ENABLED=true: calls the Stripe Tax API.
   * - When STRIPE_TAX_ENABLED=false: returns 0 tax (stub mode).
   */
  calculate(
    lineItems: TaxLineItem[],
    shippingAddress: ShippingAddress,
  ): Promise<TaxCalculationResult>;
}

// ---------------------------------------------------------------------------
// Stub adapter (STRIPE_TAX_ENABLED=false)
// ---------------------------------------------------------------------------

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate(): Promise<TaxCalculationResult> {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe Tax adapter (STRIPE_TAX_ENABLED=true)
// ---------------------------------------------------------------------------

function createStripeTaxAdapter(stripeSecretKey: string): TaxAdapter {
  const stripe = new Stripe(stripeSecretKey);

  return {
    async calculate(
      lineItems: TaxLineItem[],
      shippingAddress: ShippingAddress,
    ): Promise<TaxCalculationResult> {
      const calculation = await stripe.tax.calculations.create({
        currency: "usd",
        line_items: lineItems.map((item) => ({
          amount: item.amount,
          quantity: item.quantity,
          reference: item.reference,
          ...(item.taxCode ? { tax_code: item.taxCode } : {}),
        })),
        customer_details: {
          address: {
            line1: shippingAddress.line1,
            line2: shippingAddress.line2 ?? "",
            city: shippingAddress.city,
            state: shippingAddress.state,
            postal_code: shippingAddress.postalCode,
            country: shippingAddress.country,
          },
          address_source: "shipping",
        },
      });

      return {
        taxAmountMinor: calculation.tax_amount_exclusive,
        calculationId: calculation.id,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateTaxAdapterOptions {
  stripeTaxEnabled: boolean;
  stripeSecretKey: string;
}

export function createTaxAdapter(options: CreateTaxAdapterOptions): TaxAdapter {
  if (options.stripeTaxEnabled && options.stripeSecretKey) {
    return createStripeTaxAdapter(options.stripeSecretKey);
  }
  return createStubTaxAdapter();
}
