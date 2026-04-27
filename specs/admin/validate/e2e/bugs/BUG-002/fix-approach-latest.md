Fixed the `_purchaseLabel` method in `admin/lib/screens/shipments_screen.dart` to call
`/api/admin/shipments/${shipment.id}/buy-label` instead of the wrong
`/api/admin/shipments/${shipment.id}/purchase-label`. The API route is defined as
`/api/admin/shipments/:id/buy-label` (server.ts line 1995); the Flutter screen had
`purchase-label` which caused a 404 on every label purchase attempt.
