import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/order.dart';

class OrderFilters {
  final String? status;
  final String? paymentStatus;
  final String? fulfillmentStatus;
  final String? shippingStatus;
  final DateTime? dateFrom;
  final DateTime? dateTo;
  final String? search;

  const OrderFilters({
    this.status,
    this.paymentStatus,
    this.fulfillmentStatus,
    this.shippingStatus,
    this.dateFrom,
    this.dateTo,
    this.search,
  });

  OrderFilters copyWith({
    String? Function()? status,
    String? Function()? paymentStatus,
    String? Function()? fulfillmentStatus,
    String? Function()? shippingStatus,
    DateTime? Function()? dateFrom,
    DateTime? Function()? dateTo,
    String? Function()? search,
  }) {
    return OrderFilters(
      status: status != null ? status() : this.status,
      paymentStatus:
          paymentStatus != null ? paymentStatus() : this.paymentStatus,
      fulfillmentStatus: fulfillmentStatus != null
          ? fulfillmentStatus()
          : this.fulfillmentStatus,
      shippingStatus:
          shippingStatus != null ? shippingStatus() : this.shippingStatus,
      dateFrom: dateFrom != null ? dateFrom() : this.dateFrom,
      dateTo: dateTo != null ? dateTo() : this.dateTo,
      search: search != null ? search() : this.search,
    );
  }

  Map<String, String> toQueryParameters() {
    final params = <String, String>{};
    if (status != null) params['status'] = status!;
    if (paymentStatus != null) params['paymentStatus'] = paymentStatus!;
    if (fulfillmentStatus != null) {
      params['fulfillmentStatus'] = fulfillmentStatus!;
    }
    if (shippingStatus != null) params['shippingStatus'] = shippingStatus!;
    if (dateFrom != null) params['dateFrom'] = dateFrom!.toIso8601String();
    if (dateTo != null) params['dateTo'] = dateTo!.toIso8601String();
    if (search != null && search!.isNotEmpty) params['search'] = search!;
    return params;
  }
}

final orderFiltersProvider =
    StateProvider<OrderFilters>((ref) => const OrderFilters());

final orderListProvider =
    FutureProvider.autoDispose<List<Order>>((ref) async {
  final dio = ref.watch(dioProvider);
  final filters = ref.watch(orderFiltersProvider);
  final response = await dio.get(
    '/api/admin/orders',
    queryParameters: filters.toQueryParameters(),
  );
  final data = response.data as Map<String, dynamic>;
  final ordersJson = data['orders'] as List<dynamic>;
  return ordersJson
      .map((e) => Order.fromJson(e as Map<String, dynamic>))
      .toList();
});

final orderDetailProvider =
    FutureProvider.autoDispose.family<Order, String>((ref, orderId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/orders/$orderId');
  final data = response.data as Map<String, dynamic>;
  return Order.fromJson(data['order'] as Map<String, dynamic>);
});

final orderHistoryProvider = FutureProvider.autoDispose
    .family<List<OrderStatusHistoryEntry>, String>((ref, orderId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/orders/$orderId/history');
  final data = response.data as Map<String, dynamic>;
  final entries = data['history'] as List<dynamic>;
  return entries
      .map((e) =>
          OrderStatusHistoryEntry.fromJson(e as Map<String, dynamic>))
      .toList();
});

final orderRefundsProvider = FutureProvider.autoDispose
    .family<List<Refund>, String>((ref, orderId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/orders/$orderId/refunds');
  final data = response.data as Map<String, dynamic>;
  final refunds = data['refunds'] as List<dynamic>;
  return refunds
      .map((e) => Refund.fromJson(e as Map<String, dynamic>))
      .toList();
});
