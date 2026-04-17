import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../models/cart.dart';
import '../providers/cart_provider.dart';

class CartScreen extends ConsumerWidget {
  const CartScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(cartProvider);
    final subtotal = ref.watch(cartSubtotalProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Cart')),
      body: items.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.shopping_cart_outlined,
                      size: 64, color: theme.colorScheme.outline),
                  const SizedBox(height: 16),
                  const Text('Your cart is empty'),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: () => context.go('/catalog'),
                    child: const Text('Browse Catalog'),
                  ),
                ],
              ),
            )
          : Column(
              children: [
                Expanded(
                  child: ListView.builder(
                    itemCount: items.length,
                    itemBuilder: (context, index) =>
                        _CartItemTile(item: items[index]),
                  ),
                ),
                _CartSummary(subtotalCents: subtotal, itemCount: items.length),
              ],
            ),
    );
  }
}

class _CartItemTile extends ConsumerWidget {
  final CartItem item;

  const _CartItemTile({required this.item});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);

    return Dismissible(
      key: ValueKey(item.variantId),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 16),
        color: theme.colorScheme.error,
        child: Icon(Icons.delete, color: theme.colorScheme.onError),
      ),
      onDismissed: (_) {
        ref.read(cartProvider.notifier).removeItem(item.variantId);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${item.productTitle} removed')),
        );
      },
      child: ListTile(
        leading: SizedBox(
          width: 56,
          height: 56,
          child: Container(
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.image_outlined),
          ),
        ),
        title: Text(item.productTitle, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text('${item.material} \u2022 ${item.formattedUnitPrice}'),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              icon: const Icon(Icons.remove_circle_outline),
              onPressed: () {
                if (item.quantity <= 1) {
                  ref.read(cartProvider.notifier).removeItem(item.variantId);
                } else {
                  ref
                      .read(cartProvider.notifier)
                      .updateQuantity(item.variantId, item.quantity - 1);
                }
              },
              tooltip: 'Decrease quantity',
            ),
            Text(
              '${item.quantity}',
              style: theme.textTheme.bodyLarge?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            IconButton(
              icon: const Icon(Icons.add_circle_outline),
              onPressed: () {
                ref
                    .read(cartProvider.notifier)
                    .updateQuantity(item.variantId, item.quantity + 1);
              },
              tooltip: 'Increase quantity',
            ),
          ],
        ),
      ),
    );
  }
}

class _CartSummary extends ConsumerWidget {
  final int subtotalCents;
  final int itemCount;

  const _CartSummary({required this.subtotalCents, required this.itemCount});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final dollars = subtotalCents ~/ 100;
    final cents = (subtotalCents % 100).toString().padLeft(2, '0');

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Subtotal ($itemCount ${itemCount == 1 ? 'item' : 'items'})',
                  style: theme.textTheme.titleMedium,
                ),
                Text(
                  '\$$dollars.$cents',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => context.go('/checkout'),
                child: const Text('Proceed to Checkout'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
