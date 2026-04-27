# Research: BUG-004b — Dashboard stat cards overflow their bounds

## Root cause analysis

The bug report describes Flutter render overflow warnings on the Dashboard stat cards:
"BOTTOM OVERFLOWED BY 40 PIXELS" and "RIGHT OVERFLOWED BY 24/43 PIXELS".

These overflows were caused by two issues in `admin/lib/screens/dashboard_screen.dart`:

1. **Card too flat** (`childAspectRatio: 2.5`): In a 3-column GridView at typical
   admin screen widths (~620px), `childAspectRatio: 2.5` gives cards only ~83px of
   height. The `_CountCard` content — `headlineMedium` count text (28sp line height),
   12px all-sides padding, an icon row (24px icon + spacer), and a `bodySmall` label —
   requires ~105px minimum. Result: "BOTTOM OVERFLOWED BY 40 PIXELS".

2. **Column without `mainAxisSize: MainAxisSize.min`**: Without this, the Column
   expanded to fill the card's constrained height and then tried to overflow when the
   content exceeded it.

3. **Long label text overflowing horizontally**: Titles like "Orders Awaiting
   Fulfillment" overflow the card width without `TextOverflow.ellipsis`.

## Evidence

Current state of `admin/lib/screens/dashboard_screen.dart` (already fixed):

```dart
// _DashboardGrid (lines 95–103)
return Expanded(
  child: GridView.count(
    crossAxisCount: 3,
    mainAxisSpacing: 16,
    crossAxisSpacing: 16,
    childAspectRatio: 1.8,  // was 2.5 — generous height prevents vertical overflow
    children: cards,
  ),
);

// _CountCard Column (lines 131–154)
child: Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  mainAxisSize: MainAxisSize.min,   // prevents Column from forcing overflow
  children: [
    Row(children: [Icon(...), Spacer(), Text('$count', ...)]),
    const SizedBox(height: 4),
    Text(
      title,
      style: Theme.of(context).textTheme.bodySmall,
      overflow: TextOverflow.ellipsis,  // prevents text overflow
    ),
  ],
),
```

All three overflow fixes are already present in the source file. This bug was fixed in
a prior iteration (Attempt 2 of BUG-004 fix history, which incorrectly targeted BUG-004
instead of BUG-004b).

## Recommended fix strategy

No code changes needed — the fix is already applied:
- `childAspectRatio: 1.8` (was 2.5)
- `mainAxisSize: MainAxisSize.min` on the Column
- `overflow: TextOverflow.ellipsis` on the title Text

## What NOT to do

- Do NOT revert `childAspectRatio` back to 2.5.
- Do NOT remove `mainAxisSize: MainAxisSize.min`.

## Confidence

**High**. All three fixes are confirmed present in source. The APK needs a rebuild with
`flutter clean` to pick up the changes (see stale-android-apk-after-source-fix pattern).
