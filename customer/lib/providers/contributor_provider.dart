import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/contributor.dart';

final contributorDashboardProvider =
    FutureProvider.autoDispose<ContributorDashboardData>((ref) async {
  final dio = ref.read(dioProvider);
  final response = await dio.get('/api/contributor/dashboard');
  return ContributorDashboardData.fromJson(
      response.data as Map<String, dynamic>);
});
