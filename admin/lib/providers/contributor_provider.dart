import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/contributor.dart';

final contributorListProvider =
    FutureProvider.autoDispose<List<Contributor>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/contributors');
  final data = response.data as Map<String, dynamic>;
  final contributorsJson = data['contributors'] as List<dynamic>;
  return contributorsJson
      .map((e) => Contributor.fromJson(e as Map<String, dynamic>))
      .toList();
});

final contributorDetailProvider = FutureProvider.autoDispose
    .family<Contributor, String>((ref, contributorId) async {
  final dio = ref.watch(dioProvider);
  final response =
      await dio.get('/api/admin/contributors/$contributorId');
  final data = response.data as Map<String, dynamic>;
  return Contributor.fromJson(data['contributor'] as Map<String, dynamic>);
});
