import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/api_client.dart';

class WsMessage {
  final String subject;
  final String event;
  final Map<String, dynamic> payload;
  final int sequenceId;

  const WsMessage({
    required this.subject,
    required this.event,
    required this.payload,
    required this.sequenceId,
  });

  factory WsMessage.fromJson(Map<String, dynamic> json) {
    return WsMessage(
      subject: json['entity'] as String? ?? '',
      event: json['type'] as String? ?? '',
      payload: json['data'] as Map<String, dynamic>? ?? {},
      sequenceId: json['sequenceId'] as int? ?? 0,
    );
  }
}

class WebSocketNotifier extends StateNotifier<AsyncValue<void>> {
  final _controller = StreamController<WsMessage>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final Ref _ref;

  WebSocketNotifier(Ref ref)
      : _ref = ref,
        super(const AsyncValue.loading()) {
    _connect();
  }

  Stream<WsMessage> get messages => _controller.stream;

  Stream<WsMessage> messagesForSubject(String subject) {
    return _controller.stream.where((m) => m.subject == subject);
  }

  void _connect() {
    final token = _ref.read(accessTokenProvider);
    if (token == null) {
      state = const AsyncValue.data(null);
      return;
    }

    final baseUrl = const String.fromEnvironment('API_BASE_URL',
        defaultValue: 'http://localhost:3000');
    final wsUrl = baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
    final uri = Uri.parse('$wsUrl/ws?token=$token');

    try {
      _channel = WebSocketChannel.connect(uri);
      _subscription = _channel!.stream.listen(
        (raw) => _handleMessage(raw as String),
        onError: (_) => _reconnect(),
        onDone: () => _reconnect(),
      );
      state = const AsyncValue.data(null);
    } catch (e) {
      state = AsyncValue.error(e, StackTrace.current);
    }
  }

  void _reconnect() {
    _channel = null;
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) _connect();
    });
  }

  void _handleMessage(String raw) {
    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      final type = json['type'] as String?;
      if (type != null && type != 'connected' && !_controller.isClosed) {
        _controller.add(WsMessage.fromJson(json));
      }
    } catch (_) {
      // Ignore malformed messages
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _channel?.sink.close();
    _controller.close();
    super.dispose();
  }
}

final webSocketProvider =
    StateNotifierProvider<WebSocketNotifier, AsyncValue<void>>((ref) {
  ref.watch(accessTokenProvider);
  return WebSocketNotifier(ref);
});

/// Stream of order-related WebSocket messages.
final orderUpdatesProvider = StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('order');
});
