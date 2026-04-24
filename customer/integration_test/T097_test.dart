// regression for T097
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:kanix_customer/main.dart' as app;

// Navigate back to the login screen from wherever we are.
Future<void> _goToLogin(WidgetTester tester) async {
  // If Already have an account? link is visible, tap it
  if (tester.any(find.text('Already have an account? Sign in'))) {
    await tester.tap(find.text('Already have an account? Sign in'));
    await tester.pumpAndSettle();
  }
}

// Navigate from login to signup.
Future<void> _goToSignup(WidgetTester tester) async {
  await tester.ensureVisible(find.text("Don't have an account? Sign up"));
  await tester.tap(find.text("Don't have an account? Sign up"));
  await tester.pumpAndSettle();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // Launch the app once; subsequent tests share the running instance.
    // We use the first testWidgets' tester implicitly — see note in each test.
  });

  group('T097 — Authenticated checkout regression', () {
    testWidgets('app launches and redirects to login screen', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      // Unauthenticated users should be redirected to login
      expect(find.text('Kanix'), findsWidgets);
      expect(find.text('Sign in to your account'), findsOneWidget);
    });

    testWidgets('login screen has email and password fields', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      // Verify form fields exist
      expect(find.byType(TextFormField), findsAtLeast(2));
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.text('Sign In'), findsOneWidget);
    });

    testWidgets('login form validates empty fields', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      // Tap Sign In without filling fields to trigger validation
      await tester.tap(find.text('Sign In'));
      await tester.pumpAndSettle();

      // Validation errors should appear
      expect(find.text('Email is required'), findsOneWidget);
      expect(find.text('Password is required'), findsOneWidget);
    });

    testWidgets('login form validates invalid email', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      // Enter invalid email
      await tester.enterText(find.byType(TextFormField).first, 'notanemail');
      await tester.tap(find.text('Sign In'));
      await tester.pumpAndSettle();

      expect(find.text('Enter a valid email'), findsOneWidget);
    });

    testWidgets('navigate to signup screen', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      // Scroll down to ensure signup link is visible (form may have errors from prev test)
      await tester.drag(find.byType(SingleChildScrollView).first,
          const Offset(0, -200));
      await tester.pumpAndSettle();

      await _goToSignup(tester);

      // Verify signup screen renders
      expect(find.text('Create Account'), findsOneWidget);
      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.text('Confirm Password'), findsOneWidget);
      expect(find.text('Sign Up'), findsOneWidget);

      // Navigate back to login for next test
      await _goToLogin(tester);
    });

    testWidgets('signup form validates empty fields', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      await tester.drag(find.byType(SingleChildScrollView).first,
          const Offset(0, -200));
      await tester.pumpAndSettle();

      // Navigate to signup
      await _goToSignup(tester);
      expect(find.text('Create Account'), findsOneWidget);

      // Tap Sign Up without filling fields
      await tester.tap(find.text('Sign Up'));
      await tester.pumpAndSettle();

      expect(find.text('Name is required'), findsOneWidget);
      expect(find.text('Email is required'), findsOneWidget);
      expect(find.text('Password is required'), findsOneWidget);

      await _goToLogin(tester);
    });

    testWidgets('signup form validates password mismatch', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      await tester.drag(find.byType(SingleChildScrollView).first,
          const Offset(0, -200));
      await tester.pumpAndSettle();

      // Navigate to signup
      await _goToSignup(tester);
      expect(find.text('Create Account'), findsOneWidget);

      // Fill in form with mismatched passwords — signup has 4 TextFormFields
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Test User');
      await tester.enterText(fields.at(1), 'test@example.com');
      await tester.enterText(fields.at(2), 'password123');
      await tester.enterText(fields.at(3), 'different123');

      await tester.tap(find.text('Sign Up'));
      await tester.pumpAndSettle();

      expect(find.text('Passwords do not match'), findsOneWidget);

      await _goToLogin(tester);
    });

    testWidgets('navigate back to login from signup', (tester) async {
      app.main();
      await tester.pumpAndSettle();

      await tester.drag(find.byType(SingleChildScrollView).first,
          const Offset(0, -200));
      await tester.pumpAndSettle();

      // Go to signup
      await _goToSignup(tester);
      expect(find.text('Create Account'), findsOneWidget);

      // Go back to login
      await tester.tap(find.text('Already have an account? Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Sign in to your account'), findsOneWidget);
    });
  });
}
