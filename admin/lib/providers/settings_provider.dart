import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/admin_user_management.dart';

final adminUsersProvider =
    FutureProvider.autoDispose<List<ManagedAdminUser>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/users');
  final data = response.data as Map<String, dynamic>;
  final usersJson = data['users'] as List<dynamic>;
  return usersJson
      .map((e) => ManagedAdminUser.fromJson(e as Map<String, dynamic>))
      .toList();
});

final adminRolesProvider =
    FutureProvider.autoDispose<List<AdminRole>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/roles');
  final data = response.data as Map<String, dynamic>;
  final rolesJson = data['roles'] as List<dynamic>;
  return rolesJson
      .map((e) => AdminRole.fromJson(e as Map<String, dynamic>))
      .toList();
});
