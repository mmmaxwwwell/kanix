// regression for T099
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

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // ---------------------------------------------------------------------------
  // Backend smoke checks (no UI needed)
  // ---------------------------------------------------------------------------

  group('T099 backend API smoke', () {
    test('POST /api/test/seed-paid-order returns 201', () async {
      final client = HttpClient();
      try {
        final request = await client.postUrl(Uri.parse('$_apiBase/api/test/seed-paid-order'));
        request.headers.contentType = ContentType.json;
        request.write('{}');
        final response = await request.close();
        expect(response.statusCode, equals(201),
            reason: 'seed-paid-order must return 201');
        final body = await response.transform(utf8.decoder).join();
        final json = jsonDecode(body) as Map<String, dynamic>;
        expect(json.containsKey('order_id'), isTrue,
            reason: 'Response must contain order_id');
        expect(json.containsKey('order_number'), isTrue,
            reason: 'Response must contain order_number');
        expect(json['payment_status'], equals('paid'),
            reason: 'Seeded order must have payment_status=paid');
      } finally {
        client.close();
      }
    });

    test('GET /api/admin/fulfillment-tasks requires auth (returns 401 without token)', () async {
      final client = HttpClient();
      try {
        final request =
            await client.getUrl(Uri.parse('$_apiBase/api/admin/fulfillment-tasks'));
        final response = await request.close();
        // Without auth we expect 401, confirming the endpoint exists and is protected
        expect(response.statusCode, equals(401),
            reason: 'fulfillment-tasks must require authentication');
      } finally {
        client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // UI flows
  // ---------------------------------------------------------------------------

  group('T099 admin app fulfillment & shipments screens', () {
    patrolTest(
      'login screen shows email, password, and Sign In',
      ($) async {
        app.main();
        await $.pumpAndSettle();

        // Heading
        expect($('Kanix Admin'), findsWidgets);

        // Form fields
        expect($('Email'), findsWidgets);
        expect($('Password'), findsWidgets);
        expect($('Sign In'), findsOneWidget);
      },
    );

    patrolTest(
      'login → Fulfillment Queue shows expected DataTable columns',
      ($) async {
        app.main();
        await $.pumpAndSettle();

        // Sign in
        await $('Email').enterText('admin@kanix.test');
        await $('Password').enterText('TestAdmin123!');
        await $('Sign In').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Navigate to Fulfillment
        await $('Fulfillment').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Verify heading
        expect($('Fulfillment Queue'), findsWidgets);

        // Verify DataTable column headers (behavioral: these are the contract
        // columns the fulfillment workflow depends on)
        expect($('Order #'), findsWidgets);
        expect($('Status'), findsWidgets);
        expect($('Priority'), findsWidgets);
        expect($('Assigned To'), findsWidgets);
        expect($('Created'), findsWidgets);
        expect($('Actions'), findsWidgets);
      },
    );

    patrolTest(
      'login → Shipments screen shows expected DataTable columns',
      ($) async {
        app.main();
        await $.pumpAndSettle();

        // Sign in
        await $('Email').enterText('admin@kanix.test');
        await $('Password').enterText('TestAdmin123!');
        await $('Sign In').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Navigate to Shipments
        await $('Shipments').tap();
        await $.pumpAndSettle(timeout: const Duration(seconds: 10));

        // Verify heading
        expect($('Shipments'), findsWidgets);

        // Verify DataTable column headers
        expect($('Order #'), findsWidgets);
        expect($('Status'), findsWidgets);
        expect($('Carrier'), findsWidgets);
        expect($('Service'), findsWidgets);
        expect($('Tracking #'), findsWidgets);
        expect($('Rate'), findsWidgets);
        expect($('Created'), findsWidgets);
      },
    );
  });
}
