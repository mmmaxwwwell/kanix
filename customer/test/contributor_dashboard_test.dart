import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/contributor.dart';
import 'package:kanix_customer/providers/auth_provider.dart';
import 'package:kanix_customer/providers/contributor_provider.dart';
import 'package:kanix_customer/screens/contributor_dashboard_screen.dart';

final _now = DateTime(2026, 1, 15, 10, 30);

ContributorDashboardData _makeDashboard({
  int totalDesigns = 3,
  int totalSales = 42,
  int totalRoyaltyAccruedCents = 12050,
  int totalPaidOutCents = 8000,
  List<ContributorDesign>? designs,
  List<ContributorMilestone>? milestones,
  List<ContributorPayout>? payouts,
}) {
  return ContributorDashboardData(
    totalDesigns: totalDesigns,
    totalSales: totalSales,
    totalRoyaltyAccruedCents: totalRoyaltyAccruedCents,
    totalPaidOutCents: totalPaidOutCents,
    designs: designs ??
        [
          const ContributorDesign(
            id: 'd1',
            name: 'Plate Mount v3',
            slug: 'plate-mount-v3',
            totalSales: 25,
            royaltyAccruedCents: 7500,
          ),
          const ContributorDesign(
            id: 'd2',
            name: 'Switch Holder Pro',
            slug: 'switch-holder-pro',
            totalSales: 17,
            royaltyAccruedCents: 4550,
          ),
        ],
    milestones: milestones ??
        [
          const ContributorMilestone(
            id: 'm1',
            name: 'First 10 Sales',
            description: 'Reach 10 total sales',
            targetSales: 10,
            currentSales: 10,
            bonusCents: 500,
            achieved: true,
          ),
          const ContributorMilestone(
            id: 'm2',
            name: '50 Sales Club',
            description: 'Reach 50 total sales',
            targetSales: 50,
            currentSales: 42,
            bonusCents: 2500,
            achieved: false,
          ),
        ],
    payouts: payouts ??
        [
          ContributorPayout(
            id: 'p1',
            amountCents: 5000,
            status: 'completed',
            paidAt: _now.subtract(const Duration(days: 30)),
          ),
          ContributorPayout(
            id: 'p2',
            amountCents: 3000,
            status: 'pending',
            paidAt: _now.subtract(const Duration(days: 5)),
          ),
        ],
  );
}

AuthState _authedState({String? githubLinked}) {
  return AuthState(
    user: CustomerUser(
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      githubLinked: githubLinked,
    ),
  );
}

void main() {
  group('ContributorDashboardScreen', () {
    testWidgets('shows GitHub not linked message when not linked',
        (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider
                .overrideWith(() => _MockAuthNotifier(githubLinked: null)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Contributor Dashboard'), findsOneWidget);
      expect(find.text('GitHub account not linked'), findsOneWidget);
      expect(find.text('Link GitHub Account'), findsOneWidget);
    });

    testWidgets('shows dashboard when GitHub is linked', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final dashboard = _makeDashboard();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => Future.value(dashboard)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Contributor Dashboard'), findsOneWidget);

      // Summary cards
      expect(find.text('3'), findsOneWidget);
      expect(find.text('Designs'), findsAtLeast(1));
      expect(find.text('42'), findsOneWidget);
      expect(find.text('Total Sales'), findsOneWidget);
      expect(find.text('\$120.50'), findsOneWidget);
      expect(find.text('Royalty Accrued'), findsOneWidget);
      expect(find.text('\$80.00'), findsOneWidget);
      expect(find.text('Total Paid Out'), findsOneWidget);
    });

    testWidgets('shows designs with sales and royalty', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final dashboard = _makeDashboard();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => Future.value(dashboard)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Design names
      expect(find.text('Plate Mount v3'), findsOneWidget);
      expect(find.text('Switch Holder Pro'), findsOneWidget);

      // Per-design sales
      expect(find.text('25 sales'), findsOneWidget);
      expect(find.text('17 sales'), findsOneWidget);

      // Per-design royalty
      expect(find.text('\$75.00'), findsOneWidget);
      expect(find.text('\$45.50'), findsOneWidget);
    });

    testWidgets('shows milestones with progress bars', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final dashboard = _makeDashboard();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => Future.value(dashboard)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Milestone names
      expect(find.text('Milestones'), findsOneWidget);
      expect(find.text('First 10 Sales'), findsOneWidget);
      expect(find.text('50 Sales Club'), findsOneWidget);

      // Descriptions
      expect(find.text('Reach 10 total sales'), findsOneWidget);
      expect(find.text('Reach 50 total sales'), findsOneWidget);

      // Progress bars
      expect(find.byType(LinearProgressIndicator), findsNWidgets(2));

      // Achieved milestone shows check icon
      expect(find.byIcon(Icons.check_circle), findsOneWidget);

      // Incomplete milestone shows progress text
      expect(find.text('42/50'), findsOneWidget);

      // Bonus amounts
      expect(find.text('Bonus: \$5.00'), findsOneWidget);
      expect(find.text('Bonus: \$25.00'), findsOneWidget);
    });

    testWidgets('shows payout history', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final dashboard = _makeDashboard();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => Future.value(dashboard)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Payout History'), findsOneWidget);

      // Payout amounts
      expect(find.text('\$50.00'), findsOneWidget);
      expect(find.text('\$30.00'), findsOneWidget);

      // Status badges
      expect(find.text('Completed'), findsOneWidget);
      expect(find.text('Pending'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<ContributorDashboardData>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete(_makeDashboard());
      await tester.pumpAndSettle();
    });

    testWidgets('shows error state', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider.overrideWith((_) =>
                Future<ContributorDashboardData>.error('Network error')),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load dashboard'), findsOneWidget);
    });

    testWidgets('shows empty designs state', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final dashboard = _makeDashboard(
        totalDesigns: 0,
        totalSales: 0,
        totalRoyaltyAccruedCents: 0,
        totalPaidOutCents: 0,
        designs: [],
        milestones: [],
        payouts: [],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(
                () => _MockAuthNotifier(githubLinked: 'octocat')),
            contributorDashboardProvider
                .overrideWith((_) => Future.value(dashboard)),
          ],
          child: const MaterialApp(home: ContributorDashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No designs yet'), findsOneWidget);
      expect(find.text('No milestones yet'), findsOneWidget);
      expect(find.text('No payouts yet'), findsOneWidget);
    });
  });
}

class _MockAuthNotifier extends AsyncNotifier<AuthState>
    implements AuthNotifier {
  final String? githubLinked;

  _MockAuthNotifier({this.githubLinked});

  @override
  Future<AuthState> build() async {
    return _authedState(githubLinked: githubLinked);
  }

  @override
  Future<void> signUp(String email, String password, String name) async {}
  @override
  Future<void> signIn(String email, String password) async {}
  @override
  Future<void> verifyEmail(String token) async {}
  @override
  Future<void> resendVerificationEmail() async {}
  @override
  Future<void> linkGitHub() async {}
  @override
  Future<void> signOut() async {}
}
