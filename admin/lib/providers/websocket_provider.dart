import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

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
      subject: json['subject'] as String? ?? '',
      event: json['event'] as String? ?? '',
      payload: json['payload'] as Map<String, dynamic>? ?? {},
      sequenceId: json['sequenceId'] as int? ?? 0,
    );
  }
}

class WebSocketNotifier extends StateNotifier<AsyncValue<void>> {
  final _controller = StreamController<WsMessage>.broadcast();

  WebSocketNotifier(Ref ref) : super(const AsyncValue.data(null));

  Stream<WsMessage> get messages => _controller.stream;

  Stream<WsMessage> messagesForSubject(String subject) {
    return _controller.stream.where((m) => m.subject == subject);
  }

  void handleMessage(String raw) {
    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      final type = json['type'] as String?;
      if (type == 'message') {
        _controller.add(WsMessage.fromJson(json));
      }
    } catch (_) {
      // Ignore malformed messages
    }
  }

  @override
  void dispose() {
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
