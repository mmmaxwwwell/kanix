class Product {
  final String id;
  final String slug;
  final String title;
  final String? subtitle;
  final String? description;
  final String status;
  final List<ProductVariant> variants;
  final List<ProductMedia> media;
  final DateTime createdAt;
  final DateTime updatedAt;

  const Product({
    required this.id,
    required this.slug,
    required this.title,
    this.subtitle,
    this.description,
    required this.status,
    this.variants = const [],
    this.media = const [],
    required this.createdAt,
    required this.updatedAt,
  });

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] as String,
      slug: json['slug'] as String? ?? '',
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      description: json['description'] as String?,
      status: json['status'] as String? ?? 'draft',
      variants: (json['variants'] as List<dynamic>?)
              ?.map(
                  (e) => ProductVariant.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      media: (json['media'] as List<dynamic>?)
              ?.map((e) => ProductMedia.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  /// Returns the lowest price variant in cents, or null if no variants.
  int? get startingPriceCents {
    if (variants.isEmpty) return null;
    return variants
        .where((v) => v.status == 'active')
        .fold<int?>(null, (min, v) {
      if (min == null || v.priceCents < min) return v.priceCents;
      return min;
    });
  }

  /// Whether any active variant is in stock.
  bool get isAvailable =>
      variants.any((v) => v.status == 'active' && v.quantityOnHand > 0);

  /// Primary image URL from media list.
  String? get primaryImageUrl {
    if (media.isEmpty) return null;
    final sorted = List<ProductMedia>.from(media)
      ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder));
    return sorted.first.url;
  }
}

class ProductVariant {
  final String id;
  final String productId;
  final String sku;
  final String title;
  final String material;
  final int priceCents;
  final int quantityOnHand;
  final String status;
  final DateTime createdAt;

  const ProductVariant({
    required this.id,
    required this.productId,
    required this.sku,
    required this.title,
    required this.material,
    required this.priceCents,
    required this.quantityOnHand,
    required this.status,
    required this.createdAt,
  });

  factory ProductVariant.fromJson(Map<String, dynamic> json) {
    final optionValues = json['optionValues'] as Map<String, dynamic>? ?? {};
    return ProductVariant(
      id: json['id'] as String,
      productId: json['productId'] as String? ?? '',
      sku: json['sku'] as String? ?? '',
      title: json['title'] as String,
      material: optionValues['material'] as String? ?? 'Unknown',
      priceCents: json['priceCents'] as int? ?? 0,
      quantityOnHand: json['quantityOnHand'] as int? ?? 0,
      status: json['status'] as String? ?? 'draft',
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  String get formattedPrice {
    final dollars = priceCents ~/ 100;
    final cents = (priceCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  bool get isInStock => quantityOnHand > 0 && status == 'active';
}

class ProductMedia {
  final String id;
  final String url;
  final String? altText;
  final int sortOrder;

  const ProductMedia({
    required this.id,
    required this.url,
    this.altText,
    required this.sortOrder,
  });

  factory ProductMedia.fromJson(Map<String, dynamic> json) {
    return ProductMedia(
      id: json['id'] as String,
      url: json['url'] as String,
      altText: json['altText'] as String?,
      sortOrder: json['sortOrder'] as int? ?? 0,
    );
  }
}

/// Material-specific warranty information.
class MaterialWarrantyInfo {
  final String material;
  final String warrantyPeriod;
  final String? limitation;

  const MaterialWarrantyInfo({
    required this.material,
    required this.warrantyPeriod,
    this.limitation,
  });

  static MaterialWarrantyInfo forMaterial(String material) {
    switch (material.toUpperCase()) {
      case 'TPU':
        return const MaterialWarrantyInfo(
          material: 'TPU',
          warrantyPeriod: '1 year',
          limitation:
              'Heat deformation is excluded from warranty coverage. '
              'TPU parts should not be exposed to temperatures above 80°C.',
        );
      case 'PA11':
        return const MaterialWarrantyInfo(
          material: 'PA11',
          warrantyPeriod: '1 year',
        );
      case 'TPC':
        return const MaterialWarrantyInfo(
          material: 'TPC',
          warrantyPeriod: '1 year',
          limitation:
              'Heat resistance rated up to 120°C. '
              'Damage from exposure above rated temperature is excluded.',
        );
      default:
        return MaterialWarrantyInfo(
          material: material,
          warrantyPeriod: '1 year',
        );
    }
  }
}
