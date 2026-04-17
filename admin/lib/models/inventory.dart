class InventoryVariant {
  final String variantId;
  final String sku;
  final String productName;
  final String variantName;
  final int quantityOnHand;
  final int quantityReserved;
  final int quantityAvailable;
  final int lowStockThreshold;
  final bool isLowStock;
  final DateTime updatedAt;

  const InventoryVariant({
    required this.variantId,
    required this.sku,
    required this.productName,
    required this.variantName,
    required this.quantityOnHand,
    required this.quantityReserved,
    required this.quantityAvailable,
    required this.lowStockThreshold,
    required this.isLowStock,
    required this.updatedAt,
  });

  factory InventoryVariant.fromJson(Map<String, dynamic> json) {
    final qoh = json['quantityOnHand'] as int? ?? 0;
    final qr = json['quantityReserved'] as int? ?? 0;
    final qa = json['quantityAvailable'] as int? ?? qoh - qr;
    final threshold = json['lowStockThreshold'] as int? ?? 5;
    return InventoryVariant(
      variantId: json['variantId'] as String,
      sku: json['sku'] as String? ?? '',
      productName: json['productName'] as String? ?? '',
      variantName: json['variantName'] as String? ?? '',
      quantityOnHand: qoh,
      quantityReserved: qr,
      quantityAvailable: qa,
      lowStockThreshold: threshold,
      isLowStock: json['isLowStock'] as bool? ?? qa <= threshold,
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class InventoryAdjustment {
  final String id;
  final String variantId;
  final String type;
  final int quantity;
  final String? reason;
  final String? createdBy;
  final DateTime createdAt;

  const InventoryAdjustment({
    required this.id,
    required this.variantId,
    required this.type,
    required this.quantity,
    this.reason,
    this.createdBy,
    required this.createdAt,
  });

  factory InventoryAdjustment.fromJson(Map<String, dynamic> json) {
    return InventoryAdjustment(
      id: json['id'] as String,
      variantId: json['variantId'] as String,
      type: json['type'] as String,
      quantity: json['quantity'] as int,
      reason: json['reason'] as String?,
      createdBy: json['createdBy'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}
