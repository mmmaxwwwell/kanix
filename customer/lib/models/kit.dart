class KitDefinition {
  final String id;
  final String slug;
  final String title;
  final String? description;
  final int priceMinor;
  final String currency;
  final List<KitClassRequirement> requirements;

  const KitDefinition({
    required this.id,
    required this.slug,
    required this.title,
    this.description,
    required this.priceMinor,
    required this.currency,
    this.requirements = const [],
  });

  factory KitDefinition.fromJson(Map<String, dynamic> json) {
    return KitDefinition(
      id: json['id'] as String,
      slug: json['slug'] as String,
      title: json['title'] as String,
      description: json['description'] as String?,
      priceMinor: json['priceMinor'] as int,
      currency: json['currency'] as String? ?? 'USD',
      requirements: (json['requirements'] as List<dynamic>?)
              ?.map((e) =>
                  KitClassRequirement.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  String get formattedPrice {
    final dollars = priceMinor ~/ 100;
    final cents = (priceMinor % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  /// Sum of cheapest variant prices across all requirements.
  int get individualTotalMinor {
    var total = 0;
    for (final req in requirements) {
      // For each class, pick the N cheapest available variants
      final sortedProducts = <int>[];
      for (final product in req.products) {
        for (final variant in product.variants) {
          sortedProducts.add(variant.priceCents);
        }
      }
      sortedProducts.sort();
      for (var i = 0; i < req.quantity && i < sortedProducts.length; i++) {
        total += sortedProducts[i];
      }
    }
    return total;
  }

  int get savingsMinor {
    final individual = individualTotalMinor;
    if (individual <= priceMinor) return 0;
    return individual - priceMinor;
  }
}

class KitClassRequirement {
  final String productClassId;
  final String productClassName;
  final int quantity;
  final List<KitProduct> products;

  const KitClassRequirement({
    required this.productClassId,
    required this.productClassName,
    required this.quantity,
    this.products = const [],
  });

  factory KitClassRequirement.fromJson(Map<String, dynamic> json) {
    return KitClassRequirement(
      productClassId: json['productClassId'] as String,
      productClassName: json['productClassName'] as String,
      quantity: json['quantity'] as int,
      products: (json['products'] as List<dynamic>?)
              ?.map((e) => KitProduct.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}

class KitProduct {
  final String id;
  final String slug;
  final String title;
  final String? subtitle;
  final String? imageUrl;
  final List<KitProductVariant> variants;

  const KitProduct({
    required this.id,
    required this.slug,
    required this.title,
    this.subtitle,
    this.imageUrl,
    this.variants = const [],
  });

  factory KitProduct.fromJson(Map<String, dynamic> json) {
    return KitProduct(
      id: json['id'] as String,
      slug: json['slug'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      imageUrl: json['imageUrl'] as String?,
      variants: (json['variants'] as List<dynamic>?)
              ?.map(
                  (e) => KitProductVariant.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  bool get isAvailable => variants.any((v) => v.inStock);
}

class KitProductVariant {
  final String id;
  final String title;
  final String material;
  final int priceCents;
  final bool inStock;
  final int quantityOnHand;

  const KitProductVariant({
    required this.id,
    required this.title,
    required this.material,
    required this.priceCents,
    required this.inStock,
    required this.quantityOnHand,
  });

  factory KitProductVariant.fromJson(Map<String, dynamic> json) {
    return KitProductVariant(
      id: json['id'] as String,
      title: json['title'] as String,
      material: json['material'] as String? ?? 'Unknown',
      priceCents: json['priceCents'] as int? ?? 0,
      inStock: json['inStock'] as bool? ?? false,
      quantityOnHand: json['quantityOnHand'] as int? ?? 0,
    );
  }

  String get formattedPrice {
    final dollars = priceCents ~/ 100;
    final cents = (priceCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }
}
