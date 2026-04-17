import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/order.dart';
import 'package:kanix_customer/providers/order_provider.dart';
import 'package:kanix_customer/screens/orders_screen.dart';

final _now = DateTime(2026, 1, 15, 10, 30);

Order _makeOrder({
  String id = 'order-1',
  String orderNumber = 'KNX-1001',
  String status = 'confirmed',
  int totalCents = 5999,
  List<OrderLineItem>? lineItems,
  List<OrderTimeline>? timeline,
  List<Shipment>? shipments,
}) {
  return Order(
    id: id,
    orderNumber: orderNumber,
    status: status,
    subtotalCents: 4999,
    shippingCents: 500,
    taxCents: 500,
    totalCents: totalCents,
    createdAt: _now,
    updatedAt: _now,
    lineItems: lineItems ??
        [
          const OrderLineItem(
            id: 'li-1',
            productTitle: 'Test Widget',
            variantTitle: 'TPU Variant',
            material: 'TPU',
            quantity: 2,
            unitPriceCents: 2499,
            totalCents: 4998,
          ),
        ],
    timeline: timeline ??
        [
          OrderTimeline(
            status: 'confirmed',
            label: 'Order Confirmed',
            description: 'Your order has been confirmed',
            timestamp: _now,
          ),
          OrderTimeline(
            status: 'pending',
            label: 'Order Placed',
            timestamp: _now.subtract(const Duration(hours: 1)),
          ),
        ],
    shipments: shipments ?? [],
  );
}

