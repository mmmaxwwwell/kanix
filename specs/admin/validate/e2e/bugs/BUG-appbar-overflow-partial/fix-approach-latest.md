In `admin/lib/screens/order_detail_screen.dart`, replaced `const Spacer() + _RefundButton +
const SizedBox(width: 8) + _CancelButton` in `_OrderHeader.build()` with
`Expanded(child: OverflowBar(alignment: MainAxisAlignment.end, spacing: 8, children: [_RefundButton, _CancelButton]))`.
`OverflowBar` places both buttons side-by-side when horizontal space allows, and stacks them
vertically when it doesn't — eliminating the overflow. `Expanded` gives `OverflowBar` a bounded
max-width equal to all remaining space after the fixed header items (back button, order number,
total), which is required for `OverflowBar` to compute whether stacking is needed.
