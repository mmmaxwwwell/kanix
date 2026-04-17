import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/dispute.dart';
import 'websocket_provider.dart';

class DisputeFilters {
  final String? status;
  final String? search;

  const DisputeFilters({this.status, this.search});

  DisputeFilters copyWith({
    String? Function()? status,
    String? Function()? search,
  }) {
    return DisputeFilters(
      status: status != null ? status() : this.status,
      search: search != null ? search() : this.search,
    );
  }

  Map<String, String> toQueryParameters() {
    final params = <String, String>{};
    if (status != null) params['status'] = status!;
    if (search != null && search!.isNotEmpty) params['search'] = search!;
    return params;
  }
}

final disputeFiltersProvider =
    StateProvider<DisputeFilters>((ref) => const DisputeFilters());

final disputeListProvider =
    FutureProvider.autoDispose<List<Dispute>>((ref) async {
  final dio = ref.watch(dioProvider);
  final filters = ref.watch(disputeFiltersProvider);
  final response = await dio.get(
    '/api/admin/disputes',
    queryParameters: filters.toQueryParameters(),
  );
  final data = response.data as Map<String, dynamic>;
  final disputesJson = data['disputes'] as List<dynamic>;
  return disputesJson
      .map((e) => Dispute.fromJson(e as Map<String, dynamic>))
      .toList();
});

final disputeDetailProvider = FutureProvider.autoDispose
    .family<Dispute, String>((ref, disputeId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/disputes/$disputeId');
  final data = response.data as Map<String, dynamic>;
  return Dispute.fromJson(data['dispute'] as Map<String, dynamic>);
});

final disputeEvidenceProvider = FutureProvider.autoDispose
    .family<List<DisputeEvidence>, String>((ref, disputeId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/disputes/$disputeId/evidence');
  final data = response.data as Map<String, dynamic>;
  final evidenceJson = data['evidence'] as List<dynamic>;
  return evidenceJson
      .map((e) => DisputeEvidence.fromJson(e as Map<String, dynamic>))
      .toList();
});

final disputeUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('dispute');
});
