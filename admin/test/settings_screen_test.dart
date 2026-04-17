import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/admin_user_management.dart';
import 'package:kanix_admin/providers/settings_provider.dart';
import 'package:kanix_admin/screens/settings_screen.dart';

final _sampleUsers = [
  ManagedAdminUser(
    id: 'admin-1',
    email: 'alice@kanix.dev',
    name: 'Alice Admin',
    role: 'super_admin',
    capabilities: ['orders', 'fulfillment', 'support', 'settings'],
    isActive: true,
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 4, 10),
  ),
  ManagedAdminUser(
    id: 'admin-2',
    email: 'bob@kanix.dev',
    name: 'Bob Support',
    role: 'support',
    capabilities: ['support'],
    isActive: false,
    createdAt: DateTime(2026, 2, 15),
    updatedAt: DateTime(2026, 4, 5),
  ),
];

final _sampleRoles = [
  const AdminRole(
    id: 'role-1',
    name: 'super_admin',
    description: 'Full access to all admin features',
    permissions: ['orders.read', 'orders.write', 'settings.manage', 'users.manage'],
  ),
  const AdminRole(
    id: 'role-2',
    name: 'support',
    description: 'Access to support tickets and disputes',
    permissions: ['tickets.read', 'tickets.write', 'disputes.read'],
  ),
];

void main() {
  group('SettingsScreen', () {
    testWidgets('shows tabs for Admin Users and Roles & Permissions',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(_sampleUsers)),
            adminRolesProvider
                .overrideWith((_) => Future.value(_sampleRoles)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Settings'), findsOneWidget);
      expect(find.text('Admin Users'), findsOneWidget);
      expect(find.text('Roles & Permissions'), findsOneWidget);
    });

    testWidgets('shows loading indicator while fetching admin users',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final completer = Completer<List<ManagedAdminUser>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider.overrideWith((_) => completer.future),
            adminRolesProvider
                .overrideWith((_) => Future.value(<AdminRole>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays admin users table with data', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(_sampleUsers)),
            adminRolesProvider
                .overrideWith((_) => Future.value(_sampleRoles)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Alice Admin'), findsOneWidget);
      expect(find.text('alice@kanix.dev'), findsOneWidget);
      expect(find.text('Bob Support'), findsOneWidget);
      expect(find.text('bob@kanix.dev'), findsOneWidget);
      expect(find.text('Active'), findsOneWidget);
      expect(find.text('Inactive'), findsOneWidget);
    });

    testWidgets('has correct column headers in users table',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(_sampleUsers)),
            adminRolesProvider
                .overrideWith((_) => Future.value(_sampleRoles)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Role'), findsWidgets);
      // Status appears in column header and chip
      expect(find.text('Status'), findsOneWidget);
      expect(find.text('Capabilities'), findsOneWidget);
      expect(find.text('Created'), findsOneWidget);
    });

    testWidgets('shows empty state when no admin users', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(<ManagedAdminUser>[])),
            adminRolesProvider
                .overrideWith((_) => Future.value(<AdminRole>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No admin users found'), findsOneWidget);
    });

    testWidgets('shows error state with retry for admin users',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.error('Network error')),
            adminRolesProvider
                .overrideWith((_) => Future.value(<AdminRole>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load admin users'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('shows Add Admin button', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(_sampleUsers)),
            adminRolesProvider
                .overrideWith((_) => Future.value(_sampleRoles)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Add Admin'), findsOneWidget);
    });

    testWidgets('roles tab shows roles with permissions', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminUsersProvider
                .overrideWith((_) => Future.value(_sampleUsers)),
            adminRolesProvider
                .overrideWith((_) => Future.value(_sampleRoles)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SettingsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      // Switch to Roles tab
      await tester.tap(find.text('Roles & Permissions'));
      await tester.pumpAndSettle();

      expect(find.text('Full access to all admin features'),
          findsOneWidget);
      expect(find.text('Access to support tickets and disputes'),
          findsOneWidget);
      expect(find.text('orders.read'), findsOneWidget);
      expect(find.text('settings.manage'), findsOneWidget);
      expect(find.text('tickets.read'), findsOneWidget);
    });
  });
}
