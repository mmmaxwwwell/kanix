import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/contributor.dart';
import '../providers/auth_provider.dart';
import '../providers/contributor_provider.dart';

class ContributorDashboardScreen extends ConsumerWidget {
  const ContributorDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authStateProvider);
    final githubLinked = authState.value?.user?.githubLinked;

    if (githubLinked == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Contributor Dashboard')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.code_off,
                    size: 64,
                    color: Theme.of(context).colorScheme.outline),
                const SizedBox(height: 16),
                const Text('GitHub account not linked'),
                const SizedBox(height: 8),
                Text(
                  'Link your GitHub account in Account settings to access the contributor dashboard.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context)
                      .textTheme
                      .bodyMedium
                      ?.copyWith(color: Theme.of(context).colorScheme.outline),
                ),
                const SizedBox(height: 24),
                FilledButton.tonal(
                  onPressed: () {
                    ref.read(authStateProvider.notifier).linkGitHub();
                  },
                  child: const Text('Link GitHub Account'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final dashboardAsync = ref.watch(contributorDashboardProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Contributor Dashboard')),
      body: dashboardAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) =>
            Center(child: Text('Failed to load dashboard: $err')),
        data: (data) => _DashboardBody(data: data),
      ),
    );
  }
}

class _DashboardBody extends StatelessWidget {
  final ContributorDashboardData data;

  const _DashboardBody({required this.data});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Summary cards
          _SummaryRow(data: data),
          const SizedBox(height: 24),

          // Designs section
          Text('Designs',
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (data.designs.isEmpty)
            Text('No designs yet',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline))
          else
            ...data.designs.map((d) => _DesignCard(design: d)),
          const SizedBox(height: 24),

          // Milestones section
          Text('Milestones',
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (data.milestones.isEmpty)
            Text('No milestones yet',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline))
          else
            ...data.milestones.map((m) => _MilestoneCard(milestone: m)),
          const SizedBox(height: 24),

          // Payout history section
          Text('Payout History',
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (data.payouts.isEmpty)
            Text('No payouts yet',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline))
          else
            ...data.payouts.map((p) => _PayoutRow(payout: p)),
        ],
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  final ContributorDashboardData data;

  const _SummaryRow({required this.data});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _SummaryCard(
          label: 'Designs',
          value: '${data.totalDesigns}',
          icon: Icons.design_services,
        ),
        _SummaryCard(
          label: 'Total Sales',
          value: '${data.totalSales}',
          icon: Icons.shopping_bag,
        ),
        _SummaryCard(
          label: 'Royalty Accrued',
          value: data.formattedTotalRoyalty,
          icon: Icons.attach_money,
        ),
        _SummaryCard(
          label: 'Total Paid Out',
          value: data.formattedTotalPaidOut,
          icon: Icons.payments,
        ),
      ],
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _SummaryCard({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      width: 160,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 20, color: theme.colorScheme.primary),
              const SizedBox(height: 8),
              Text(value,
                  style: theme.textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.bold)),
              Text(label,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline)),
            ],
          ),
        ),
      ),
    );
  }
}

class _DesignCard extends StatelessWidget {
  final ContributorDesign design;

  const _DesignCard({required this.design});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(design.name,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text(
                    '${design.totalSales} sales',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
            Text(design.formattedRoyalty,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class _MilestoneCard extends StatelessWidget {
  final ContributorMilestone milestone;

  const _MilestoneCard({required this.milestone});

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
                Expanded(
                  child: Text(milestone.name,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600)),
                ),
                if (milestone.achieved)
                  const Icon(Icons.check_circle,
                      size: 20, color: Colors.green)
                else
                  Text(
                    '${milestone.currentSales}/${milestone.targetSales}',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
              ],
            ),
            if (milestone.description.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(milestone.description,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline)),
            ],
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: milestone.progress,
                minHeight: 8,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
                color: milestone.achieved
                    ? Colors.green
                    : theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Bonus: ${milestone.formattedBonus}',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ],
        ),
      ),
    );
  }
}

class _PayoutRow extends StatelessWidget {
  final ContributorPayout payout;

  const _PayoutRow({required this.payout});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(payout.formattedAmount,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text(
                    _formatDate(payout.paidAt),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
            _PayoutStatusBadge(
                status: payout.status, label: payout.statusLabel),
          ],
        ),
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.month}/${date.day}/${date.year}';
  }
}

class _PayoutStatusBadge extends StatelessWidget {
  final String status;
  final String label;

  const _PayoutStatusBadge({required this.status, required this.label});

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
      case 'processing':
        return (Colors.blue.shade100, Colors.blue.shade800);
      case 'completed':
        return (Colors.green.shade100, Colors.green.shade800);
      case 'failed':
        return (scheme.errorContainer, scheme.onErrorContainer);
      default:
        return (scheme.surfaceContainerHighest, scheme.onSurface);
    }
  }
}
