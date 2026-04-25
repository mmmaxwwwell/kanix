import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/fulfillment.dart';

final fulfillmentListProvider =
    FutureProvider.autoDispose<List<FulfillmentTask>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/fulfillment-tasks');
  final data = response.data as Map<String, dynamic>;
  final tasks = data['tasks'] as List<dynamic>;
  return tasks
      .map((e) => FulfillmentTask.fromJson(e as Map<String, dynamic>))
      .toList();
});

final fulfillmentDetailProvider = FutureProvider.autoDispose
    .family<FulfillmentTask, String>((ref, taskId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/fulfillment-tasks/$taskId');
  final data = response.data as Map<String, dynamic>;
  return FulfillmentTask.fromJson(data['task'] as Map<String, dynamic>);
});
