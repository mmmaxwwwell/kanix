Same fix as BUG-refund-error-verbose-message — the two findings describe identical symptoms and root
cause. The fix in `admin/lib/screens/order_detail_screen.dart` addresses both: the `catch` block in
`_RefundButton._showRefundDialog()` now extracts the API's `message` field from the DioException
response and shows a concise "Refund failed: <message>" SnackBar instead of the raw DioException
toString output.
