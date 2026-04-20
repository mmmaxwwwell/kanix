# kanix_customer

Customer-facing Flutter app for the Kanix commerce platform.

## Stripe configuration

The app reads the Stripe publishable key in two ways (in order):

1. **At runtime** — from the API via `GET /api/customer/stripe/config`. This is the normal path; no build-time config is needed when the API is reachable.
2. **At build/launch time** — via `--dart-define=STRIPE_PUBLISHABLE_KEY=…` as a fallback used before the API call completes.

### Running locally

```bash
flutter run \
  --dart-define=STRIPE_PUBLISHABLE_KEY=pk_test_REPLACE_ME
```

Or use a gitignored JSON file:

```bash
# dart-define.json (add to .gitignore)
# { "STRIPE_PUBLISHABLE_KEY": "pk_test_…" }

flutter run --dart-define-from-file=dart-define.json
```

Use a Stripe **test** key (`pk_test_…`) for development. Get one at
https://dashboard.stripe.com/test/apikeys.

## Tests

```bash
flutter test
```
