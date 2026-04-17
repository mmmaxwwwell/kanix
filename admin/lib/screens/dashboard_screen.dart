import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/dashboard_provider.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summaryAsync = ref.watch(dashboardSummaryProvider);

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Dashboard',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 24),
          summaryAsync.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, _) => Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, size: 48, color: Colors.red),
                  const SizedBox(height: 8),
                  Text('Failed to load dashboard: $error'),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: () =>
                        ref.invalidate(dashboardSummaryProvider),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
            data: (summary) => _DashboardGrid(summary: summary),
          ),
        ],
      ),
    );
  }
}

class _DashboardGrid extends StatelessWidget {
  final DashboardSummary summary;

  const _DashboardGrid({required this.summary});

  @override
  Widget build(BuildContext context) {
    final cards = [
      _CountCard(
        title: 'Orders Awaiting Fulfillment',
        count: summary.ordersAwaitingFulfillment,
        icon: Icons.receipt_long,
        color: Colors.orange,
        route: '/orders',
      ),
      _CountCard(
        title: 'Open Support Tickets',
        count: summary.openSupportTickets,
        icon: Icons.support_agent,
        color: Colors.blue,
        route: '/support',
      ),
      _CountCard(
        title: 'Low Stock Variants',
        count: summary.lowStockVariants,
        icon: Icons.inventory_2,
        color: Colors.amber,
        route: '/inventory',
      ),
      _CountCard(
        title: 'Open Disputes',
        count: summary.openDisputes,
        icon: Icons.gavel,
        color: Colors.red,
        route: '/disputes',
      ),
      _CountCard(
        title: 'Shipment Exceptions',
        count: summary.shipmentsWithExceptions,
        icon: Icons.local_shipping,
        color: Colors.deepOrange,
        route: '/shipments',
      ),
    ];

    return Expanded(
      child: GridView.count(
        crossAxisCount: 3,
        mainAxisSpacing: 16,
        crossAxisSpacing: 16,
        childAspectRatio: 2.5,
        children: cards,
      ),
    );
  }
}

class _CountCard extends StatelessWidget {
  final String title;
  final int count;
  final IconData icon;
  final Color color;
  final String route;

  const _CountCard({
    required this.title,
    required this.count,
    required this.icon,
    required this.color,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 2,
      child: InkWell(
        onTap: () => context.go(route),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(icon, color: color, size: 24),
                  const Spacer(),
                  Text(
                    '$count',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: count > 0 ? color : null,
                        ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                title,
                style: Theme.of(context).textTheme.bodySmall,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