void main() {
  group('OrdersScreen', () {
    testWidgets('shows order list with status badges', (tester) async {
      final orders = [
        _makeOrder(
          id: 'o1',
          orderNumber: 'KNX-1001',
          status: 'confirmed',
          totalCents: 5999,
        ),
        _makeOrder(
          id: 'o2',
          orderNumber: 'KNX-1002',
          status: 'shipped',
          totalCents: 3499,
        ),
        _makeOrder(
          id: 'o3',
          orderNumber: 'KNX-1003',
          status: 'delivered',
          totalCents: 7999,
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ordersProvider.overrideWith((_) => Future.value(orders)),
          ],
          child: const MaterialApp(home: OrdersScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Orders'), findsOneWidget);
      expect(find.text('Order #KNX-1001'), findsOneWidget);
      expect(find.text('Order #KNX-1002'), findsOneWidget);
      expect(find.text('Order #KNX-1003'), findsOneWidget);

      // Status badges
      expect(find.text('Confirmed'), findsOneWidget);
      expect(find.text('Shipped'), findsOneWidget);
      expect(find.text('Delivered'), findsOneWidget);

      // Prices
      expect(find.text('\$59.99'), findsOneWidget);
      expect(find.text('\$34.99'), findsOneWidget);
      expect(find.text('\$79.99'), findsOneWidget);
    });

    testWidgets('shows empty state when no orders', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ordersProvider
                .overrideWith((_) => Future.value(<Order>[])),
          ],
          child: const MaterialApp(home: OrdersScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No orders yet'), findsOneWidget);
      expect(find.text('Browse Catalog'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<List<Order>>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ordersProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: OrdersScreen()),
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
            ordersProvider.overrideWith(
                (_) => Future<List<Order>>.error('Network error')),
          ],
          child: const MaterialApp(home: OrdersScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load orders'), findsOneWidget);
    });

    testWidgets('shows all order statuses with correct badges',
        (tester) async {
      final orders = [
        _makeOrder(id: 'o1', orderNumber: 'KNX-001', status: 'pending'),
        _makeOrder(id: 'o2', orderNumber: 'KNX-002', status: 'processing'),
        _makeOrder(id: 'o3', orderNumber: 'KNX-003', status: 'cancelled'),
        _makeOrder(id: 'o4', orderNumber: 'KNX-004', status: 'refunded'),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ordersProvider.overrideWith((_) => Future.value(orders)),
          ],
          child: const MaterialApp(home: OrdersScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Pending'), findsOneWidget);
      expect(find.text('Processing'), findsOneWidget);
      expect(find.text('Cancelled'), findsOneWidget);
      expect(find.text('Refunded'), findsOneWidget);
    });
  });

  group('OrderDetailScreen', () {
    testWidgets('shows order detail with line items and totals',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final order = _makeOrder();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => Future.value(order)),
          ],
          child: const MaterialApp(
            home: OrderDetailScreen(orderId: 'order-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order Detail'), findsOneWidget);
      expect(find.text('Order #KNX-1001'), findsOneWidget);
      expect(find.text('Confirmed'), findsOneWidget);

      // Line items
      expect(find.text('Test Widget (TPU) x2'), findsOneWidget);

      // Totals
      expect(find.text('Subtotal'), findsOneWidget);
      expect(find.text('Shipping'), findsOneWidget);
      expect(find.text('Tax'), findsOneWidget);
      expect(find.text('Total'), findsOneWidget);
    });

    testWidgets('shows order timeline with status changes', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final order = _makeOrder(
        timeline: [
          OrderTimeline(
            status: 'shipped',
            label: 'Order Shipped',
            description: 'Your package is on its way',
            timestamp: _now,
          ),
          OrderTimeline(
            status: 'confirmed',
            label: 'Order Confirmed',
            timestamp: _now.subtract(const Duration(hours: 2)),
          ),
          OrderTimeline(
            status: 'pending',
            label: 'Order Placed',
            timestamp: _now.subtract(const Duration(hours: 3)),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => Future.value(order)),
          ],
          child: const MaterialApp(
            home: OrderDetailScreen(orderId: 'order-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Timeline'), findsOneWidget);
      expect(find.text('Order Shipped'), findsOneWidget);
      expect(find.text('Your package is on its way'), findsOneWidget);
      expect(find.text('Order Confirmed'), findsOneWidget);
      expect(find.text('Order Placed'), findsOneWidget);
    });

    testWidgets('shows shipment tracking with carrier events',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final order = _makeOrder(
        status: 'shipped',
        shipments: [
          Shipment(
            id: 'ship-1',
            trackingNumber: '1Z999AA10123456784',
            carrier: 'UPS',
            status: 'in_transit',
            createdAt: _now,
            trackingEvents: [
              TrackingEvent(
                status: 'in_transit',
                message: 'Package arrived at facility',
                location: 'Memphis, TN',
                timestamp: _now,
              ),
              TrackingEvent(
                status: 'pre_transit',
                message: 'Shipping label created',
                location: 'Portland, OR',
                timestamp: _now.subtract(const Duration(days: 1)),
              ),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => Future.value(order)),
          ],
          child: const MaterialApp(
            home: OrderDetailScreen(orderId: 'order-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Shipments'), findsOneWidget);
      expect(find.text('UPS - 1Z999AA10123456784'), findsOneWidget);
      expect(find.text('In Transit'), findsOneWidget);

      // Tracking events
      expect(find.text('Package arrived at facility'), findsOneWidget);
      expect(find.text('Memphis, TN'), findsOneWidget);
      expect(find.text('Shipping label created'), findsOneWidget);
      expect(find.text('Portland, OR'), findsOneWidget);
    });

    testWidgets('shows empty timeline message', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final order = _makeOrder(timeline: []);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => Future.value(order)),
          ],
          child: const MaterialApp(
            home: OrderDetailScreen(orderId: 'order-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No status updates yet'), findsOneWidget);
    });

    testWidgets('shows error state for order detail', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderDetailProvider('bad-id')
                .overrideWith((_) => Future<Order>.error('Not found')),
          ],
          child: const MaterialApp(
            home: OrderDetailScreen(orderId: 'bad-id'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load order'), findsOneWidget);
    });
  });

  group('ShipmentTrackingScreen', () {
    testWidgets('shows shipment tracking details', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final shipment = Shipment(
        id: 'ship-1',
        trackingNumber: '9400111899223100',
        carrier: 'USPS',
        status: 'out_for_delivery',
        createdAt: _now,
        trackingEvents: [
          TrackingEvent(
            status: 'out_for_delivery',
            message: 'Out for delivery',
            location: 'Portland, OR',
            timestamp: _now,
          ),
          TrackingEvent(
            status: 'in_transit',
            message: 'Arrived at post office',
            location: 'Portland, OR',
            timestamp: _now.subtract(const Duration(hours: 6)),
          ),
          TrackingEvent(
            status: 'in_transit',
            message: 'In transit to destination',
            location: 'Seattle, WA',
            timestamp: _now.subtract(const Duration(days: 1)),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentTrackingProvider('ship-1')
                .overrideWith((_) => Future.value(shipment)),
          ],
          child: const MaterialApp(
            home: ShipmentTrackingScreen(shipmentId: 'ship-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Shipment Tracking'), findsOneWidget);
      expect(find.text('USPS - 9400111899223100'), findsOneWidget);
      expect(find.text('Out for Delivery'), findsOneWidget);

      // Tracking events
      expect(find.text('Out for delivery'), findsOneWidget);
      expect(find.text('Arrived at post office'), findsOneWidget);
      expect(find.text('In transit to destination'), findsOneWidget);
      expect(find.text('Portland, OR'), findsAtLeast(1));
      expect(find.text('Seattle, WA'), findsOneWidget);
    });

    testWidgets('shows empty tracking events message', (tester) async {
      final shipment = Shipment(
        id: 'ship-1',
        trackingNumber: 'TRACK123',
        carrier: 'FedEx',
        status: 'pre_transit',
        createdAt: _now,
        trackingEvents: [],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentTrackingProvider('ship-1')
                .overrideWith((_) => Future.value(shipment)),
          ],
          child: const MaterialApp(
            home: ShipmentTrackingScreen(shipmentId: 'ship-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No tracking events yet'), findsOneWidget);
    });

    testWidgets('shows loading state', (tester) async {
      final completer = Completer<Shipment>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentTrackingProvider('ship-1')
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
            home: ShipmentTrackingScreen(shipmentId: 'ship-1'),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete(Shipment(
        id: 'ship-1',
        trackingNumber: 'X',
        carrier: 'X',
        status: 'pre_transit',
        createdAt: _now,
      ));
      await tester.pumpAndSettle();
    });

    testWidgets('shows error state', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            shipmentTrackingProvider('bad')
                .overrideWith((_) => Future<Shipment>.error('Not found')),
          ],
          child: const MaterialApp(
            home: ShipmentTrackingScreen(shipmentId: 'bad'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load tracking'), findsOneWidget);
    });
  });
}
