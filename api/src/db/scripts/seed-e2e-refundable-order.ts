/**
 * seed-e2e-refundable-order.ts
 *
 * Creates one "seed" paid order backed by a REAL captured Stripe test charge
 * so that E2E refund tests (T104c) have a refundable order in the database.
 *
 * Skipped automatically when STRIPE_SECRET_KEY is a placeholder (stub mode).
 * Idempotent: skips if a seed order with ORDER_NUMBER already exists.
 *
 * Usage: pnpm db:seed-e2e-refundable
 */

import Stripe from "stripe";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { order } from "../schema/order.js";
import { payment } from "../schema/payment.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kanix:kanix@localhost:5432/kanix";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const ORDER_NUMBER = "E2E-SEED-REFUNDABLE-001";
const AMOUNT_MINOR = 2999; // $29.99

// Skip when no real Stripe key is configured
function isPlaceholderKey(key: string): boolean {
  return (
    !key ||
    key.startsWith("sk_test_xxx") ||
    key.includes("placeholder") ||
    key.includes("REPLACE_ME") ||
    key === "sk_test_e2e_placeholder_key"
  );
}

async function run() {
  if (isPlaceholderKey(STRIPE_SECRET_KEY)) {
    console.log(
      "[seed-e2e-refundable] STRIPE_SECRET_KEY is a placeholder — skipping (stub mode).",
    );
    process.exit(0);
  }

  const sql = postgres(DATABASE_URL);
  const db = drizzle(sql);

  // Idempotency: skip if order AND payment both exist
  const existing = await db
    .select({ id: order.id })
    .from(order)
    .where(eq(order.orderNumber, ORDER_NUMBER));
  if (existing.length > 0) {
    const existingOrderId = existing[0]!.id;
    const existingPayment = await db
      .select({ id: payment.id })
      .from(payment)
      .where(eq(payment.orderId, existingOrderId));
    if (existingPayment.length > 0) {
      console.log(
        `[seed-e2e-refundable] Order ${ORDER_NUMBER} already exists with payment (id=${existingOrderId}), skipping.`,
      );
      await sql.end();
      process.exit(0);
    }
    // Order exists but payment row is missing (orphaned) — create a new PI and insert payment.
    console.log(
      `[seed-e2e-refundable] Order ${ORDER_NUMBER} exists (id=${existingOrderId}) but payment row is missing — recovering.`,
    );
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const recoveryIntent = await stripe.paymentIntents.create({
      amount: AMOUNT_MINOR,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
      return_url: "http://localhost:3000",
      metadata: { order_number: ORDER_NUMBER, source: "e2e-seed-recovery" },
    });
    if (recoveryIntent.status !== "succeeded") {
      console.error(
        `[seed-e2e-refundable] Recovery PI status=${recoveryIntent.status}. Aborting.`,
      );
      await sql.end();
      process.exit(1);
    }
    await db.insert(payment).values({
      orderId: existingOrderId,
      provider: "stripe",
      providerPaymentIntentId: recoveryIntent.id,
      status: "succeeded",
      amountMinor: AMOUNT_MINOR,
      currency: "USD",
    });
    console.log(
      `[seed-e2e-refundable] Recovered: inserted payment for order ${ORDER_NUMBER} (id=${existingOrderId}) with PI ${recoveryIntent.id}`,
    );
    console.log(`[seed-e2e-refundable] ORDER_ID=${existingOrderId}`);
    await sql.end();
    process.exit(0);
  }

  // Create a real Stripe PaymentIntent with confirm: true + test card
  // This produces a succeeded + captured charge immediately in Stripe test mode.
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  console.log("[seed-e2e-refundable] Creating confirmed Stripe PaymentIntent…");
  const intent = await stripe.paymentIntents.create({
    amount: AMOUNT_MINOR,
    currency: "usd",
    payment_method: "pm_card_visa",
    confirm: true,
    return_url: "http://localhost:3000",
    metadata: {
      order_number: ORDER_NUMBER,
      source: "e2e-seed",
    },
  });

  if (intent.status !== "succeeded") {
    console.error(
      `[seed-e2e-refundable] PaymentIntent status=${intent.status} (expected 'succeeded'). Aborting.`,
    );
    await sql.end();
    process.exit(1);
  }
  console.log(`[seed-e2e-refundable] PaymentIntent ${intent.id} succeeded.`);

  // Insert a paid order record
  const [newOrder] = await db
    .insert(order)
    .values({
      orderNumber: ORDER_NUMBER,
      email: "e2e-seed@kanix.test",
      status: "confirmed",
      paymentStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      shippingStatus: "not_shipped",
      currency: "USD",
      subtotalMinor: AMOUNT_MINOR,
      taxMinor: 0,
      shippingMinor: 0,
      discountMinor: 0,
      totalMinor: AMOUNT_MINOR,
      placedAt: new Date(),
    })
    .returning({ id: order.id });

  if (!newOrder) throw new Error("Failed to insert order row");

  // Insert the corresponding payment record
  await db.insert(payment).values({
    orderId: newOrder.id,
    provider: "stripe",
    providerPaymentIntentId: intent.id,
    status: "succeeded",
    amountMinor: AMOUNT_MINOR,
    currency: "USD",
  });

  console.log(
    `[seed-e2e-refundable] Seeded order ${ORDER_NUMBER} (id=${newOrder.id}) with PI ${intent.id}`,
  );
  console.log(`[seed-e2e-refundable] ORDER_ID=${newOrder.id}`);

  await sql.end();
}

run().catch((err) => {
  console.error("[seed-e2e-refundable] Error:", err);
  process.exit(1);
});
