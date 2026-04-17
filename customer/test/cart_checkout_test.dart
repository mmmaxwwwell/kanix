import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:kanix_customer/models/cart.dart';
import 'package:kanix_customer/models/product.dart';
import 'package:kanix_customer/providers/auth_provider.dart';
import 'package:kanix_customer/providers/cart_provider.dart';
import 'package:kanix_customer/providers/catalog_provider.dart';
import 'package:kanix_customer/screens/cart_screen.dart';
import 'package:kanix_customer/screens/checkout_screen.dart';
import 'package:kanix_customer/screens/order_confirmation_screen.dart';
import 'package:kanix_customer/screens/product_detail_screen.dart';

final _now = DateTime(2026, 1, 1);

CartItem _makeCartItem({
  String variantId = 'var-1',
  String productId = 'prod-1',
  String productTitle = 'Test Product',
  String material = 'TPU',
  int priceCents = 2999,
  int quantity = 1,
}) {
  return CartItem(
    variantId: variantId,
    productId: productId,
    productTitle: productTitle,
    variantTitle: '$material Variant',
    material: material,
    priceCents: priceCents,
    quantity: quantity,
  );
}

Product _makeProduct({
  String id = 'prod-1',
  String title = 'Test Product',
}) {
  return Product(
    id: id,
    slug: 'test-product',
    title: title,
    status: 'active',
    variants: [
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
    ],
    media: [],
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
  group('CartScreen', () {
    testWidgets('shows empty cart state with browse button', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
          ],
          child: const MaterialApp(home: CartScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Cart'), findsOneWidget);
      expect(find.text('Your cart is empty'), findsOneWidget);
      expect(find.text('Browse Catalog'), findsOneWidget);
    });

    testWidgets('shows cart items with quantity and price', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final item1 = _makeCartItem(
        variantId: 'v1',
        productTitle: 'Widget Alpha',
        priceCents: 2999,
        quantity: 2,
      );
      final item2 = _makeCartItem(
        variantId: 'v2',
        productTitle: 'Widget Beta',
        material: 'PA11',
        priceCents: 3999,
        quantity: 1,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
            cartProvider.overrideWith(() {
              final notifier = CartNotifier();
              return notifier;
            }),
          ],
          child: const MaterialApp(home: CartScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Add items to cart
      final container = ProviderScope.containerOf(
          tester.element(find.byType(CartScreen)));
      container.read(cartProvider.notifier).addItem(item1);
      container.read(cartProvider.notifier).addItem(item2);
      await tester.pumpAndSettle();

      expect(find.text('Widget Alpha'), findsOneWidget);
      expect(find.text('Widget Beta'), findsOneWidget);
      expect(find.text('2'), findsOneWidget); // quantity for Alpha
      expect(find.text('1'), findsOneWidget); // quantity for Beta
      // Subtotal: 2*29.99 + 1*39.99 = 99.97
      expect(find.textContaining('\$99.97'), findsOneWidget);
      expect(find.text('Proceed to Checkout'), findsOneWidget);
    });

    testWidgets('can increase and decrease item quantity', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final item = _makeCartItem(quantity: 2, priceCents: 1000);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
          ],
          child: const MaterialApp(home: CartScreen()),
        ),
      );
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
          tester.element(find.byType(CartScreen)));
      container.read(cartProvider.notifier).addItem(item);
      await tester.pumpAndSettle();

      expect(find.text('2'), findsOneWidget);

      // Increase quantity
      await tester.tap(find.byTooltip('Increase quantity'));
      await tester.pumpAndSettle();
      expect(find.text('3'), findsOneWidget);

      // Decrease quantity
      await tester.tap(find.byTooltip('Decrease quantity'));
      await tester.pumpAndSettle();
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('removing last item shows empty cart', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final item = _makeCartItem(quantity: 1);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
          ],
          child: const MaterialApp(home: CartScreen()),
        ),
      );
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
          tester.element(find.byType(CartScreen)));
      container.read(cartProvider.notifier).addItem(item);
      await tester.pumpAndSettle();

      expect(find.text('Test Product'), findsOneWidget);

      // Decrease to 0 removes item
      await tester.tap(find.byTooltip('Decrease quantity'));
      await tester.pumpAndSettle();

      expect(find.text('Your cart is empty'), findsOneWidget);
    });
  });

  group('CheckoutScreen', () {
    testWidgets('shows empty cart message when cart is empty', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
          ],
          child: const MaterialApp(home: CheckoutScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Checkout'), findsOneWidget);
      expect(find.text('Your cart is empty'), findsOneWidget);
    });

    testWidgets('shows order summary and address form when cart has items',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final item = _makeCartItem(
        productTitle: 'Widget Alpha',
        priceCents: 2999,
        quantity: 1,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
            savedAddressesProvider.overrideWith(
                (_) => Future.value(<Address>[])),
          ],
          child: const MaterialApp(home: CheckoutScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Add item
      final container = ProviderScope.containerOf(
          tester.element(find.byType(CheckoutScreen)));
      container.read(cartProvider.notifier).addItem(item);
      await tester.pumpAndSettle();

      expect(find.text('Order Summary'), findsOneWidget);
      expect(find.textContaining('Widget Alpha'), findsOneWidget);
      expect(find.text('Shipping Address'), findsOneWidget);
      // Address form fields shown when no saved addresses
      expect(find.text('Full Name'), findsOneWidget);
      expect(find.text('Street Address'), findsOneWidget);
      expect(find.text('City'), findsOneWidget);
      expect(find.text('State'), findsOneWidget);
      expect(find.text('ZIP Code'), findsOneWidget);
    });

    testWidgets('shows saved addresses when available', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final savedAddresses = [
        const Address(
          id: 'addr-1',
          name: 'John Doe',
          street1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          zip: '62701',
        ),
      ];
      final item = _makeCartItem();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
            savedAddressesProvider
                .overrideWith((_) => Future.value(savedAddresses)),
          ],
          child: const MaterialApp(home: CheckoutScreen()),
        ),
      );
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
          tester.element(find.byType(CheckoutScreen)));
      container.read(cartProvider.notifier).addItem(item);
      await tester.pumpAndSettle();

      expect(find.text('John Doe'), findsOneWidget);
      expect(find.textContaining('123 Main St'), findsOneWidget);
      expect(find.text('New Address'), findsOneWidget);
    });

    testWidgets('place order button disabled until address and shipping selected',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final item = _makeCartItem();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authStateProvider.overrideWith(() => _MockAuthNotifier()),
            savedAddressesProvider.overrideWith(
                (_) => Future.value(<Address>[])),
          ],
          child: const MaterialApp(home: CheckoutScreen()),
        ),
      );
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
          tester.element(find.byType(CheckoutScreen)));
      container.read(cartProvider.notifier).addItem(item);
      await tester.pumpAndSettle();

      // Place Order should be disabled (no address/shipping selected)
      final button = tester.widget<FilledButton>(find.widgetWithText(
          FilledButton, 'Place Order'));
      expect(button.onPressed, isNull);
    });
  });

  group('OrderConfirmationScreen', () {
    testWidgets('shows order confirmation details', (tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const confirmation = OrderConfirmation(
        orderId: 'ord-123',
        orderNumber: 'KNX-1001',
        subtotalCents: 5998,
        shippingCents: 799,
        taxCents: 480,
        totalCents: 7277,
      );

      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: OrderConfirmationScreen(confirmation: confirmation),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order Confirmed'), findsOneWidget);
      expect(find.text('Thank you for your order!'), findsOneWidget);
      expect(find.text('Order #KNX-1001'), findsOneWidget);
      expect(find.text('Subtotal'), findsOneWidget);
      expect(find.text('\$59.98'), findsOneWidget);
      expect(find.text('Shipping'), findsOneWidget);
      expect(find.text('\$7.99'), findsOneWidget);
      expect(find.text('Tax'), findsOneWidget);
      expect(find.text('\$4.80'), findsOneWidget);
      expect(find.text('Total'), findsOneWidget);
      expect(find.text('\$72.77'), findsOneWidget);
      expect(find.text('View Orders'), findsOneWidget);
      expect(find.text('Continue Shopping'), findsOneWidget);
    });
  });

  group('ProductDetailScreen add to cart integration', () {
    testWidgets('add to cart adds item to cart provider', (tester) async {
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

      // Tap add to cart
      await tester.tap(find.text('Add to Cart'));
      await tester.pumpAndSettle();

      expect(find.text('Added to cart'), findsOneWidget);

      // Verify cart has the item
      final container = ProviderScope.containerOf(
          tester.element(find.byType(ProductDetailScreen)));
      final cartItems = container.read(cartProvider);
      expect(cartItems.length, 1);
      expect(cartItems.first.variantId, 'var-tpu');
      expect(cartItems.first.productTitle, 'Test Product');
    });
  });

  group('CartNotifier', () {
    test('addItem adds new item', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final item = _makeCartItem();
      container.read(cartProvider.notifier).addItem(item);

      expect(container.read(cartProvider).length, 1);
    });

    test('addItem merges duplicate variant quantities', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final item = _makeCartItem(quantity: 1);
      container.read(cartProvider.notifier).addItem(item);
      container.read(cartProvider.notifier).addItem(item);

      expect(container.read(cartProvider).length, 1);
      expect(container.read(cartProvider).first.quantity, 2);
    });

    test('updateQuantity changes item quantity', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(_makeCartItem(quantity: 1));
      container.read(cartProvider.notifier).updateQuantity('var-1', 5);

      expect(container.read(cartProvider).first.quantity, 5);
    });

    test('updateQuantity to 0 removes item', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(_makeCartItem());
      container.read(cartProvider.notifier).updateQuantity('var-1', 0);

      expect(container.read(cartProvider), isEmpty);
    });

    test('removeItem removes item by variantId', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(_makeCartItem());
      container.read(cartProvider.notifier).removeItem('var-1');

      expect(container.read(cartProvider), isEmpty);
    });

    test('clear removes all items', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v1'));
      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v2'));
      container.read(cartProvider.notifier).clear();

      expect(container.read(cartProvider), isEmpty);
    });

    test('cartSubtotalProvider computes correct total', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v1', priceCents: 1000, quantity: 2));
      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v2', priceCents: 500, quantity: 3));

      // 2*1000 + 3*500 = 3500
      expect(container.read(cartSubtotalProvider), 3500);
    });

    test('cartItemCountProvider computes correct count', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v1', quantity: 2));
      container.read(cartProvider.notifier).addItem(
          _makeCartItem(variantId: 'v2', quantity: 3));

      expect(container.read(cartItemCountProvider), 5);
    });
  });
}
