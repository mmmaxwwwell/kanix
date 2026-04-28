# Research: BUG-021 — Disputes list type cast crash

## Root cause (confirmed by code reading)

Flutter `admin/lib/models/dispute.dart` `Dispute.fromJson` expects API field names
that do not match what `GET /api/admin/disputes` actually returns.

### Field name mismatches

| Flutter model expects | API returns | Nullable in Dart? |
|---|---|---|
| `stripeDisputeId` | `providerDisputeId` | No (required String) → **crash** |
| `createdAt` | `openedAt` | No (required DateTime) → **crash** |
| `updatedAt` | *(not returned)* | No (required DateTime) → **crash** |
| `evidenceDueBy` | `dueBy` | Yes (DateTime?) → null-safe but wrong field |
| `evidenceSubmitted` | `evidenceCount` (int) | No (required bool, null-coalesced to false) |
| `orderNumber` | *(not returned)* | Yes (String?) → null-safe, renders as N/A |

The first crash is on line 35: `stripeDisputeId: json['stripeDisputeId'] as String`
— the key is missing, so json returns null, cast to String throws
"type 'Null' is not a subtype of type 'String' in type cast".

## Evidence

- `GET /api/admin/disputes?limit=1` returns: `['id','paymentId','orderId','providerDisputeId','reason','amountMinor','currency','status','openedAt','closedAt','dueBy','evidenceCount']`
- Flutter model at `admin/lib/models/dispute.dart:35`: `stripeDisputeId: json['stripeDisputeId'] as String`
- Screenshot: `specs/admin/validate/e2e/screenshots/step2-disputes-error.png`

## Fix locations

Either:
1. Update `Dispute.fromJson` in `admin/lib/models/dispute.dart` to use the correct API field names
2. Update `api/src/server.ts` dispute list serializer to return the field names the Flutter model expects

Option 1 is lower risk (no API contract change). Fix:
- `json['stripeDisputeId']` → `json['providerDisputeId']`
- `json['createdAt']` → `json['openedAt']`
- Remove `updatedAt` field (or use `json['openedAt']` as fallback)
- `json['evidenceDueBy']` → `json['dueBy']`
- `json['evidenceSubmitted']` → `(json['evidenceCount'] as int? ?? 0) > 0` or look for a boolean field in the detail endpoint

## How to verify

After fix: `GET /api/admin/disputes` should return 200 and the Flutter Disputes screen
should render a DataTable with rows. The target dispute `dp_e2e_1777331186` should
appear in the list.
