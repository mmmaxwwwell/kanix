# Research: BUG-033 — API response shape mismatch with Flutter ContributorDashboardData model

## Root cause analysis

Two independent issues compound:

1. **Provider unwrapping**: `contributor_provider.dart` passes `response.data` directly to
   `ContributorDashboardData.fromJson`, but the API wraps the result in `{ dashboard: {...} }`.
   So `fromJson` receives `{ dashboard: {...} }` instead of the inner object.

2. **Field name mismatches**:
   - `ContributorDesign.fromJson` reads `name`, `slug`, `totalSales`, `royaltyAccruedCents`
     but API has `productTitle`, `productSlug`, `salesCount` (no per-design royalty)
   - `ContributorMilestone.fromJson` reads `name`, `description`, `targetSales`, `currentSales`,
     `bonusCents`, `achieved` but API has `milestoneType`, `reachedAt`, `notes`
   - `ContributorPayout.fromJson` reads `amountCents`, `paidAt` but API has `amountMinor`, `completedAt`/`initiatedAt`
   - `ContributorDashboardData.fromJson` reads `totalDesigns`, `totalSales`, `totalRoyaltyAccruedCents`,
     `totalPaidOutCents` but API has designs/royaltySummary objects, not flat totals

## Evidence

API response (from `server.ts` getContributorDashboard, `db/queries/contributor.ts`):
```json
{
  "dashboard": {
    "contributor": { "id": "...", "status": "active", ... },
    "designs": [{ "id": "...", "productTitle": "...", "productSlug": "...", "salesCount": 26 }],
    "royaltySummary": { "totalMinor": 5175, "paidMinor": 0, "pendingMinor": 5175, "clawedBackMinor": 199, "currency": "USD" },
    "milestones": [{ "id": "...", "milestoneType": "royalty_activation", "reachedAt": "...", "notes": "..." }],
    "payouts": []
  }
}
```

Flutter model reads (contributor.dart lines 155-176):
- `totalDesigns` — not in API
- `totalSales` — not in API
- `designs[].name` — API has `productTitle`
- `designs[].totalSales` — API has `salesCount`

## Recommended fix strategy

Option (a) — fix Flutter side only (lower risk, API unchanged):

1. `contributor_provider.dart`: unwrap `response.data['dashboard']` before passing to `fromJson`
2. `ContributorDashboardData.fromJson`: compute totals from nested objects
   - `totalDesigns` = `designs.length`
   - `totalSales` = sum of `designs[].salesCount`
   - `totalRoyaltyAccruedCents` = `royaltySummary['totalMinor']`
   - `totalPaidOutCents` = `royaltySummary['paidMinor']`
3. `ContributorDesign.fromJson`: map `productTitle`→`name`, `productSlug`→`slug`, `salesCount`→`totalSales`
4. `ContributorMilestone.fromJson`: map `milestoneType`→`name` (humanized), `notes`→`description`,
   derive `targetSales` from type constants, `achieved` = `reachedAt != null`
5. `ContributorPayout.fromJson`: map `amountMinor`→`amountCents`, `completedAt??initiatedAt`→`paidAt`

## What NOT to do

- Don't change the API shape (would break admin app tests).
- Don't add a separate fromDashboardJson — update fromJson in place.

## Confidence

High — API response shape confirmed from source code; field mappings are deterministic.
