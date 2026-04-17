import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/shipment.dart';
import 'package:kanix_admin/providers/shipment_provider.dart';
import 'package:kanix_admin/screens/shipments_screen.dart';

final _sampleShipments = [
  Shipment(
    id: 'ship-1',
    orderId: 'order-1',
    orderNumber: 'KNX-000001',
    status: 'draft',
    createdAt: DateTime(2026, 4, 15),
    updatedAt: DateTime(2026, 4, 15),
  ),
  Shipment(
    id: 'ship-2',
    orderId: 'order-2',
    orderNumber: 'KNX-000002',
    status: 'label_purchased',
    carrier: 'USPS',
    service: 'Priority Mail',
    trackingNumber: '9400111899223456789012',
    trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012',
    labelUrl: 'https://easypost.com/labels/ship-2.pdf',
    rateCentsMinor: 895,
    createdAt: DateTime(2026, 4, 14),
    updatedAt: DateTime(2026, 4, 15),
  ),
  Shipment(
    id: 'ship-3',
    orderId: 'order-3',
    orderNumber: 'KNX-000003',
    status: 'delivered',
    carrier: 'UPS',
    service: 'Ground',
    trackingNumber: '1Z999AA10123456784',
    rateCentsMinor: 1250,
    createdAt: DateTime(2026, 4, 10),
    updatedAt: DateTime(2026, 4, 14),
    events: [
      ShipmentEvent(
        id: 'evt-1',
        shipmentId: 'ship-3',
        status: 'in_transit',
        description: 'Package picked up',
        location: 'Portland, OR',
        occurredAt: DateTime(2026, 4, 11),
        createdAt: DateTime(2026, 4, 11),
      ),
      ShipmentEvent(
        id: 'evt-2',
        shipmentId: 'ship-3',
        status: 'delivered',
        description: 'Delivered',
        location: 'Austin, TX',
        occurredAt: DateTime(2026, 4, 14),
        createdAt: DateTime(2026, 4, 14),
      ),
    ],
  ),
];

void main() {
  group('ShipmentsScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<Shipment>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ShipmentsScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Shipments'), findsOneWidget);
    });

    testWidgets('displays shipment list when data loads', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentListProvider
                .overrideWith((_) => Future.value(_sampleShipments)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ShipmentsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Shipments'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      expect(find.text('KNX-000002'), findsOneWidget);
      expect(find.text('KNX-000003'), findsOneWidget);
      expect(find.text('USPS'), findsOneWidget);
      expect(find.text('UPS'), findsOneWidget);
      expect(find.text('Priority Mail'), findsOneWidget);
      expect(find.text('\$8.95'), findsOneWidget);
      expect(find.text('\$12.50'), findsOneWidget);
    });

    testWidgets('shows empty state when no shipments', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentListProvider
                .overrideWith((_) => Future.value(<Shipment>[])),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ShipmentsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No shipments'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ShipmentsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load shipments'),
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
            shipmentListProvider
                .overrideWith((_) => Future.value(_sampleShipments)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: ShipmentsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order #'), findsOneWidget);
      expect(find.text('Status'), findsOneWidget);
      expect(find.text('Carrier'), findsOneWidget);
      expect(find.text('Service'), findsOneWidget);
      expect(find.text('Tracking #'), findsOneWidget);
      expect(find.text('Rate'), findsOneWidget);
      expect(find.text('Created'), findsOneWidget);
    });
  });

  group('ShipmentDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<Shipment>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentDetailProvider('ship-1')
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ShipmentDetailScreen(shipmentId: 'ship-1')),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays shipment detail with actions', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final shipment = _sampleShipments[0]; // draft
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentDetailProvider('ship-1')
                .overrideWith((_) => Future.value(shipment)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ShipmentDetailScreen(shipmentId: 'ship-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Shipment Details'), findsOneWidget);
      expect(find.text('Shipment Info'), findsOneWidget);
      expect(find.text('ship-1'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      // Draft shipment should have Purchase Label and Void buttons
      expect(find.text('Purchase Label'), findsOneWidget);
      expect(find.text('Void'), findsOneWidget);
    });

    testWidgets('label_purchased shipment shows mark shipped and print',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final shipment = _sampleShipments[1]; // label_purchased
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentDetailProvider('ship-2')
                .overrideWith((_) => Future.value(shipment)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ShipmentDetailScreen(shipmentId: 'ship-2')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Mark Shipped'), findsOneWidget);
      expect(find.text('Track Package'), findsOneWidget);
      expect(find.text('Print Label'), findsOneWidget);
      expect(find.text('Void'), findsOneWidget);
    });

    testWidgets('delivered shipment shows tracking events',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final shipment = _sampleShipments[2]; // delivered with events
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentDetailProvider('ship-3')
                .overrideWith((_) => Future.value(shipment)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ShipmentDetailScreen(shipmentId: 'ship-3')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Tracking Events'), findsOneWidget);
      expect(find.text('Package picked up'), findsOneWidget);
      expect(find.text('Delivered'), findsWidgets);
      expect(find.text('Portland, OR'), findsOneWidget);
      expect(find.text('Austin, TX'), findsOneWidget);
    });
  });
}
