# Research: INFRA-bug021-dispute-fromjson-field-mismatch

Auto-generated from executor handoff (iteration 2, spawn 2).

## Executor report

- **Symptom**: Flutter Disputes screen shows "Failed to load disputes: type 'Null' is not a subtype of type 'String' in type cast" immediately on navigation
- **Evidence**: `admin/lib/models/dispute.dart:35` accesses `json['stripeDisputeId'] as String` but API returns `providerDisputeId`. Full mismatch table in BUG-021 research: stripeDisputeId→providerDisputeId, createdAt→openedAt, updatedAt→(missing), evidenceDueBy→dueBy, evidenceSubmitted(bool)→evidenceCount(int).
- **Suspected root cause**: Flutter model was written against an older API contract; API was updated but Flutter model was not synced.
- **Suggested fix location**: `admin/lib/models/dispute.dart` — update `Dispute.fromJson` to use `providerDisputeId`, `openedAt`, `dueBy`, and derive `evidenceSubmitted` from `evidenceCount > 0`.
- **How a fix agent can verify**: After APK rebuild and install, navigate to Disputes in admin app — DataTable should render rows instead of error message.
