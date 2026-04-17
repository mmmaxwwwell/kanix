class Order {
  final String id;
  final String orderNumber;
  final String? customerId;
  final String email;
  final String status;
  final String paymentStatus;
  final String fulfillmentStatus;
  final String shippingStatus;
  final String currency;
  final int subtotalMinor;
  final int taxMinor;
  final int shippingMinor;
  final int discountMinor;
  final int totalMinor;
  final Map<String, dynamic>? billingAddressSnapshot;
  final Map<String, dynamic>? shippingAddressSnapshot;
  final DateTime? placedAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<OrderLine>? lines;

  const Order({
    required this.id,
    required this.orderNumber,
    this.customerId,
    required this.email,
    required this.status,
    required this.paymentStatus,
    required this.fulfillmentStatus,
    required this.shippingStatus,
    required this.currency,
    required this.subtotalMinor,
    required this.taxMinor,
    required this.shippingMinor,
    required this.discountMinor,
    required this.totalMinor,
    this.billingAddressSnapshot,
    this.shippingAddressSnapshot,
    this.placedAt,
    required this.createdAt,
    required this.updatedAt,
    this.lines,
  });

  factory Order.fromJson(Map<String, dynamic> json) {
    return Order(
      id: json['id'] as String,
      orderNumber: json['orderNumber'] as String,
      customerId: json['customerId'] as String?,
      email: json['email'] as String,
      status: json['status'] as String,
      paymentStatus: json['paymentStatus'] as String,
      fulfillmentStatus: json['fulfillmentStatus'] as String,
      shippingStatus: json['shippingStatus'] as String,
      currency: json['currency'] as String? ?? 'USD',
      subtotalMinor: json['subtotalMinor'] as int? ?? 0,
      taxMinor: json['taxMinor'] as int? ?? 0,
      shippingMinor: json['shippingMinor'] as int? ?? 0,
      discountMinor: json['discountMinor'] as int? ?? 0,
      totalMinor: json['totalMinor'] as int? ?? 0,
      billingAddressSnapshot:
          json['billingAddressSnapshotJson'] as Map<String, dynamic>?,
      shippingAddressSnapshot:
          json['shippingAddressSnapshotJson'] as Map<String, dynamic>?,
      placedAt: json['placedAt'] != null
          ? DateTime.parse(json['placedAt'] as String)
          : null,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      lines: json['lines'] != null
          ? (json['lines'] as List<dynamic>)
              .map((e) => OrderLine.fromJson(e as Map<String, dynamic>))
              .toList()
          : null,
    );
  }

  String get formattedTotal =>
      '\$${(totalMinor / 100).toStringAsFixed(2)}';
}

class OrderLine {
  final String id;
  final String orderId;
  final String variantId;
  final String skuSnapshot;
  final String titleSnapshot;
  final Map<String, dynamic> optionValuesSnapshot;
  final int quantity;
  final int unitPriceMinor;
  final int totalMinor;

  const OrderLine({
    required this.id,
    required this.orderId,
    required this.variantId,
    required this.skuSnapshot,
    required this.titleSnapshot,
    required this.optionValuesSnapshot,
    required this.quantity,
    required this.unitPriceMinor,
    required this.totalMinor,
  });

  factory OrderLine.fromJson(Map<String, dynamic> json) {
    return OrderLine(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      variantId: json['variantId'] as String,
      skuSnapshot: json['skuSnapshot'] as String,
      titleSnapshot: json['titleSnapshot'] as String,
      optionValuesSnapshot:
          json['optionValuesSnapshotJson'] as Map<String, dynamic>? ?? {},
      quantity: json['quantity'] as int,
      unitPriceMinor: json['unitPriceMinor'] as int,
      totalMinor: json['totalMinor'] as int,
    );
  }

  String get formattedUnitPrice =>
      '\$${(unitPriceMinor / 100).toStringAsFixed(2)}';

  String get formattedTotal =>
      '\$${(totalMinor / 100).toStringAsFixed(2)}';
}

class OrderStatusHistoryEntry {
  final String id;
  final String orderId;
  final String statusType;
  final String oldValue;
  final String newValue;
  final String? reason;
  final String? actorAdminUserId;
  final DateTime createdAt;

  const OrderStatusHistoryEntry({
    required this.id,
    required this.orderId,
    required this.statusType,
    required this.oldValue,
    required this.newValue,
    this.reason,
    this.actorAdminUserId,
    required this.createdAt,
  });

  factory OrderStatusHistoryEntry.fromJson(Map<String, dynamic> json) {
    return OrderStatusHistoryEntry(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      statusType: json['statusType'] as String,
      oldValue: json['oldValue'] as String,
      newValue: json['newValue'] as String,
      reason: json['reason'] as String?,
      actorAdminUserId: json['actorAdminUserId'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

class Refund {
  final String id;
  final String orderId;
  final int amountMinor;
  final String reason;
  final String status;
  final DateTime createdAt;

  const Refund({
    required this.id,
    required this.orderId,
    required this.amountMinor,
    required this.reason,
    required this.status,
    required this.createdAt,
  });

  factory Refund.fromJson(Map<String, dynamic> json) {
    return Refund(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      amountMinor: json['amountMinor'] as int,
      reason: json['reason'] as String,
      status: json['status'] as String? ?? 'succeeded',
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  String get formattedAmount =>
      '\$${(amountMinor / 100).toStringAsFixed(2)}';
}
