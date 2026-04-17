import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/auth_provider.dart';
import '../screens/login_screen.dart';
import '../screens/dashboard_screen.dart';
import '../screens/orders_screen.dart';
import '../screens/order_detail_screen.dart';
import '../screens/fulfillment_screen.dart'
    show FulfillmentScreen, FulfillmentDetailScreen;
import '../screens/shipments_screen.dart'
    show ShipmentsScreen, ShipmentDetailScreen;
import '../screens/inventory_screen.dart'
    show InventoryScreen, InventoryDetailScreen;
import '../screens/products_screen.dart'
    show ProductsScreen, ProductDetailScreen;
import '../screens/support_screen.dart';
import '../screens/disputes_screen.dart';
import '../screens/customers_screen.dart';
import '../screens/settings_screen.dart';
import '../widgets/app_shell.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);

  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/dashboard',
    redirect: (context, state) {
      final isAuthenticated = authState.value?.isAuthenticated ?? false;
      final isLoginRoute = state.matchedLocation == '/login';

      if (!isAuthenticated && !isLoginRoute) {
        return '/login';
      }
      if (isAuthenticated && isLoginRoute) {
        return '/dashboard';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(
            path: '/dashboard',
            builder: (context, state) => const DashboardScreen(),
          ),
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => OrderDetailScreen(
                  orderId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/fulfillment',
            builder: (context, state) => const FulfillmentScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => FulfillmentDetailScreen(
                  taskId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/shipments',
            builder: (context, state) => const ShipmentsScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => ShipmentDetailScreen(
                  shipmentId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/inventory',
            builder: (context, state) => const InventoryScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => InventoryDetailScreen(
                  variantId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/products',
            builder: (context, state) => const ProductsScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => ProductDetailScreen(
                  productId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/support',
            builder: (context, state) => const SupportScreen(),
          ),
          GoRoute(
            path: '/disputes',
            builder: (context, state) => const DisputesScreen(),
          ),
          GoRoute(
            path: '/customers',
            builder: (context, state) => const CustomersScreen(),
          ),
          GoRoute(
            path: '/settings',
            builder: (context, state) => const SettingsScreen(),
          ),
        ],
      ),
    ],
  );
});
