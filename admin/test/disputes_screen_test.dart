import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/dispute.dart';
import 'package:kanix_admin/providers/dispute_provider.dart';
import 'package:kanix_admin/screens/disputes_screen.dart';

final _sampleDisputes = [
  Dispute(
    id: 'dispute-1',
    orderId: 'order-1',
    orderNumber: 'KNX-000001',
    stripeDisputeId: 'dp_abc123',
    reason: 'product_not_received',
    status: 'needs_response',
    amountMinor: 5000,
    currency: 'USD',
    evidenceDueBy: DateTime.now().add(const Duration(days: 10)),
    evidenceSubmitted: false,
    createdAt: DateTime(2026, 4, 10),
    updatedAt: DateTime(2026, 4, 12),
  ),
  Dispute(
    id: 'dispute-2',
    orderId: 'order-2',
    orderNumber: 'KNX-000002',
    stripeDisputeId: 'dp_def456',
    reason: 'fraudulent',
    status: 'won',
    amountMinor: 12000,
    currency: 'USD',
    evidenceSubmitted: true,
    createdAt: DateTime(2026, 4, 5),
    updatedAt: DateTime(2026, 4, 15),
  ),
];

final _sampleEvidence = [
  DisputeEvidence(
    id: 'ev-1',
    disputeId: 'dispute-1',
    category: 'shipping_documentation',
    fileName: 'tracking.pdf',
    status: 'ready',
    createdAt: DateTime(2026, 4, 11),
  ),
  DisputeEvidence(
    id: 'ev-2',
    disputeId: 'dispute-1',
    category: 'customer_communication',
    fileName: 'emails.pdf',
    status: 'pending',
    createdAt: DateTime(2026, 4, 12),
  ),
];

void main() {
  group('DisputesScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<Dispute>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider.overrideWith((_) => completer.future),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Disputes'), findsOneWidget);
    });

    testWidgets('displays dispute list when data loads', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.value(_sampleDisputes)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Disputes'), findsOneWidget);
      expect(find.text('dp_abc123'), findsOneWidget);
      expect(find.text('dp_def456'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      expect(find.text('KNX-000002'), findsOneWidget);
      expect(find.text('\$50.00'), findsOneWidget);
      expect(find.text('\$120.00'), findsOneWidget);
    });

    testWidgets('shows empty state when no disputes', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.value(<Dispute>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No disputes found'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load disputes'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('has filter dropdown and search field', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.value(<Dispute>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);
      // Status dropdown
      expect(
          find.byType(DropdownButtonFormField<String>), findsOneWidget);
    });

    testWidgets('data table has correct column headers', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.value(_sampleDisputes)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Dispute ID'), findsOneWidget);
      expect(find.text('Order'), findsOneWidget);
      expect(find.text('Reason'), findsOneWidget);
      expect(find.text('Amount'), findsOneWidget);
      // Status appears in column header and filter label
      expect(find.text('Status'), findsWidgets);
      expect(find.text('Evidence Due'), findsOneWidget);
      expect(find.text('Evidence'), findsOneWidget);
    });

    testWidgets('shows evidence readiness icons', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeListProvider
                .overrideWith((_) => Future.value(_sampleDisputes)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: DisputesScreen())),
        ),
      );
      await tester.pumpAndSettle();

      // First dispute: needs_response with evidence not submitted → pending icon
      expect(find.byIcon(Icons.pending), findsOneWidget);
      // Second dispute: evidence submitted → check_circle icon
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });
  });

  group('DisputeDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final completer = Completer<Dispute>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeDetailProvider('dispute-1')
                .overrideWith((_) => completer.future),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: DisputeDetailScreen(disputeId: 'dispute-1'),
            ),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays dispute detail with evidence', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeDetailProvider('dispute-1')
                .overrideWith((_) => Future.value(_sampleDisputes[0])),
            disputeEvidenceProvider('dispute-1')
                .overrideWith((_) => Future.value(_sampleEvidence)),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: DisputeDetailScreen(disputeId: 'dispute-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Header
      expect(find.textContaining('dp_abc123'), findsOneWidget);

      // Info cards
      expect(find.text('\$50.00'), findsOneWidget);
      expect(find.text('product not received'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);

      // Evidence section
      expect(find.text('Evidence'), findsOneWidget);
      expect(find.text('Generate Bundle'), findsOneWidget);

      // Evidence table
      expect(find.text('shipping documentation'), findsOneWidget);
      expect(find.text('tracking.pdf'), findsOneWidget);
      expect(find.text('customer communication'), findsOneWidget);
      expect(find.text('emails.pdf'), findsOneWidget);
    });

    testWidgets('shows generate bundle button only for needs_response',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      // Won dispute should NOT show generate bundle
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeDetailProvider('dispute-2')
                .overrideWith((_) => Future.value(_sampleDisputes[1])),
            disputeEvidenceProvider('dispute-2')
                .overrideWith((_) => Future.value(<DisputeEvidence>[])),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: DisputeDetailScreen(disputeId: 'dispute-2'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Generate Bundle'), findsNothing);
    });

    testWidgets('shows empty evidence state', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            disputeDetailProvider('dispute-1')
                .overrideWith((_) => Future.value(_sampleDisputes[0])),
            disputeEvidenceProvider('dispute-1')
                .overrideWith((_) => Future.value(<DisputeEvidence>[])),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: DisputeDetailScreen(disputeId: 'dispute-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No evidence uploaded yet'), findsOneWidget);
    });
  });
}
