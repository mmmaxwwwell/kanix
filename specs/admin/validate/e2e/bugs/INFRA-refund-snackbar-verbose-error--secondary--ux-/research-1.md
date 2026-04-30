# Research: INFRA-refund-snackbar-verbose-error--secondary--ux-

Auto-generated from executor handoff (iteration 7, spawn 2).

## Executor report

- **Symptom** When refund fails, SnackBar displays raw DioException stack trace text instead of a user-friendly message
- **Evidence** UI accessibility tree (iter-7-spawn-2, step-5): item 14 text = "Refund failed: DioException [bad response]: This exception was thrown because the response has a status code of 502 and RequestOptions.validateStatus was configured to throw for this status code. The status code of 502 has the following meaning: 'Server error - the server failed to fulfil an apparently valid request' Read more about status codes at https://developer.mozilla.org/en-US/docs/Web/HTTP/Status In order to resolve this exception you typically have either to verify and fix your request code or you have to fix the server code."
- **Suspected root cause** The admin Flutter app's refund handler catches the DioException and calls `snackBar.showError(e.toString())` or similar, passing the full exception message rather than extracting a concise error string.
- **Suggested fix location** admin/lib/providers/ or admin/lib/screens/order_detail/ — whichever file handles the refund API call and shows the SnackBar on failure.
- **How a fix agent can verify** After fix: retry the refund in the UI; SnackBar should show something like "Refund failed: payment provider error" (or the server's `message` field), not the full DioException.
