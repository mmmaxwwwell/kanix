# Research: BUG-appbar-overflow-partial — AppBar overflows 134px, Cancel Order button off-screen

## Root cause analysis

The `_OrderHeader` widget in `admin/lib/screens/order_detail_screen.dart` (lines 131-155) renders a
`Row` with these children:

```
IconButton(48) | SizedBox(8) | Flexible(title) | SizedBox(16) | Text(total) |
Spacer | _RefundButton | SizedBox(8) | _CancelButton
```

The previous fix (BUG-refund-button-appbar-overflow) wrapped the title in `Flexible`, reducing
overflow from 3601px to 134px. However, `_RefundButton` and `_CancelButton` remain as flex=0
(fixed-size) items AFTER the `Spacer`. On narrow screens (phones ~300-350dp), these buttons total
~280dp (Refund ~120dp + Cancel Order ~160dp) which exceeds the available space after other fixed
items (IconButton+SizedBox+SizedBox+Text(total) = ~130dp fixed).

Flutter's Row layout: when fixed items overflow the row width, flex items (Flexible + Spacer) each
get 0px and fixed items overflow. The 134px overflow at 3x density = ~44dp logical overflow.

## Evidence

- `_OrderHeader.build()` line 149: `const Spacer()` then fixed buttons
- Screenshot shows: Refund button at x=812 (accessible), Cancel Order at x=1029 (134px off-screen)
- Previous fix added `Flexible(child: Text(...))` for the title, which fixed the title overflow
  but left button overflow intact

## Recommended fix strategy

Replace `Spacer + _RefundButton + SizedBox(8) + _CancelButton` with:

```dart
Expanded(
  child: OverflowBar(
    alignment: MainAxisAlignment.end,
    spacing: 8,
    children: [
      _RefundButton(order: order),
      _CancelButton(order: order),
    ],
  ),
),
```

`OverflowBar` (Flutter built-in since 2.0) places children horizontally when they fit, and stacks
them vertically when they don't. `Expanded` gives `OverflowBar` a bounded max width (all remaining
space after fixed items), so it can compute whether to stack. `alignment: end` right-aligns buttons.

This removes the `Spacer` (replaced by `Expanded`) and the `SizedBox(width: 8)` between buttons
(replaced by `spacing: 8`).

## What NOT to do

- Do not use `Flexible(fit: FlexFit.loose)` on `_CancelButton` alone — it doesn't cause the button
  to shrink below its minimum size, so it may still overflow
- Do not simply remove `Spacer` without replacement — buttons would lose right-alignment
- Do not use `SingleChildScrollView` horizontal — makes buttons scrollable, bad UX

## Confidence

High — `OverflowBar` is the Flutter-recommended solution for this exact overflow scenario. The fix
is minimal and doesn't change normal-case UX (buttons side-by-side on tablets, stacked on phones).
