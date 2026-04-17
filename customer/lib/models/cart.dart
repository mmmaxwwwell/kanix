class CartItem {
  final String variantId;
  final String productId;
  final String productTitle;
  final String variantTitle;
  final String material;
  final int priceCents;
  final int quantity;
  final String? imageUrl;

  const CartItem({
    required this.variantId,
    required this.productId,
    required this.productTitle,
    required this.variantTitle,
    required this.material,
    required this.priceCents,
    required this.quantity,
    this.imageUrl,
  });

  CartItem copyWith({int? quantity}) {
    return CartItem(
      variantId: variantId,
      productId: productId,
      productTitle: productTitle,
      variantTitle: variantTitle,
      material: material,
      priceCents: priceCents,
      quantity: quantity ?? this.quantity,
      imageUrl: imageUrl,
    );
  }

  int get totalCents => priceCents * quantity;

  String get formattedPrice {
    final dollars = totalCents ~/ 100;
    final cents = (totalCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  String get formattedUnitPrice {
    final dollars = priceCents ~/ 100;
    final cents = (priceCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  factory CartItem.fromJson(Map<String, dynamic> json) {
    return CartItem(
      variantId: json['variantId'] as String,
      productId: json['productId'] as String,
      productTitle: json['productTitle'] as String,
      variantTitle: json['variantTitle'] as String,
      material: json['material'] as String,
      priceCents: json['priceCents'] as int,
      quantity: json['quantity'] as int,
      imageUrl: json['imageUrl'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'variantId': variantId,
        'productId': productId,
        'productTitle': productTitle,
        'variantTitle': variantTitle,
        'material': material,
        'priceCents': priceCents,
        'quantity': quantity,
        'imageUrl': imageUrl,
      };
}

class Address {
  final String? id;
  final String name;
  final String street1;
  final String? street2;
  final String city;
  final String state;
  final String zip;
  final String country;

  const Address({
    this.id,
    required this.name,
    required this.street1,
    this.street2,
    required this.city,
    required this.state,
    required this.zip,
    this.country = 'US',
  });

  factory Address.fromJson(Map<String, dynamic> json) {
    return Address(
      id: json['id'] as String?,
      name: json['name'] as String,
      street1: json['street1'] as String,
      street2: json['street2'] as String?,
      city: json['city'] as String,
      state: json['state'] as String,
      zip: json['zip'] as String,
      country: json['country'] as String? ?? 'US',
    );
  }

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'name': name,
        'street1': street1,
        if (street2 != null) 'street2': street2,
        'city': city,
        'state': state,
        'zip': zip,
        'country': country,
      };

  String get formatted => '$street1${street2 != null ? ', $street2' : ''}, '
      '$city, $state $zip';
}

class ShippingRate {
  final String id;
  final String carrier;
  final String service;
  final int rateCents;
  final int? estDeliveryDays;

  const ShippingRate({
    required this.id,
    required this.carrier,
    required this.service,
    required this.rateCents,
    this.estDeliveryDays,
  });

  factory ShippingRate.fromJson(Map<String, dynamic> json) {
    return ShippingRate(
      id: json['id'] as String,
      carrier: json['carrier'] as String,
      service: json['service'] as String,
      rateCents: json['rateCents'] as int,
      estDeliveryDays: json['estDeliveryDays'] as int?,
    );
  }

  String get formattedRate {
    final dollars = rateCents ~/ 100;
    final cents = (rateCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }
}

class OrderConfirmation {
  final String orderId;
  final String orderNumber;
  final int subtotalCents;
  final int shippingCents;
  final int taxCents;
  final int totalCents;

  const OrderConfirmation({
    required this.orderId,
    required this.orderNumber,
    required this.subtotalCents,
    required this.shippingCents,
    required this.taxCents,
    required this.totalCents,
  });

  factory OrderConfirmation.fromJson(Map<String, dynamic> json) {
    return OrderConfirmation(
      orderId: json['orderId'] as String,
      orderNumber: json['orderNumber'] as String,
      subtotalCents: json['subtotalCents'] as int,
      shippingCents: json['shippingCents'] as int,
      taxCents: json['taxCents'] as int,
      totalCents: json['totalCents'] as int,
    );
  }

  String get formattedTotal {
    final dollars = totalCents ~/ 100;
    final cents = (totalCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }
}
