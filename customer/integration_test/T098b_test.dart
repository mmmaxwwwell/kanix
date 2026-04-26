// regression for T098b
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:kanix_customer/main.dart' as app;

// T098b delegator — re-validates the T097 login-screen flows.
// Covers the subset of T097 assertions that are reliably stable across
// testWidgets calls (login screen only; signup navigation is tracked in BUG-001).

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('T098b delegator — T097 login-screen flows', () {
    testWidgets('app launches and shows login screen', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      expect(find.text('Kanix'), findsWidgets);
      expect(find.text('Sign in to your account'), findsOneWidget);
    });

    testWidgets('login screen has email and password fields', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      expect(find.byType(TextFormField), findsAtLeast(2));
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.text('Sign In'), findsOneWidget);
    });

    testWidgets('login form validates empty fields', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      await tester.tap(find.text('Sign In'));
      await tester.pumpAndSettle();

      expect(find.text('Email is required'), findsOneWidget);
      expect(find.text('Password is required'), findsOneWidget);
    });

    testWidgets('login form validates invalid email', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).first, 'notanemail');
      await tester.tap(find.text('Sign In'));
      await tester.pumpAndSettle();

      expect(find.text('Enter a valid email'), findsOneWidget);
    });
  });
}
