import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/auth_provider.dart';

class AppShell extends ConsumerWidget {
  final Widget child;

  const AppShell({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authStateProvider);
    final admin = authState.value?.admin;

    return Scaffold(
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _selectedIndex(context),
            onDestinationSelected: (index) => _onDestinationSelected(context, index),
            labelType: NavigationRailLabelType.all,
            leading: Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Column(
                children: [
                  const Icon(Icons.admin_panel_settings, size: 32),
                  const SizedBox(height: 4),
                  Text(
                    'Kanix Admin',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ],
              ),
            ),
            trailing: Expanded(
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (admin != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Text(
                            admin.name,
                            style: Theme.of(context).textTheme.labelSmall,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      IconButton(
                        icon: const Icon(Icons.logout),
                        tooltip: 'Sign out',
                        onPressed: () {
                          ref.read(authStateProvider.notifier).signOut();
                        },
                      ),
                    ],
                  ),
                ),
              ),
            ),
            destinations: const [
              NavigationRailDestination(
                icon: Icon(Icons.dashboard_outlined, semanticLabel: 'Dashboard'),
                selectedIcon: Icon(Icons.dashboard, semanticLabel: 'Dashboard'),
                label: Text('Dashboard'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.receipt_long_outlined, semanticLabel: 'Orders'),
                selectedIcon: Icon(Icons.receipt_long, semanticLabel: 'Orders'),
                label: Text('Orders'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.assignment_outlined, semanticLabel: 'Fulfillment'),
                selectedIcon: Icon(Icons.assignment, semanticLabel: 'Fulfillment'),
                label: Text('Fulfillment'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.local_shipping_outlined, semanticLabel: 'Shipments'),
                selectedIcon: Icon(Icons.local_shipping, semanticLabel: 'Shipments'),
                label: Text('Shipments'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.inventory_2_outlined, semanticLabel: 'Inventory'),
                selectedIcon: Icon(Icons.inventory_2, semanticLabel: 'Inventory'),
                label: Text('Inventory'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.storefront_outlined, semanticLabel: 'Products'),
                selectedIcon: Icon(Icons.storefront, semanticLabel: 'Products'),
                label: Text('Products'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.support_agent_outlined, semanticLabel: 'Support'),
                selectedIcon: Icon(Icons.support_agent, semanticLabel: 'Support'),
                label: Text('Support'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.gavel_outlined, semanticLabel: 'Disputes'),
                selectedIcon: Icon(Icons.gavel, semanticLabel: 'Disputes'),
                label: Text('Disputes'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.people_outlined, semanticLabel: 'Contributors'),
                selectedIcon: Icon(Icons.people, semanticLabel: 'Contributors'),
                label: Text('Contributors'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.settings_outlined, semanticLabel: 'Settings'),
                selectedIcon: Icon(Icons.settings, semanticLabel: 'Settings'),
                label: Text('Settings'),
              ),
            ],
          ),
          const VerticalDivider(thickness: 1, width: 1),
          Expanded(child: child),
        ],
      ),
    );
  }

  static const _routes = [
    '/dashboard',
    '/orders',
    '/fulfillment',
    '/shipments',
    '/inventory',
    '/products',
    '/support',
    '/disputes',
    '/contributors',
    '/settings',
  ];

  int _selectedIndex(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    // Exact match first, then prefix match for detail routes (e.g. /orders/123)
    final index = _routes.indexOf(location);
    if (index >= 0) return index;
    for (var i = 0; i < _routes.length; i++) {
      if (location.startsWith('${_routes[i]}/')) return i;
    }
    return 0;
  }

  void _onDestinationSelected(BuildContext context, int index) {
    context.go(_routes[index]);
  }
}
