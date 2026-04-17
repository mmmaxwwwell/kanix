class Product {
  final String id;
  final String name;
  final String? description;
  final String status;
  final List<Variant> variants;
  final List<ProductMedia> media;
  final List<Classification> classifications;
  final DateTime createdAt;
  final DateTime updatedAt;

  const Product({
    required this.id,
    required this.name,
    this.description,
    required this.status,
    this.variants = const [],
    this.media = const [],
    this.classifications = const [],
    required this.createdAt,
    required this.updatedAt,
  });

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String?,
      status: json['status'] as String? ?? 'draft',
      variants: (json['variants'] as List<dynamic>?)
              ?.map((e) => Variant.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      media: (json['media'] as List<dynamic>?)
              ?.map((e) => ProductMedia.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      classifications: (json['classifications'] as List<dynamic>?)
              ?.map(
                  (e) => Classification.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        if (description != null) 'description': description,
        'status': status,
      };
}

class Variant {
  final String id;
  final String productId;
  final String sku;
  final String name;
  final int priceCents;
  final int quantityOnHand;
  final bool isActive;
  final DateTime createdAt;

  const Variant({
    required this.id,
    required this.productId,
    required this.sku,
    required this.name,
    required this.priceCents,
    required this.quantityOnHand,
    required this.isActive,
    required this.createdAt,
  });

  factory Variant.fromJson(Map<String, dynamic> json) {
    return Variant(
      id: json['id'] as String,
      productId: json['productId'] as String? ?? '',
      sku: json['sku'] as String? ?? '',
      name: json['name'] as String,
      priceCents: json['priceCents'] as int? ?? 0,
      quantityOnHand: json['quantityOnHand'] as int? ?? 0,
      isActive: json['isActive'] as bool? ?? true,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  String get formattedPrice {
    final dollars = priceCents ~/ 100;
    final cents = (priceCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }
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

class Classification {
  final String id;
  final String name;
  final String? category;

  const Classification({
    required this.id,
    required this.name,
    this.category,
  });

  factory Classification.fromJson(Map<String, dynamic> json) {
    return Classification(
      id: json['id'] as String,
      name: json['name'] as String,
      category: json['category'] as String?,
    );
  }
}
