import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/product.dart';
import 'package:kanix_customer/providers/auth_provider.dart';
import 'package:kanix_customer/providers/catalog_provider.dart';
import 'package:kanix_customer/screens/catalog_screen.dart';
import 'package:kanix_customer/screens/product_detail_screen.dart';

final _now = DateTime(2026, 1, 1);

Product _makeProduct({
  String id = 'prod-1',
  String title = 'Test Product',
  String? description,
  List<ProductVariant>? variants,
  List<ProductMedia>? media,
}) {
  return Product(
    id: id,
    slug: 'test-product',
    title: title,
    description: description,
    status: 'active',
    variants: variants ??
        [
          ProductVariant(
            id: 'var-tpu',
            productId: id,
            sku: 'SKU-TPU',
            title: 'TPU Variant',
            material: 'TPU',
            priceCents: 2999,
            quantityOnHand: 10,
            status: 'active',
            createdAt: _now,
          ),
          ProductVariant(
            id: 'var-pa11',
            productId: id,
            sku: 'SKU-PA11',
            title: 'PA11 Variant',
            material: 'PA11',
            priceCents: 3999,
            quantityOnHand: 5,
            status: 'active',
            createdAt: _now,
          ),
          ProductVariant(
            id: 'var-tpc',
            productId: id,
            sku: 'SKU-TPC',
            title: 'TPC Variant',
            material: 'TPC',
            priceCents: 4999,
            quantityOnHand: 0,
            status: 'active',
            createdAt: _now,
          ),
        ],
    media: media ?? [],
    createdAt: _now,
    updatedAt: _now,
  );
}

class _MockAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() async => const AuthState(
        user: CustomerUser(
          id: 'test-id',
          email: 'test@example.com',
          name: 'Test User',
          emailVerified: true,
        ),
      );
}

void main() {
  group('CatalogScreen', () {
    testWidgets('shows product grid with titles and pricing', (tester) async {
      final products = [
        _makeProduct(id: 'p1', title: 'Widget Alpha'),
        _makeProduct(id: 'p2', title: 'Widget Beta'),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
            catalogProvider
                .overrideWith((_) => Future.value(products)),
          ],
          child: const MaterialApp(home: CatalogScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Catalog'), findsOneWidget);
      expect(find.text('Widget Alpha'), findsOneWidget);
      expect(find.text('Widget Beta'), findsOneWidget);
      // Starting price from cheapest active variant ($29.99)
      expect(find.text('From \$29.99'), findsNWidgets(2));
    });

    testWidgets('shows availability badges', (tester) async {
      final products = [
        _makeProduct(
          id: 'p1',
          title: 'Available Product',
          variants: [
            ProductVariant(
              id: 'v1',
              productId: 'p1',
              sku: 'S1',
              title: 'V1',
              material: 'TPU',
              priceCents: 1000,
              quantityOnHand: 5,
              status: 'active',
              createdAt: _now,
            ),
          ],
        ),
        _makeProduct(
          id: 'p2',
          title: 'Unavailable Product',
          variants: [
            ProductVariant(
              id: 'v2',
              productId: 'p2',
              sku: 'S2',
              title: 'V2',
              material: 'TPU',
              priceCents: 1000,
              quantityOnHand: 0,
              status: 'active',
              createdAt: _now,
            ),
          ],
        ),
      ];

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            catalogProvider
                .overrideWith((_) => Future.value(products)),
          ],
          child: const MaterialApp(home: CatalogScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('In Stock'), findsOneWidget);
      expect(find.text('Out of Stock'), findsOneWidget);
    });

    testWidgets('shows empty state when no products', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            catalogProvider.overrideWith(
                (_) => Future.value(<Product>[])),
          ],
          child: const MaterialApp(home: CatalogScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No products available'), findsOneWidget);
    });

    testWidgets('shows error state with retry button', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            catalogProvider.overrideWith(
                (_) => Future<List<Product>>.error('Network error')),
          ],
          child: const MaterialApp(home: CatalogScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Failed to load products'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<List<Product>>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            catalogProvider.overrideWith(
                (_) => completer.future),
          ],
          child: const MaterialApp(home: CatalogScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // Complete the future to avoid pending timer issues
      completer.complete([]);
      await tester.pumpAndSettle();
    });
  });

  group('ProductDetailScreen', () {
    testWidgets('shows product title and price', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct(
        title: 'Test Widget',
        description: 'A great product',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Test Widget'), findsOneWidget);
      // First variant (TPU) is selected by default
      expect(find.text('\$29.99'), findsOneWidget);
      expect(find.text('A great product'), findsOneWidget);
    });

    testWidgets('shows material variant selector with TPU/PA11/TPC',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Material'), findsOneWidget);
      expect(find.text('TPU'), findsOneWidget);
      expect(find.text('PA11'), findsOneWidget);
      expect(find.text('TPC'), findsOneWidget);
    });

    testWidgets('switching variant updates price and warranty info',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Default is TPU - shows TPU warranty limitation
      expect(find.text('Warranty: 1 year'), findsOneWidget);
      expect(find.textContaining('Heat deformation is excluded'),
          findsOneWidget);

      // Tap PA11 chip
      await tester.tap(find.text('PA11'));
      await tester.pumpAndSettle();

      // Price updated to PA11 price
      expect(find.text('\$39.99'), findsOneWidget);
      // PA11 has no limitation
      expect(find.textContaining('Heat deformation'), findsNothing);
      expect(find.text('Warranty: 1 year'), findsOneWidget);
    });

    testWidgets('shows TPC warranty limitation', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap TPC chip
      await tester.tap(find.text('TPC'));
      await tester.pumpAndSettle();

      expect(find.text('\$49.99'), findsOneWidget);
      expect(find.textContaining('Heat resistance rated up to 120'),
          findsOneWidget);
    });

    testWidgets('add to cart button enabled when in stock', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // TPU is selected by default and is in stock
      final addButton = find.text('Add to Cart');
      expect(addButton, findsOneWidget);

      // Tap add to cart
      await tester.tap(addButton);
      await tester.pumpAndSettle();

      expect(find.text('Added to cart'), findsOneWidget);
    });

    testWidgets('add to cart button disabled when out of stock',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final product = _makeProduct();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(product)),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'prod-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Select TPC which is out of stock
      await tester.tap(find.text('TPC'));
      await tester.pumpAndSettle();

      expect(find.text('Out of Stock'), findsOneWidget);

      // Add to cart should be disabled - tapping should not show snackbar
      await tester.tap(find.text('Add to Cart'));
      await tester.pumpAndSettle();

      expect(find.text('Added to cart'), findsNothing);
    });

    testWidgets('shows product detail error state', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('bad-id').overrideWith(
                (_) => Future<Product>.error('Not found')),
          ],
          child: const MaterialApp(
            home: ProductDetailScreen(productId: 'bad-id'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Failed to load product'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });
}
