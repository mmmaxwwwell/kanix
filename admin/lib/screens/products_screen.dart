import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/product.dart';
import '../providers/product_provider.dart';
import '../providers/websocket_provider.dart';

/// Stream of product-related WebSocket messages.
final productUpdatesProvider =
    StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('product');
});

class ProductsScreen extends ConsumerWidget {
  const ProductsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final productsAsync = ref.watch(productListProvider);

    ref.listen(productUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(productListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Products',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              FilledButton.icon(
                icon: const Icon(Icons.add),
                label: const Text('New Product'),
                onPressed: () => _showCreateDialog(context, ref),
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(productListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: productsAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load products: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () =>
                          ref.invalidate(productListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (products) => products.isEmpty
                  ? const Center(child: Text('No products'))
                  : _ProductTable(products: products),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showCreateDialog(
      BuildContext context, WidgetRef ref) async {
    final nameController = TextEditingController();
    final descriptionController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Create Product'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Product Name',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Name is required';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: descriptionController,
                decoration: const InputDecoration(
                  labelText: 'Description (optional)',
                  border: OutlineInputBorder(),
                ),
                maxLines: 3,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Create'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post('/api/admin/products', data: {
          'name': nameController.text,
          if (descriptionController.text.isNotEmpty)
            'description': descriptionController.text,
        });
        ref.invalidate(productListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Product created')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to create product: $e')),
          );
        }
      }
    }
  }
}

class _ProductTable extends StatelessWidget {
  final List<Product> products;

