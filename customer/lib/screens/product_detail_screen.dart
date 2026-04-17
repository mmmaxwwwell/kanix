import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/cart.dart';
import '../models/product.dart';
import '../providers/cart_provider.dart';
import '../providers/catalog_provider.dart';

class ProductDetailScreen extends ConsumerStatefulWidget {
  final String productId;

  const ProductDetailScreen({super.key, required this.productId});

  @override
  ConsumerState<ProductDetailScreen> createState() =>
      _ProductDetailScreenState();
}

class _ProductDetailScreenState extends ConsumerState<ProductDetailScreen> {
  String? _selectedVariantId;

  @override
  Widget build(BuildContext context) {
    final productAsync = ref.watch(productDetailProvider(widget.productId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Product Details'),
      ),
      body: productAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48),
              const SizedBox(height: 16),
              Text(
                'Failed to load product',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              FilledButton(
                onPressed: () =>
                    ref.invalidate(productDetailProvider(widget.productId)),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (product) => _ProductDetailBody(
          product: product,
          selectedVariantId: _selectedVariantId,
          onVariantSelected: (id) => setState(() => _selectedVariantId = id),
        ),
      ),
    );
  }
}

class _ProductDetailBody extends ConsumerWidget {
  final Product product;
  final String? selectedVariantId;
  final ValueChanged<String> onVariantSelected;

  const _ProductDetailBody({
    required this.product,
    required this.selectedVariantId,
    required this.onVariantSelected,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final activeVariants =
        product.variants.where((v) => v.status == 'active').toList();
    final selectedId = selectedVariantId ??
        (activeVariants.isNotEmpty ? activeVariants.first.id : null);
    final selectedVariant = selectedId != null
        ? activeVariants
            .cast<ProductVariant?>()
            .firstWhere((v) => v!.id == selectedId, orElse: () => null)
        : null;
    final warrantyInfo = selectedVariant != null
        ? MaterialWarrantyInfo.forMaterial(selectedVariant.material)
        : null;

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Product image
          SizedBox(
            height: 300,
            width: double.infinity,
            child: product.primaryImageUrl != null
                ? Image.network(
                    product.primaryImageUrl!,
                    fit: BoxFit.cover,
                    errorBuilder: (_, _, _) =>
                        const _DetailPlaceholderImage(),
                  )
                : const _DetailPlaceholderImage(),
          ),

          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Title
                Text(
                  product.title,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                if (product.subtitle != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    product.subtitle!,
                    style: theme.textTheme.bodyLarge?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],

                // Price
                if (selectedVariant != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    selectedVariant.formattedPrice,
                    style: theme.textTheme.headlineMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],

                // Material variant selector
                if (activeVariants.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  Text(
                    'Material',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    children: activeVariants
                        .map((variant) => _MaterialChip(
                              variant: variant,
                              isSelected: variant.id == selectedId,
                              onSelected: () =>
                                  onVariantSelected(variant.id),
                            ))
                        .toList(),
                  ),
                ],

                // Availability
                if (selectedVariant != null) ...[
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Icon(
                        selectedVariant.isInStock
                            ? Icons.check_circle
                            : Icons.cancel,
                        size: 18,
                        color: selectedVariant.isInStock
                            ? Colors.green
                            : Colors.red,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        selectedVariant.isInStock
                            ? 'In Stock'
                            : 'Out of Stock',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: selectedVariant.isInStock
                              ? Colors.green.shade800
                              : Colors.red.shade800,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ],

                // Warranty info
                if (warrantyInfo != null) ...[
                  const SizedBox(height: 24),
                  _WarrantyInfoCard(warrantyInfo: warrantyInfo),
                ],

                // Description
                if (product.description != null) ...[
                  const SizedBox(height: 24),
                  Text(
                    'Description',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    product.description!,
                    style: theme.textTheme.bodyMedium,
                  ),
                ],

                const SizedBox(height: 32),

                // Add to cart button
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: selectedVariant != null &&
                            selectedVariant.isInStock
                        ? () {
                            ref.read(cartProvider.notifier).addItem(
                                  CartItem(
                                    variantId: selectedVariant.id,
                                    productId: product.id,
                                    productTitle: product.title,
                                    variantTitle: selectedVariant.title,
                                    material: selectedVariant.material,
                                    priceCents: selectedVariant.priceCents,
                                    quantity: 1,
                                    imageUrl: product.primaryImageUrl,
                                  ),
                                );
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Added to cart'),
                              ),
                            );
                          }
                        : null,
                    icon: const Icon(Icons.add_shopping_cart),
                    label: const Text('Add to Cart'),
                  ),
                ),

                const SizedBox(height: 16),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailPlaceholderImage extends StatelessWidget {
  const _DetailPlaceholderImage();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: const Center(
        child: Icon(Icons.image_outlined, size: 64),
      ),
    );
  }
}

class _MaterialChip extends StatelessWidget {
  final ProductVariant variant;
  final bool isSelected;
  final VoidCallback onSelected;

  const _MaterialChip({
    required this.variant,
    required this.isSelected,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      label: Text(variant.material),
      selected: isSelected,
      onSelected: (_) => onSelected(),
    );
  }
}

class _WarrantyInfoCard extends StatelessWidget {
  final MaterialWarrantyInfo warrantyInfo;

  const _WarrantyInfoCard({required this.warrantyInfo});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      color: theme.colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.verified_user,
                  size: 18,
                  color: theme.colorScheme.onSecondaryContainer,
                ),
                const SizedBox(width: 6),
                Text(
                  'Warranty: ${warrantyInfo.warrantyPeriod}',
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: theme.colorScheme.onSecondaryContainer,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            if (warrantyInfo.limitation != null) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.info_outline,
                    size: 16,
                    color: theme.colorScheme.onSecondaryContainer
                        .withValues(alpha: 0.7),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      warrantyInfo.limitation!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSecondaryContainer
                            .withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
