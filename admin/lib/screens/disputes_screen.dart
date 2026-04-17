import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/dispute.dart';
import '../providers/dispute_provider.dart';

class DisputesScreen extends ConsumerWidget {
  const DisputesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final disputesAsync = ref.watch(disputeListProvider);
    final filters = ref.watch(disputeFiltersProvider);

    ref.listen(disputeUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(disputeListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Disputes',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(disputeListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _DisputeFiltersBar(filters: filters),
          const SizedBox(height: 16),
          Expanded(
            child: disputesAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load disputes: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () => ref.invalidate(disputeListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (disputes) => disputes.isEmpty
                  ? const Center(child: Text('No disputes found'))
                  : _DisputesDataTable(disputes: disputes),
            ),
          ),
        ],
      ),
    );
  }
}

class _DisputeFiltersBar extends ConsumerWidget {
  final DisputeFilters filters;

  const _DisputeFiltersBar({required this.filters});

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
              hintText: 'Order #, dispute ID...',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
              isDense: true,
            ),
            onChanged: (value) {
              ref.read(disputeFiltersProvider.notifier).state =
                  filters.copyWith(
                      search: () => value.isEmpty ? null : value);
            },
          ),
        ),
        SizedBox(
          width: 180,
          child: DropdownButtonFormField<String>(
            initialValue: filters.status,
            decoration: const InputDecoration(
              labelText: 'Status',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            isExpanded: true,
            items: const [
              DropdownMenuItem<String>(value: null, child: Text('All')),
              DropdownMenuItem(
                  value: 'needs_response', child: Text('needs response')),
              DropdownMenuItem(
                  value: 'under_review', child: Text('under review')),
              DropdownMenuItem(value: 'won', child: Text('won')),
              DropdownMenuItem(value: 'lost', child: Text('lost')),
              DropdownMenuItem(
                  value: 'warning_closed', child: Text('warning closed')),
            ],
            onChanged: (v) {
              ref.read(disputeFiltersProvider.notifier).state =
                  filters.copyWith(status: () => v);
            },
          ),
        ),
        if (filters.status != null ||
            (filters.search != null && filters.search!.isNotEmpty))
          TextButton.icon(
            icon: const Icon(Icons.clear),
            label: const Text('Clear filters'),
            onPressed: () {
              ref.read(disputeFiltersProvider.notifier).state =
                  const DisputeFilters();
            },
          ),
      ],
    );
  }
}

class _DisputesDataTable extends StatelessWidget {
  final List<Dispute> disputes;

  const _DisputesDataTable({required this.disputes});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Dispute ID')),
          DataColumn(label: Text('Order')),
          DataColumn(label: Text('Reason')),
          DataColumn(label: Text('Amount'), numeric: true),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Evidence Due')),
          DataColumn(label: Text('Evidence')),
        ],
        rows: disputes.map((dispute) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/disputes/${dispute.id}');
            },
            cells: [
              DataCell(Text(dispute.stripeDisputeId)),
              DataCell(Text(dispute.orderNumber ?? dispute.orderId)),
              DataCell(Text(dispute.reason.replaceAll('_', ' '))),
              DataCell(Text(dispute.formattedAmount)),
              DataCell(_StatusChip(
                label: dispute.status,
                color: _disputeStatusColor(dispute.status),
              )),
              DataCell(Text(
                dispute.evidenceDueBy != null
                    ? _formatDate(dispute.evidenceDueBy!)
                    : '-',
                style: dispute.isEvidenceDueSoon
                    ? const TextStyle(
                        color: Colors.red, fontWeight: FontWeight.bold)
                    : null,
              )),
              DataCell(_EvidenceReadinessIcon(dispute: dispute)),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _EvidenceReadinessIcon extends StatelessWidget {
  final Dispute dispute;

  const _EvidenceReadinessIcon({required this.dispute});

  @override
  Widget build(BuildContext context) {
    if (dispute.evidenceSubmitted) {
      return const Tooltip(
        message: 'Evidence submitted',
        child: Icon(Icons.check_circle, color: Colors.green, size: 20),
      );
    }
    if (dispute.isEvidenceDueSoon) {
      return const Tooltip(
        message: 'Evidence due soon',
        child: Icon(Icons.warning, color: Colors.red, size: 20),
      );
    }
    if (dispute.status == 'needs_response') {
      return const Tooltip(
        message: 'Evidence needed',
        child: Icon(Icons.pending, color: Colors.orange, size: 20),
      );
    }
    return const SizedBox.shrink();
  }
}

class DisputeDetailScreen extends ConsumerWidget {
  final String disputeId;

  const DisputeDetailScreen({super.key, required this.disputeId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final disputeAsync = ref.watch(disputeDetailProvider(disputeId));

    ref.listen(disputeUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(disputeDetailProvider(disputeId));
        ref.invalidate(disputeEvidenceProvider(disputeId));
      }
    });

    return disputeAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load dispute: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(disputeDetailProvider(disputeId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (dispute) => _DisputeDetailContent(dispute: dispute),
    );
  }
}

class _DisputeDetailContent extends ConsumerWidget {
  final Dispute dispute;

  const _DisputeDetailContent({required this.dispute});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final evidenceAsync = ref.watch(disputeEvidenceProvider(dispute.id));

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _DisputeHeader(dispute: dispute),
          const SizedBox(height: 16),
          _DisputeInfoCards(dispute: dispute),
          const SizedBox(height: 16),
          Row(
            children: [
              Text('Evidence',
                  style: Theme.of(context).textTheme.titleLarge),
              const Spacer(),
              if (!dispute.evidenceSubmitted &&
                  dispute.status == 'needs_response')
                FilledButton.icon(
                  icon: const Icon(Icons.archive),
                  label: const Text('Generate Bundle'),
                  onPressed: () =>
                      _generateBundle(context, ref, dispute.id),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: evidenceAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (e, _) =>
                  Center(child: Text('Failed to load evidence: $e')),
              data: (evidence) => evidence.isEmpty
                  ? const Center(child: Text('No evidence uploaded yet'))
                  : _EvidenceList(evidence: evidence),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _generateBundle(
      BuildContext context, WidgetRef ref, String disputeId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Generate Evidence Bundle'),
        content: const Text(
          'This will compile all uploaded evidence into a submission bundle for Stripe. Continue?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Generate'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post('/api/admin/disputes/$disputeId/bundle');
        ref.invalidate(disputeDetailProvider(disputeId));
        ref.invalidate(disputeEvidenceProvider(disputeId));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
                content: Text('Evidence bundle generated successfully')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Bundle generation failed: $e')),
          );
        }
      }
    }
  }
}

class _DisputeHeader extends StatelessWidget {
  final Dispute dispute;

  const _DisputeHeader({required this.dispute});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(width: 8),
        Text(
          'Dispute: ${dispute.stripeDisputeId}',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(width: 16),
        _StatusChip(
          label: dispute.status,
          color: _disputeStatusColor(dispute.status),
        ),
      ],
    );
  }
}

