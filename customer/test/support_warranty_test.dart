import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/product.dart';
import 'package:kanix_customer/models/support.dart';
import 'package:kanix_customer/providers/support_provider.dart';
import 'package:kanix_customer/screens/support_screen.dart';
import 'package:kanix_customer/screens/warranty_screen.dart';

final _now = DateTime(2026, 1, 15, 10, 30);

SupportTicket _makeTicket({
  String id = 'ticket-1',
  String ticketNumber = 'TKT-1001',
  String subject = 'Product issue',
  String status = 'open',
  String priority = 'normal',
}) {
  return SupportTicket(
    id: id,
    ticketNumber: ticketNumber,
    subject: subject,
    status: status,
    priority: priority,
    createdAt: _now,
    updatedAt: _now,
  );
}

TicketMessage _makeMessage({
  String id = 'msg-1',
  String ticketId = 'ticket-1',
  String senderType = 'customer',
  String body = 'Hello, I need help.',
  List<MessageAttachment> attachments = const [],
}) {
  return TicketMessage(
    id: id,
    ticketId: ticketId,
    senderType: senderType,
    body: body,
    attachments: attachments,
    createdAt: _now,
  );
}

WarrantyClaim _makeClaim({
  String id = 'claim-1',
  String claimNumber = 'WRN-001',
  String orderId = 'order-1',
  String orderNumber = 'KNX-1001',
  String productTitle = 'Test Widget',
  String material = 'TPU',
  String status = 'pending',
  String defectDescription = 'Product cracked under normal use',
  DateTime? orderDate,
  DateTime? warrantyExpiresAt,
}) {
  final oDate = orderDate ?? _now.subtract(const Duration(days: 30));
  return WarrantyClaim(
    id: id,
    claimNumber: claimNumber,
    orderId: orderId,
    orderNumber: orderNumber,
    productTitle: productTitle,
    material: material,
    status: status,
    defectDescription: defectDescription,
    photoUrls: ['photo1.jpg', 'photo2.jpg'],
    warrantyPeriod: '1 year',
    orderDate: oDate,
    warrantyExpiresAt:
        warrantyExpiresAt ?? oDate.add(const Duration(days: 365)),
    createdAt: _now,
    updatedAt: _now,
  );
}

