import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/shipment.dart';

final shipmentListProvider =
    FutureProvider.autoDispose<List<Shipment>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/shipments');
  final data = response.data as Map<String, dynamic>;
  final shipments = data['shipments'] as List<dynamic>;
  return shipments
      .map((e) => Shipment.fromJson(e as Map<String, dynamic>))
      .toList();
});

final shipmentDetailProvider = FutureProvider.autoDispose
    .family<Shipment, String>((ref, shipmentId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/shipments/$shipmentId');
  final data = response.data as Map<String, dynamic>;
  return Shipment.fromJson(data['shipment'] as Map<String, dynamic>);
});
