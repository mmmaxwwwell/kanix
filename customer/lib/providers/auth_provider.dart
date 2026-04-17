import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';

class CustomerUser {
  final String id;
  final String email;
  final String name;
  final bool emailVerified;
  final String? githubLinked;

  const CustomerUser({
    required this.id,
    required this.email,
    required this.name,
    this.emailVerified = false,
    this.githubLinked,
  });

  factory CustomerUser.fromJson(Map<String, dynamic> json) {
    return CustomerUser(
      id: json['id'] as String,
      email: json['email'] as String,
      name: (json['name'] as String?) ?? '',
      emailVerified: json['emailVerified'] as bool? ?? false,
      githubLinked: json['githubLinked'] as String?,
    );
  }
}

class AuthState {
  final CustomerUser? user;
  final bool isLoading;
  final String? error;
  final bool pendingVerification;

  const AuthState({
    this.user,
    this.isLoading = false,
    this.error,
    this.pendingVerification = false,
  });

  bool get isAuthenticated => user != null;

  AuthState copyWith({
    CustomerUser? user,
    bool? isLoading,
    String? error,
    bool? pendingVerification,
  }) {
    return AuthState(
      user: user ?? this.user,
      isLoading: isLoading ?? this.isLoading,
      error: error,
      pendingVerification: pendingVerification ?? this.pendingVerification,
    );
  }
}

class AuthNotifier extends AsyncNotifier<AuthState> {
  @override
  Future<AuthState> build() async {
    try {
      final dio = ref.read(dioProvider);
      final response = await dio.get('/api/customer/me');
      if (response.statusCode == 200) {
        final user = CustomerUser.fromJson(
            response.data['user'] as Map<String, dynamic>);
        return AuthState(user: user);
      }
    } catch (_) {
      // No valid session
    }
    return const AuthState();
  }

  Future<void> signUp(String email, String password, String name) async {
    state = const AsyncValue.data(AuthState(isLoading: true));
    try {
      final dio = ref.read(dioProvider);
      final response = await dio.post(
        '/auth/signup',
        data: {
          'formFields': [
            {'id': 'email', 'value': email},
            {'id': 'password', 'value': password},
            {'id': 'name', 'value': name},
          ],
        },
      );

      if (response.statusCode == 200 && response.data['status'] == 'OK') {
        final accessToken = response.headers.value('st-access-token');
        if (accessToken != null) {
          ref.read(accessTokenProvider.notifier).state = accessToken;
        }
        state = const AsyncValue.data(
          AuthState(pendingVerification: true),
        );
      } else {
        final message =
            response.data['message'] as String? ?? 'Sign up failed';
        state = AsyncValue.data(AuthState(error: message));
      }
    } on DioException catch (e) {
      final message = e.response?.data?['message'] as String? ??
          'Sign up failed. Please try again.';
      state = AsyncValue.data(AuthState(error: message));
    } catch (e) {
      state = AsyncValue.data(AuthState(error: e.toString()));
    }
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
        final accessToken =
            signInResponse.headers.value('st-access-token');
        if (accessToken != null) {
          ref.read(accessTokenProvider.notifier).state = accessToken;
        }

        final profileResponse = await dio.get('/api/customer/me');
        if (profileResponse.statusCode == 200) {
          final user = CustomerUser.fromJson(
              profileResponse.data['user'] as Map<String, dynamic>);
          if (!user.emailVerified) {
            state = const AsyncValue.data(
              AuthState(pendingVerification: true),
            );
            return;
          }
          state = AsyncValue.data(AuthState(user: user));
          return;
        }

        state = const AsyncValue.data(
          AuthState(error: 'Failed to fetch profile'),
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

  Future<void> verifyEmail(String token) async {
    state = const AsyncValue.data(AuthState(isLoading: true));
    try {
      final dio = ref.read(dioProvider);
      final response = await dio.post(
        '/auth/user/email/verify',
        data: {'method': 'token', 'token': token},
      );

      if (response.statusCode == 200 && response.data['status'] == 'OK') {
        final profileResponse = await dio.get('/api/customer/me');
        if (profileResponse.statusCode == 200) {
          final user = CustomerUser.fromJson(
              profileResponse.data['user'] as Map<String, dynamic>);
          state = AsyncValue.data(AuthState(user: user));
          return;
        }
      }
      state = const AsyncValue.data(
        AuthState(error: 'Email verification failed'),
      );
    } on DioException catch (e) {
      final message = e.response?.data?['message'] as String? ??
          'Verification failed. Please try again.';
      state = AsyncValue.data(AuthState(error: message));
    } catch (e) {
      state = AsyncValue.data(AuthState(error: e.toString()));
    }
  }

  Future<void> resendVerificationEmail() async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post('/auth/user/email/verify/token');
    } catch (_) {
      // Best-effort
    }
  }

  Future<void> linkGitHub() async {
    try {
      final dio = ref.read(dioProvider);
      final response = await dio.get('/api/customer/github/auth-url');
      if (response.statusCode == 200) {
        // The URL would be opened in a browser; handled by the UI layer
      }
    } catch (_) {
      // Handled by UI
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
