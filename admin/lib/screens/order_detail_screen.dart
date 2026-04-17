import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/order.dart';
import '../providers/order_provider.dart';
import '../providers/websocket_provider.dart';

class OrderDetailScreen extends ConsumerWidget {
  final String orderId;

  const OrderDetailScreen({super.key, required this.orderId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orderAsync = ref.watch(orderDetailProvider(orderId));

    // Real-time updates: refresh when order events arrive
    ref.listen(orderUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(orderDetailProvider(orderId));
        ref.invalidate(orderHistoryProvider(orderId));
        ref.invalidate(orderRefundsProvider(orderId));
      }
    });

    return orderAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load order: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(orderDetailProvider(orderId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (order) => _OrderDetailContent(order: order),
    );
  }
}

class _OrderDetailContent extends ConsumerStatefulWidget {
  final Order order;

  const _OrderDetailContent({required this.order});

  @override
  ConsumerState<_OrderDetailContent> createState() =>
      _OrderDetailContentState();
}

class _OrderDetailContentState extends ConsumerState<_OrderDetailContent>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  static const _tabs = [
    Tab(text: 'Summary'),
    Tab(text: 'Items'),
    Tab(text: 'Payment'),
    Tab(text: 'Fulfillment'),
    Tab(text: 'Shipping'),
    Tab(text: 'Support'),
    Tab(text: 'Evidence'),
    Tab(text: 'Audit'),
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _tabs.length, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final order = widget.order;

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _OrderHeader(order: order),
          const SizedBox(height: 16),
          TabBar(
            controller: _tabController,
            isScrollable: true,
            tabs: _tabs,
          ),
          const SizedBox(height: 16),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _SummaryTab(order: order),
                _ItemsTab(order: order),
                _PaymentTab(order: order),
                _FulfillmentTab(order: order),
                _ShippingTab(order: order),
                _SupportTab(order: order),
                _EvidenceTab(order: order),
                _AuditTab(orderId: order.id),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _OrderHeader extends ConsumerWidget {
  final Order order;

  const _OrderHeader({required this.order});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Row(
      children: [
        IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(width: 8),
        Text(
          'Order ${order.orderNumber}',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(width: 16),
        Text(order.formattedTotal,
            style: Theme.of(context).textTheme.titleLarge),
        const Spacer(),
        _RefundButton(order: order),
        const SizedBox(width: 8),
        _CancelButton(order: order),
      ],
    );
  }
}

class _RefundButton extends ConsumerWidget {
  final Order order;

  const _RefundButton({required this.order});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Only show refund for paid orders
    final canRefund = order.paymentStatus == 'paid' ||
        order.paymentStatus == 'partially_refunded';
    if (!canRefund) return const SizedBox.shrink();

    return OutlinedButton.icon(
      icon: const Icon(Icons.money_off),
      label: const Text('Refund'),
      onPressed: () => _showRefundDialog(context, ref),
    );
  }

  Future<void> _showRefundDialog(BuildContext context, WidgetRef ref) async {
    final amountController = TextEditingController();
    final reasonController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Issue Refund'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Order: ${order.orderNumber}'),
              Text('Total: ${order.formattedTotal}'),
              const SizedBox(height: 16),
              TextFormField(
                controller: amountController,
                decoration: const InputDecoration(
                  labelText: 'Amount (cents)',
                  hintText: 'e.g. 1500 for \$15.00',
                  border: OutlineInputBorder(),
                ),
                keyboardType: TextInputType.number,
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Amount is required';
                  final parsed = int.tryParse(v);
                  if (parsed == null || parsed <= 0) {
                    return 'Enter a valid positive amount';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: reasonController,
                decoration: const InputDecoration(
                  labelText: 'Reason',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Reason is required';
                  return null;
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Confirm Refund'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/orders/${order.id}/refunds',
          data: {
            'amount': int.parse(amountController.text),
            'reason': reasonController.text,
          },
        );
        ref.invalidate(orderDetailProvider(order.id));
        ref.invalidate(orderRefundsProvider(order.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Refund issued successfully')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Refund failed: $e')),
          );
        }
      }
    }
  }
}

class _CancelButton extends ConsumerWidget {
  final Order order;

  const _CancelButton({required this.order});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Only show cancel for orders that can be canceled
    final canCancel = order.status == 'confirmed' ||
        order.status == 'pending_payment';
    if (!canCancel) return const SizedBox.shrink();

