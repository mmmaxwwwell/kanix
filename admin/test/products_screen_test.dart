import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/product.dart';
import 'package:kanix_admin/providers/product_provider.dart';
import 'package:kanix_admin/screens/products_screen.dart';

final _sampleProducts = [
  Product(
    id: 'prod-1',
    name: 'Widget Alpha',
    description: 'A great widget',
    status: 'active',
    variants: [
      Variant(
        id: 'v-1',
        productId: 'prod-1',
        sku: 'WA-SM',
        name: 'Small',
        priceCents: 1999,
        quantityOnHand: 50,
        isActive: true,
        createdAt: DateTime(2026, 4, 10),
      ),
      Variant(
        id: 'v-2',
        productId: 'prod-1',
        sku: 'WA-LG',
        name: 'Large',
        priceCents: 2999,
        quantityOnHand: 25,
        isActive: true,
        createdAt: DateTime(2026, 4, 10),
      ),
    ],
    media: [
      const ProductMedia(
        id: 'm-1',
        url: 'https://example.com/img.jpg',
        altText: 'Widget photo',
        sortOrder: 0,
      ),
    ],
    classifications: [
      const Classification(
        id: 'c-1',
        name: 'Premium',
        category: 'Tier',
      ),
    ],
    createdAt: DateTime(2026, 4, 10),
    updatedAt: DateTime(2026, 4, 15),
  ),
  Product(
    id: 'prod-2',
    name: 'Widget Beta',
    status: 'draft',
    createdAt: DateTime(2026, 4, 12),
    updatedAt: DateTime(2026, 4, 14),
  ),
];

void main() {
  group('ProductsScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<Product>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productListProvider.overrideWith((_) => completer.future),
          ],
          child:
              const MaterialApp(home: Scaffold(body: ProductsScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Products'), findsOneWidget);
    });

    testWidgets('displays product list', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productListProvider
                .overrideWith((_) => Future.value(_sampleProducts)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: ProductsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Products'), findsOneWidget);
      expect(find.text('Widget Alpha'), findsOneWidget);
      expect(find.text('Widget Beta'), findsOneWidget);
      expect(find.text('active'), findsOneWidget);
      expect(find.text('draft'), findsOneWidget);
      expect(find.text('New Product'), findsOneWidget);
    });

    testWidgets('shows empty state when no products', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productListProvider
                .overrideWith((_) => Future.value(<Product>[])),
          ],
          child:
              const MaterialApp(home: Scaffold(body: ProductsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No products'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child:
              const MaterialApp(home: Scaffold(body: ProductsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load products'),
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
            productListProvider
                .overrideWith((_) => Future.value(_sampleProducts)),
          ],
          child:
              const MaterialApp(home: Scaffold(body: ProductsScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Status'), findsOneWidget);
      expect(find.text('Variants'), findsOneWidget);
      expect(find.text('Media'), findsOneWidget);
      expect(find.text('Updated'), findsOneWidget);
    });
  });

  group('ProductDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<Product>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ProductDetailScreen(productId: 'prod-1')),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays product detail with variants, media, classifications',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.value(_sampleProducts[0])),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ProductDetailScreen(productId: 'prod-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Product details
      expect(find.text('Widget Alpha'), findsWidgets);
      expect(find.text('Product Details'), findsOneWidget);
      expect(find.text('A great widget'), findsOneWidget);
      expect(find.text('Edit'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);

      // Variants section
      expect(find.text('Variants'), findsOneWidget);
      expect(find.text('WA-SM'), findsOneWidget);
      expect(find.text('WA-LG'), findsOneWidget);
      expect(find.text('Small'), findsOneWidget);
      expect(find.text('Large'), findsOneWidget);
      expect(find.text(r'$19.99'), findsOneWidget);
      expect(find.text(r'$29.99'), findsOneWidget);
      expect(find.text('Add Variant'), findsOneWidget);

      // Media section
      expect(find.text('Media'), findsWidgets);
      expect(find.text('Widget photo'), findsOneWidget);
      expect(find.text('Add Media'), findsOneWidget);

      // Classifications section
      expect(find.text('Classifications'), findsOneWidget);
      expect(find.text('Tier: Premium'), findsOneWidget);
      expect(find.text('Add Classification'), findsOneWidget);
    });

    testWidgets('product with no variants/media/classifications shows empty states',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-2')
                .overrideWith((_) => Future.value(_sampleProducts[1])),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ProductDetailScreen(productId: 'prod-2')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Widget Beta'), findsWidgets);
      expect(find.text('No variants'), findsOneWidget);
      expect(find.text('No media'), findsOneWidget);
      expect(find.text('No classifications'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            productDetailProvider('prod-1')
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: ProductDetailScreen(productId: 'prod-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed to load product'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });
}
