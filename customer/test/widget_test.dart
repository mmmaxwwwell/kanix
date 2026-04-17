import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/main.dart';
import 'package:kanix_customer/providers/auth_provider.dart';

void main() {
  testWidgets('App launches and shows login screen', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider.overrideWith(() => _MockAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Kanix'), findsOneWidget);
    expect(find.text('Sign In'), findsOneWidget);
  });

  testWidgets('Login screen has email and password fields', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider.overrideWith(() => _MockAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.widgetWithText(TextFormField, 'Email'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Password'), findsOneWidget);
  });

  testWidgets('Login screen has sign up link', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider.overrideWith(() => _MockAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Don't have an account? Sign up"), findsOneWidget);
  });

  testWidgets('Navigates to signup screen', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider.overrideWith(() => _MockAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text("Don't have an account? Sign up"));
    await tester.pumpAndSettle();

    expect(find.text('Create Account'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Name'), findsOneWidget);
  });

  testWidgets('Shows catalog when authenticated', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider
              .overrideWith(() => _AuthenticatedAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Catalog'), findsWidgets);
  });

  testWidgets('Shows email verification when pending', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider
              .overrideWith(() => _PendingVerificationAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Verify Your Email'), findsOneWidget);
  });

  testWidgets('Bottom navigation shows 4 destinations when authenticated',
      (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStateProvider
              .overrideWith(() => _AuthenticatedAuthNotifier()),
        ],
        child: const KanixCustomerApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.text('Catalog'), findsWidgets);
    expect(find.text('Cart'), findsWidgets);
    expect(find.text('Orders'), findsWidgets);
    expect(find.text('Account'), findsWidgets);
  });
}

class _MockAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() async => const AuthState();
}

class _AuthenticatedAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() async => const AuthState(
        user: CustomerUser(
          id: 'test-id',
          email: 'test@example.com',
          name: 'Test User',
          emailVerified: true,
        ),
      );
}

class _PendingVerificationAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() async =>
      const AuthState(pendingVerification: true);
}
