class Shipment {
  final String id;
  final String orderId;
  final String orderNumber;
  final String status;
  final String? carrier;
  final String? service;
  final String? trackingNumber;
  final String? trackingUrl;
  final String? labelUrl;
  final int? rateCentsMinor;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<ShipmentEvent>? events;

  const Shipment({
    required this.id,
    required this.orderId,
    required this.orderNumber,
    required this.status,
    this.carrier,
    this.service,
    this.trackingNumber,
    this.trackingUrl,
    this.labelUrl,
    this.rateCentsMinor,
    this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
    this.events,
  });

  factory Shipment.fromJson(Map<String, dynamic> json) {
    return Shipment(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      orderNumber: json['orderNumber'] as String? ?? '',
      status: json['status'] as String,
      carrier: json['carrier'] as String?,
      service: json['service'] as String?,
      trackingNumber: json['trackingNumber'] as String?,
      trackingUrl: json['trackingUrl'] as String?,
      labelUrl: json['labelUrl'] as String?,
      rateCentsMinor: json['rateCentsMinor'] as int?,
      errorMessage: json['errorMessage'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      events: json['events'] != null
          ? (json['events'] as List<dynamic>)
              .map((e) => ShipmentEvent.fromJson(e as Map<String, dynamic>))
              .toList()
          : null,
    );
  }

  String get formattedRate => rateCentsMinor != null
      ? '\$${(rateCentsMinor! / 100).toStringAsFixed(2)}'
      : '-';
}

class ShipmentEvent {
  final String id;
  final String shipmentId;
  final String status;
  final String? description;
  final String? location;
  final DateTime occurredAt;
  final DateTime createdAt;

  const ShipmentEvent({
    required this.id,
    required this.shipmentId,
    required this.status,
    this.description,
    this.location,
    required this.occurredAt,
    required this.createdAt,
  });

  factory ShipmentEvent.fromJson(Map<String, dynamic> json) {
    return ShipmentEvent(
      id: json['id'] as String,
      shipmentId: json['shipmentId'] as String,
      status: json['status'] as String,
      description: json['description'] as String?,
      location: json['location'] as String?,
      occurredAt: DateTime.parse(json['occurredAt'] as String),
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}
