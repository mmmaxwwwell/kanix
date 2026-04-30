Added `import 'package:dio/dio.dart'` to `admin/lib/screens/order_detail_screen.dart` and modified the
`catch (e)` block in `_RefundButton._showRefundDialog()` to check `if (e is DioException)`. When it
is, the code extracts `e.response?.data['message']` (which the API populates with "Payment provider
error during refund" on 502) and shows "Refund failed: <message>" in the SnackBar. If no structured
message is available, it falls back to "Refund failed: payment provider error". For non-Dio
exceptions it retains the original `$e` interpolation. This prevents the verbose multi-paragraph
DioException.toString() output from appearing in the SnackBar.
