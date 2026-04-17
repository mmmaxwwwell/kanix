import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/inventory.dart';
import '../providers/inventory_provider.dart';
import '../providers/websocket_provider.dart';

/// Stream of inventory-related WebSocket messages.
final inventoryUpdatesProvider =
    StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('inventory');
});

class InventoryScreen extends ConsumerWidget {
  const InventoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inventoryAsync = ref.watch(inventoryListProvider);

    ref.listen(inventoryUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(inventoryListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Inventory Overview',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(inventoryListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: inventoryAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load inventory: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () =>
                          ref.invalidate(inventoryListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (variants) => variants.isEmpty
                  ? const Center(child: Text('No inventory data'))
                  : _InventoryTable(variants: variants),
            ),
          ),
        ],
      ),
    );
  }
}

class _InventoryTable extends StatelessWidget {
  final List<InventoryVariant> variants;

  const _InventoryTable({required this.variants});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('SKU')),
          DataColumn(label: Text('Product')),
          DataColumn(label: Text('Variant')),
          DataColumn(label: Text('On Hand'), numeric: true),
          DataColumn(label: Text('Reserved'), numeric: true),
          DataColumn(label: Text('Available'), numeric: true),
          DataColumn(label: Text('Status')),
        ],
        rows: variants.map((v) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/inventory/${v.variantId}');
            },
            cells: [
              DataCell(Text(v.sku)),
              DataCell(Text(v.productName)),
              DataCell(Text(v.variantName)),
              DataCell(Text('${v.quantityOnHand}')),
              DataCell(Text('${v.quantityReserved}')),
              DataCell(Text('${v.quantityAvailable}')),
              DataCell(_StockStatusChip(variant: v)),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _StockStatusChip extends StatelessWidget {
  final InventoryVariant variant;

  const _StockStatusChip({required this.variant});

  @override
  Widget build(BuildContext context) {
    final isLow = variant.isLowStock;
    return Chip(
      label: Text(
        isLow ? 'Low Stock' : 'In Stock',
        style: TextStyle(
          fontSize: 11,
          color: isLow ? Colors.orange : Colors.green,
        ),
      ),
      backgroundColor: isLow
          ? Colors.orange.withValues(alpha: 0.1)
          : Colors.green.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

// ---------------------------------------------------------------------------
// Variant Balance Detail Screen
// ---------------------------------------------------------------------------

class InventoryDetailScreen extends ConsumerWidget {
  final String variantId;

  const InventoryDetailScreen({super.key, required this.variantId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final variantAsync = ref.watch(inventoryDetailProvider(variantId));
    final adjustmentsAsync =
        ref.watch(inventoryAdjustmentsProvider(variantId));

    ref.listen(inventoryUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(inventoryDetailProvider(variantId));
        ref.invalidate(inventoryAdjustmentsProvider(variantId));
      }
    });

    return variantAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load variant: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(inventoryDetailProvider(variantId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (variant) => _InventoryDetailContent(
        variant: variant,
        adjustmentsAsync: adjustmentsAsync,
      ),
    );
  }
}

class _InventoryDetailContent extends ConsumerWidget {
  final InventoryVariant variant;
  final AsyncValue<List<InventoryAdjustment>> adjustmentsAsync;

  const _InventoryDetailContent({
    required this.variant,
    required this.adjustmentsAsync,
  });

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
                onPressed: () => context.go('/inventory'),
              ),
              const SizedBox(width: 8),
              Text(
                'Variant Balance',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(width: 16),
              _StockStatusChip(variant: variant),
            ],
          ),
          const SizedBox(height: 24),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailCard(
                    title: 'Variant Details',
                    children: [
                      _DetailRow(label: 'SKU', value: variant.sku),
                      _DetailRow(
                          label: 'Product', value: variant.productName),
                      _DetailRow(
                          label: 'Variant', value: variant.variantName),
                      _DetailRow(
                          label: 'On Hand',
                          value: '${variant.quantityOnHand}'),
                      _DetailRow(
                          label: 'Reserved',
                          value: '${variant.quantityReserved}'),
                      _DetailRow(
                          label: 'Available',
                          value: '${variant.quantityAvailable}'),
                      _DetailRow(
                          label: 'Low Stock Threshold',
                          value: '${variant.lowStockThreshold}'),
                      _DetailRow(
                          label: 'Updated',
                          value: _formatDateTime(variant.updatedAt)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Text('Adjustments',
                          style: Theme.of(context).textTheme.titleMedium),
                      const Spacer(),
                      FilledButton.icon(
                        icon: const Icon(Icons.add),
                        label: const Text('New Adjustment'),
                        onPressed: () =>
                            _showAdjustmentDialog(context, ref),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  adjustmentsAsync.when(
                    loading: () => const Center(
                        child: CircularProgressIndicator()),
                    error: (e, _) =>
                        Text('Failed to load adjustments: $e'),
                    data: (adjustments) => adjustments.isEmpty
                        ? const Padding(
                            padding: EdgeInsets.all(16),
                            child: Text('No adjustments recorded'),
                          )
                        : _AdjustmentsTable(adjustments: adjustments),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showAdjustmentDialog(
      BuildContext context, WidgetRef ref) async {
    final quantityController = TextEditingController();
    final reasonController = TextEditingController();
    final formKey = GlobalKey<FormState>();
    String adjustmentType = 'add';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) => AlertDialog(
          title: const Text('Create Inventory Adjustment'),
          content: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: adjustmentType,
                  decoration: const InputDecoration(
                    labelText: 'Type',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                        value: 'add', child: Text('Add')),
                    DropdownMenuItem(
                        value: 'remove', child: Text('Remove')),
                    DropdownMenuItem(
                        value: 'set', child: Text('Set')),
                  ],
                  onChanged: (v) =>
                      setState(() => adjustmentType = v ?? 'add'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: quantityController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Quantity',
                    border: OutlineInputBorder(),
                  ),
                  validator: (v) {
                    if (v == null || v.isEmpty) {
                      return 'Quantity is required';
                    }
                    if (int.tryParse(v) == null) {
                      return 'Must be a number';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: reasonController,
                  decoration: const InputDecoration(
                    labelText: 'Reason (optional)',
                    border: OutlineInputBorder(),
                  ),
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
              child: const Text('Submit'),
            ),
          ],
        ),
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/inventory/${variant.variantId}/adjustments',
          data: {
            'type': adjustmentType,
            'quantity': int.parse(quantityController.text),
            if (reasonController.text.isNotEmpty)
              'reason': reasonController.text,
          },
        );
        ref.invalidate(inventoryDetailProvider(variant.variantId));
        ref.invalidate(inventoryAdjustmentsProvider(variant.variantId));
        ref.invalidate(inventoryListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Adjustment created')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to create adjustment: $e')),
          );
        }
      }
    }
  }
}

