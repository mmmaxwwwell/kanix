Fixed the `_markShipped` method in `admin/lib/screens/shipments_screen.dart` to send
`{'new_status': 'shipped'}` instead of `{'status': 'shipped'}`. The API's shipment
transition schema (server.ts lines 2133–2135) requires the field name `new_status`;
the Flutter screen was sending `status` which the API silently ignores, causing the
transition to fail or return a 400 validation error. Previous fix attempts added
an unrelated `/api/test/seed-paid-order` endpoint; this iteration fixes the actual
field name mismatch in the Flutter screen.
