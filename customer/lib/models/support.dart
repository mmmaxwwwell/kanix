class SupportTicket {
  final String id;
  final String ticketNumber;
  final String? orderId;
  final String subject;
  final String status;
  final String priority;
  final DateTime createdAt;
  final DateTime updatedAt;

  const SupportTicket({
    required this.id,
    required this.ticketNumber,
    this.orderId,
    required this.subject,
    required this.status,
    required this.priority,
    required this.createdAt,
    required this.updatedAt,
  });

  factory SupportTicket.fromJson(Map<String, dynamic> json) {
    return SupportTicket(
      id: json['id'] as String,
      ticketNumber: json['ticketNumber'] as String,
      orderId: json['orderId'] as String?,
      subject: json['subject'] as String,
      status: json['status'] as String,
      priority: json['priority'] as String? ?? 'normal',
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  String get statusLabel {
    switch (status) {
      case 'open':
        return 'Open';
      case 'awaiting_customer':
        return 'Awaiting Response';
      case 'awaiting_admin':
        return 'In Review';
      case 'resolved':
        return 'Resolved';
      case 'closed':
        return 'Closed';
      default:
        return status;
    }
  }
}

class TicketMessage {
  final String id;
  final String ticketId;
  final String senderType;
  final String body;
  final List<MessageAttachment> attachments;
  final DateTime createdAt;

  const TicketMessage({
    required this.id,
    required this.ticketId,
    required this.senderType,
    required this.body,
    this.attachments = const [],
    required this.createdAt,
  });

  factory TicketMessage.fromJson(Map<String, dynamic> json) {
    return TicketMessage(
      id: json['id'] as String,
      ticketId: json['ticketId'] as String,
      senderType: json['senderType'] as String,
      body: json['body'] as String,
      attachments: (json['attachments'] as List<dynamic>?)
              ?.map((e) =>
                  MessageAttachment.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

class MessageAttachment {
  final String id;
  final String filename;
  final String url;
  final String contentType;

  const MessageAttachment({
    required this.id,
    required this.filename,
    required this.url,
    required this.contentType,
  });

  factory MessageAttachment.fromJson(Map<String, dynamic> json) {
    return MessageAttachment(
      id: json['id'] as String,
      filename: json['filename'] as String,
      url: json['url'] as String,
      contentType: json['contentType'] as String? ?? 'application/octet-stream',
    );
  }
}

class WarrantyClaim {
  final String id;
  final String claimNumber;
  final String orderId;
  final String orderNumber;
  final String productTitle;
  final String material;
  final String status;
  final String defectDescription;
  final List<String> photoUrls;
  final String? warrantyPeriod;
  final DateTime orderDate;
  final DateTime? warrantyExpiresAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  const WarrantyClaim({
    required this.id,
    required this.claimNumber,
    required this.orderId,
    required this.orderNumber,
    required this.productTitle,
    required this.material,
    required this.status,
    required this.defectDescription,
    this.photoUrls = const [],
    this.warrantyPeriod,
    required this.orderDate,
    this.warrantyExpiresAt,
    required this.createdAt,
    required this.updatedAt,
  });

  factory WarrantyClaim.fromJson(Map<String, dynamic> json) {
    return WarrantyClaim(
      id: json['id'] as String,
      claimNumber: json['claimNumber'] as String,
      orderId: json['orderId'] as String,
      orderNumber: json['orderNumber'] as String? ?? '',
      productTitle: json['productTitle'] as String? ?? '',
      material: json['material'] as String? ?? '',
      status: json['status'] as String,
      defectDescription: json['defectDescription'] as String? ?? '',
      photoUrls: (json['photoUrls'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [],
      warrantyPeriod: json['warrantyPeriod'] as String?,
      orderDate: DateTime.parse(json['orderDate'] as String),
      warrantyExpiresAt: json['warrantyExpiresAt'] != null
          ? DateTime.parse(json['warrantyExpiresAt'] as String)
          : null,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  String get statusLabel {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'under_review':
        return 'Under Review';
      case 'approved':
        return 'Approved';
      case 'denied':
        return 'Denied';
      case 'fulfilled':
        return 'Fulfilled';
      default:
        return status;
    }
  }

  bool get isWithinWarranty {
    if (warrantyExpiresAt == null) return false;
    return DateTime.now().isBefore(warrantyExpiresAt!);
  }
}
