class Order {
  final String id;
  final String orderNumber;
  final String status;
  final int subtotalCents;
  final int shippingCents;
  final int taxCents;
  final int totalCents;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<OrderLineItem> lineItems;
  final List<OrderTimeline> timeline;
  final List<Shipment> shipments;

  const Order({
    required this.id,
    required this.orderNumber,
    required this.status,
    required this.subtotalCents,
    required this.shippingCents,
    required this.taxCents,
    required this.totalCents,
    required this.createdAt,
    required this.updatedAt,
    this.lineItems = const [],
    this.timeline = const [],
    this.shipments = const [],
  });

  factory Order.fromJson(Map<String, dynamic> json) {
    return Order(
      id: json['id'] as String,
      orderNumber: json['orderNumber'] as String,
      status: json['status'] as String,
      subtotalCents: json['subtotalCents'] as int? ?? 0,
      shippingCents: json['shippingCents'] as int? ?? 0,
      taxCents: json['taxCents'] as int? ?? 0,
      totalCents: json['totalCents'] as int? ?? 0,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      lineItems: (json['lineItems'] as List<dynamic>?)
              ?.map(
                  (e) => OrderLineItem.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      timeline: (json['timeline'] as List<dynamic>?)
              ?.map(
                  (e) => OrderTimeline.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      shipments: (json['shipments'] as List<dynamic>?)
              ?.map((e) => Shipment.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  String get formattedTotal {
    final dollars = totalCents ~/ 100;
    final cents = (totalCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  String get statusLabel {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'confirmed':
        return 'Confirmed';
      case 'processing':
        return 'Processing';
      case 'shipped':
        return 'Shipped';
      case 'delivered':
        return 'Delivered';
      case 'cancelled':
        return 'Cancelled';
      case 'refunded':
        return 'Refunded';
      default:
        return status;
    }
  }
}

class OrderLineItem {
  final String id;
  final String productTitle;
  final String variantTitle;
  final String material;
  final int quantity;
  final int unitPriceCents;
  final int totalCents;

  const OrderLineItem({
    required this.id,
    required this.productTitle,
    required this.variantTitle,
    required this.material,
    required this.quantity,
    required this.unitPriceCents,
    required this.totalCents,
  });

  factory OrderLineItem.fromJson(Map<String, dynamic> json) {
    return OrderLineItem(
      id: json['id'] as String,
      productTitle: json['productTitle'] as String? ?? '',
      variantTitle: json['variantTitle'] as String? ?? '',
      material: json['material'] as String? ?? '',
      quantity: json['quantity'] as int? ?? 1,
      unitPriceCents: json['unitPriceCents'] as int? ?? 0,
      totalCents: json['totalCents'] as int? ?? 0,
    );
  }

  String get formattedUnitPrice {
    final dollars = unitPriceCents ~/ 100;
    final cents = (unitPriceCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  String get formattedTotal {
    final dollars = totalCents ~/ 100;
    final cents = (totalCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }
}

class OrderTimeline {
  final String status;
  final String label;
  final String? description;
  final DateTime timestamp;

  const OrderTimeline({
    required this.status,
    required this.label,
    this.description,
    required this.timestamp,
  });

  factory OrderTimeline.fromJson(Map<String, dynamic> json) {
    return OrderTimeline(
      status: json['status'] as String,
      label: json['label'] as String? ?? json['status'] as String,
      description: json['description'] as String?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }
}

class Shipment {
  final String id;
  final String trackingNumber;
  final String carrier;
  final String status;
  final String? trackingUrl;
  final DateTime createdAt;
  final List<TrackingEvent> trackingEvents;

  const Shipment({
    required this.id,
    required this.trackingNumber,
    required this.carrier,
    required this.status,
    this.trackingUrl,
    required this.createdAt,
    this.trackingEvents = const [],
  });

  factory Shipment.fromJson(Map<String, dynamic> json) {
    return Shipment(
      id: json['id'] as String,
      trackingNumber: json['trackingNumber'] as String? ?? '',
      carrier: json['carrier'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      trackingUrl: json['trackingUrl'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      trackingEvents: (json['trackingEvents'] as List<dynamic>?)
              ?.map(
                  (e) => TrackingEvent.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }

  String get statusLabel {
    switch (status) {
      case 'pre_transit':
        return 'Pre-Transit';
      case 'in_transit':
        return 'In Transit';
      case 'out_for_delivery':
        return 'Out for Delivery';
      case 'delivered':
        return 'Delivered';
      case 'return_to_sender':
        return 'Return to Sender';
      case 'failure':
        return 'Delivery Failed';
      default:
        return status;
    }
  }
}

class TrackingEvent {
  final String status;
  final String message;
  final String? location;
  final DateTime timestamp;

  const TrackingEvent({
    required this.status,
    required this.message,
    this.location,
    required this.timestamp,
  });

  factory TrackingEvent.fromJson(Map<String, dynamic> json) {
    return TrackingEvent(
      status: json['status'] as String? ?? '',
      message: json['message'] as String? ?? '',
      location: json['location'] as String?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }
}