class _DisputeInfoCards extends StatelessWidget {
  final Dispute dispute;

  const _DisputeInfoCards({required this.dispute});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 16,
      runSpacing: 12,
      children: [
        _InfoCard(
          title: 'Amount',
          value: dispute.formattedAmount,
          icon: Icons.attach_money,
        ),
        _InfoCard(
          title: 'Reason',
          value: dispute.reason.replaceAll('_', ' '),
          icon: Icons.info_outline,
        ),
        _InfoCard(
          title: 'Order',
          value: dispute.orderNumber ?? dispute.orderId,
          icon: Icons.receipt,
        ),
        _InfoCard(
          title: 'Evidence Due',
          value: dispute.evidenceDueBy != null
              ? _formatDate(dispute.evidenceDueBy!)
              : 'N/A',
          icon: Icons.calendar_today,
          valueColor: dispute.isEvidenceDueSoon ? Colors.red : null,
        ),
        _InfoCard(
          title: 'Evidence Status',
          value: dispute.evidenceSubmitted ? 'Submitted' : 'Pending',
          icon: dispute.evidenceSubmitted
              ? Icons.check_circle
              : Icons.pending,
          valueColor:
              dispute.evidenceSubmitted ? Colors.green : Colors.orange,
        ),
      ],
    );
  }
}

class _InfoCard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color? valueColor;

  const _InfoCard({
    required this.title,
    required this.value,
    required this.icon,
    this.valueColor,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 20, color: valueColor ?? Colors.grey),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: Theme.of(context).textTheme.labelSmall),
                Text(
                  value,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: valueColor,
                        fontWeight: valueColor != null
                            ? FontWeight.bold
                            : null,
                      ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _EvidenceList extends StatelessWidget {
  final List<DisputeEvidence> evidence;

  const _EvidenceList({required this.evidence});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        columns: const [
          DataColumn(label: Text('Category')),
          DataColumn(label: Text('File')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Created')),
        ],
        rows: evidence.map((e) {
          return DataRow(cells: [
            DataCell(Text(e.category.replaceAll('_', ' '))),
            DataCell(Text(e.fileName ?? '-')),
            DataCell(_StatusChip(
              label: e.status,
              color: _evidenceStatusColor(e.status),
            )),
            DataCell(Text(_formatDateTime(e.createdAt))),
          ]);
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

Color _disputeStatusColor(String status) {
  switch (status) {
    case 'needs_response':
      return Colors.deepOrange;
    case 'under_review':
      return Colors.blue;
    case 'won':
      return Colors.green;
    case 'lost':
      return Colors.red;
    case 'warning_closed':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

Color _evidenceStatusColor(String status) {
  switch (status) {
    case 'ready':
      return Colors.green;
    case 'pending':
      return Colors.orange;
    case 'submitted':
      return Colors.blue;
    default:
      return Colors.grey;
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
