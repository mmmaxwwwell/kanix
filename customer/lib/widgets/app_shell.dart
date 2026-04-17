import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

class AppShell extends ConsumerWidget {
  final Widget child;

  const AppShell({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex(context),
        onDestinationSelected: (index) =>
            _onDestinationSelected(context, ref, index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.storefront_outlined),
            selectedIcon: Icon(Icons.storefront),
            label: 'Catalog',
          ),
          NavigationDestination(
            icon: Icon(Icons.shopping_cart_outlined),
            selectedIcon: Icon(Icons.shopping_cart),
            label: 'Cart',
          ),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Orders',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outlined),
            selectedIcon: Icon(Icons.person),
            label: 'Account',
          ),
        ],
      ),
    );
  }

  static const _routes = [
    '/catalog',
    '/cart',
    '/orders',
    '/account',
  ];

  int _selectedIndex(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    final index = _routes.indexOf(location);
    if (index >= 0) return index;
    for (var i = 0; i < _routes.length; i++) {
      if (location.startsWith('${_routes[i]}/')) return i;
    }
    // Map other routes to their parent nav item
    if (location.startsWith('/product')) return 0;
    if (location.startsWith('/checkout')) return 1;
    if (location.startsWith('/support') || location.startsWith('/warranty')) {
      return 2;
    }
    if (location.startsWith('/contributor')) return 3;
    return 0;
  }

  void _onDestinationSelected(
      BuildContext context, WidgetRef ref, int index) {
    context.go(_routes[index]);
  }
}
