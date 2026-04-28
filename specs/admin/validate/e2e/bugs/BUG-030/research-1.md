# Research: BUG-030 — Customer app calls /api/contributor/dashboard (singular) → 404

## Root cause analysis

`customer/lib/providers/contributor_provider.dart:9` uses:
```dart
final response = await dio.get('/api/contributor/dashboard');
```
The server registers the route at `/api/contributors/dashboard` (plural) per
`api/src/server.ts:7531–7533`. The singular path never matches any route → 404.

## Evidence

- `customer/lib/providers/contributor_provider.dart:9` — confirmed singular path.
- `api/src/server.ts:7531`: `// GET /api/contributors/dashboard — contributor dashboard [FR-075]`
- `api/src/server.ts:7533`: route registered as `"/api/contributors/dashboard"` (plural).
- Executor step-9 confirmed: singular → 404; plural → 200 with full dashboard data.

## Recommended fix strategy

Change line 9 of `customer/lib/providers/contributor_provider.dart` from:
```dart
final response = await dio.get('/api/contributor/dashboard');
```
to:
```dart
final response = await dio.get('/api/contributors/dashboard');
```
One-character change — add the missing `s`.

## What NOT to do

- Do not add an alias route on the server side — the server path is correct; fix the client typo.

## Confidence

High — typo confirmed by executor; fix is one character.