class _AdjustmentsTable extends StatelessWidget {
  final List<InventoryAdjustment> adjustments;

  const _AdjustmentsTable({required this.adjustments});

  @override
  Widget build(BuildContext context) {
    return DataTable(
      columns: const [
        DataColumn(label: Text('Type')),
        DataColumn(label: Text('Quantity'), numeric: true),
        DataColumn(label: Text('Reason')),
        DataColumn(label: Text('Created By')),
        DataColumn(label: Text('Date')),
      ],
      rows: adjustments.map((a) {
        return DataRow(cells: [
          DataCell(_AdjustmentTypeChip(type: a.type)),
          DataCell(Text('${a.quantity}')),
          DataCell(Text(a.reason ?? '-')),
          DataCell(Text(a.createdBy ?? '-')),
          DataCell(Text(_formatDateTime(a.createdAt))),
        ]);
      }).toList(),
    );
  }
}

class _AdjustmentTypeChip extends StatelessWidget {
  final String type;

  const _AdjustmentTypeChip({required this.type});

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (type) {
      case 'add':
        color = Colors.green;
        break;
      case 'remove':
        color = Colors.red;
        break;
      case 'set':
        color = Colors.blue;
        break;
      default:
        color = Colors.grey;
    }
    return Chip(
      label: Text(
        type,
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared detail widgets
// ---------------------------------------------------------------------------

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
            width: 160,
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
