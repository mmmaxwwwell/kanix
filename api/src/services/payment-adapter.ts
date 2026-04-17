import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatePaymentIntentInput {
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string;
}

export interface PaymentAdapter {
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
}

// ---------------------------------------------------------------------------
// Stripe adapter (production)
// ---------------------------------------------------------------------------

function createStripePaymentAdapter(stripeSecretKey: string): PaymentAdapter {
  const stripe = new Stripe(stripeSecretKey);

  return {
    async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult> {
      const intent = await stripe.paymentIntents.create({
        amount: input.amountMinor,
        currency: input.currency,
        metadata: input.metadata,
      });
      return {
        id: intent.id,
        clientSecret: intent.client_secret ?? "",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stub adapter (for testing)
// ---------------------------------------------------------------------------

let stubCounter = 0;

function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent(): Promise<PaymentIntentResult> {
      stubCounter++;
      return {
        id: `pi_stub_${stubCounter}_${Date.now()}`,
        clientSecret: `pi_stub_${stubCounter}_secret_${Date.now()}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreatePaymentAdapterOptions {
  stripeSecretKey: string;
}

export function createPaymentAdapter(options: CreatePaymentAdapterOptions): PaymentAdapter {
  if (options.stripeSecretKey && !options.stripeSecretKey.startsWith("sk_test_xxx")) {
    return createStripePaymentAdapter(options.stripeSecretKey);
  }
  return createStubPaymentAdapter();
}
