import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/providers/dashboard_provider.dart';
import 'package:kanix_admin/screens/dashboard_screen.dart';

void main() {
  group('DashboardSummary', () {
    test('fromJson parses all fields', () {
      final summary = DashboardSummary.fromJson({
        'ordersAwaitingFulfillment': 5,
        'openSupportTickets': 3,
        'lowStockVariants': 7,
        'openDisputes': 2,
        'shipmentsWithExceptions': 1,
      });
      expect(summary.ordersAwaitingFulfillment, 5);
      expect(summary.openSupportTickets, 3);
      expect(summary.lowStockVariants, 7);
      expect(summary.openDisputes, 2);
      expect(summary.shipmentsWithExceptions, 1);
    });
  });

  group('DashboardScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      // Use a Completer that never completes to simulate loading state
      final completer = Completer<DashboardSummary>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardSummaryProvider
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: DashboardScreen()),
        ),
      );
      // After first pump, should be in loading state
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Dashboard'), findsOneWidget);
    });

    testWidgets('displays counts and quick-link cards when data is loaded',
        (tester) async {
      const summary = DashboardSummary(
        ordersAwaitingFulfillment: 12,
        openSupportTickets: 4,
        lowStockVariants: 8,
        openDisputes: 3,
        shipmentsWithExceptions: 1,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardSummaryProvider
                .overrideWith((_) => Future.value(summary)),
          ],
          child: const MaterialApp(home: DashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Title
      expect(find.text('Dashboard'), findsOneWidget);

      // Each count should appear
      expect(find.text('12'), findsOneWidget);
      expect(find.text('4'), findsOneWidget);
      expect(find.text('8'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);

      // Card titles
      expect(find.text('Orders Awaiting Fulfillment'), findsOneWidget);
      expect(find.text('Open Support Tickets'), findsOneWidget);
      expect(find.text('Low Stock Variants'), findsOneWidget);
      expect(find.text('Open Disputes'), findsOneWidget);
      expect(find.text('Shipment Exceptions'), findsOneWidget);

      // 5 cards rendered
      expect(find.byType(Card), findsNWidgets(5));
    });

    testWidgets('shows zero counts correctly', (tester) async {
      const summary = DashboardSummary(
        ordersAwaitingFulfillment: 0,
        openSupportTickets: 0,
        lowStockVariants: 0,
        openDisputes: 0,
        shipmentsWithExceptions: 0,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardSummaryProvider
                .overrideWith((_) => Future.value(summary)),
          ],
          child: const MaterialApp(home: DashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // All five 0 counts displayed
      expect(find.text('0'), findsNWidgets(5));
    });

    testWidgets('shows error state with retry button', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardSummaryProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(home: DashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load dashboard'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
    });

    testWidgets('cards have correct icons', (tester) async {
      const summary = DashboardSummary(
        ordersAwaitingFulfillment: 1,
        openSupportTickets: 1,
        lowStockVariants: 1,
        openDisputes: 1,
        shipmentsWithExceptions: 1,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardSummaryProvider
                .overrideWith((_) => Future.value(summary)),
          ],
          child: const MaterialApp(home: DashboardScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.receipt_long), findsOneWidget);
      expect(find.byIcon(Icons.support_agent), findsOneWidget);
      expect(find.byIcon(Icons.inventory_2), findsOneWidget);
      expect(find.byIcon(Icons.gavel), findsOneWidget);
      expect(find.byIcon(Icons.local_shipping), findsOneWidget);
    });
  });
}
