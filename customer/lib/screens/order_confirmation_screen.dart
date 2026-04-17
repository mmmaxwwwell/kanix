import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../models/cart.dart';

class OrderConfirmationScreen extends StatelessWidget {
  final OrderConfirmation confirmation;

  const OrderConfirmationScreen({super.key, required this.confirmation});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Order Confirmed')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.check_circle,
                  size: 80, color: Colors.green.shade600),
              const SizedBox(height: 16),
              Text(
                'Thank you for your order!',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                'Order #${confirmation.orderNumber}',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: theme.colorScheme.primary,
                ),
              ),
              const SizedBox(height: 24),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    children: [
                      _SummaryRow(
                        label: 'Subtotal',
                        cents: confirmation.subtotalCents,
                      ),
                      const SizedBox(height: 4),
                      _SummaryRow(
                        label: 'Shipping',
                        cents: confirmation.shippingCents,
                      ),
                      const SizedBox(height: 4),
                      _SummaryRow(
                        label: 'Tax',
                        cents: confirmation.taxCents,
                      ),
                      const Divider(height: 16),
                      _SummaryRow(
                        label: 'Total',
                        cents: confirmation.totalCents,
                        bold: true,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => context.go('/orders'),
                  child: const Text('View Orders'),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => context.go('/catalog'),
                  child: const Text('Continue Shopping'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  final String label;
  final int cents;
  final bool bold;

  const _SummaryRow({
    required this.label,
    required this.cents,
    this.bold = false,
  });

  @override
  Widget build(BuildContext context) {
    final dollars = cents ~/ 100;
    final c = (cents % 100).toString().padLeft(2, '0');
    final style = bold
        ? Theme.of(context)
            .textTheme
            .titleMedium
            ?.copyWith(fontWeight: FontWeight.bold)
        : Theme.of(context).textTheme.bodyMedium;

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: style),
        Text('\$$dollars.$c', style: style),
      ],
    );
  }
}
