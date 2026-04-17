import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/support.dart';
import 'websocket_provider.dart';

class TicketFilters {
  final String? status;
  final String? priority;
  final String? search;

  const TicketFilters({this.status, this.priority, this.search});

  TicketFilters copyWith({
    String? Function()? status,
    String? Function()? priority,
    String? Function()? search,
  }) {
    return TicketFilters(
      status: status != null ? status() : this.status,
      priority: priority != null ? priority() : this.priority,
      search: search != null ? search() : this.search,
    );
  }

  Map<String, String> toQueryParameters() {
    final params = <String, String>{};
    if (status != null) params['status'] = status!;
    if (priority != null) params['priority'] = priority!;
    if (search != null && search!.isNotEmpty) params['search'] = search!;
    return params;
  }
}

final ticketFiltersProvider =
    StateProvider<TicketFilters>((ref) => const TicketFilters());

final ticketListProvider =
    FutureProvider.autoDispose<List<SupportTicket>>((ref) async {
  final dio = ref.watch(dioProvider);
  final filters = ref.watch(ticketFiltersProvider);
  final response = await dio.get(
    '/api/admin/support/tickets',
    queryParameters: filters.toQueryParameters(),
  );
  final data = response.data as Map<String, dynamic>;
  final ticketsJson = data['tickets'] as List<dynamic>;
  return ticketsJson
      .map((e) => SupportTicket.fromJson(e as Map<String, dynamic>))
      .toList();
});

final ticketDetailProvider = FutureProvider.autoDispose
    .family<SupportTicket, String>((ref, ticketId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/support/tickets/$ticketId');
  final data = response.data as Map<String, dynamic>;
  return SupportTicket.fromJson(data['ticket'] as Map<String, dynamic>);
});

final ticketMessagesProvider = FutureProvider.autoDispose
    .family<List<TicketMessage>, String>((ref, ticketId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/admin/support/tickets/$ticketId/messages');
  final data = response.data as Map<String, dynamic>;
  final messagesJson = data['messages'] as List<dynamic>;
  return messagesJson
      .map((e) => TicketMessage.fromJson(e as Map<String, dynamic>))
      .toList();
});

final ticketUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('ticket');
});
