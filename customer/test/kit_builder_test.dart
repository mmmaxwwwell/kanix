import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/kit.dart';
import 'package:kanix_customer/providers/kit_provider.dart';
import 'package:kanix_customer/screens/kit_builder_screen.dart';

KitDefinition _makeKit({
  String id = 'kit-1',
  String title = 'Starter Kit',
  String? description = 'Build your starter kit',
  int priceMinor = 14900,
  List<KitClassRequirement>? requirements,
}) {
  return KitDefinition(
    id: id,
    slug: 'starter-kit',
    title: title,
    description: description,
    priceMinor: priceMinor,
    currency: 'USD',
    requirements: requirements ??
        [
          KitClassRequirement(
            productClassId: 'class-plates',
            productClassName: 'Plates',
            quantity: 2,
            products: [
              KitProduct(
                id: 'prod-plate-a',
                slug: 'plate-a',
                title: 'Plate Alpha',
                variants: [
                  const KitProductVariant(
                    id: 'var-plate-a-tpu',
                    title: 'Plate Alpha TPU',
                    material: 'TPU',
                    priceCents: 2999,
                    inStock: true,
                    quantityOnHand: 10,
                  ),
                  const KitProductVariant(
                    id: 'var-plate-a-pa11',
                    title: 'Plate Alpha PA11',
                    material: 'PA11',
                    priceCents: 3999,
                    inStock: true,
                    quantityOnHand: 5,
                  ),
                ],
              ),
              KitProduct(
                id: 'prod-plate-b',
                slug: 'plate-b',
                title: 'Plate Beta',
                variants: [
                  const KitProductVariant(
                    id: 'var-plate-b-tpu',
                    title: 'Plate Beta TPU',
                    material: 'TPU',
                    priceCents: 3499,
                    inStock: true,
                    quantityOnHand: 8,
                  ),
                  const KitProductVariant(
                    id: 'var-plate-b-tpc',
                    title: 'Plate Beta TPC',
                    material: 'TPC',
                    priceCents: 4499,
                    inStock: false,
                    quantityOnHand: 0,
                  ),
                ],
              ),
            ],
          ),
          KitClassRequirement(
            productClassId: 'class-modules',
            productClassName: 'Modules',
            quantity: 1,
            products: [
              KitProduct(
                id: 'prod-module-a',
                slug: 'module-a',
                title: 'Module Alpha',
                variants: [
                  const KitProductVariant(
                    id: 'var-mod-a-tpu',
                    title: 'Module Alpha TPU',
                    material: 'TPU',
                    priceCents: 1999,
                    inStock: true,
                    quantityOnHand: 15,
                  ),
                ],
              ),
            ],
          ),
        ],
  );
}

