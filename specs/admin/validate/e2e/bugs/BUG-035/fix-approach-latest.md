Two-part fix:

1. **API (`api/src/server.ts`)**: The `GET /api/contributors/dashboard` route returned the
   raw `DashboardResult` which includes a `contributor` sub-object with `charityName` and
   `charityEin` but no computed `donationEnabled` boolean. Added a one-liner spread in the
   route handler to inject `donationEnabled: !!(charityName && charityEin)` into the
   dashboard object before returning.

2. **Flutter (`customer/lib/models/contributor.dart` and
   `customer/lib/screens/contributor_dashboard_screen.dart`)**: Added `donationEnabled` and
   `charityName` fields to `ContributorDashboardData`, parsed from the new `donationEnabled`
   API field (with fallback inference from `contributor.charityName`). Added a
   `_DonationSection` widget to `_DashboardBody` showing a read-only Switch toggle, charity
   name when enabled, and the applicable royalty rate (20% with donation, 10% standard).
