import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../models/order.dart';
import '../providers/order_provider.dart';

class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ordersAsync = ref.watch(ordersProvider);

    // Invalidate orders list when WebSocket sends order updates.
    ref.listen(orderUpdatesProvider, (_, _) {
      ref.invalidate(ordersProvider);
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: ordersAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) => Center(child: Text('Failed to load orders: $err')),
        data: (orders) {
          if (orders.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.receipt_long,
                      size: 64,
                      color: Theme.of(context).colorScheme.outline),
                  const SizedBox(height: 16),
                  const Text('No orders yet'),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: () => context.go('/catalog'),
                    child: const Text('Browse Catalog'),
                  ),
                ],
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(ordersProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: orders.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final order = orders[index];
                return _OrderCard(order: order);
              },
            ),
          );
        },
      ),
    );
  }
}

class _OrderCard extends StatelessWidget {
  final Order order;

  const _OrderCard({required this.order});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.go('/orders/${order.id}'),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Order #${order.orderNumber}',
                    style: theme.textTheme.titleSmall
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                  _StatusBadge(status: order.status, label: order.statusLabel),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    _formatDate(order.createdAt),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  Text(
                    order.formattedTotal,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class _StatusBadge extends StatelessWidget {
  final String status;
  final String label;

  const _StatusBadge({required this.status, required this.label});

  @override
  Widget build(BuildContext context) {
    final (bgColor, fgColor) = _statusColors(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        label,
        style: Theme.of(context)
            .textTheme
            .labelSmall
            ?.copyWith(color: fgColor, fontWeight: FontWeight.w600),
      ),
    );
  }

  (Color, Color) _statusColors(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    switch (status) {
      case 'pending':
        return (Colors.orange.shade100, Colors.orange.shade800);
      case 'confirmed':
      case 'processing':
        return (Colors.blue.shade100, Colors.blue.shade800);
      case 'shipped':
        return (Colors.purple.shade100, Colors.purple.shade800);
      case 'delivered':
        return (Colors.green.shade100, Colors.green.shade800);
      case 'cancelled':
      case 'refunded':
        return (scheme.errorContainer, scheme.onErrorContainer);
      default:
        return (scheme.surfaceContainerHighest, scheme.onSurface);
    }
  }
}

class OrderDetailScreen extends ConsumerWidget {
  final String orderId;

  const OrderDetailScreen({super.key, required this.orderId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orderAsync = ref.watch(orderDetailProvider(orderId));

    // Refresh order detail on WebSocket updates.
    ref.listen(orderUpdatesProvider, (_, next) {
      final msg = next.valueOrNull;
      if (msg != null && msg.payload['orderId'] == orderId) {
        ref.invalidate(orderDetailProvider(orderId));
      }
    });

    ref.listen(shipmentUpdatesProvider, (_, next) {
      final msg = next.valueOrNull;
      if (msg != null && msg.payload['orderId'] == orderId) {
        ref.invalidate(orderDetailProvider(orderId));
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Order Detail')),
      body: orderAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) =>
            Center(child: Text('Failed to load order: $err')),
        data: (order) => _OrderDetailBody(order: order),
      ),
    );
  }
}

class _OrderDetailBody extends StatelessWidget {
  final Order order;

  const _OrderDetailBody({required this.order});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Order #${order.orderNumber}',
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              _StatusBadge(
                  status: order.status, label: order.statusLabel),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'Placed on ${_formatDate(order.createdAt)}',
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          const SizedBox(height: 24),

          // Line Items
          Text('Items',
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          ...order.lineItems.map((item) => _LineItemRow(item: item)),
          const Divider(height: 24),

          // Order totals
          _TotalRow(label: 'Subtotal', cents: order.subtotalCents),
          _TotalRow(label: 'Shipping', cents: order.shippingCents),
          _TotalRow(label: 'Tax', cents: order.taxCents),
          const Divider(height: 16),
          _TotalRow(
              label: 'Total', cents: order.totalCents, bold: true),
          const SizedBox(height: 24),

          // Timeline
          Text('Timeline',
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (order.timeline.isEmpty)
            Text('No status updates yet',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline))
          else
            _OrderTimeline(events: order.timeline),
          const SizedBox(height: 24),

          // Shipments
          if (order.shipments.isNotEmpty) ...[
            Text('Shipments',
                style: theme.textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ...order.shipments
                .map((s) => _ShipmentCard(shipment: s)),
            const SizedBox(height: 16),
          ],
        ],
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class _LineItemRow extends StatelessWidget {
  final OrderLineItem item;

  const _LineItemRow({required this.item});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '${item.productTitle} (${item.material}) x${item.quantity}',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          Text(item.formattedTotal),
        ],
      ),
    );
  }
}

