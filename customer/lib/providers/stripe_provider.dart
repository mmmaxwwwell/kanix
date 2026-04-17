import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_stripe/flutter_stripe.dart';

import '../config/api_client.dart';

/// Fetches the Stripe publishable key from the API and initializes the SDK.
final stripeInitProvider = FutureProvider<void>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/stripe/config');
  final data = response.data as Map<String, dynamic>;
  Stripe.publishableKey = data['publishableKey'] as String;
});

/// Creates a Stripe payment method from the card details currently entered
/// in the on-screen [CardField]. Returns the payment method ID.
Future<String> createCardPaymentMethod() async {
  final paymentMethod = await Stripe.instance.createPaymentMethod(
    params: const PaymentMethodParams.card(
      paymentMethodData: PaymentMethodData(),
    ),
  );
  return paymentMethod.id;
}
