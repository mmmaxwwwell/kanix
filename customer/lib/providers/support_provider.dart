import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/order.dart';
import '../models/support.dart';
import 'websocket_provider.dart';

/// Fetches the list of support tickets for the current customer.
final ticketListProvider =
    FutureProvider.autoDispose<List<SupportTicket>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/support/tickets');
  final data = response.data as Map<String, dynamic>;
  final tickets = data['tickets'] as List<dynamic>;
  return tickets
      .map((e) => SupportTicket.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Fetches a single support ticket by ID.
final ticketDetailProvider = FutureProvider.autoDispose
    .family<SupportTicket, String>((ref, ticketId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/customer/support/tickets/$ticketId');
  final data = response.data as Map<String, dynamic>;
  return SupportTicket.fromJson(data['ticket'] as Map<String, dynamic>);
});

/// Fetches messages for a specific ticket.
final ticketMessagesProvider = FutureProvider.autoDispose
    .family<List<TicketMessage>, String>((ref, ticketId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/customer/support/tickets/$ticketId/messages');
  final data = response.data as Map<String, dynamic>;
  final messages = data['messages'] as List<dynamic>;
  return messages
      .map((e) => TicketMessage.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Stream of ticket-related WebSocket messages.
final ticketUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('ticket');
});

/// Fetches the list of warranty claims for the current customer.
final warrantyClaimsProvider =
    FutureProvider.autoDispose<List<WarrantyClaim>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/warranty/claims');
  final data = response.data as Map<String, dynamic>;
  final claims = data['claims'] as List<dynamic>;
  return claims
      .map((e) => WarrantyClaim.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// Fetches a single warranty claim by ID.
final warrantyClaimDetailProvider = FutureProvider.autoDispose
    .family<WarrantyClaim, String>((ref, claimId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/customer/warranty/claims/$claimId');
  final data = response.data as Map<String, dynamic>;
  return WarrantyClaim.fromJson(data['claim'] as Map<String, dynamic>);
});

/// Stream of warranty-related WebSocket messages.
final warrantyUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('warranty');
});

/// Fetches delivered orders eligible for warranty claims.
final deliveredOrdersProvider =
    FutureProvider.autoDispose<List<Order>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/customer/orders', queryParameters: {'status': 'delivered'});
  final data = response.data as Map<String, dynamic>;
  final orders = data['orders'] as List<dynamic>;
  return orders
      .map((e) => Order.fromJson(e as Map<String, dynamic>))
      .toList();
});
