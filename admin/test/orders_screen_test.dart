import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/order.dart';
import 'package:kanix_admin/providers/order_provider.dart';
import 'package:kanix_admin/screens/orders_screen.dart';

final _sampleOrders = [
  Order(
    id: 'order-1',
    orderNumber: 'KNX-000001',
    email: 'alice@example.com',
    status: 'confirmed',
    paymentStatus: 'paid',
    fulfillmentStatus: 'unfulfilled',
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
  ),
  Order(
    id: 'order-2',
    orderNumber: 'KNX-000002',
    email: 'bob@example.com',
    status: 'completed',
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    shippingStatus: 'delivered',
    currency: 'USD',
    subtotalMinor: 12000,
    taxMinor: 990,
    shippingMinor: 0,
    discountMinor: 500,
    totalMinor: 12490,
    placedAt: DateTime(2026, 4, 8),
    createdAt: DateTime(2026, 4, 8),
    updatedAt: DateTime(2026, 4, 12),
  ),
];

void main() {
  group('OrdersScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<Order>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Orders'), findsOneWidget);
    });

    testWidgets('displays order list when data loads', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider
                .overrideWith((_) => Future.value(_sampleOrders)),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Orders'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      expect(find.text('KNX-000002'), findsOneWidget);
      expect(find.text('alice@example.com'), findsOneWidget);
      expect(find.text('bob@example.com'), findsOneWidget);
      // Total column
      expect(find.text('\$62.00'), findsOneWidget);
      expect(find.text('\$124.90'), findsOneWidget);
    });

    testWidgets('shows empty state when no orders', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider
                .overrideWith((_) => Future.value(<Order>[])),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No orders found'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load orders'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('has filter dropdowns and search field', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider
                .overrideWith((_) => Future.value(<Order>[])),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      await tester.pumpAndSettle();

      // Search field
      expect(find.byType(TextField), findsOneWidget);
      // Filter dropdowns: Status, Payment, Fulfillment, Shipping
      expect(find.byType(DropdownButtonFormField<String>), findsNWidgets(4));
      // Date range button
      expect(find.text('Date range'), findsOneWidget);
    });

    testWidgets('data table has correct column headers', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            orderListProvider
                .overrideWith((_) => Future.value(_sampleOrders)),
          ],
          child: const MaterialApp(home: Scaffold(body: OrdersScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order #'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      // 'Status' appears both as a column header and as a filter label
      expect(find.text('Status'), findsWidgets);
      expect(find.text('Total'), findsOneWidget);
      expect(find.text('Date'), findsOneWidget);
    });
  });
}
