import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/kit.dart';
import '../providers/kit_provider.dart';

class KitBuilderScreen extends ConsumerWidget {
  const KitBuilderScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final kitsAsync = ref.watch(kitListProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Kit Builder')),
      body: kitsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48),
              const SizedBox(height: 16),
              Text(
                'Failed to load kits',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              FilledButton(
                onPressed: () => ref.invalidate(kitListProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (kits) {
          if (kits.isEmpty) {
            return const Center(child: Text('No kits available'));
          }
          if (kits.length == 1) {
            return _KitBuilderBody(kit: kits.first);
          }
          return ListView.builder(
            itemCount: kits.length,
            itemBuilder: (context, index) => _KitListTile(kit: kits[index]),
          );
        },
      ),
    );
  }
}

class _KitListTile extends StatelessWidget {
  final KitDefinition kit;

  const _KitListTile({required this.kit});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: ListTile(
        title: Text(kit.title),
        subtitle: kit.description != null ? Text(kit.description!) : null,
        trailing: Text(
          kit.formattedPrice,
          style: theme.textTheme.titleMedium?.copyWith(
            color: theme.colorScheme.primary,
            fontWeight: FontWeight.bold,
          ),
        ),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => Scaffold(
              appBar: AppBar(title: Text(kit.title)),
              body: _KitBuilderBody(kit: kit),
            ),
          ),
        ),
      ),
    );
  }
}

class KitBuilderDetailScreen extends ConsumerWidget {
  final String kitId;

