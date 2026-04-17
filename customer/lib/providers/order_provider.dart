import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/order.dart';
import 'websocket_provider.dart';

/// Fetches the list of orders for the current user.
final ordersProvider =
    FutureProvider.autoDispose<List<Order>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/orders');
  final data = response.data as Map<String, dynamic>;
  final orders = data['orders'] as List<dynamic>;
  return orders
      .map((e) => Order.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Fetches a single order by ID (includes line items, timeline, shipments).
final orderDetailProvider = FutureProvider.autoDispose
    .family<Order, String>((ref, orderId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/orders/$orderId');
  final data = response.data as Map<String, dynamic>;
  return Order.fromJson(data['order'] as Map<String, dynamic>);
});

/// Fetches shipment tracking details for a specific shipment.
final shipmentTrackingProvider = FutureProvider.autoDispose
    .family<Shipment, String>((ref, shipmentId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/customer/shipments/$shipmentId/tracking');
  final data = response.data as Map<String, dynamic>;
  return Shipment.fromJson(data['shipment'] as Map<String, dynamic>);
});

/// Stream of order-related WebSocket messages for real-time updates.
final orderUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('order');
});

/// Stream of shipment-related WebSocket messages for real-time tracking.
final shipmentUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('shipment');
});
