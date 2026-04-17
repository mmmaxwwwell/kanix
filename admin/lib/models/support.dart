class SupportTicket {
  final String id;
  final String ticketNumber;
  final String? orderId;
  final String? customerId;
  final String customerEmail;
  final String subject;
  final String status;
  final String priority;
  final String? assignedAdminId;
  final DateTime createdAt;
  final DateTime updatedAt;

  const SupportTicket({
    required this.id,
    required this.ticketNumber,
    this.orderId,
    this.customerId,
    required this.customerEmail,
    required this.subject,
    required this.status,
    required this.priority,
    this.assignedAdminId,
    required this.createdAt,
    required this.updatedAt,
  });

  factory SupportTicket.fromJson(Map<String, dynamic> json) {
    return SupportTicket(
      id: json['id'] as String,
      ticketNumber: json['ticketNumber'] as String,
      orderId: json['orderId'] as String?,
      customerId: json['customerId'] as String?,
      customerEmail: json['customerEmail'] as String,
      subject: json['subject'] as String,
      status: json['status'] as String,
      priority: json['priority'] as String? ?? 'normal',
      assignedAdminId: json['assignedAdminId'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class TicketMessage {
  final String id;
  final String ticketId;
  final String senderType;
  final String? senderAdminId;
  final String? senderCustomerId;
  final String body;
  final bool isInternal;
  final DateTime createdAt;

  const TicketMessage({
    required this.id,
    required this.ticketId,
    required this.senderType,
    this.senderAdminId,
    this.senderCustomerId,
    required this.body,
    required this.isInternal,
    required this.createdAt,
  });

  factory TicketMessage.fromJson(Map<String, dynamic> json) {
    return TicketMessage(
      id: json['id'] as String,
      ticketId: json['ticketId'] as String,
      senderType: json['senderType'] as String,
      senderAdminId: json['senderAdminId'] as String?,
      senderCustomerId: json['senderCustomerId'] as String?,
      body: json['body'] as String,
      isInternal: json['isInternal'] as bool? ?? false,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}