  const _ProductTable({required this.products});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Name')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Variants'), numeric: true),
          DataColumn(label: Text('Media'), numeric: true),
          DataColumn(label: Text('Updated')),
        ],
        rows: products.map((p) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/products/${p.id}');
            },
            cells: [
              DataCell(Text(p.name)),
              DataCell(_ProductStatusChip(status: p.status)),
              DataCell(Text('${p.variants.length}')),
              DataCell(Text('${p.media.length}')),
              DataCell(Text(_formatDate(p.updatedAt))),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _ProductStatusChip extends StatelessWidget {
  final String status;

  const _ProductStatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (status) {
      case 'active':
        color = Colors.green;
        break;
      case 'draft':
        color = Colors.orange;
        break;
      case 'archived':
        color = Colors.grey;
        break;
      default:
        color = Colors.grey;
    }
    return Chip(
      label: Text(
        status,
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

// ---------------------------------------------------------------------------
// Product Detail Screen
// ---------------------------------------------------------------------------

class ProductDetailScreen extends ConsumerWidget {
  final String productId;

  const ProductDetailScreen({super.key, required this.productId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final productAsync = ref.watch(productDetailProvider(productId));

    ref.listen(productUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(productDetailProvider(productId));
      }
    });

    return productAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load product: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(productDetailProvider(productId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (product) => _ProductDetailContent(product: product),
    );
  }
}

class _ProductDetailContent extends ConsumerWidget {
  final Product product;

  const _ProductDetailContent({required this.product});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/products'),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  product.name,
                  style: Theme.of(context).textTheme.headlineMedium,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 16),
              _ProductStatusChip(status: product.status),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.edit),
                label: const Text('Edit'),
                onPressed: () => _showEditDialog(context, ref),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.delete, color: Colors.red),
                label: const Text('Delete',
                    style: TextStyle(color: Colors.red)),
                style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: Colors.red)),
                onPressed: () => _showDeleteDialog(context, ref),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailCard(
                    title: 'Product Details',
                    children: [
                      _DetailRow(label: 'ID', value: product.id),
                      _DetailRow(label: 'Name', value: product.name),
                      _DetailRow(
                          label: 'Description',
                          value: product.description ?? '-'),
                      _DetailRow(label: 'Status', value: product.status),
                      _DetailRow(
                          label: 'Created',
                          value: _formatDateTime(product.createdAt)),
                      _DetailRow(
                          label: 'Updated',
                          value: _formatDateTime(product.updatedAt)),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _VariantsSection(product: product),
                  const SizedBox(height: 24),
                  _MediaSection(product: product),
                  const SizedBox(height: 24),
                  _ClassificationsSection(product: product),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showEditDialog(
      BuildContext context, WidgetRef ref) async {
    final nameController = TextEditingController(text: product.name);
    final descController =
        TextEditingController(text: product.description ?? '');
    final formKey = GlobalKey<FormState>();
    String status = product.status;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) => AlertDialog(
          title: const Text('Edit Product'),
          content: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: nameController,
                  decoration: const InputDecoration(
                    labelText: 'Product Name',
                    border: OutlineInputBorder(),
                  ),
                  validator: (v) {
                    if (v == null || v.isEmpty) return 'Name is required';
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: descController,
                  decoration: const InputDecoration(
                    labelText: 'Description',
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 3,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: status,
                  decoration: const InputDecoration(
                    labelText: 'Status',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                        value: 'draft', child: Text('Draft')),
                    DropdownMenuItem(
                        value: 'active', child: Text('Active')),
                    DropdownMenuItem(
                        value: 'archived', child: Text('Archived')),
                  ],
                  onChanged: (v) =>
                      setState(() => status = v ?? product.status),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                if (formKey.currentState!.validate()) {
                  Navigator.of(ctx).pop(true);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.put('/api/admin/products/${product.id}', data: {
          'name': nameController.text,
          'description': descController.text,
          'status': status,
        });
        ref.invalidate(productDetailProvider(product.id));
        ref.invalidate(productListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Product updated')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to update product: $e')),
          );
        }
      }
    }
  }

  Future<void> _showDeleteDialog(
      BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Product'),
        content: Text(
          'Are you sure you want to delete "${product.name}"? '
          'This action cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.delete('/api/admin/products/${product.id}');
        ref.invalidate(productListProvider);
        if (context.mounted) {
          context.go('/products');
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Product deleted')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to delete product: $e')),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Variants Section
// ---------------------------------------------------------------------------

class _VariantsSection extends ConsumerWidget {
  final Product product;

  const _VariantsSection({required this.product});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _DetailCard(
      title: 'Variants',
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Add Variant'),
              onPressed: () => _showAddVariantDialog(context, ref),
            ),
          ],
        ),
        if (product.variants.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('No variants'),
          )
        else
          DataTable(
            columns: const [
              DataColumn(label: Text('SKU')),
              DataColumn(label: Text('Name')),
              DataColumn(label: Text('Price')),
              DataColumn(label: Text('Stock'), numeric: true),
              DataColumn(label: Text('Active')),
              DataColumn(label: Text('Actions')),
            ],
            rows: product.variants.map((v) {
              return DataRow(cells: [
                DataCell(Text(v.sku)),
                DataCell(Text(v.name)),
                DataCell(Text(v.formattedPrice)),
                DataCell(Text('${v.quantityOnHand}')),
                DataCell(Icon(
                  v.isActive ? Icons.check_circle : Icons.cancel,
                  color: v.isActive ? Colors.green : Colors.grey,
                  size: 18,
                )),
                DataCell(IconButton(
                  icon: const Icon(Icons.delete, size: 18),
                  onPressed: () =>
                      _deleteVariant(context, ref, v.id),
                )),
              ]);
            }).toList(),
          ),
      ],
    );
  }

  Future<void> _showAddVariantDialog(
      BuildContext context, WidgetRef ref) async {
    final skuController = TextEditingController();
    final nameController = TextEditingController();
    final priceController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add Variant'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: skuController,
                decoration: const InputDecoration(
                  labelText: 'SKU',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'SKU is required';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Variant Name',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Name is required';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: priceController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Price (cents)',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Price is required';
                  if (int.tryParse(v) == null) return 'Must be a number';
                  return null;
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/products/${product.id}/variants',
          data: {
            'sku': skuController.text,
            'name': nameController.text,
            'priceCents': int.parse(priceController.text),
          },
        );
        ref.invalidate(productDetailProvider(product.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Variant added')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to add variant: $e')),
          );
        }
      }
    }
  }

  Future<void> _deleteVariant(
      BuildContext context, WidgetRef ref, String variantId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Variant'),
        content:
            const Text('Are you sure you want to delete this variant?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.delete(
          '/api/admin/products/${product.id}/variants/$variantId',
        );
        ref.invalidate(productDetailProvider(product.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Variant deleted')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to delete variant: $e')),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Media Section
// ---------------------------------------------------------------------------

class _MediaSection extends ConsumerWidget {
  final Product product;

  const _MediaSection({required this.product});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _DetailCard(
      title: 'Media',
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton.icon(
              icon: const Icon(Icons.add_photo_alternate),
              label: const Text('Add Media'),
              onPressed: () => _showAddMediaDialog(context, ref),
            ),
          ],
        ),
        if (product.media.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('No media'),
          )
        else
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: product.media.map((m) {
              return Card(
                child: SizedBox(
                  width: 160,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        height: 100,
                        width: 160,
                        color: Colors.grey.shade200,
                        child: const Icon(Icons.image,
                            size: 40, color: Colors.grey),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(8),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                m.altText ?? 'Media ${m.sortOrder}',
                                style: const TextStyle(fontSize: 12),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete, size: 16),
                              onPressed: () =>
                                  _deleteMedia(context, ref, m.id),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }).toList(),
          ),
      ],
    );
  }

  Future<void> _showAddMediaDialog(
      BuildContext context, WidgetRef ref) async {
    final urlController = TextEditingController();
    final altTextController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add Media'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: urlController,
                decoration: const InputDecoration(
                  labelText: 'Media URL',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'URL is required';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: altTextController,
                decoration: const InputDecoration(
                  labelText: 'Alt Text (optional)',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/products/${product.id}/media',
          data: {
            'url': urlController.text,
            if (altTextController.text.isNotEmpty)
              'altText': altTextController.text,
          },
        );
        ref.invalidate(productDetailProvider(product.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Media added')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to add media: $e')),
          );
        }
      }
    }
  }

  Future<void> _deleteMedia(
      BuildContext context, WidgetRef ref, String mediaId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove Media'),
        content: const Text('Are you sure you want to remove this media?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (confirmed != true || !context.mounted) return;

    try {
      final dio = ref.read(dioProvider);
      await dio.delete(
        '/api/admin/products/${product.id}/media/$mediaId',
      );
      ref.invalidate(productDetailProvider(product.id));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Media removed')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to remove media: $e')),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Classifications Section
// ---------------------------------------------------------------------------

class _ClassificationsSection extends ConsumerWidget {
  final Product product;

  const _ClassificationsSection({required this.product});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _DetailCard(
      title: 'Classifications',
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton.icon(
              icon: const Icon(Icons.label),
              label: const Text('Add Classification'),
              onPressed: () =>
                  _showAddClassificationDialog(context, ref),
            ),
          ],
        ),
        if (product.classifications.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('No classifications'),
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: product.classifications.map((c) {
              return Chip(
                label: Text(
                  c.category != null ? '${c.category}: ${c.name}' : c.name,
                ),
                deleteIcon: const Icon(Icons.close, size: 16),
                onDeleted: () =>
                    _deleteClassification(context, ref, c.id),
              );
            }).toList(),
          ),
      ],
    );
  }

  Future<void> _showAddClassificationDialog(
      BuildContext context, WidgetRef ref) async {
    final nameController = TextEditingController();
    final categoryController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add Classification'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  border: OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) return 'Name is required';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: categoryController,
                decoration: const InputDecoration(
                  labelText: 'Category (optional)',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/products/${product.id}/classifications',
          data: {
            'name': nameController.text,
            if (categoryController.text.isNotEmpty)
              'category': categoryController.text,
          },
        );
        ref.invalidate(productDetailProvider(product.id));
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Classification added')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
                content:
                    Text('Failed to add classification: $e')),
          );
        }
      }
    }
  }

  Future<void> _deleteClassification(
      BuildContext context, WidgetRef ref, String classificationId) async {
    try {
      final dio = ref.read(dioProvider);
      await dio.delete(
        '/api/admin/products/${product.id}/classifications/$classificationId',
      );
      ref.invalidate(productDetailProvider(product.id));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Classification removed')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content:
                  Text('Failed to remove classification: $e')),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared detail widgets
// ---------------------------------------------------------------------------

class _DetailCard extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _DetailCard({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;

  const _DetailRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 160,
            child: Text(label,
                style: const TextStyle(fontWeight: FontWeight.w500)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
