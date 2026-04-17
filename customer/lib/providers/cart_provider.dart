import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/cart.dart';

/// Local cart state — items stored client-side, synced to API at checkout.
class CartNotifier extends Notifier<List<CartItem>> {
  @override
  List<CartItem> build() => [];

  void addItem(CartItem item) {
    final existing = state.indexWhere((i) => i.variantId == item.variantId);
    if (existing >= 0) {
      final updated = List<CartItem>.from(state);
      updated[existing] = updated[existing]
          .copyWith(quantity: updated[existing].quantity + item.quantity);
      state = updated;
    } else {
      state = [...state, item];
    }
  }

  void updateQuantity(String variantId, int quantity) {
    if (quantity <= 0) {
      removeItem(variantId);
      return;
    }
    state = [
      for (final item in state)
        if (item.variantId == variantId)
          item.copyWith(quantity: quantity)
        else
          item,
    ];
  }

  void removeItem(String variantId) {
    state = state.where((i) => i.variantId != variantId).toList();
  }

  void clear() {
    state = [];
  }
}

final cartProvider =
    NotifierProvider<CartNotifier, List<CartItem>>(CartNotifier.new);

/// Cart subtotal in cents.
final cartSubtotalProvider = Provider<int>((ref) {
  final items = ref.watch(cartProvider);
  return items.fold<int>(0, (sum, item) => sum + item.totalCents);
});

/// Cart item count.
final cartItemCountProvider = Provider<int>((ref) {
  final items = ref.watch(cartProvider);
  return items.fold<int>(0, (sum, item) => sum + item.quantity);
});

/// Saved addresses for the current user.
final savedAddressesProvider =
    FutureProvider.autoDispose<List<Address>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/addresses');
  final data = response.data as Map<String, dynamic>;
  final addresses = data['addresses'] as List<dynamic>;
  return addresses
      .map((e) => Address.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Fetches shipping rates for the given address.
final shippingRatesProvider = FutureProvider.autoDispose
    .family<List<ShippingRate>, Address>((ref, address) async {
  final dio = ref.watch(dioProvider);
  final items = ref.read(cartProvider);
  final response = await dio.post('/api/customer/shipping/rates', data: {
    'address': address.toJson(),
    'items': items.map((i) => {'variantId': i.variantId, 'quantity': i.quantity}).toList(),
  });
  final data = response.data as Map<String, dynamic>;
  final rates = data['rates'] as List<dynamic>;
  return rates
      .map((e) => ShippingRate.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Fetches tax amount for the current cart + address.
final taxAmountProvider = FutureProvider.autoDispose
    .family<int, Address>((ref, address) async {
  final dio = ref.watch(dioProvider);
  final items = ref.read(cartProvider);
  final response = await dio.post('/api/customer/tax/calculate', data: {
    'address': address.toJson(),
    'items': items.map((i) => {'variantId': i.variantId, 'quantity': i.quantity}).toList(),
  });
  final data = response.data as Map<String, dynamic>;
  return data['taxCents'] as int;
});

/// Checkout action — places the order via the API.
class CheckoutNotifier extends AutoDisposeAsyncNotifier<OrderConfirmation?> {
  @override
  Future<OrderConfirmation?> build() async => null;

  Future<OrderConfirmation> placeOrder({
    required Address address,
    required String shippingRateId,
    required String paymentMethodId,
  }) async {
    state = const AsyncValue.loading();
    try {
      final dio = ref.read(dioProvider);
      final items = ref.read(cartProvider);
      final response = await dio.post('/api/customer/checkout', data: {
        'address': address.toJson(),
        'shippingRateId': shippingRateId,
        'paymentMethodId': paymentMethodId,
        'items': items
            .map((i) =>
                {'variantId': i.variantId, 'quantity': i.quantity})
            .toList(),
      });
      final data = response.data as Map<String, dynamic>;
      final confirmation =
          OrderConfirmation.fromJson(data['order'] as Map<String, dynamic>);
      ref.read(cartProvider.notifier).clear();
      state = AsyncValue.data(confirmation);
      return confirmation;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      rethrow;
    }
  }
}

final checkoutProvider =
    AsyncNotifierProvider.autoDispose<CheckoutNotifier, OrderConfirmation?>(
        CheckoutNotifier.new);
