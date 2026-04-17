import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../models/order.dart';
import '../providers/order_provider.dart';
import '../providers/websocket_provider.dart';

class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ordersAsync = ref.watch(orderListProvider);
    final filters = ref.watch(orderFiltersProvider);

    // Listen for real-time order updates and refresh the list
    ref.listen(orderUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(orderListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Orders',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(orderListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _OrderFiltersBar(filters: filters),
          const SizedBox(height: 16),
          Expanded(
            child: ordersAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load orders: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () => ref.invalidate(orderListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (orders) => orders.isEmpty
                  ? const Center(child: Text('No orders found'))
                  : _OrdersDataTable(orders: orders),
            ),
          ),
        ],
      ),
    );
  }
}

class _OrderFiltersBar extends ConsumerWidget {
  final OrderFilters filters;

  const _OrderFiltersBar({required this.filters});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Wrap(
      spacing: 12,
      runSpacing: 8,
      children: [
        SizedBox(
          width: 200,
          child: TextField(
            decoration: const InputDecoration(
              labelText: 'Search',
              hintText: 'Order #, email...',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
              isDense: true,
            ),
            onChanged: (value) {
              ref.read(orderFiltersProvider.notifier).state =
                  filters.copyWith(search: () => value.isEmpty ? null : value);
            },
          ),
        ),
        _FilterDropdown(
          label: 'Status',
          value: filters.status,
          items: const [
            'draft',
            'pending_payment',
            'confirmed',
            'completed',
            'canceled',
            'closed',
          ],
          onChanged: (v) {
            ref.read(orderFiltersProvider.notifier).state =
                filters.copyWith(status: () => v);
          },
        ),
        _FilterDropdown(
          label: 'Payment',
          value: filters.paymentStatus,
          items: const [
            'unpaid',
            'processing',
            'paid',
            'partially_refunded',
            'refunded',
            'failed',
            'disputed',
          ],
          onChanged: (v) {
            ref.read(orderFiltersProvider.notifier).state =
                filters.copyWith(paymentStatus: () => v);
          },
        ),
        _FilterDropdown(
          label: 'Fulfillment',
          value: filters.fulfillmentStatus,
          items: const [
            'unfulfilled',
            'queued',
            'picking',
            'packing',
            'ready_to_ship',
            'partially_fulfilled',
            'fulfilled',
            'canceled',
          ],
          onChanged: (v) {
            ref.read(orderFiltersProvider.notifier).state =
                filters.copyWith(fulfillmentStatus: () => v);
          },
        ),
        _FilterDropdown(
          label: 'Shipping',
          value: filters.shippingStatus,
          items: const [
            'not_shipped',
            'label_pending',
            'label_purchased',
            'shipped',
            'in_transit',
            'out_for_delivery',
            'delivered',
            'delivery_exception',
            'returned',
            'canceled',
          ],
          onChanged: (v) {
            ref.read(orderFiltersProvider.notifier).state =
                filters.copyWith(shippingStatus: () => v);
          },
        ),
        _DateRangeButton(filters: filters),
        if (_hasActiveFilters(filters))
          TextButton.icon(
            icon: const Icon(Icons.clear),
            label: const Text('Clear filters'),
            onPressed: () {
              ref.read(orderFiltersProvider.notifier).state =
                  const OrderFilters();
            },
          ),
      ],
    );
  }

  bool _hasActiveFilters(OrderFilters f) =>
      f.status != null ||
      f.paymentStatus != null ||
      f.fulfillmentStatus != null ||
      f.shippingStatus != null ||
      f.dateFrom != null ||
      f.dateTo != null ||
      (f.search != null && f.search!.isNotEmpty);
}

class _FilterDropdown extends StatelessWidget {
  final String label;
  final String? value;
  final List<String> items;
  final ValueChanged<String?> onChanged;

  const _FilterDropdown({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 160,
      child: DropdownButtonFormField<String>(
        initialValue: value,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
        isExpanded: true,
        items: [
          const DropdownMenuItem<String>(value: null, child: Text('All')),
          ...items.map((item) => DropdownMenuItem(
                value: item,
                child: Text(
                  item.replaceAll('_', ' '),
                  overflow: TextOverflow.ellipsis,
                ),
              )),
        ],
        onChanged: onChanged,
      ),
    );
  }
}

