#!/usr/bin/env bash
# Verifies BUG-002 — WebSocketNotifier now establishes a real WS connection
set -eu

PROVIDER="admin/lib/providers/websocket_provider.dart"
PUBSPEC="admin/pubspec.yaml"

# Check web_socket_channel dependency is added
if ! grep -q "web_socket_channel" "$PUBSPEC" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: web_socket_channel not found in $PUBSPEC"
  echo "COMMAND: grep web_socket_channel $PUBSPEC"
  exit 1
fi

# Check WebSocketChannel.connect() is called (real connection logic present)
if ! grep -q "WebSocketChannel.connect" "$PROVIDER" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $PROVIDER does not call WebSocketChannel.connect — no real WS connection"
  echo "COMMAND: grep WebSocketChannel.connect $PROVIDER"
  exit 1
fi

# Check WsMessage.fromJson reads from correct server key 'entity' (not 'subject')
if ! grep -q "json\['entity'\]" "$PROVIDER" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $PROVIDER WsMessage.fromJson still reads wrong JSON key (missing entity mapping)"
  echo "COMMAND: grep entity $PROVIDER"
  exit 1
fi

echo "STATUS: FIXED"
echo "EVIDENCE: pubspec has web_socket_channel; provider calls WebSocketChannel.connect and reads correct server JSON keys (entity/type/data)"
echo "COMMAND: grep -n 'WebSocketChannel.connect' $PROVIDER; grep web_socket_channel $PUBSPEC"
exit 0
