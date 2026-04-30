# Research: BUG-refund-error-verbose-message — Refund failure SnackBar shows raw DioException text

## Root cause analysis

In `admin/lib/screens/order_detail_screen.dart`, the `_RefundButton._showRefundDialog()` method
catches all exceptions and calls `'Refund failed: $e'` where `$e` is the caught exception. When the
exception is a `DioException` (thrown by Dio on non-2xx HTTP responses), calling `.toString()` on it
produces the full verbose multi-paragraph message that includes HTTP status, URL, and developer-help
links.

Specifically at lines 260-265:
```dart
} catch (e) {
  if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Refund failed: $e')),
    );
  }
}
```

The API returns a structured JSON error on 502:
```json
{"error": "ERR_REFUND_PROVIDER_FAILURE", "message": "Payment provider error during refund"}
```

This `message` field is available on `DioException.response?.data['message']` but is ignored.

## Evidence

- API endpoint `POST /api/admin/orders/:id/refunds` returns 502 with `message: "Payment provider error during refund"` (server.ts line ~1352)
- Catch block uses `$e` which calls `DioException.toString()` producing ~200 chars of verbose text
- The INFRA-refund-snackbar-verbose-error research confirms: item 14 text in accessibility tree = full DioException string

## Recommended fix strategy

1. Add `import 'package:dio/dio.dart';` to `order_detail_screen.dart`
2. In the catch block, check `if (e is DioException)`:
   - Try to extract `e.response?.data['message']` as a string
   - Fall back to `'payment provider error'` if no message
3. Show `'Refund failed: <extracted message>'` in the SnackBar

This gives users "Refund failed: Payment provider error during refund" instead of the verbose DioException.

## What NOT to do

- Do not use `e.message` on DioException — that's the Dio internal message, also verbose
- Do not hide all errors with a generic message — surface the API `message` field when available

## Confidence

High — the root cause is clear, the API response structure is confirmed, and the fix is a simple
DioException type check + response data extraction.
