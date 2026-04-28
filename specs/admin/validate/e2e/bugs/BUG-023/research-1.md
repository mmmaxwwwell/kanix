# Research: BUG-023 — No Submit Bundle button in Flutter admin UI

## Root cause analysis

`admin/lib/screens/disputes_screen.dart` implements `DisputeDetailScreen` / `_DisputeDetailContent` with a "Generate Bundle" button but no "Submit Bundle" button. The API endpoint `POST /api/admin/disputes/:id/submit-bundle` exists (server.ts:3423) and is fully functional — it finds the latest "generated" bundle for the dispute and submits it to Stripe. There is simply no UI affordance to call it.

The Generate Bundle button renders at line 286-294 inside `_DisputeDetailContent.build`:
```dart
if (!dispute.evidenceSubmitted && dispute.status == 'needs_response')
  FilledButton.icon(
    icon: const Icon(Icons.archive),
    label: const Text('Generate Bundle'),
    onPressed: () => _generateBundle(context, ref, dispute.id),
  ),
```

A `_submitBundle` method and corresponding "Submit Bundle" button are entirely absent.

## Evidence

- `api/src/server.ts:3421-3525`: `POST /api/admin/disputes/:id/submit-bundle` route exists, calls `paymentAdapter.submitDisputeEvidence`, transitions dispute status.
- `admin/lib/screens/disputes_screen.dart:286-355`: Generate Bundle button + `_generateBundle` method exist; no submit counterpart.
- The `_generateBundle` method also has a minor path bug (calls `/api/admin/disputes/$disputeId/bundle` instead of `/api/admin/disputes/$disputeId/generate-bundle`) — but that is out of scope for BUG-023.

## Recommended fix strategy

Add a "Submit Bundle" `OutlinedButton.icon` next to the "Generate Bundle" button in `_DisputeDetailContent.build`. Show it under the same condition (`!dispute.evidenceSubmitted && dispute.status == 'needs_response'`). Add a `_submitBundle` method mirroring `_generateBundle` but calling `POST /api/admin/disputes/$disputeId/submit-bundle`.

File to modify: `admin/lib/screens/disputes_screen.dart`
- Add button in the `Row` at line 281-295 (Evidence section header)
- Add `_submitBundle` method to `_DisputeDetailContent` alongside `_generateBundle`

## What NOT to do

- Do not add new Dispute model fields or change the API — the current API is correct.
- Do not change the Generate Bundle button path bug in this fix (separate concern).
- Do not gate the Submit Bundle button on a "bundle generated" state — we don't have that field in the Dispute model and the API returns a clear error if no bundle exists.

## Confidence

High — the API endpoint is implemented and tested, the Flutter pattern for the Generate Bundle button is a direct template to follow.