void main() {
  group('SupportScreen', () {
    testWidgets('shows ticket list with status badges', (tester) async {
      final tickets = [
        _makeTicket(
          id: 't1',
          ticketNumber: 'TKT-1001',
          subject: 'Broken part',
          status: 'open',
        ),
        _makeTicket(
          id: 't2',
          ticketNumber: 'TKT-1002',
          subject: 'Shipping delay',
          status: 'awaiting_customer',
        ),
        _makeTicket(
          id: 't3',
          ticketNumber: 'TKT-1003',
          subject: 'Refund request',
          status: 'resolved',
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(tickets)),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Support'), findsOneWidget);
      expect(find.text('Broken part'), findsOneWidget);
      expect(find.text('Shipping delay'), findsOneWidget);
      expect(find.text('Refund request'), findsOneWidget);

      // Status badges
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Awaiting Response'), findsOneWidget);
      expect(find.text('Resolved'), findsOneWidget);

      // Ticket numbers
      expect(find.text('#TKT-1001'), findsOneWidget);
      expect(find.text('#TKT-1002'), findsOneWidget);
      expect(find.text('#TKT-1003'), findsOneWidget);
    });

    testWidgets('shows empty state when no tickets', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(<SupportTicket>[])),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No support tickets'), findsOneWidget);
      expect(find.text('Create Ticket'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<List<SupportTicket>>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete([]);
      await tester.pumpAndSettle();
    });

    testWidgets('shows error state', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider.overrideWith((_) =>
                Future<List<SupportTicket>>.error('Network error')),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load tickets'), findsOneWidget);
    });

    testWidgets('shows create ticket FAB', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(<SupportTicket>[])),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(FloatingActionButton), findsOneWidget);
    });

    testWidgets('shows all ticket statuses', (tester) async {
      final tickets = [
        _makeTicket(
            id: 't1', ticketNumber: 'TKT-001', status: 'open',
            subject: 'Open ticket'),
        _makeTicket(
            id: 't2', ticketNumber: 'TKT-002', status: 'awaiting_admin',
            subject: 'Admin ticket'),
        _makeTicket(
            id: 't3', ticketNumber: 'TKT-003', status: 'closed',
            subject: 'Closed ticket'),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketListProvider
                .overrideWith((_) => Future.value(tickets)),
          ],
          child: const MaterialApp(home: SupportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Open'), findsOneWidget);
      expect(find.text('In Review'), findsOneWidget);
      expect(find.text('Closed'), findsOneWidget);
    });
  });

  group('SupportDetailScreen', () {
    testWidgets('shows ticket detail with messages', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final ticket = _makeTicket(
        subject: 'Product defect issue',
        status: 'open',
      );
      final messages = [
        _makeMessage(
          id: 'msg-1',
          senderType: 'customer',
          body: 'I received a broken part.',
        ),
        _makeMessage(
          id: 'msg-2',
          senderType: 'admin',
          body: 'Sorry to hear that. Can you send photos?',
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(ticket)),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(messages)),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'ticket-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ticket Detail'), findsOneWidget);
      expect(find.text('Product defect issue'), findsOneWidget);
      expect(find.text('Open'), findsOneWidget);

      // Messages
      expect(find.text('I received a broken part.'), findsOneWidget);
      expect(find.text('Sorry to hear that. Can you send photos?'),
          findsOneWidget);
      expect(find.text('You'), findsOneWidget);
      expect(find.text('Support'), findsOneWidget);
    });

    testWidgets('shows message attachments', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final ticket = _makeTicket(status: 'open');
      final messages = [
        _makeMessage(
          body: 'Here are the photos',
          attachments: [
            const MessageAttachment(
              id: 'att-1',
              filename: 'defect.jpg',
              url: 'https://example.com/defect.jpg',
              contentType: 'image/jpeg',
            ),
            const MessageAttachment(
              id: 'att-2',
              filename: 'receipt.pdf',
              url: 'https://example.com/receipt.pdf',
              contentType: 'application/pdf',
            ),
          ],
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(ticket)),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(messages)),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'ticket-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('defect.jpg'), findsOneWidget);
      expect(find.text('receipt.pdf'), findsOneWidget);
    });

    testWidgets('hides reply bar for resolved tickets', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final ticket = _makeTicket(status: 'resolved');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(ticket)),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(<TicketMessage>[])),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'ticket-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Resolved'), findsOneWidget);
      // No reply input field
      expect(find.byTooltip('Send message'), findsNothing);
    });

    testWidgets('shows reply bar for open tickets', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final ticket = _makeTicket(status: 'open');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(ticket)),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(<TicketMessage>[])),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'ticket-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byTooltip('Send message'), findsOneWidget);
      expect(find.byTooltip('Add attachment'), findsOneWidget);
    });

    testWidgets('shows error state for ticket detail', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('bad-id').overrideWith(
                (_) => Future<SupportTicket>.error('Not found')),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'bad-id'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load ticket'), findsOneWidget);
    });

    testWidgets('shows empty messages state', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final ticket = _makeTicket(status: 'open');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ticketDetailProvider('ticket-1')
                .overrideWith((_) => Future.value(ticket)),
            ticketMessagesProvider('ticket-1')
                .overrideWith((_) => Future.value(<TicketMessage>[])),
          ],
          child: const MaterialApp(
            home: SupportDetailScreen(ticketId: 'ticket-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No messages yet'), findsOneWidget);
    });
  });

  group('WarrantyScreen', () {
    testWidgets('shows warranty claims list', (tester) async {
      final claims = [
        _makeClaim(
          id: 'c1',
          claimNumber: 'WRN-001',
          productTitle: 'Plate Mount',
          material: 'TPU',
          status: 'pending',
        ),
        _makeClaim(
          id: 'c2',
          claimNumber: 'WRN-002',
          productTitle: 'Switch Holder',
          material: 'PA11',
          status: 'approved',
        ),
        _makeClaim(
          id: 'c3',
          claimNumber: 'WRN-003',
          productTitle: 'Case Bottom',
          material: 'TPC',
          status: 'denied',
          orderDate: _now.subtract(const Duration(days: 400)),
          warrantyExpiresAt:
              _now.subtract(const Duration(days: 400))
                  .add(const Duration(days: 365)),
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimsProvider
                .overrideWith((_) => Future.value(claims)),
          ],
          child: const MaterialApp(home: WarrantyScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Warranty Claims'), findsOneWidget);
      expect(find.text('Plate Mount'), findsOneWidget);
      expect(find.text('Switch Holder'), findsOneWidget);
      expect(find.text('Case Bottom'), findsOneWidget);

      // Status badges
      expect(find.text('Pending'), findsOneWidget);
      expect(find.text('Approved'), findsOneWidget);
      expect(find.text('Denied'), findsOneWidget);

      // Claim numbers
      expect(find.text('#WRN-001'), findsOneWidget);
      expect(find.text('#WRN-002'), findsOneWidget);
      expect(find.text('#WRN-003'), findsOneWidget);

      // Warranty validity
      expect(find.text('Within Warranty'), findsAtLeast(1));
      expect(find.text('Warranty Expired'), findsAtLeast(1));
    });

    testWidgets('shows empty state when no claims', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimsProvider
                .overrideWith((_) => Future.value(<WarrantyClaim>[])),
          ],
          child: const MaterialApp(home: WarrantyScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No warranty claims'), findsOneWidget);
      expect(find.text('File Warranty Claim'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<List<WarrantyClaim>>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimsProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: WarrantyScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete([]);
      await tester.pumpAndSettle();
    });

    testWidgets('shows error state', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimsProvider.overrideWith((_) =>
                Future<List<WarrantyClaim>>.error('Network error')),
          ],
          child: const MaterialApp(home: WarrantyScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load claims'), findsOneWidget);
    });

    testWidgets('shows FAB for filing claims', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimsProvider
                .overrideWith((_) => Future.value(<WarrantyClaim>[])),
          ],
          child: const MaterialApp(home: WarrantyScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(FloatingActionButton), findsOneWidget);
    });
  });

  group('WarrantyDetailScreen', () {
    testWidgets('shows claim detail with warranty info', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final claim = _makeClaim(
        productTitle: 'Plate Mount v2',
        material: 'TPU',
        status: 'under_review',
        defectDescription: 'Cracked after 2 months of normal use',
        orderNumber: 'KNX-2001',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimDetailProvider('claim-1')
                .overrideWith((_) => Future.value(claim)),
          ],
          child: const MaterialApp(
            home: WarrantyDetailScreen(claimId: 'claim-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Warranty Claim'), findsOneWidget);
      expect(find.text('Plate Mount v2'), findsOneWidget);
      expect(find.text('Under Review'), findsOneWidget);
      expect(find.text('#WRN-001'), findsOneWidget);

      // Warranty info
      expect(find.text('Within Warranty Period'), findsOneWidget);
      expect(find.text('Material: TPU'), findsOneWidget);
      expect(find.text('Warranty Period: 1 year'), findsOneWidget);

      // TPU limitation
      expect(find.textContaining('Heat deformation'), findsOneWidget);

      // Order info
      expect(find.text('#KNX-2001'), findsOneWidget);

      // Defect description
      expect(find.text('Cracked after 2 months of normal use'),
          findsOneWidget);
    });

    testWidgets('shows expired warranty for old order', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final claim = _makeClaim(
        material: 'PA11',
        status: 'denied',
        orderDate: _now.subtract(const Duration(days: 400)),
        warrantyExpiresAt: _now.subtract(const Duration(days: 400))
            .add(const Duration(days: 365)),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimDetailProvider('claim-1')
                .overrideWith((_) => Future.value(claim)),
          ],
          child: const MaterialApp(
            home: WarrantyDetailScreen(claimId: 'claim-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Warranty Period Expired'), findsOneWidget);
      expect(find.text('Denied'), findsOneWidget);
    });

    testWidgets('shows TPC warranty limitation', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final claim = _makeClaim(material: 'TPC');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimDetailProvider('claim-1')
                .overrideWith((_) => Future.value(claim)),
          ],
          child: const MaterialApp(
            home: WarrantyDetailScreen(claimId: 'claim-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Material: TPC'), findsOneWidget);
      expect(
          find.textContaining('Heat resistance rated'), findsOneWidget);
    });

    testWidgets('shows error state for claim detail', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimDetailProvider('bad-id').overrideWith(
                (_) => Future<WarrantyClaim>.error('Not found')),
          ],
          child: const MaterialApp(
            home: WarrantyDetailScreen(claimId: 'bad-id'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load claim'), findsOneWidget);
    });

    testWidgets('shows photo placeholders', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final claim = _makeClaim();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            warrantyClaimDetailProvider('claim-1')
                .overrideWith((_) => Future.value(claim)),
          ],
          child: const MaterialApp(
            home: WarrantyDetailScreen(claimId: 'claim-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Photos'), findsOneWidget);
      // 2 photo placeholders
      expect(find.byIcon(Icons.photo), findsNWidgets(2));
    });
  });

  group('MaterialWarrantyInfo', () {
    test('returns correct warranty for TPU', () {
      final info = MaterialWarrantyInfo.forMaterial('TPU');
      expect(info.material, 'TPU');
      expect(info.warrantyPeriod, '1 year');
      expect(info.limitation, contains('Heat deformation'));
    });

    test('returns correct warranty for PA11', () {
      final info = MaterialWarrantyInfo.forMaterial('PA11');
      expect(info.material, 'PA11');
      expect(info.warrantyPeriod, '1 year');
      expect(info.limitation, isNull);
    });

    test('returns correct warranty for TPC', () {
      final info = MaterialWarrantyInfo.forMaterial('TPC');
      expect(info.material, 'TPC');
      expect(info.warrantyPeriod, '1 year');
      expect(info.limitation, contains('Heat resistance'));
    });

    test('returns default warranty for unknown material', () {
      final info = MaterialWarrantyInfo.forMaterial('PETG');
      expect(info.material, 'PETG');
      expect(info.warrantyPeriod, '1 year');
      expect(info.limitation, isNull);
    });
  });
}
