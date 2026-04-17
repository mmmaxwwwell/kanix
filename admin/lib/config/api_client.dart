import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _defaultBaseUrl = 'http://localhost:3000';

final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(BaseOptions(
    baseUrl: const String.fromEnvironment('API_BASE_URL',
        defaultValue: _defaultBaseUrl),
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 10),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  ));

  dio.interceptors.add(AuthInterceptor(ref));
  dio.interceptors.add(LogInterceptor(
    requestBody: true,
    responseBody: true,
    logPrint: (o) {}, // silent in production; enable for debug
  ));

  return dio;
});

class AuthInterceptor extends Interceptor {
  final Ref _ref;

  AuthInterceptor(this._ref);

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    // SuperTokens uses cookie-based auth; Dio handles cookies automatically
    // when using the browser (Flutter web). For non-web platforms, the
    // session tokens are managed via headers.
    final accessToken = _ref.read(accessTokenProvider);
    if (accessToken != null) {
      options.headers['Authorization'] = 'Bearer $accessToken';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (err.response?.statusCode == 401) {
      // Clear stored auth state on 401
      _ref.read(accessTokenProvider.notifier).state = null;
    }
    handler.next(err);
  }
}

/// Holds the SuperTokens access token for non-web platforms.
final accessTokenProvider = StateProvider<String?>((ref) => null);
