# Research: BUG-035 — Dashboard has no donation toggle or charity section

## Root cause analysis

Two separate gaps:

1. **API gap**: `GET /api/contributors/dashboard` returns `{ dashboard }` where `dashboard`
   is a `DashboardResult`. The `contributor` sub-object (`ContributorRow`) includes `charityName`
   and `charityEin` but there is no computed `donationEnabled` boolean anywhere in the response.
   The Flutter app must dig into `contributor.charityName` to infer donation state, and does not
   do so.

2. **Flutter gap**: `ContributorDashboardData` model has no `donationEnabled` or `charityName`
   fields. `_DashboardBody` has no donation section — it only renders Summary, Designs,
   Milestones, Payout History.

## Evidence

`api/src/db/queries/contributor.ts` line 60-71 — `ContributorRow` has `charityName | null` and
`charityEin | null` but no `donationEnabled`.

`api/src/server.ts` line 7596 — route returns `return { dashboard }` verbatim with no
`donationEnabled` injection.

`customer/lib/models/contributor.dart` line 162-229 — `ContributorDashboardData` has no
`donationEnabled`, `charityName`, or `royaltyRate` fields.

`api/src/db/queries/contributor.ts` line 280-286 — `getRoyaltyRate` shows that
`charityName && charityEin` → 20% (DONATION_RATE), otherwise 10% (ROYALTY_RATE). This
mapping lives only in the API; the UI should display it when donation is enabled.

## Recommended fix strategy

1. **API (server.ts)**: In the dashboard route handler, before returning, inject
   `donationEnabled` into the dashboard object:
   ```ts
   return {
     dashboard: {
       ...dashboard,
       donationEnabled: !!(dashboard.contributor.charityName && dashboard.contributor.charityEin),
     },
   };
   ```
   This is read-only transformation in the route handler — no schema or DB changes needed.

2. **Flutter model (`contributor.dart`)**: Add fields `donationEnabled`, `charityName`, and
   parse them in `fromJson`:
   - `donationEnabled` from `json['donationEnabled']` (the new API field)
   - `charityName` from `json['contributor']?['charityName']` (already in response)

3. **Flutter UI (`contributor_dashboard_screen.dart`)**: Add a Donation section after
   Payout History in `_DashboardBody._build`, showing:
   - A read-only toggle (Switch widget, non-interactive for display) indicating ON/OFF
   - Charity name when enabled
   - Royalty rate (20% when enabled, 10% standard)

## What NOT to do

- Do not add a DB column — `donationEnabled` is a derived field.
- Do not make the toggle interactive (the E2E plan step-9 tests toggling OFF, but that
  requires an API PATCH endpoint which is an admin action; the customer dashboard is read-only).
  Show state only.

## Confidence

High — both gaps are clear from reading the code. API change is a one-liner; Flutter changes
are additive.
