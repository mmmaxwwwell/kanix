import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/shipment.dart';
import '../providers/shipment_provider.dart';
import '../providers/websocket_provider.dart';

/// Stream of shipment-related WebSocket messages.
final shipmentUpdatesProvider =
    StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('shipment');
});

class ShipmentsScreen extends ConsumerWidget {
  const ShipmentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shipmentsAsync = ref.watch(shipmentListProvider);

    // Real-time updates
    ref.listen(shipmentUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(shipmentListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Shipments',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(shipmentListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: shipmentsAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load shipments: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () =>
                          ref.invalidate(shipmentListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (shipments) => shipments.isEmpty
                  ? const Center(child: Text('No shipments'))
                  : _ShipmentsTable(shipments: shipments),
            ),
          ),
        ],
      ),
    );
  }
}

class _ShipmentsTable extends StatelessWidget {
  final List<Shipment> shipments;

  const _ShipmentsTable({required this.shipments});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Order #')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Carrier')),
          DataColumn(label: Text('Service')),
          DataColumn(label: Text('Tracking #')),
          DataColumn(label: Text('Rate'), numeric: true),
          DataColumn(label: Text('Created')),
        ],
        rows: shipments.map((shipment) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/shipments/${shipment.id}');
            },
            cells: [
              DataCell(Text(shipment.orderNumber)),
              DataCell(ShipmentStatusChip(status: shipment.status)),
              DataCell(Text(shipment.carrier ?? '-')),
              DataCell(Text(shipment.service ?? '-')),
              DataCell(Text(shipment.trackingNumber ?? '-')),
              DataCell(Text(shipment.formattedRate)),
              DataCell(Text(_formatDate(shipment.createdAt))),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class ShipmentStatusChip extends StatelessWidget {
  final String status;

  const ShipmentStatusChip({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: _colorForStatus(status)),
      ),
      backgroundColor: _colorForStatus(status).withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }

  Color _colorForStatus(String s) {
    switch (s) {
      case 'delivered':
        return Colors.green;
      case 'shipped':
      case 'in_transit':
      case 'out_for_delivery':
      case 'ready':
        return Colors.blue;
      case 'label_purchased':
      case 'label_pending':
        return Colors.orange;
      case 'exception':
      case 'returned':
        return Colors.red;
      case 'voided':
      case 'draft':
        return Colors.grey;
      default:
        return Colors.grey;
    }
  }
}

class ShipmentDetailScreen extends ConsumerWidget {
  final String shipmentId;

  const ShipmentDetailScreen({super.key, required this.shipmentId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shipmentAsync = ref.watch(shipmentDetailProvider(shipmentId));

    // Real-time updates
    ref.listen(shipmentUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(shipmentDetailProvider(shipmentId));
      }
    });

    return shipmentAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load shipment: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(shipmentDetailProvider(shipmentId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (shipment) => _ShipmentDetailContent(shipment: shipment),
    );
  }
}

class _ShipmentDetailContent extends ConsumerWidget {
  final Shipment shipment;

