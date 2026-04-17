import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';

class AdminUser {
  final String id;
  final String email;
  final String name;
  final List<String> capabilities;

  const AdminUser({
    required this.id,
    required this.email,
    required this.name,
    required this.capabilities,
  });

  factory AdminUser.fromJson(Map<String, dynamic> json) {
    return AdminUser(
      id: json['id'] as String,
      email: json['email'] as String,
      name: json['name'] as String,
      capabilities: (json['capabilities'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
    );
  }

  bool hasCapability(String capability) => capabilities.contains(capability);
}

class AuthState {
  final AdminUser? admin;
  final bool isLoading;
  final String? error;

  const AuthState({this.admin, this.isLoading = false, this.error});

  bool get isAuthenticated => admin != null;

  AuthState copyWith({AdminUser? admin, bool? isLoading, String? error}) {
    return AuthState(
      admin: admin ?? this.admin,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

class AuthNotifier extends AsyncNotifier<AuthState> {
  @override
  Future<AuthState> build() async {
    // Try to restore session on startup
    try {
      final dio = ref.read(dioProvider);
      final response = await dio.get('/api/admin/me');
      if (response.statusCode == 200) {
        final admin = AdminUser.fromJson(
            response.data['admin'] as Map<String, dynamic>);
        return AuthState(admin: admin);
      }
    } catch (_) {
      // No valid session
    }
    return const AuthState();
  }

  Future<void> signIn(String email, String password) async {
    state = const AsyncValue.data(AuthState(isLoading: true));
    try {
      final dio = ref.read(dioProvider);
      final signInResponse = await dio.post(
        '/auth/signin',
        data: {
          'formFields': [
            {'id': 'email', 'value': email},
            {'id': 'password', 'value': password},
          ],
        },
      );

      if (signInResponse.statusCode == 200 &&
          signInResponse.data['status'] == 'OK') {
        // Extract tokens from response headers for non-web platforms
        final accessToken =
            signInResponse.headers.value('st-access-token');
        if (accessToken != null) {
          ref.read(accessTokenProvider.notifier).state = accessToken;
        }

        // Fetch admin profile
        final profileResponse = await dio.get('/api/admin/me');
        if (profileResponse.statusCode == 200) {
          final admin = AdminUser.fromJson(
              profileResponse.data['admin'] as Map<String, dynamic>);
          state = AsyncValue.data(AuthState(admin: admin));
          return;
        }

        state = const AsyncValue.data(
          AuthState(error: 'Failed to fetch admin profile'),
        );
      } else {
        final message = signInResponse.data['message'] as String? ??
            'Invalid credentials';
        state = AsyncValue.data(AuthState(error: message));
      }
    } on DioException catch (e) {
      final message = e.response?.data?['message'] as String? ??
          'Sign in failed. Check your credentials and try again.';
      state = AsyncValue.data(AuthState(error: message));
    } catch (e) {
      state = AsyncValue.data(AuthState(error: e.toString()));
    }
  }

  Future<void> signOut() async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post('/auth/signout');
    } catch (_) {
      // Best-effort signout
    }
    ref.read(accessTokenProvider.notifier).state = null;
    state = const AsyncValue.data(AuthState());
  }
}

final authStateProvider =
    AsyncNotifierProvider<AuthNotifier, AuthState>(AuthNotifier.new);
