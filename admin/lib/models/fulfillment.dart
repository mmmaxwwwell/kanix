class FulfillmentTask {
  final String id;
  final String orderId;
  final String orderNumber;
  final String status;
  final String priority;
  final String? assignedTo;
  final String? assignedToName;
  final String? blockedReason;
  final DateTime createdAt;
  final DateTime updatedAt;

  const FulfillmentTask({
    required this.id,
    required this.orderId,
    required this.orderNumber,
    required this.status,
    required this.priority,
    this.assignedTo,
    this.assignedToName,
    this.blockedReason,
    required this.createdAt,
    required this.updatedAt,
  });

  factory FulfillmentTask.fromJson(Map<String, dynamic> json) {
    return FulfillmentTask(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      orderNumber: json['orderNumber'] as String? ?? '',
      status: json['status'] as String,
      priority: json['priority'] as String? ?? 'standard',
      assignedTo: json['assignedTo'] as String?,
      assignedToName: json['assignedToName'] as String?,
      blockedReason: json['blockedReason'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  bool get canProgress {
    const progressable = [
      'new',
      'assigned',
      'picking',
      'picked',
      'packing',
      'packed',
      'shipment_pending',
    ];
    return progressable.contains(status);
  }

  String? get nextStatus {
    switch (status) {
      case 'new':
        return 'assigned';
      case 'assigned':
        return 'picking';
      case 'picking':
        return 'picked';
      case 'picked':
        return 'packing';
      case 'packing':
        return 'packed';
      case 'packed':
        return 'shipment_pending';
      case 'shipment_pending':
        return 'done';
      default:
        return null;
    }
  }

  String get nextStatusLabel {
    switch (nextStatus) {
      case 'assigned':
        return 'Assign';
      case 'picking':
        return 'Start Picking';
      case 'picked':
        return 'Mark Picked';
      case 'packing':
        return 'Start Packing';
      case 'packed':
        return 'Mark Packed';
      case 'shipment_pending':
        return 'Ready for Shipment';
      case 'done':
        return 'Mark Done';
      default:
        return 'Progress';
    }
  }
}