  const _ShipmentDetailContent({required this.shipment});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/shipments'),
              ),
              const SizedBox(width: 8),
              Text(
                'Shipment Details',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(width: 16),
              ShipmentStatusChip(status: shipment.status),
            ],
          ),
          const SizedBox(height: 24),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailCard(
                    title: 'Shipment Info',
                    children: [
                      _DetailRow(
                          label: 'Shipment ID', value: shipment.id),
                      _DetailRow(
                          label: 'Order', value: shipment.orderNumber),
                      _DetailRow(
                          label: 'Status',
                          value:
                              shipment.status.replaceAll('_', ' ')),
                      _DetailRow(
                          label: 'Carrier',
                          value: shipment.carrier ?? '-'),
                      _DetailRow(
                          label: 'Service',
                          value: shipment.service ?? '-'),
                      _DetailRow(
                          label: 'Tracking #',
                          value: shipment.trackingNumber ?? '-'),
                      _DetailRow(
                          label: 'Rate', value: shipment.formattedRate),
                      _DetailRow(
                          label: 'Created',
                          value: _formatDateTime(shipment.createdAt)),
                      if (shipment.errorMessage != null)
                        _DetailRow(
                            label: 'Error',
                            value: shipment.errorMessage!),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _ShipmentActions(shipment: shipment),
                  const SizedBox(height: 24),
                  _TrackingEvents(shipment: shipment),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ShipmentActions extends ConsumerWidget {
  final Shipment shipment;

  const _ShipmentActions({required this.shipment});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _DetailCard(
      title: 'Actions',
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            if (shipment.status == 'draft')
              FilledButton.icon(
                icon: const Icon(Icons.local_shipping),
                label: const Text('Purchase Label'),
                onPressed: () => _purchaseLabel(context, ref),
              ),
            if (shipment.status == 'label_purchased' ||
                shipment.status == 'ready')
              FilledButton.icon(
                icon: const Icon(Icons.send),
                label: const Text('Mark Shipped'),
                onPressed: () => _markShipped(context, ref),
              ),
            if (shipment.status == 'draft' ||
                shipment.status == 'label_pending' ||
                shipment.status == 'label_purchased')
              OutlinedButton.icon(
                icon: const Icon(Icons.cancel, color: Colors.red),
                label: const Text('Void',
                    style: TextStyle(color: Colors.red)),
                style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: Colors.red)),
                onPressed: () => _voidShipment(context, ref),
              ),
            if (shipment.trackingUrl != null)
              OutlinedButton.icon(
                icon: const Icon(Icons.open_in_new),
                label: const Text('Track Package'),
                onPressed: () {
                  // In a real app, this would use url_launcher
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                        content:
                            Text('Tracking: ${shipment.trackingUrl}')),
                  );
                },
              ),
            if (shipment.labelUrl != null)
              OutlinedButton.icon(
                icon: const Icon(Icons.print),
                label: const Text('Print Label'),
                onPressed: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                        content:
                            Text('Label: ${shipment.labelUrl}')),
                  );
                },
              ),
          ],
        ),
      ],
    );
  }

  Future<void> _purchaseLabel(
      BuildContext context, WidgetRef ref) async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post(
          '/api/admin/shipments/${shipment.id}/purchase-label');
      ref.invalidate(shipmentDetailProvider(shipment.id));
      ref.invalidate(shipmentListProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Label purchased')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to purchase label: $e')),
        );
      }
    }
  }

  Future<void> _markShipped(
      BuildContext context, WidgetRef ref) async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post(
        '/api/admin/shipments/${shipment.id}/transition',
        data: {'status': 'shipped'},
      );
      ref.invalidate(shipmentDetailProvider(shipment.id));
      ref.invalidate(shipmentListProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Shipment marked as shipped')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to mark shipped: $e')),
        );
      }
    }
  }

  Future<void> _voidShipment(
      BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Void Shipment'),
        content: const Text(
          'Are you sure you want to void this shipment? '
          'If a label was purchased, it will be refunded.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Keep'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Void Shipment'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/shipments/${shipment.id}/transition',
          data: {'status': 'voided'},
        );
        ref.invalidate(shipmentDetailProvider(shipment.id));
        ref.invalidate(shipmentListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Shipment voided')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to void: $e')),
          );
        }
      }
    }
  }
}

class _TrackingEvents extends StatelessWidget {
  final Shipment shipment;

  const _TrackingEvents({required this.shipment});

  @override
  Widget build(BuildContext context) {
    final events = shipment.events;
    if (events == null || events.isEmpty) {
      return _DetailCard(
        title: 'Tracking Events',
        children: [const Text('No tracking events yet')],
      );
    }

    return _DetailCard(
      title: 'Tracking Events',
      children: [
        DataTable(
          columns: const [
            DataColumn(label: Text('Status')),
            DataColumn(label: Text('Description')),
            DataColumn(label: Text('Location')),
            DataColumn(label: Text('Time')),
          ],
          rows: events.map((event) {
            return DataRow(cells: [
              DataCell(Text(event.status.replaceAll('_', ' '))),
              DataCell(Text(event.description ?? '-')),
              DataCell(Text(event.location ?? '-')),
              DataCell(Text(_formatDateTime(event.occurredAt))),
            ]);
          }).toList(),
        ),
      ],
    );
  }
}

class _DetailCard extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _DetailCard({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;

  const _DetailRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 140,
            child: Text(label,
                style: const TextStyle(fontWeight: FontWeight.w500)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
