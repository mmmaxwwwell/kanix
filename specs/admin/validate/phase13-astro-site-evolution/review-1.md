# Phase phase13-astro-site-evolution — Review #1: REVIEW-FIXES

**Date**: 2026-04-18T01:21:00Z
**Fixes applied**:
- `site/src/pages/checkout.astro`: `stripe.confirmPayment()` was called with `cardElement._elements || cardElement` — an undocumented internal Stripe SDK property — instead of the proper `elements` instance returned by `stripe.elements()`. The `elements` variable was scoped inside `initStripe()` but needed in the outer `payBtn` click handler. Fixed by storing the Elements instance in a module-level `stripeElements` variable and passing it directly. Commit: 4c443d2.

**Deferred** (optional improvements, not bugs):
- `escapeHtml()` in checkout.astro uses DOM-based escaping (creating a temporary div); this is fine for client-side code but not reusable server-side
- `item.id` is injected into `data-remove-item` attribute via innerHTML without escaping; safe because item IDs are UUIDs from the API, but slightly fragile if API returns unexpected data
- `formatPrice` is defined in both `products.ts` and `cart.ts` with the same signature — minor duplication but not a bug
