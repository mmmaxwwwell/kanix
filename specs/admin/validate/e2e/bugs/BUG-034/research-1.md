# Research: BUG-034 — Dashboard does not display clawback amount

## Root cause analysis

The API already returns `royaltySummary.clawedBackMinor=199` in the dashboard response.
The Flutter model (`ContributorDashboardData.fromJson`) reads `royaltySummary.totalMinor` and
`royaltySummary.paidMinor` but never reads `clawedBackMinor`. The field is silently dropped.

The UI (`_SummaryRow` in `contributor_dashboard_screen.dart`) only renders four summary cards:
Designs, Total Sales, Royalty Accrued, Total Paid Out. There is no card or line item for
clawbacks, so even if the model stored the value it would not be visible.

This is a pure Flutter-side omission — no API changes are needed.

## Evidence

`customer/lib/models/contributor.dart` lines 210-215:
```dart
final royaltySummary = json['royaltySummary'] as Map<String, dynamic>?;
final totalRoyaltyAccruedCents =
    (royaltySummary?['totalMinor'] ?? ...) as int;
final totalPaidOutCents =
    (royaltySummary?['paidMinor'] ?? ...) as int;
// clawedBackMinor is never read
```

`api/src/db/queries/contributor.ts` lines 987-993 confirms `clawedBackMinor` is in the
`DashboardRoyaltySummary` interface and is populated correctly in `getContributorDashboard`.

## Recommended fix strategy

1. Add `clawedBackMinor` field to `ContributorDashboardData` in `contributor.dart`.
2. Parse it from `royaltySummary?['clawedBackMinor']` in `fromJson`.
3. Add a `formattedClawBack` getter.
4. In `_SummaryRow._build`, add a conditional `_SummaryCard` for Clawback that only
   renders when `data.clawedBackMinor > 0` (avoids noise when no clawbacks exist).

## What NOT to do

- Do not add an API field — the value is already returned.
- Do not always show the card — it should only appear when clawbacks are > 0.

## Confidence

High — root cause is a single missing field in the Dart model + UI.
