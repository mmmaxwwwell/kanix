# Research: INFRA-contributor-model-api-shape-mismatch

Auto-generated from executor handoff (iteration 2, spawn 3).

## Executor report

- **Symptom** All numeric fields in the contributor dashboard display as 0 because `ContributorDashboardData.fromJson` reads field names that don't exist in the API response
- **Evidence** API response shape (from `GET /api/contributors/dashboard`):
  ```json
  {
    "dashboard": {
      "contributor": { "id": "...", "status": "active", ... },
      "designs": [{ "productTitle": "...", "productSlug": "...", "salesCount": 26, ... }],
      "royaltySummary": { "totalMinor": 5175, "clawedBackMinor": 199, ... },
      "milestones": [{ "milestoneType": "royalty_activation", "reachedAt": "...", ... }],
      "payouts": []
    }
  }
  ```
  Flutter model `ContributorDashboardData.fromJson` (contributor.dart line 155-173) reads: `totalDesigns`, `totalSales`, `totalRoyaltyAccruedCents`, `designs[].name`, `designs[].totalSales`, `milestones[].name/targetSales/currentSales/bonusCents/achieved` — none of these keys exist at the top level or inside `dashboard`
- **Suspected root cause** API and Flutter model were designed independently without agreeing on a shape; the API wraps in `{dashboard:{...}}` but the provider passes the top-level JSON object to `fromJson`
- **Suggested fix location** Either:
  (a) Change `contributor_provider.dart` to unwrap `response['dashboard']` before passing to `ContributorDashboardData.fromJson`, AND update `ContributorDashboardData.fromJson` to map from the actual API field names (`salesCount`, `productTitle`, `milestoneType/reachedAt`, etc.), OR
  (b) Change `api/src/routes/contributors.ts` to return the flat shape the Flutter model expects. Option (a) is lower-risk (API change could break admin app).
- **How a fix agent can verify** After APK rebuild: navigate to `/contributor` → confirm dashboard shows totalSales=26, royalty ~$51.75, royalty_activation milestone shown as reached, 1 design listed
