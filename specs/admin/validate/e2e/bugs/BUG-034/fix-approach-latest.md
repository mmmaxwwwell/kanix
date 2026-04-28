The API already returned `royaltySummary.clawedBackMinor` in the dashboard response, but
the Flutter model (`ContributorDashboardData` in `customer/lib/models/contributor.dart`)
never parsed that field, so it was silently dropped. Added `clawedBackMinor` and
`formattedClawBack` to the model, parsed from `royaltySummary['clawedBackMinor']`. In
`contributor_dashboard_screen.dart` added a conditional `_SummaryCard` for "Clawed Back"
that only renders when `clawedBackMinor > 0`, keeping the UI clean when no clawbacks exist.
