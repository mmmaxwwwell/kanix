import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/inventory.dart';
import 'package:kanix_admin/providers/inventory_provider.dart';
import 'package:kanix_admin/screens/inventory_screen.dart';

final _sampleVariants = [
  InventoryVariant(
    variantId: 'var-1',
    sku: 'SKU-001',
    productName: 'Widget A',
    variantName: 'Small',
    quantityOnHand: 100,
    quantityReserved: 10,
    quantityAvailable: 90,
    lowStockThreshold: 5,
    isLowStock: false,
    updatedAt: DateTime(2026, 4, 15),
  ),
  InventoryVariant(
    variantId: 'var-2',
    sku: 'SKU-002',
    productName: 'Widget B',
    variantName: 'Large',
    quantityOnHand: 3,
    quantityReserved: 1,
    quantityAvailable: 2,
    lowStockThreshold: 5,
    isLowStock: true,
    updatedAt: DateTime(2026, 4, 14),
  ),
];

final _sampleAdjustments = [
  InventoryAdjustment(
    id: 'adj-1',
    variantId: 'var-1',
    type: 'add',
    quantity: 50,
    reason: 'Restock',
    createdBy: 'admin@test.com',
    createdAt: DateTime(2026, 4, 15),
  ),
  InventoryAdjustment(
    id: 'adj-2',
    variantId: 'var-1',
    type: 'remove',
    quantity: 5,
    reason: 'Damaged',
    createdAt: DateTime(2026, 4, 14),
  ),
];

void main() {
  group('InventoryScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<InventoryVariant>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
              home: Scaffold(body: InventoryScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Inventory Overview'), findsOneWidget);
    });

    testWidgets('displays inventory table with low-stock highlighting',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryListProvider
                .overrideWith((_) => Future.value(_sampleVariants)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: InventoryScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Inventory Overview'), findsOneWidget);
      expect(find.text('SKU-001'), findsOneWidget);
      expect(find.text('SKU-002'), findsOneWidget);
      expect(find.text('Widget A'), findsOneWidget);
      expect(find.text('Widget B'), findsOneWidget);
      expect(find.text('In Stock'), findsOneWidget);
      expect(find.text('Low Stock'), findsOneWidget);
    });

    testWidgets('shows empty state when no inventory', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryListProvider
                .overrideWith((_) => Future.value(<InventoryVariant>[])),
          ],
          child: const MaterialApp(
              home: Scaffold(body: InventoryScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No inventory data'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(
              home: Scaffold(body: InventoryScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load inventory'),
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
            inventoryListProvider
                .overrideWith((_) => Future.value(_sampleVariants)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: InventoryScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('SKU'), findsOneWidget);
      expect(find.text('Product'), findsOneWidget);
      expect(find.text('Variant'), findsOneWidget);
      expect(find.text('On Hand'), findsOneWidget);
      expect(find.text('Reserved'), findsOneWidget);
      expect(find.text('Available'), findsOneWidget);
      expect(find.text('Status'), findsOneWidget);
    });
  });

  group('InventoryDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<InventoryVariant>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryDetailProvider('var-1')
                .overrideWith((_) => completer.future),
            inventoryAdjustmentsProvider('var-1')
                .overrideWith((_) => Future.value(<InventoryAdjustment>[])),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: InventoryDetailScreen(variantId: 'var-1')),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays variant balance detail', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryDetailProvider('var-1')
                .overrideWith((_) => Future.value(_sampleVariants[0])),
            inventoryAdjustmentsProvider('var-1')
                .overrideWith((_) => Future.value(_sampleAdjustments)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: InventoryDetailScreen(variantId: 'var-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Variant Balance'), findsOneWidget);
      expect(find.text('Variant Details'), findsOneWidget);
      expect(find.text('SKU-001'), findsOneWidget);
      expect(find.text('Widget A'), findsOneWidget);
      expect(find.text('100'), findsOneWidget);
      expect(find.text('10'), findsOneWidget);
      expect(find.text('90'), findsOneWidget);
      expect(find.text('In Stock'), findsOneWidget);
      expect(find.text('New Adjustment'), findsOneWidget);
    });

    testWidgets('displays adjustments table', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryDetailProvider('var-1')
                .overrideWith((_) => Future.value(_sampleVariants[0])),
            inventoryAdjustmentsProvider('var-1')
                .overrideWith((_) => Future.value(_sampleAdjustments)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: InventoryDetailScreen(variantId: 'var-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Adjustments'), findsOneWidget);
      expect(find.text('Restock'), findsOneWidget);
      expect(find.text('Damaged'), findsOneWidget);
      expect(find.text('50'), findsOneWidget);
      expect(find.text('admin@test.com'), findsOneWidget);
    });

    testWidgets('shows low stock variant with highlighting',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            inventoryDetailProvider('var-2')
                .overrideWith((_) => Future.value(_sampleVariants[1])),
            inventoryAdjustmentsProvider('var-2')
                .overrideWith((_) => Future.value(<InventoryAdjustment>[])),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: InventoryDetailScreen(variantId: 'var-2')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Low Stock'), findsOneWidget);
      expect(find.text('No adjustments recorded'), findsOneWidget);
    });
  });
}
