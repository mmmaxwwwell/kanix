import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/auth_provider.dart';
import '../screens/login_screen.dart';
import '../screens/signup_screen.dart';
import '../screens/email_verification_screen.dart';
import '../screens/catalog_screen.dart';
import '../screens/product_detail_screen.dart';
import '../screens/kit_builder_screen.dart'
    show KitBuilderScreen, KitBuilderDetailScreen;
import '../screens/cart_screen.dart';
import '../screens/checkout_screen.dart';
import '../models/cart.dart' show OrderConfirmation;
import '../screens/order_confirmation_screen.dart';
import '../screens/orders_screen.dart'
    show OrdersScreen, OrderDetailScreen;
import '../screens/support_screen.dart'
    show SupportScreen, SupportDetailScreen;
import '../screens/warranty_screen.dart'
    show WarrantyScreen, WarrantyDetailScreen;
import '../screens/account_screen.dart';
import '../screens/contributor_dashboard_screen.dart';
import '../widgets/app_shell.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);

  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/catalog',
    redirect: (context, state) {
      final isAuthenticated = authState.value?.isAuthenticated ?? false;
      final pendingVerification =
          authState.value?.pendingVerification ?? false;
      final location = state.matchedLocation;

      final isAuthRoute =
          location == '/login' || location == '/signup';
      final isVerifyRoute = location == '/verify-email';

      if (pendingVerification && !isVerifyRoute) {
        return '/verify-email';
      }
      if (!isAuthenticated && !pendingVerification && !isAuthRoute) {
        return '/login';
      }
      if (isAuthenticated && (isAuthRoute || isVerifyRoute)) {
        return '/catalog';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/signup',
        builder: (context, state) => const SignupScreen(),
      ),
      GoRoute(
        path: '/verify-email',
        builder: (context, state) => const EmailVerificationScreen(),
      ),
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(
            path: '/catalog',
            builder: (context, state) => const CatalogScreen(),
          ),
          GoRoute(
            path: '/product/:id',
            builder: (context, state) => ProductDetailScreen(
              productId: state.pathParameters['id']!,
            ),
          ),
          GoRoute(
            path: '/kit-builder',
            builder: (context, state) => const KitBuilderScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => KitBuilderDetailScreen(
                  kitId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/cart',
            builder: (context, state) => const CartScreen(),
          ),
          GoRoute(
            path: '/checkout',
            builder: (context, state) => const CheckoutScreen(),
            routes: [
              GoRoute(
                path: 'confirmation',
                builder: (context, state) {
                  final confirmation =
                      state.extra as OrderConfirmation;
                  return OrderConfirmationScreen(
                      confirmation: confirmation);
                },
              ),
            ],
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
            path: '/support',
            builder: (context, state) => const SupportScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => SupportDetailScreen(
                  ticketId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/warranty',
            builder: (context, state) => const WarrantyScreen(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => WarrantyDetailScreen(
                  claimId: state.pathParameters['id']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/account',
            builder: (context, state) => const AccountScreen(),
          ),
          GoRoute(
            path: '/contributor',
            builder: (context, state) =>
                const ContributorDashboardScreen(),
          ),
        ],
      ),
    ],
  );
});
