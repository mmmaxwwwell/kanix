import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../models/contributor.dart';
import '../providers/contributor_provider.dart';

class ContributorsScreen extends ConsumerWidget {
  const ContributorsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final contributorsAsync = ref.watch(contributorListProvider);

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Contributors',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(contributorListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: contributorsAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load contributors: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () =>
                          ref.invalidate(contributorListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (contributors) => contributors.isEmpty
                  ? const Center(child: Text('No contributors found'))
                  : _ContributorsDataTable(contributors: contributors),
            ),
          ),
        ],
      ),
    );
  }
}

class _ContributorsDataTable extends StatelessWidget {
  final List<Contributor> contributors;

  const _ContributorsDataTable({required this.contributors});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('GitHub Username')),
          DataColumn(label: Text('Display Name')),
          DataColumn(label: Text('Royalty Status')),
          DataColumn(label: Text('Royalty Rate')),
          DataColumn(label: Text('Total Earned')),
          DataColumn(label: Text('Pending Balance')),
          DataColumn(label: Text('Products')),
        ],
        rows: contributors.map((contributor) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/contributors/${contributor.id}');
            },
            cells: [
              DataCell(Text(contributor.githubUsername)),
              DataCell(Text(contributor.displayName ?? '-')),
              DataCell(_RoyaltyStatusChip(status: contributor.royaltyStatus)),
              DataCell(Text('${(contributor.royaltyRate * 100).toStringAsFixed(0)}%')),
              DataCell(Text('\$${contributor.totalEarned.toStringAsFixed(2)}')),
              DataCell(Text('\$${contributor.pendingBalance.toStringAsFixed(2)}')),
              DataCell(Text('${contributor.productCount}')),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class ContributorDetailScreen extends ConsumerWidget {
  final String contributorId;

  const ContributorDetailScreen({super.key, required this.contributorId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final contributorAsync =
        ref.watch(contributorDetailProvider(contributorId));

    return contributorAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load contributor: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(contributorDetailProvider(contributorId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (contributor) =>
          _ContributorDetailContent(contributor: contributor),
    );
  }
}

class _ContributorDetailContent extends StatelessWidget {
  final Contributor contributor;

  const _ContributorDetailContent({required this.contributor});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  contributor.displayName ?? contributor.githubUsername,
                  style: Theme.of(context).textTheme.headlineMedium,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 16),
              _RoyaltyStatusChip(status: contributor.royaltyStatus),
            ],
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                spacing: 32,
                runSpacing: 12,
                children: [
                  _InfoItem(
                      label: 'GitHub', value: contributor.githubUsername),
                  if (contributor.email != null)
                    _InfoItem(label: 'Email', value: contributor.email!),
                  _InfoItem(
                      label: 'Royalty Rate',
                      value:
                          '${(contributor.royaltyRate * 100).toStringAsFixed(0)}%'),
                  _InfoItem(
                      label: 'Products',
                      value: '${contributor.productCount}'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text('Royalty Summary',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: _SummaryCard(
                      label: 'Total Earned',
                      value:
                          '\$${contributor.totalEarned.toStringAsFixed(2)}',
                      color: Colors.green,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: _SummaryCard(
                      label: 'Total Paid',
                      value:
                          '\$${contributor.totalPaid.toStringAsFixed(2)}',
                      color: Colors.blue,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: _SummaryCard(
                      label: 'Pending Balance',
                      value:
                          '\$${contributor.pendingBalance.toStringAsFixed(2)}',
                      color: Colors.orange,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          _InfoItem(
              label: 'Member Since',
              value: _formatDate(contributor.createdAt)),
        ],
      ),
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _SummaryCard({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                )),
        const SizedBox(height: 4),
        Text(
          value,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                color: color,
                fontWeight: FontWeight.bold,
              ),
        ),
      ],
    );
  }
}

class _InfoItem extends StatelessWidget {
  final String label;
  final String value;

  const _InfoItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                )),
        const SizedBox(height: 2),
        Text(value, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _RoyaltyStatusChip extends StatelessWidget {
  final String status;

  const _RoyaltyStatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = _royaltyStatusColor(status);
    return Chip(
      label: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

Color _royaltyStatusColor(String status) {
  switch (status) {
    case 'active':
      return Colors.green;
    case 'paused':
      return Colors.orange;
    case 'suspended':
      return Colors.red;
    case 'pending':
      return Colors.blue;
    default:
      return Colors.grey;
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}
