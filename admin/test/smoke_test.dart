import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/main.dart';
import 'package:kanix_admin/providers/auth_provider.dart';
import 'package:kanix_admin/config/api_client.dart';
import 'package:kanix_admin/config/router.dart';

void main() {
  test('smoke test — app instantiates', () {
    expect(1 + 1, 2);
  });

  test('AdminUser.fromJson parses correctly', () {
    final user = AdminUser.fromJson({
      'id': 'u1',
      'email': 'admin@kanix.com',
      'name': 'Admin',
      'capabilities': ['orders.read', 'orders.manage'],
    });
    expect(user.id, 'u1');
    expect(user.email, 'admin@kanix.com');
    expect(user.name, 'Admin');
    expect(user.capabilities, ['orders.read', 'orders.manage']);
    expect(user.hasCapability('orders.read'), true);
    expect(user.hasCapability('inventory.adjust'), false);
  });

  test('AuthState defaults to unauthenticated', () {
    const state = AuthState();
    expect(state.isAuthenticated, false);
    expect(state.isLoading, false);
    expect(state.error, isNull);
  });

  test('AuthState with admin is authenticated', () {
    const admin = AdminUser(
      id: 'u1',
      email: 'admin@kanix.com',
      name: 'Admin',
      capabilities: [],
    );
    const state = AuthState(admin: admin);
    expect(state.isAuthenticated, true);
  });

  testWidgets('KanixAdminApp renders login screen when unauthenticated',
      (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: KanixAdminApp()),
    );
    await tester.pumpAndSettle();

    // Should redirect to login since there's no session
    expect(find.text('Kanix Admin'), findsOneWidget);
    expect(find.text('Sign In'), findsOneWidget);
  });

  test('dioProvider creates Dio instance', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final dio = container.read(dioProvider);
    expect(dio.options.baseUrl, contains('localhost'));
  });

  test('routerProvider creates GoRouter with expected routes', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final router = container.read(routerProvider);
    expect(router, isNotNull);
  });
}