  const KitBuilderDetailScreen({super.key, required this.kitId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final kitsAsync = ref.watch(kitListProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Kit Builder')),
      body: kitsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48),
              const SizedBox(height: 16),
              Text(
                'Failed to load kit',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              FilledButton(
                onPressed: () => ref.invalidate(kitListProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (kits) {
          final kit = kits.cast<KitDefinition?>().firstWhere(
                (k) => k!.id == kitId,
                orElse: () => null,
              );
          if (kit == null) {
            return const Center(child: Text('Kit not found'));
          }
          return _KitBuilderBody(kit: kit);
        },
      ),
    );
  }
}

class _KitBuilderBody extends StatefulWidget {
  final KitDefinition kit;

  const _KitBuilderBody({required this.kit});

  @override
  State<_KitBuilderBody> createState() => _KitBuilderBodyState();
}

class _KitBuilderBodyState extends State<_KitBuilderBody> {
  // Maps classId -> list of selected variant IDs
  final Map<String, List<String>> _selections = {};

  bool get _allClassesSatisfied {
    for (final req in widget.kit.requirements) {
      final selected = _selections[req.productClassId] ?? [];
      if (selected.length < req.quantity) return false;
    }
    return true;
  }

  int get _selectedIndividualTotal {
    var total = 0;
    for (final req in widget.kit.requirements) {
      final selectedIds = _selections[req.productClassId] ?? [];
      for (final variantId in selectedIds) {
        for (final product in req.products) {
          for (final variant in product.variants) {
            if (variant.id == variantId) {
              total += variant.priceCents;
            }
          }
        }
      }
    }
    return total;
  }

  void _toggleVariant(String classId, String variantId, int maxQuantity) {
    setState(() {
      final selected = List<String>.from(_selections[classId] ?? []);
      if (selected.contains(variantId)) {
        selected.remove(variantId);
      } else {
        if (selected.length >= maxQuantity) {
          // Replace the first selection
          selected.removeAt(0);
        }
        selected.add(variantId);
      }
      _selections[classId] = selected;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kit = widget.kit;
    final savingsMinor = _allClassesSatisfied
        ? (_selectedIndividualTotal - kit.priceMinor)
        : kit.savingsMinor;

    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Kit header
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        kit.title,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (kit.description != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          kit.description!,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      // Price info
                      Row(
                        children: [
                          Text(
                            'Kit Price: ${kit.formattedPrice}',
                            style: theme.textTheme.titleMedium?.copyWith(
                              color: theme.colorScheme.primary,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          if (savingsMinor > 0) ...[
                            const SizedBox(width: 12),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: Colors.green.shade100,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Text(
                                'Save \$${(savingsMinor / 100).toStringAsFixed(2)}',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: Colors.green.shade800,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),

                const Divider(),

                // Class requirements
                ...kit.requirements.map((req) => _ClassRequirementSection(
                      requirement: req,
                      selectedVariantIds:
                          _selections[req.productClassId] ?? [],
                      onToggleVariant: (variantId) => _toggleVariant(
                          req.productClassId, variantId, req.quantity),
                    )),
              ],
            ),
          ),
        ),

        // Bottom bar with validation + add to cart
        _BottomBar(
          kit: kit,
          allSatisfied: _allClassesSatisfied,
          selections: _selections,
        ),
      ],
    );
  }
}

class _ClassRequirementSection extends StatelessWidget {
  final KitClassRequirement requirement;
  final List<String> selectedVariantIds;
  final ValueChanged<String> onToggleVariant;

  const _ClassRequirementSection({
    required this.requirement,
    required this.selectedVariantIds,
    required this.onToggleVariant,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selectedCount = selectedVariantIds.length;
    final isSatisfied = selectedCount >= requirement.quantity;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                isSatisfied ? Icons.check_circle : Icons.radio_button_unchecked,
                size: 20,
                color: isSatisfied ? Colors.green : theme.colorScheme.outline,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Pick ${requirement.quantity} ${requirement.productClassName}',
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                '$selectedCount/${requirement.quantity}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: isSatisfied
                      ? Colors.green.shade700
                      : theme.colorScheme.onSurfaceVariant,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ...requirement.products.map((product) => _KitProductTile(
                product: product,
                selectedVariantIds: selectedVariantIds,
                onToggleVariant: onToggleVariant,
              )),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

class _KitProductTile extends StatelessWidget {
  final KitProduct product;
  final List<String> selectedVariantIds;
  final ValueChanged<String> onToggleVariant;

  const _KitProductTile({
    required this.product,
    required this.selectedVariantIds,
    required this.onToggleVariant,
  });

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
              children: [
                Expanded(
                  child: Text(
                    product.title,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                // Stock indicator
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      product.isAvailable
                          ? Icons.circle
                          : Icons.circle_outlined,
                      size: 10,
                      color:
                          product.isAvailable ? Colors.green : Colors.red,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      product.isAvailable ? 'In Stock' : 'Out of Stock',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: product.isAvailable
                            ? Colors.green.shade700
                            : Colors.red.shade700,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: product.variants.map((variant) {
                final isSelected = selectedVariantIds.contains(variant.id);
                return ChoiceChip(
                  label: Text(
                    '${variant.material} ${variant.formattedPrice}',
                  ),
                  selected: isSelected,
                  onSelected: variant.inStock
                      ? (_) => onToggleVariant(variant.id)
                      : null,
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }
}

class _BottomBar extends StatelessWidget {
  final KitDefinition kit;
  final bool allSatisfied;
  final Map<String, List<String>> selections;

  const _BottomBar({
    required this.kit,
    required this.allSatisfied,
    required this.selections,
  });

  String? get _missingClassMessage {
    if (allSatisfied) return null;
    final missing = <String>[];
    for (final req in kit.requirements) {
      final selected = selections[req.productClassId] ?? [];
      if (selected.length < req.quantity) {
        final remaining = req.quantity - selected.length;
        missing.add('$remaining ${req.productClassName}');
      }
    }
    return 'Still need: ${missing.join(', ')}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final missingMsg = _missingClassMessage;

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
            if (missingMsg != null) ...[
              Text(
                missingMsg,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
              const SizedBox(height: 8),
            ],
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: allSatisfied
                    ? () {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Kit added to cart'),
                          ),
                        );
                      }
                    : null,
                icon: const Icon(Icons.add_shopping_cart),
                label: Text('Add Kit to Cart - ${kit.formattedPrice}'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
