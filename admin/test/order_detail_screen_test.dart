import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/order.dart';
import 'package:kanix_admin/providers/order_provider.dart';
import 'package:kanix_admin/screens/order_detail_screen.dart';

final _sampleOrder = Order(
  id: 'order-1',
  orderNumber: 'KNX-000001',
  email: 'alice@example.com',
  customerId: 'cust-1',
  status: 'confirmed',
  paymentStatus: 'paid',
  fulfillmentStatus: 'queued',
  shippingStatus: 'not_shipped',
  currency: 'USD',
  subtotalMinor: 5000,
  taxMinor: 400,
  shippingMinor: 800,
  discountMinor: 0,
  totalMinor: 6200,
  placedAt: DateTime(2026, 4, 10),
  createdAt: DateTime(2026, 4, 10),
  updatedAt: DateTime(2026, 4, 10),
  lines: [
    OrderLine(
      id: 'line-1',
      orderId: 'order-1',
      variantId: 'variant-1',
      skuSnapshot: 'KNX-BELT-TPU-M',
      titleSnapshot: 'Belt Module - TPU Medium',
      optionValuesSnapshot: {'material': 'TPU', 'size': 'M'},
      quantity: 2,
      unitPriceMinor: 2500,
      totalMinor: 5000,
    ),
  ],
);

final _sampleHistory = [
  OrderStatusHistoryEntry(
    id: 'hist-1',
    orderId: 'order-1',
    statusType: 'status',
    oldValue: 'draft',
    newValue: 'confirmed',
    reason: 'Payment received',
    createdAt: DateTime(2026, 4, 10, 14, 30),
  ),
  OrderStatusHistoryEntry(
    id: 'hist-2',
    orderId: 'order-1',
    statusType: 'payment_status',
    oldValue: 'unpaid',
    newValue: 'paid',
    createdAt: DateTime(2026, 4, 10, 14, 30),
  ),
];

/// Helper to build test widget with a large enough surface.
Widget _buildTestWidget(Widget child, {List<Override> overrides = const []}) {
  return ProviderScope(
    overrides: overrides,
    child: MaterialApp(
      home: Scaffold(body: child),
    ),
  );
}

/// Set a large test surface to avoid overflow.
void _setLargeSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1920, 1080);
  tester.view.devicePixelRatio = 1.0;
}

List<Override> _defaultOverrides() => [
      orderDetailProvider('order-1')
          .overrideWith((_) => Future.value(_sampleOrder)),
      orderHistoryProvider('order-1')
          .overrideWith((_) => Future.value(_sampleHistory)),
      orderRefundsProvider('order-1')
          .overrideWith((_) => Future.value(<Refund>[])),
    ];

void main() {
  group('OrderDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      final completer = Completer<Order>();
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => completer.future),
          ],
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays order header with order number and total',
        (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order KNX-000001'), findsOneWidget);
      // Total appears in header and summary tab
      expect(find.text('\$62.00'), findsWidgets);
    });

    testWidgets('has all eight tabs', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Summary'), findsOneWidget);
      expect(find.text('Items'), findsOneWidget);
      // 'Payment' appears as tab + in the summary tab's status rows
      expect(find.text('Payment'), findsWidgets);
      expect(find.text('Fulfillment'), findsWidgets);
      expect(find.text('Shipping'), findsWidgets);
      expect(find.text('Support'), findsOneWidget);
      expect(find.text('Evidence'), findsOneWidget);
      expect(find.text('Audit'), findsOneWidget);
    });

    testWidgets('summary tab shows order status and customer info',
        (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order Status'), findsOneWidget);
      expect(find.text('alice@example.com'), findsOneWidget);
    });

    testWidgets('items tab shows order lines', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Items'));
      await tester.pumpAndSettle();

      expect(find.text('KNX-BELT-TPU-M'), findsOneWidget);
      expect(find.text('Belt Module - TPU Medium'), findsOneWidget);
    });

    testWidgets('shows refund button for paid orders', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Refund'), findsOneWidget);
    });

    testWidgets('shows cancel button for confirmed orders', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Cancel Order'), findsOneWidget);
    });

    testWidgets('refund dialog opens on button tap', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Refund'));
      await tester.pumpAndSettle();

      expect(find.text('Issue Refund'), findsOneWidget);
      expect(find.text('Confirm Refund'), findsOneWidget);
    });

    testWidgets('cancel dialog opens on button tap', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cancel Order'));
      await tester.pumpAndSettle();

      expect(find.text('Confirm Cancellation'), findsOneWidget);
      expect(find.text('Keep Order'), findsOneWidget);
    });

    testWidgets('audit tab shows history entries', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: _defaultOverrides(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Audit'));
      await tester.pumpAndSettle();

      expect(find.text('Payment received'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      _setLargeSurface(tester);
      addTearDown(() => tester.view.resetPhysicalSize());
      await tester.pumpWidget(
        _buildTestWidget(
          const OrderDetailScreen(orderId: 'order-1'),
          overrides: [
            orderDetailProvider('order-1')
                .overrideWith((_) => Future.error('Not found')),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load order'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });
}
