import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/contributor.dart';

final contributorDashboardProvider =
    FutureProvider.autoDispose<ContributorDashboardData>((ref) async {
  final dio = ref.read(dioProvider);
  final response = await dio.get('/api/contributors/dashboard');
  final outer = response.data as Map<String, dynamic>;
  final dashboard = outer['dashboard'] as Map<String, dynamic>;
  return ContributorDashboardData.fromJson(dashboard);
});