class _TotalRow extends StatelessWidget {
  final String label;
  final int cents;
  final bool bold;

  const _TotalRow({
    required this.label,
    required this.cents,
    this.bold = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dollars = cents ~/ 100;
    final c = (cents % 100).toString().padLeft(2, '0');
    final style = bold
        ? theme.textTheme.titleSmall
            ?.copyWith(fontWeight: FontWeight.bold)
        : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label, style: style), Text('\$$dollars.$c', style: style)],
      ),
    );
  }
}

class _OrderTimeline extends StatelessWidget {
  final List<OrderTimeline> events;

  const _OrderTimeline({required this.events});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        for (var i = 0; i < events.length; i++)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 32,
                child: Column(
                  children: [
                    Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i == 0
                            ? theme.colorScheme.primary
                            : theme.colorScheme.outline,
                      ),
                    ),
                    if (i < events.length - 1)
                      Container(
                        width: 2,
                        height: 40,
                        color: theme.colorScheme.outlineVariant,
                      ),
                  ],
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        events[i].label,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight:
                              i == 0 ? FontWeight.w600 : FontWeight.normal,
                        ),
                      ),
                      if (events[i].description != null)
                        Text(
                          events[i].description!,
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: theme.colorScheme.outline),
                        ),
                      Text(
                        _formatDateTime(events[i].timestamp),
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.colorScheme.outline),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
      ],
    );
  }

  String _formatDateTime(DateTime dt) {
    return '${dt.month}/${dt.day}/${dt.year} '
        '${dt.hour.toString().padLeft(2, '0')}:'
        '${dt.minute.toString().padLeft(2, '0')}';
  }
}

class _ShipmentCard extends StatelessWidget {
  final Shipment shipment;

  const _ShipmentCard({required this.shipment});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '${shipment.carrier} - ${shipment.trackingNumber}',
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(fontWeight: FontWeight.w600),
                ),
                _StatusBadge(
                  status: shipment.status,
                  label: shipment.statusLabel,
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (shipment.trackingEvents.isNotEmpty) ...[
              Text('Tracking Events',
                  style: theme.textTheme.labelMedium
                      ?.copyWith(color: theme.colorScheme.outline)),
              const SizedBox(height: 4),
              ...shipment.trackingEvents
                  .map((e) => _TrackingEventRow(event: e)),
            ] else
              Text('No tracking events yet',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline)),
          ],
        ),
      ),
    );
  }
}

class _TrackingEventRow extends StatelessWidget {
  final TrackingEvent event;

  const _TrackingEventRow({required this.event});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.circle, size: 8, color: theme.colorScheme.outline),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(event.message, style: theme.textTheme.bodySmall),
                if (event.location != null)
                  Text(event.location!,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.outline)),
                Text(
                  _formatDateTime(event.timestamp),
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _formatDateTime(DateTime dt) {
    return '${dt.month}/${dt.day}/${dt.year} '
        '${dt.hour.toString().padLeft(2, '0')}:'
        '${dt.minute.toString().padLeft(2, '0')}';
  }
}

/// Standalone tracking screen for a specific shipment.
class ShipmentTrackingScreen extends ConsumerWidget {
  final String shipmentId;

  const ShipmentTrackingScreen({super.key, required this.shipmentId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final trackingAsync = ref.watch(shipmentTrackingProvider(shipmentId));

    // Refresh on WebSocket shipment updates.
    ref.listen(shipmentUpdatesProvider, (_, next) {
      final msg = next.valueOrNull;
      if (msg != null && msg.payload['shipmentId'] == shipmentId) {
        ref.invalidate(shipmentTrackingProvider(shipmentId));
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Shipment Tracking')),
      body: trackingAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) =>
            Center(child: Text('Failed to load tracking: $err')),
        data: (shipment) => SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '${shipment.carrier} - ${shipment.trackingNumber}',
                    style: Theme.of(context)
                        .textTheme
                        .titleMedium
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                  _StatusBadge(
                    status: shipment.status,
                    label: shipment.statusLabel,
                  ),
                ],
              ),
              const SizedBox(height: 24),
              if (shipment.trackingEvents.isNotEmpty) ...[
                Text('Events',
                    style: Theme.of(context)
                        .textTheme
                        .titleSmall
                        ?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                ...shipment.trackingEvents
                    .map((e) => _TrackingEventRow(event: e)),
              ] else
                Center(
                  child: Text(
                    'No tracking events yet',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.outline),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
