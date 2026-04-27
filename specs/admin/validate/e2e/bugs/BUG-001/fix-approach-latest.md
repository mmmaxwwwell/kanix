Replaced all six occurrences of `/api/admin/fulfillment/${task.id}/transition` and
`/api/admin/fulfillment/${task.id}/assign` in `admin/lib/screens/fulfillment_screen.dart`
with the correct `/api/admin/fulfillment-tasks/${task.id}/...` paths. The API only
defines routes under `/api/admin/fulfillment-tasks` — the screen's inline Dio calls
had the wrong base path (missing the `-tasks` segment), causing 404s on every
workflow action (assign, start-picking, mark-picked, start-packing, mark-packed,
block, unblock, cancel). Previous fix attempts addressed only the provider's list/detail
endpoints; the screen's six inline call sites were never touched.