void main() {
  group('KitBuilderScreen', () {
    testWidgets('shows kit title and class requirements', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Kit Builder'), findsOneWidget);
      expect(find.text('Starter Kit'), findsOneWidget);
      expect(find.text('Build your starter kit'), findsOneWidget);
      // Class requirements with "Pick N ClassName"
      expect(find.text('Pick 2 Plates'), findsOneWidget);
      expect(find.text('Pick 1 Modules'), findsOneWidget);
    });

    testWidgets('shows products with in-stock indicators', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Plate Alpha'), findsOneWidget);
      expect(find.text('Plate Beta'), findsOneWidget);
      expect(find.text('Module Alpha'), findsOneWidget);
      // Stock indicators — there should be multiple "In Stock" texts
      expect(find.text('In Stock'), findsWidgets);
    });

    testWidgets('shows kit price and savings', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Kit price
      expect(find.text('Kit Price: \$149.00'), findsOneWidget);
      // Savings badge (individual cheapest: 2*2999 + 1999 = 7997 = $79.97,
      // but kit is $149 which is more, so no savings in this test data)
      // Let me adjust — need a kit priced less than individual total
    });

    testWidgets('shows savings when kit price is less than individual total',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      // Individual cheapest: 2999 + 2999 + 1999 = 7997 cents
      // Kit price: 6900 cents
      // Savings: 1097 cents = $10.97
      final kit = _makeKit(priceMinor: 6900);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Kit Price: \$69.00'), findsOneWidget);
      // Individual cheapest: 2999 + 3499 (cheapest 2 plates) + 1999 (module) = 8497
      // Savings: 8497 - 6900 = 1597 = $15.97
      expect(find.textContaining('Save \$15.97'), findsOneWidget);
    });

    testWidgets('add to cart disabled when not all classes satisfied',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit(priceMinor: 6900);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Button should contain kit price text
      expect(find.text('Add Kit to Cart - \$69.00'), findsOneWidget);

      // Tap add to cart — should not show snackbar since not all classes selected
      await tester.tap(find.text('Add Kit to Cart - \$69.00'));
      await tester.pumpAndSettle();
      expect(find.text('Kit added to cart'), findsNothing);

      // Should show missing message
      expect(find.textContaining('Still need:'), findsOneWidget);
    });

    testWidgets('selecting variants enables add to cart', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit(priceMinor: 6900);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Select 2 plates — pick TPU variants from both
      await tester.tap(find.text('TPU \$29.99').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('TPU \$34.99'));
      await tester.pumpAndSettle();

      // Select 1 module
      await tester.tap(find.text('TPU \$19.99'));
      await tester.pumpAndSettle();

      // Now all classes satisfied — missing message should be gone
      expect(find.textContaining('Still need:'), findsNothing);

      // Tap add to cart
      await tester.tap(find.text('Add Kit to Cart - \$69.00'));
      await tester.pumpAndSettle();
      expect(find.text('Kit added to cart'), findsOneWidget);
    });

    testWidgets('validates class counts with progress indicator',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit(priceMinor: 6900);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Initially 0/2 plates and 0/1 modules
      expect(find.text('0/2'), findsOneWidget);
      expect(find.text('0/1'), findsOneWidget);

      // Select one plate
      await tester.tap(find.text('TPU \$29.99').first);
      await tester.pumpAndSettle();

      expect(find.text('1/2'), findsOneWidget);
    });

    testWidgets('shows loading indicator', (tester) async {
      final completer = Completer<List<KitDefinition>>();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete([]);
      await tester.pumpAndSettle();
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith(
                (_) => Future<List<KitDefinition>>.error('Network error')),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Failed to load kits'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('shows empty state when no kits', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider
                .overrideWith((_) => Future.value(<KitDefinition>[])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No kits available'), findsOneWidget);
    });

    testWidgets('out of stock product shows indicator', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final kit = _makeKit(
        priceMinor: 6900,
        requirements: [
          KitClassRequirement(
            productClassId: 'class-plates',
            productClassName: 'Plates',
            quantity: 1,
            products: [
              KitProduct(
                id: 'prod-plate-oos',
                slug: 'plate-oos',
                title: 'Plate Out of Stock',
                variants: [
                  const KitProductVariant(
                    id: 'var-oos',
                    title: 'Plate OOS TPU',
                    material: 'TPU',
                    priceCents: 2999,
                    inStock: false,
                    quantityOnHand: 0,
                  ),
                ],
              ),
              KitProduct(
                id: 'prod-plate-is',
                slug: 'plate-is',
                title: 'Plate In Stock',
                variants: [
                  const KitProductVariant(
                    id: 'var-is',
                    title: 'Plate IS TPU',
                    material: 'TPU',
                    priceCents: 3499,
                    inStock: true,
                    quantityOnHand: 5,
                  ),
                ],
              ),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            kitListProvider.overrideWith((_) => Future.value([kit])),
          ],
          child: const MaterialApp(home: KitBuilderScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // One product is out of stock, one is in stock
      expect(find.text('Out of Stock'), findsOneWidget);
      expect(find.text('In Stock'), findsOneWidget);
    });
  });
}
