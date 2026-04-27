Changed `childAspectRatio` from `2.5` to `1.8` in the `_DashboardGrid` widget in
`admin/lib/screens/dashboard_screen.dart`. The previous ratio made cards too flat
(only ~83px tall for a ~207px-wide card in a 3-column grid) to accommodate the
`headlineMedium` count text (28sp) plus 12px padding on all sides, icon row, and
label — resulting in "BOTTOM OVERFLOWED" and "RIGHT OVERFLOWED" Flutter rendering
errors visible as yellow/black stripe patterns. Ratio 1.8 gives ~115px of card
height, which is sufficient for all stat cards at typical admin screen widths.
