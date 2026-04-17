import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/kit.dart';

final kitListProvider =
    FutureProvider.autoDispose<List<KitDefinition>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/kits');
  final data = response.data as Map<String, dynamic>;
  final kits = data['kits'] as List<dynamic>;
  return kits
      .map((e) => KitDefinition.fromJson(e as Map<String, dynamic>))
      .toList();
});
