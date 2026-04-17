import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/support.dart';
import 'package:kanix_admin/providers/support_provider.dart';
import 'package:kanix_admin/screens/support_screen.dart';

final _sampleTickets = [
  SupportTicket(
    id: 'ticket-1',
    ticketNumber: 'TKT-000001',
    orderId: 'order-1',
    customerId: 'cust-1',
    customerEmail: 'alice@example.com',
    subject: 'Missing item in order',
    status: 'open',
    priority: 'high',
    createdAt: DateTime(2026, 4, 10),
    updatedAt: DateTime(2026, 4, 12),
  ),
  SupportTicket(
    id: 'ticket-2',
    ticketNumber: 'TKT-000002',
    customerEmail: 'bob@example.com',
    subject: 'Refund request',
    status: 'awaiting_customer',
    priority: 'normal',
    createdAt: DateTime(2026, 4, 8),
    updatedAt: DateTime(2026, 4, 11),
  ),
];

final _sampleMessages = [
  TicketMessage(
    id: 'msg-1',
    ticketId: 'ticket-1',
    senderType: 'customer',
    senderCustomerId: 'cust-1',
    body: 'I am missing an item from my order.',
    isInternal: false,
    createdAt: DateTime(2026, 4, 10, 10, 0),
  ),
  TicketMessage(
    id: 'msg-2',
    ticketId: 'ticket-1',
    senderType: 'admin',
    senderAdminId: 'admin-1',
    body: 'Looking into this for you.',
    isInternal: false,
    createdAt: DateTime(2026, 4, 10, 11, 30),
  ),
  TicketMessage(
    id: 'msg-3',
    ticketId: 'ticket-1',
    senderType: 'admin',
    senderAdminId: 'admin-1',
    body: 'Check warehouse logs for this order.',
    isInternal: true,
    createdAt: DateTime(2026, 4, 10, 11, 35),
  ),
];

void main() {
  group('SupportScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<SupportTicket>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider.overrideWith((_) => completer.future),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Support Tickets'), findsOneWidget);
    });

    testWidgets('displays ticket list when data loads', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(_sampleTickets)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Support Tickets'), findsOneWidget);
      expect(find.text('TKT-000001'), findsOneWidget);
      expect(find.text('TKT-000002'), findsOneWidget);
      expect(find.text('alice@example.com'), findsOneWidget);
      expect(find.text('bob@example.com'), findsOneWidget);
      expect(find.text('Missing item in order'), findsOneWidget);
      expect(find.text('Refund request'), findsOneWidget);
    });

    testWidgets('shows empty state when no tickets', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(<SupportTicket>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No tickets found'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load tickets'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('has filter dropdowns and search field', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(<SupportTicket>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);
      // Status + Priority dropdowns
      expect(
          find.byType(DropdownButtonFormField<String>), findsNWidgets(2));
    });

    testWidgets('data table has correct column headers', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(_sampleTickets)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: SupportScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ticket #'), findsOneWidget);
      expect(find.text('Subject'), findsOneWidget);
      expect(find.text('Customer'), findsOneWidget);
      // Status appears in column header and filter label
      expect(find.text('Status'), findsWidgets);
      // Priority appears in column header and filter label
      expect(find.text('Priority'), findsWidgets);
      expect(find.text('Updated'), findsOneWidget);
    });
  });

  group('SupportDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final completer = Completer<SupportTicket>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => completer.future),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: SupportDetailScreen(ticketId: 'ticket-1'),
            ),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays ticket detail with messages', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(_sampleTickets[0])),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(_sampleMessages)),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: SupportDetailScreen(ticketId: 'ticket-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Header info
      expect(find.textContaining('TKT-000001'), findsOneWidget);
      expect(find.textContaining('Missing item in order'), findsOneWidget);

      // Messages
      expect(find.text('I am missing an item from my order.'),
          findsOneWidget);
      expect(
          find.text('Looking into this for you.'), findsOneWidget);
      expect(find.text('Check warehouse logs for this order.'),
          findsOneWidget);

      // Internal note badge
      expect(find.text('Internal Note'), findsOneWidget);

      // Reply bar
      expect(find.text('Internal'), findsOneWidget);
      expect(find.byIcon(Icons.send), findsOneWidget);
    });

    testWidgets('shows empty message state', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(_sampleTickets[0])),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(<TicketMessage>[])),
          ],
          child: MaterialApp(
            home: const Scaffold(
              body: SupportDetailScreen(ticketId: 'ticket-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No messages yet'), findsOneWidget);
    });
  });
}