    return OutlinedButton.icon(
      icon: const Icon(Icons.cancel, color: Colors.red),
      label: const Text('Cancel Order', style: TextStyle(color: Colors.red)),
      style: OutlinedButton.styleFrom(
        side: const BorderSide(color: Colors.red),
      ),
      onPressed: () => _showCancelDialog(context, ref),
    );
  }

  Future<void> _showCancelDialog(BuildContext context, WidgetRef ref) async {
    final reasonController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel Order'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Are you sure you want to cancel order ${order.orderNumber}?',
              ),
              const SizedBox(height: 8),
              const Text(
                'This will release inventory reservations and initiate a refund if payment was collected.',
                style: TextStyle(color: Colors.red),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: reasonController,
                decoration: const InputDecoration(
                  labelText: 'Cancellation reason',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Reason is required';
                  return null;
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Keep Order'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Confirm Cancellation'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/orders/${order.id}/cancel',
          data: {'reason': reasonController.text},
        );
        ref.invalidate(orderDetailProvider(order.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Order canceled successfully')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Cancellation failed: $e')),
          );
        }
      }
    }
  }
}

// --- Tab Implementations ---

class _SummaryTab extends StatelessWidget {
  final Order order;

  const _SummaryTab({required this.order});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionCard(
            title: 'Order Status',
            children: [
              _StatusRow(label: 'Order', value: order.status),
              _StatusRow(label: 'Payment', value: order.paymentStatus),
              _StatusRow(
                  label: 'Fulfillment', value: order.fulfillmentStatus),
              _StatusRow(label: 'Shipping', value: order.shippingStatus),
            ],
          ),
          const SizedBox(height: 16),
          _SectionCard(
            title: 'Customer',
            children: [
              _InfoRow(label: 'Email', value: order.email),
              _InfoRow(
                  label: 'Customer ID',
                  value: order.customerId ?? 'Guest'),
            ],
          ),
          const SizedBox(height: 16),
          _SectionCard(
            title: 'Totals',
            children: [
              _InfoRow(
                  label: 'Subtotal',
                  value:
                      '\$${(order.subtotalMinor / 100).toStringAsFixed(2)}'),
              _InfoRow(
                  label: 'Tax',
                  value: '\$${(order.taxMinor / 100).toStringAsFixed(2)}'),
              _InfoRow(
                  label: 'Shipping',
                  value:
                      '\$${(order.shippingMinor / 100).toStringAsFixed(2)}'),
              _InfoRow(
                  label: 'Discount',
                  value:
                      '-\$${(order.discountMinor / 100).toStringAsFixed(2)}'),
              const Divider(),
              _InfoRow(label: 'Total', value: order.formattedTotal),
            ],
          ),
          if (order.shippingAddressSnapshot != null) ...[
            const SizedBox(height: 16),
            _SectionCard(
              title: 'Shipping Address',
              children: [
                Text(_formatAddress(order.shippingAddressSnapshot!)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _ItemsTab extends StatelessWidget {
  final Order order;

  const _ItemsTab({required this.order});

  @override
  Widget build(BuildContext context) {
    final lines = order.lines;
    if (lines == null || lines.isEmpty) {
      return const Center(child: Text('No items available'));
    }

    return SingleChildScrollView(
      child: DataTable(
        columns: const [
          DataColumn(label: Text('SKU')),
          DataColumn(label: Text('Title')),
          DataColumn(label: Text('Options')),
          DataColumn(label: Text('Qty'), numeric: true),
          DataColumn(label: Text('Unit Price'), numeric: true),
          DataColumn(label: Text('Total'), numeric: true),
        ],
        rows: lines.map((line) {
          return DataRow(cells: [
            DataCell(Text(line.skuSnapshot)),
            DataCell(Text(line.titleSnapshot)),
            DataCell(Text(
              line.optionValuesSnapshot.entries
                  .map((e) => '${e.key}: ${e.value}')
                  .join(', '),
            )),
            DataCell(Text('${line.quantity}')),
            DataCell(Text(line.formattedUnitPrice)),
            DataCell(Text(line.formattedTotal)),
          ]);
        }).toList(),
      ),
    );
  }
}

class _PaymentTab extends ConsumerWidget {
  final Order order;

  const _PaymentTab({required this.order});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final refundsAsync = ref.watch(orderRefundsProvider(order.id));

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionCard(
            title: 'Payment Status',
            children: [
              _StatusRow(label: 'Status', value: order.paymentStatus),
              _InfoRow(label: 'Total', value: order.formattedTotal),
              _InfoRow(label: 'Currency', value: order.currency),
            ],
          ),
          const SizedBox(height: 16),
          Text('Refunds',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          refundsAsync.when(
            loading: () => const CircularProgressIndicator(),
            error: (e, _) => Text('Failed to load refunds: $e'),
            data: (refunds) => refunds.isEmpty
                ? const Text('No refunds issued')
                : DataTable(
                    columns: const [
                      DataColumn(label: Text('Amount')),
                      DataColumn(label: Text('Reason')),
                      DataColumn(label: Text('Status')),
                      DataColumn(label: Text('Date')),
                    ],
                    rows: refunds.map((r) {
                      return DataRow(cells: [
                        DataCell(Text(r.formattedAmount)),
                        DataCell(Text(r.reason)),
                        DataCell(Text(r.status)),
                        DataCell(Text(_formatDateTime(r.createdAt))),
                      ]);
                    }).toList(),
                  ),
          ),
        ],
      ),
    );
  }
}

class _FulfillmentTab extends StatelessWidget {
  final Order order;

  const _FulfillmentTab({required this.order});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: _SectionCard(
        title: 'Fulfillment',
        children: [
          _StatusRow(label: 'Status', value: order.fulfillmentStatus),
          const SizedBox(height: 8),
          const Text(
            'Fulfillment task details are available in the Fulfillment screen.',
          ),
        ],
      ),
    );
  }
}

