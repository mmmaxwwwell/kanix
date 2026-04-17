import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/order.dart';
import '../models/product.dart';
import '../models/support.dart';
import '../providers/support_provider.dart';

class WarrantyScreen extends ConsumerWidget {
  const WarrantyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final claimsAsync = ref.watch(warrantyClaimsProvider);

    ref.listen(warrantyUpdatesProvider, (_, _) {
      ref.invalidate(warrantyClaimsProvider);
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Warranty Claims')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showFileClaimSheet(context, ref),
        child: const Icon(Icons.add),
      ),
      body: claimsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) =>
            Center(child: Text('Failed to load claims: $err')),
        data: (claims) {
          if (claims.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.verified_user,
                      size: 64,
                      color: Theme.of(context).colorScheme.outline),
                  const SizedBox(height: 16),
                  const Text('No warranty claims'),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: () => _showFileClaimSheet(context, ref),
                    icon: const Icon(Icons.add),
                    label: const Text('File Warranty Claim'),
                  ),
                ],
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(warrantyClaimsProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: claims.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final claim = claims[index];
                return _ClaimCard(claim: claim);
              },
            ),
          );
        },
      ),
    );
  }

  void _showFileClaimSheet(BuildContext context, WidgetRef ref) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.85,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        expand: false,
        builder: (context, scrollController) =>
            _FileClaimForm(ref: ref, scrollController: scrollController),
      ),
    );
  }
}

class _ClaimCard extends StatelessWidget {
  final WarrantyClaim claim;

  const _ClaimCard({required this.claim});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.go('/warranty/${claim.id}'),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      claim.productTitle,
                      style: theme.textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.bold),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  _ClaimStatusBadge(
                      status: claim.status, label: claim.statusLabel),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                'Order #${claim.orderNumber} - ${claim.material}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '#${claim.claimNumber}',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  _WarrantyValidityChip(claim: claim),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ClaimStatusBadge extends StatelessWidget {
  final String status;
  final String label;

  const _ClaimStatusBadge({required this.status, required this.label});

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
    switch (status) {
      case 'pending':
        return (Colors.orange.shade100, Colors.orange.shade800);
      case 'under_review':
        return (Colors.blue.shade100, Colors.blue.shade800);
      case 'approved':
        return (Colors.green.shade100, Colors.green.shade800);
      case 'denied':
        final scheme = Theme.of(context).colorScheme;
        return (scheme.errorContainer, scheme.onErrorContainer);
      case 'fulfilled':
        return (Colors.teal.shade100, Colors.teal.shade800);
      default:
        final scheme = Theme.of(context).colorScheme;
        return (scheme.surfaceContainerHighest, scheme.onSurface);
    }
  }
}

class _WarrantyValidityChip extends StatelessWidget {
  final WarrantyClaim claim;

  const _WarrantyValidityChip({required this.claim});

  @override
  Widget build(BuildContext context) {
    final isValid = claim.isWithinWarranty;
    final color = isValid ? Colors.green : Colors.red;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.shade100,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        isValid ? 'Within Warranty' : 'Warranty Expired',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: color.shade800,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}

class _FileClaimForm extends StatefulWidget {
  final WidgetRef ref;
  final ScrollController scrollController;

  const _FileClaimForm({
    required this.ref,
    required this.scrollController,
  });

  @override
  State<_FileClaimForm> createState() => _FileClaimFormState();
}

class _FileClaimFormState extends State<_FileClaimForm> {
  Order? _selectedOrder;
  OrderLineItem? _selectedItem;
  final _descriptionController = TextEditingController();
  final List<String> _photoNames = [];
  bool _submitting = false;

  @override
  void dispose() {
    _descriptionController.dispose();
    super.dispose();
  }

  MaterialWarrantyInfo? get _warrantyInfo {
    if (_selectedItem == null) return null;
    return MaterialWarrantyInfo.forMaterial(_selectedItem!.material);
  }

  bool get _isWithinWarranty {
    if (_selectedOrder == null) return false;
    final orderDate = _selectedOrder!.createdAt;
    final warrantyEnd = orderDate.add(const Duration(days: 365));
    return DateTime.now().isBefore(warrantyEnd);
  }

