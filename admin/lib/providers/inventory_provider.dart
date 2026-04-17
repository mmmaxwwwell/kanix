import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/inventory.dart';

final inventoryListProvider =
    FutureProvider.autoDispose<List<InventoryVariant>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/inventory');
  final data = response.data as Map<String, dynamic>;
  final items = data['variants'] as List<dynamic>;
  return items
      .map((e) => InventoryVariant.fromJson(e as Map<String, dynamic>))
      .toList();
});

final inventoryDetailProvider = FutureProvider.autoDispose
    .family<InventoryVariant, String>((ref, variantId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/inventory/$variantId');
  final data = response.data as Map<String, dynamic>;
  return InventoryVariant.fromJson(data['variant'] as Map<String, dynamic>);
});

final inventoryAdjustmentsProvider = FutureProvider.autoDispose
    .family<List<InventoryAdjustment>, String>((ref, variantId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/admin/inventory/$variantId/adjustments');
  final data = response.data as Map<String, dynamic>;
  final adjustments = data['adjustments'] as List<dynamic>;
  return adjustments
      .map((e) => InventoryAdjustment.fromJson(e as Map<String, dynamic>))
      .toList();
});
