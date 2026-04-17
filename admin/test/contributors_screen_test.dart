import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/contributor.dart';
import 'package:kanix_admin/providers/contributor_provider.dart';
import 'package:kanix_admin/screens/contributors_screen.dart';

final _sampleContributors = [
  Contributor(
    id: 'contrib-1',
    githubUsername: 'alice-dev',
    displayName: 'Alice Developer',
    email: 'alice@example.com',
    royaltyStatus: 'active',
    royaltyRate: 0.10,
    totalEarned: 1250.50,
    totalPaid: 1000.00,
    pendingBalance: 250.50,
    productCount: 3,
    createdAt: DateTime(2025, 6, 1),
    updatedAt: DateTime(2026, 4, 10),
  ),
  Contributor(
    id: 'contrib-2',
    githubUsername: 'bob-maker',
    displayName: null,
    email: null,
    royaltyStatus: 'paused',
    royaltyRate: 0.05,
    totalEarned: 320.00,
    totalPaid: 320.00,
    pendingBalance: 0.00,
    productCount: 1,
    createdAt: DateTime(2025, 9, 15),
    updatedAt: DateTime(2026, 3, 20),
  ),
];

void main() {
  group('ContributorsScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final completer = Completer<List<Contributor>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Contributors'), findsOneWidget);
    });

    testWidgets('displays contributor list with data', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => Future.value(_sampleContributors)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Contributors'), findsOneWidget);
      expect(find.text('alice-dev'), findsOneWidget);
      expect(find.text('Alice Developer'), findsOneWidget);
      expect(find.text('bob-maker'), findsOneWidget);
      expect(find.text(r'$1250.50'), findsOneWidget);
      expect(find.text(r'$250.50'), findsOneWidget);
      expect(find.text('10%'), findsOneWidget);
      expect(find.text('5%'), findsOneWidget);
    });

    testWidgets('shows empty state when no contributors', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => Future.value(<Contributor>[])),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No contributors found'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load contributors'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('data table has correct column headers', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => Future.value(_sampleContributors)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('GitHub Username'), findsOneWidget);
      expect(find.text('Display Name'), findsOneWidget);
      expect(find.text('Royalty Status'), findsOneWidget);
      expect(find.text('Royalty Rate'), findsOneWidget);
      expect(find.text('Total Earned'), findsOneWidget);
      expect(find.text('Pending Balance'), findsOneWidget);
      expect(find.text('Products'), findsOneWidget);
    });

    testWidgets('shows royalty status chips with correct labels',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorListProvider
                .overrideWith((_) => Future.value(_sampleContributors)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ContributorsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('active'), findsOneWidget);
      expect(find.text('paused'), findsOneWidget);
    });
  });

  group('ContributorDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final completer = Completer<Contributor>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorDetailProvider('contrib-1')
                .overrideWith((_) => completer.future),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: ContributorDetailScreen(contributorId: 'contrib-1'),
            ),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays contributor detail with royalty summary',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorDetailProvider('contrib-1')
                .overrideWith((_) => Future.value(_sampleContributors[0])),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: ContributorDetailScreen(contributorId: 'contrib-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Header
      expect(find.text('Alice Developer'), findsOneWidget);
      expect(find.text('active'), findsOneWidget);

      // Info items
      expect(find.text('alice-dev'), findsOneWidget);
      expect(find.text('alice@example.com'), findsOneWidget);
      expect(find.text('10%'), findsOneWidget);

      // Royalty summary
      expect(find.text('Total Earned'), findsOneWidget);
      expect(find.text(r'$1250.50'), findsOneWidget);
      expect(find.text('Total Paid'), findsOneWidget);
      expect(find.text(r'$1000.00'), findsOneWidget);
      expect(find.text('Pending Balance'), findsOneWidget);
      expect(find.text(r'$250.50'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            contributorDetailProvider('contrib-1')
                .overrideWith((_) => Future.error('Not found')),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: ContributorDetailScreen(contributorId: 'contrib-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load contributor'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });
}