  Future<void> _submit() async {
    if (_selectedOrder == null ||
        _selectedItem == null ||
        _descriptionController.text.trim().isEmpty) {
      return;
    }

    setState(() => _submitting = true);
    try {
      final dio = widget.ref.read(dioProvider);
      await dio.post(
        '/api/customer/warranty/claims',
        data: {
          'orderId': _selectedOrder!.id,
          'lineItemId': _selectedItem!.id,
          'defectDescription': _descriptionController.text.trim(),
          'photoNames': _photoNames,
        },
      );
      widget.ref.invalidate(warrantyClaimsProvider);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to file claim: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _addPhoto() {
    setState(() {
      _photoNames.add('photo_${_photoNames.length + 1}.jpg');
    });
  }

  @override
  Widget build(BuildContext context) {
    final ordersAsync = widget.ref.watch(deliveredOrdersProvider);
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.all(24),
      child: ListView(
        controller: widget.scrollController,
        children: [
          Text('File Warranty Claim',
              style: theme.textTheme.titleMedium),
          const SizedBox(height: 24),

          // Step 1: Select order
          Text('Select Order', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          ordersAsync.when(
            loading: () => const Center(
                child: Padding(
              padding: EdgeInsets.all(16),
              child: CircularProgressIndicator(),
            )),
            error: (e, _) => Text('Failed to load orders: $e'),
            data: (orders) {
              if (orders.isEmpty) {
                return Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(
                      'No delivered orders available for warranty claims.',
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(color: theme.colorScheme.outline),
                    ),
                  ),
                );
              }
              return DropdownButtonFormField<Order>(
                initialValue: _selectedOrder,
                decoration: const InputDecoration(
                  labelText: 'Order',
                  border: OutlineInputBorder(),
                ),
                isExpanded: true,
                items: orders.map((order) {
                  return DropdownMenuItem<Order>(
                    value: order,
                    child: Text(
                        'Order #${order.orderNumber} - ${_formatDate(order.createdAt)}'),
                  );
                }).toList(),
                onChanged: (order) {
                  setState(() {
                    _selectedOrder = order;
                    _selectedItem = null;
                  });
                },
              );
            },
          ),
          const SizedBox(height: 16),

          // Step 2: Select product/line item
          if (_selectedOrder != null) ...[
            Text('Select Product', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            DropdownButtonFormField<OrderLineItem>(
              initialValue: _selectedItem,
              decoration: const InputDecoration(
                labelText: 'Product',
                border: OutlineInputBorder(),
              ),
              isExpanded: true,
              items: _selectedOrder!.lineItems.map((item) {
                return DropdownMenuItem<OrderLineItem>(
                  value: item,
                  child: Text('${item.productTitle} (${item.material})'),
                );
              }).toList(),
              onChanged: (item) {
                setState(() => _selectedItem = item);
              },
            ),
            const SizedBox(height: 16),
          ],

          // Warranty period validation
          if (_selectedItem != null) ...[
            _WarrantyInfoCard(
              warrantyInfo: _warrantyInfo!,
              orderDate: _selectedOrder!.createdAt,
              isWithinWarranty: _isWithinWarranty,
            ),
            const SizedBox(height: 16),

            // Step 3: Describe defect
            Text('Describe the Defect', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            TextField(
              controller: _descriptionController,
              decoration: const InputDecoration(
                labelText: 'Defect Description',
                hintText:
                    'Describe the issue with your product in detail...',
                border: OutlineInputBorder(),
                alignLabelWithHint: true,
              ),
              maxLines: 4,
              minLines: 3,
            ),
            const SizedBox(height: 16),

            // Step 4: Upload photos
            Text('Upload Photos', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            if (_photoNames.isNotEmpty)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _photoNames.map((name) {
                  return Chip(
                    avatar: const Icon(Icons.photo, size: 16),
                    label: Text(name,
                        style: theme.textTheme.bodySmall),
                    onDeleted: () {
                      setState(() => _photoNames.remove(name));
                    },
                    visualDensity: VisualDensity.compact,
                  );
                }).toList(),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _addPhoto,
              icon: const Icon(Icons.add_a_photo),
              label: const Text('Add Photo'),
            ),
            const SizedBox(height: 24),

            // Submit
            FilledButton(
              onPressed: _submitting ||
                      _descriptionController.text.trim().isEmpty
                  ? null
                  : _submit,
              child: _submitting
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child:
                          CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Submit Claim'),
            ),
            const SizedBox(height: 24),
          ],
        ],
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class _WarrantyInfoCard extends StatelessWidget {
  final MaterialWarrantyInfo warrantyInfo;
  final DateTime orderDate;
  final bool isWithinWarranty;

  const _WarrantyInfoCard({
    required this.warrantyInfo,
    required this.orderDate,
    required this.isWithinWarranty,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final expiryDate = orderDate.add(const Duration(days: 365));

    return Card(
      color: isWithinWarranty
          ? Colors.green.shade50
          : Colors.red.shade50,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  isWithinWarranty
                      ? Icons.check_circle
                      : Icons.warning,
                  color: isWithinWarranty
                      ? Colors.green.shade700
                      : Colors.red.shade700,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Text(
                  isWithinWarranty
                      ? 'Within Warranty Period'
                      : 'Warranty Period Expired',
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: isWithinWarranty
                        ? Colors.green.shade700
                        : Colors.red.shade700,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Material: ${warrantyInfo.material}',
              style: theme.textTheme.bodyMedium,
            ),
            Text(
              'Warranty Period: ${warrantyInfo.warrantyPeriod}',
              style: theme.textTheme.bodyMedium,
            ),
            Text(
              'Order Date: ${_formatDate(orderDate)}',
              style: theme.textTheme.bodyMedium,
            ),
            Text(
              'Expires: ${_formatDate(expiryDate)}',
              style: theme.textTheme.bodyMedium,
            ),
            if (warrantyInfo.limitation != null) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: Colors.amber.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.amber.shade200),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.info_outline,
                        size: 16, color: Colors.amber.shade700),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        warrantyInfo.limitation!,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: Colors.amber.shade900),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class WarrantyDetailScreen extends ConsumerWidget {
  final String claimId;

  const WarrantyDetailScreen({super.key, required this.claimId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final claimAsync = ref.watch(warrantyClaimDetailProvider(claimId));

    ref.listen(warrantyUpdatesProvider, (_, _) {
      ref.invalidate(warrantyClaimDetailProvider(claimId));
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Warranty Claim')),
      body: claimAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) =>
            Center(child: Text('Failed to load claim: $err')),
        data: (claim) => _ClaimDetailBody(claim: claim),
      ),
    );
  }
}

class _ClaimDetailBody extends StatelessWidget {
  final WarrantyClaim claim;

  const _ClaimDetailBody({required this.claim});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final warrantyInfo = MaterialWarrantyInfo.forMaterial(claim.material);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  claim.productTitle,
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
              ),
              _ClaimStatusBadge(
                  status: claim.status, label: claim.statusLabel),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '#${claim.claimNumber}',
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          const SizedBox(height: 16),

          // Warranty validation
          _WarrantyInfoCard(
            warrantyInfo: warrantyInfo,
            orderDate: claim.orderDate,
            isWithinWarranty: claim.isWithinWarranty,
          ),
          const SizedBox(height: 16),

          // Order info
          Text('Order Information',
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _InfoRow(
                      label: 'Order', value: '#${claim.orderNumber}'),
                  _InfoRow(label: 'Material', value: claim.material),
                  _InfoRow(
                      label: 'Order Date',
                      value: _formatDate(claim.orderDate)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Defect description
          Text('Defect Description',
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(claim.defectDescription),
            ),
          ),
          const SizedBox(height: 16),

          // Photos
          if (claim.photoUrls.isNotEmpty) ...[
            Text('Photos',
                style: theme.textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: claim.photoUrls.map((url) {
                return Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                        color: theme.colorScheme.outlineVariant),
                  ),
                  child: Icon(Icons.photo,
                      color: theme.colorScheme.outline),
                );
              }).toList(),
            ),
          ],
        ],
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;

  const _InfoRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.outline,
                  )),
          Text(value, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}