class _ShippingTab extends StatelessWidget {
  final Order order;

  const _ShippingTab({required this.order});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionCard(
            title: 'Shipping',
            children: [
              _StatusRow(label: 'Status', value: order.shippingStatus),
            ],
          ),
          if (order.shippingAddressSnapshot != null) ...[
            const SizedBox(height: 16),
            _SectionCard(
              title: 'Shipping Address',
              children: [
                Text(_formatAddress(order.shippingAddressSnapshot!)),
              ],
            ),
          ],
          const SizedBox(height: 16),
          const Text(
            'Shipment details are available in the Shipments screen.',
          ),
        ],
      ),
    );
  }
}

class _SupportTab extends StatelessWidget {
  final Order order;

  const _SupportTab({required this.order});

  @override
  Widget build(BuildContext context) {
    return const SingleChildScrollView(
      child: Padding(
        padding: EdgeInsets.all(16),
        child: Text(
          'Support tickets linked to this order are available in the Support screen.',
        ),
      ),
    );
  }
}

class _EvidenceTab extends StatelessWidget {
  final Order order;

  const _EvidenceTab({required this.order});

  @override
  Widget build(BuildContext context) {
    return const SingleChildScrollView(
      child: Padding(
        padding: EdgeInsets.all(16),
        child: Text(
          'Dispute evidence linked to this order is available in the Disputes screen.',
        ),
      ),
    );
  }
}

class _AuditTab extends ConsumerWidget {
  final String orderId;

  const _AuditTab({required this.orderId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final historyAsync = ref.watch(orderHistoryProvider(orderId));

    return historyAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed to load audit history: $e')),
      data: (entries) => entries.isEmpty
          ? const Center(child: Text('No status changes recorded'))
          : SingleChildScrollView(
              child: DataTable(
                columns: const [
                  DataColumn(label: Text('Type')),
                  DataColumn(label: Text('From')),
                  DataColumn(label: Text('To')),
                  DataColumn(label: Text('Reason')),
                  DataColumn(label: Text('Date')),
                ],
                rows: entries.map((entry) {
                  return DataRow(cells: [
                    DataCell(Text(entry.statusType.replaceAll('_', ' '))),
                    DataCell(Text(entry.oldValue.replaceAll('_', ' '))),
                    DataCell(Text(entry.newValue.replaceAll('_', ' '))),
                    DataCell(Text(entry.reason ?? '-')),
                    DataCell(Text(_formatDateTime(entry.createdAt))),
                  ]);
                }).toList(),
              ),
            ),
    );
  }
}

// --- Shared Widgets ---

class _SectionCard extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _SectionCard({required this.title, required this.children});

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

class _StatusRow extends StatelessWidget {
  final String label;
  final String value;

  const _StatusRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 120,
            child: Text(label,
                style: const TextStyle(fontWeight: FontWeight.w500)),
          ),
          Chip(
            label: Text(value.replaceAll('_', ' ')),
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;

  const _InfoRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 120,
            child: Text(label,
                style: const TextStyle(fontWeight: FontWeight.w500)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}

String _formatAddress(Map<String, dynamic> address) {
  final parts = <String>[];
  if (address['line1'] != null) parts.add(address['line1'] as String);
  if (address['line2'] != null) parts.add(address['line2'] as String);
  final cityStateZip = <String>[];
  if (address['city'] != null) cityStateZip.add(address['city'] as String);
  if (address['state'] != null) cityStateZip.add(address['state'] as String);
  if (address['postalCode'] != null) {
    cityStateZip.add(address['postalCode'] as String);
  }
  if (cityStateZip.isNotEmpty) parts.add(cityStateZip.join(', '));
  if (address['country'] != null) parts.add(address['country'] as String);
  return parts.join('\n');
}
