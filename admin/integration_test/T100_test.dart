// regression for T100
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:patrol/patrol.dart';
import 'package:kanix_admin/main.dart' as app;

// API base URL: use 10.0.2.2 on Android emulator to reach host localhost:3000
const String _apiBase = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3000',
);

// E2E seed dispute created by test/e2e/setup.sh
const String _disputeId = '68fcd36b-fe99-432d-a79e-8820c6e2cd96';
const String _providerDisputeId = 'dp_e2e_1777331186';

/// Sign in via SuperTokens and return the st-access-token header value.
Future<String> _getAdminToken() async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_apiBase/auth/signin'));
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({
      'formFields': [
        {'id': 'email', 'value': 'admin@kanix.test'},
        {'id': 'password', 'value': 'TestAdmin123!'},
      ],
    }));
    final response = await request.close();
    final token = response.headers.value('st-access-token') ?? '';
    await response.transform(utf8.decoder).join(); // drain body
    expect(token, isNotEmpty, reason: 'SuperTokens must return st-access-token');
    return token;
  } finally {
    client.close();
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // ---------------------------------------------------------------------------
  // Backend API regression guards (BUG-021 through BUG-026)
  // These verify state transitions and data flows, not UI rendering.
  // ---------------------------------------------------------------------------

  group('T100 backend disputes API', () {
    late String token;

    setUp(() async {
      token = await _getAdminToken();
    });

    test('GET /api/admin/disputes?search narrows results (BUG-025)', () async {
      // BUG-025: search param was silently ignored — all 934 disputes returned.
      // After fix: server applies ilike filter on providerDisputeId.
      final client = HttpClient();
      try {
        final request = await client.getUrl(
          Uri.parse('$_apiBase/api/admin/disputes?search=$_providerDisputeId'),
        );
        request.headers.add('authorization', 'Bearer $token');
        final response = await request.close();
        expect(response.statusCode, equals(200));
        final body =
            jsonDecode(await response.transform(utf8.decoder).join()) as Map;
        // Response shape: {"disputes": [...]} or {"data": [...]}
        final disputes = (body['disputes'] ?? body['data'] ?? []) as List;
        expect(disputes.length, lessThanOrEqualTo(10),
            reason:
                'BUG-025: search must narrow results — not return all disputes');
        expect(disputes.length, greaterThanOrEqualTo(1),
            reason: 'Search must return at least the seeded dispute');
      } finally {
        client.close();
      }
    });

    test('GET /api/admin/disputes/:id returns dispute detail (BUG-024)', () async {
      // BUG-024: GET /api/admin/disputes/:id endpoint was missing (404).
      // After fix: endpoint returns dispute with all required fields.
      final client = HttpClient();
      try {
        final request = await client.getUrl(
          Uri.parse('$_apiBase/api/admin/disputes/$_disputeId'),
        );
        request.headers.add('authorization', 'Bearer $token');
        final response = await request.close();
        expect(response.statusCode, equals(200),
            reason: 'BUG-024: GET /api/admin/disputes/:id must return 200');
        final body =
            jsonDecode(await response.transform(utf8.decoder).join()) as Map;
        final dispute = body['dispute'] as Map<String, dynamic>;
        // Verify key fields that the Flutter UI reads via Dispute.fromJson
        expect(dispute['providerDisputeId'], equals(_providerDisputeId),
            reason: 'BUG-021: API must use providerDisputeId field name');
        expect(dispute['reason'], equals('fraudulent'));
        expect(dispute['amountMinor'], equals(5200));
        expect(dispute['status'], equals('opened'));
        expect(dispute.containsKey('dueBy'), isTrue,
            reason: 'BUG-021: API must include dueBy field');
        expect(dispute.containsKey('evidenceCount'), isTrue,
            reason: 'BUG-021: API must include evidenceCount field (not evidenceSubmitted bool)');
      } finally {
        client.close();
      }
    });

    test('GET /api/admin/disputes/:id/evidence returns 200 (BUG-026)', () async {
      // BUG-026: GET /api/admin/disputes/:id/evidence endpoint was missing.
      // Flutter app called this route; it always received 404, breaking the
      // evidence section in dispute detail.
      final client = HttpClient();
      try {
        final request = await client.getUrl(
          Uri.parse('$_apiBase/api/admin/disputes/$_disputeId/evidence'),
        );
        request.headers.add('authorization', 'Bearer $token');
        final response = await request.close();
        expect(response.statusCode, equals(200),
            reason:
                'BUG-026: GET /api/admin/disputes/:id/evidence must return 200');
        final rawBody = await response.transform(utf8.decoder).join();
        // Must be valid JSON (previously returned HTML 404 error page)
        expect(
          () => jsonDecode(rawBody),
          returnsNormally,
          reason: 'Evidence endpoint must return valid JSON, not a 404 page',
        );
      } finally {
        client.close();
      }
    });

    test('POST /api/admin/disputes/:id/generate-bundle returns 200 (BUG-022)',
        () async {
      // BUG-022: generate-bundle returned 500 because evidence.ts called
      // JSON.parse() on plain-text evidence content (not valid JSON).
      // After fix: plain text is passed through without JSON.parse.
      final client = HttpClient();
      try {
        final request = await client.postUrl(
          Uri.parse('$_apiBase/api/admin/disputes/$_disputeId/generate-bundle'),
        );
        request.headers.add('authorization', 'Bearer $token');
        request.headers.contentType = ContentType.json;
        request.write('{}');
        final response = await request.close();
        expect(response.statusCode, equals(200),
            reason:
                'BUG-022: generate-bundle must return 200, not 500 (JSON.parse crash)');
        final body =
            jsonDecode(await response.transform(utf8.decoder).join()) as Map;
        expect(body.containsKey('bundle_id'), isTrue,
            reason: 'generate-bundle response must contain bundle_id');
        expect((body['evidence_count'] as num).toInt(), greaterThan(0),
            reason: 'Bundle must contain at least 1 evidence item');
      } finally {
        client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // UI regression guards
  // ---------------------------------------------------------------------------

  group('T100 admin app disputes UI', () {
    patrolTest(
      'disputes list loads without crash (BUG-021 regression guard)',
      ($) async {
        app.main();
        await $.pumpAndSettle();

        // Sign in
        await $('Email').enterText('admin@kanix.test');
        await $('Password').enterText('TestAdmin123!');
        await $('Sign In').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Dashboard must be visible after login
        expect($('Dashboard'), findsWidgets);

        // Navigate to Disputes
        await $('Disputes').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // BUG-021: before fix, Disputes screen crashed with:
        //   "type 'Null' is not a subtype of type 'String' in type cast"
        // because Dispute.fromJson used wrong field names (stripeDisputeId vs
        // providerDisputeId, evidenceSubmitted bool vs evidenceCount int, etc.)
        // After fix: DataTable renders rows without error.
        expect(
          find.textContaining('Failed to load disputes'),
          findsNothing,
          reason: 'BUG-021: disputes list must not crash with Null cast error',
        );
        expect(
          find.textContaining("type 'Null' is not a subtype"),
          findsNothing,
          reason: 'BUG-021: no type cast error in disputes list',
        );
      },
    );

    patrolTest(
      'dispute detail loads without 404 (BUG-024 + BUG-026 regression guard)',
      ($) async {
        app.main();
        await $.pumpAndSettle();

        // Sign in
        await $('Email').enterText('admin@kanix.test');
        await $('Password').enterText('TestAdmin123!');
        await $('Sign In').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Navigate to Disputes
        await $('Disputes').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Tap a dispute row. The disputes list renders rows with the reason
        // field visible; "fraudulent" is the reason for our seed dispute.
        await $('fraudulent').first.tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // BUG-024: before fix, all dispute detail navigations returned 404
        //   "Route GET:/api/admin/disputes/<id> not found"
        expect(
          find.textContaining('Route GET:/api/admin/disputes'),
          findsNothing,
          reason: 'BUG-024: dispute detail must not show 404 routing error',
        );
        expect(
          find.textContaining('not found'),
          findsNothing,
          reason: 'BUG-024: no "not found" error on dispute detail screen',
        );

        // Dispute detail fields must be present (state: loaded)
        expect($('Amount'), findsWidgets);
        expect($('Reason'), findsWidgets);
        expect($('Evidence Status'), findsWidgets);

        // BUG-026: before fix, evidence section showed:
        //   "Failed to load evidence: DioException [bad response]: 404"
        // because GET /api/admin/disputes/:id/evidence endpoint was missing.
        expect(
          find.textContaining('Failed to load evidence'),
          findsNothing,
          reason: 'BUG-026: evidence section must not show 404 DioException',
        );
        expect(
          find.textContaining('DioException'),
          findsNothing,
          reason: 'BUG-026: no DioException in evidence section',
        );
      },
    );
  });
}