class _DateRangeButton extends ConsumerWidget {
  final OrderFilters filters;

  const _DateRangeButton({required this.filters});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasDate = filters.dateFrom != null || filters.dateTo != null;
    return OutlinedButton.icon(
      icon: const Icon(Icons.date_range),
      label: Text(hasDate ? 'Date range set' : 'Date range'),
      style: hasDate
          ? OutlinedButton.styleFrom(
              side: BorderSide(color: Theme.of(context).colorScheme.primary),
            )
          : null,
      onPressed: () async {
        final picked = await showDateRangePicker(
          context: context,
          firstDate: DateTime(2024),
          lastDate: DateTime.now().add(const Duration(days: 1)),
          initialDateRange: filters.dateFrom != null && filters.dateTo != null
              ? DateTimeRange(
                  start: filters.dateFrom!, end: filters.dateTo!)
              : null,
        );
        if (picked != null) {
          ref.read(orderFiltersProvider.notifier).state = filters.copyWith(
            dateFrom: () => picked.start,
            dateTo: () => picked.end,
          );
        }
      },
    );
  }
}

class _OrdersDataTable extends StatelessWidget {
  final List<Order> orders;

  const _OrdersDataTable({required this.orders});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Order #')),
          DataColumn(label: Text('Email')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Payment')),
          DataColumn(label: Text('Fulfillment')),
          DataColumn(label: Text('Shipping')),
          DataColumn(label: Text('Total'), numeric: true),
          DataColumn(label: Text('Date')),
        ],
        rows: orders.map((order) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/orders/${order.id}');
            },
            cells: [
              DataCell(Text(order.orderNumber)),
              DataCell(Text(
                order.email,
                overflow: TextOverflow.ellipsis,
              )),
              DataCell(_StatusChip(
                  label: order.status, color: _statusColor(order.status))),
              DataCell(_StatusChip(
                  label: order.paymentStatus,
                  color: _paymentColor(order.paymentStatus))),
              DataCell(_StatusChip(
                  label: order.fulfillmentStatus,
                  color: _fulfillmentColor(order.fulfillmentStatus))),
              DataCell(_StatusChip(
                  label: order.shippingStatus,
                  color: _shippingColor(order.shippingStatus))),
              DataCell(Text(order.formattedTotal)),
              DataCell(Text(
                order.placedAt != null
                    ? _formatDate(order.placedAt!)
                    : '-',
              )),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(
        label.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

Color _statusColor(String status) {
  switch (status) {
    case 'confirmed':
      return Colors.green;
    case 'completed':
      return Colors.blue;
    case 'canceled':
      return Colors.red;
    case 'pending_payment':
      return Colors.orange;
    case 'closed':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

Color _paymentColor(String status) {
  switch (status) {
    case 'paid':
      return Colors.green;
    case 'partially_refunded':
      return Colors.orange;
    case 'refunded':
      return Colors.red;
    case 'failed':
      return Colors.red;
    case 'disputed':
      return Colors.deepOrange;
    case 'processing':
      return Colors.blue;
    default:
      return Colors.grey;
  }
}

Color _fulfillmentColor(String status) {
  switch (status) {
    case 'fulfilled':
      return Colors.green;
    case 'picking':
    case 'packing':
    case 'ready_to_ship':
      return Colors.blue;
    case 'queued':
      return Colors.orange;
    case 'canceled':
      return Colors.red;
    default:
      return Colors.grey;
  }
}

Color _shippingColor(String status) {
  switch (status) {
    case 'delivered':
      return Colors.green;
    case 'shipped':
    case 'in_transit':
    case 'out_for_delivery':
      return Colors.blue;
    case 'label_purchased':
    case 'label_pending':
      return Colors.orange;
    case 'delivery_exception':
    case 'returned':
      return Colors.red;
    case 'canceled':
      return Colors.red;
    default:
      return Colors.grey;
  }
}
