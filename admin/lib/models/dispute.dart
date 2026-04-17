class Dispute {
  final String id;
  final String orderId;
  final String? orderNumber;
  final String stripeDisputeId;
  final String reason;
  final String status;
  final int amountMinor;
  final String currency;
  final DateTime? evidenceDueBy;
  final bool evidenceSubmitted;
  final DateTime createdAt;
  final DateTime updatedAt;

  const Dispute({
    required this.id,
    required this.orderId,
    this.orderNumber,
    required this.stripeDisputeId,
    required this.reason,
    required this.status,
    required this.amountMinor,
    required this.currency,
    this.evidenceDueBy,
    required this.evidenceSubmitted,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Dispute.fromJson(Map<String, dynamic> json) {
    return Dispute(
      id: json['id'] as String,
      orderId: json['orderId'] as String,
      orderNumber: json['orderNumber'] as String?,
      stripeDisputeId: json['stripeDisputeId'] as String,
      reason: json['reason'] as String,
      status: json['status'] as String,
      amountMinor: json['amountMinor'] as int? ?? 0,
      currency: json['currency'] as String? ?? 'USD',
      evidenceDueBy: json['evidenceDueBy'] != null
          ? DateTime.parse(json['evidenceDueBy'] as String)
          : null,
      evidenceSubmitted: json['evidenceSubmitted'] as bool? ?? false,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  String get formattedAmount =>
      '\$${(amountMinor / 100).toStringAsFixed(2)}';

  bool get isEvidenceDueSoon {
    if (evidenceDueBy == null || evidenceSubmitted) return false;
    return evidenceDueBy!.difference(DateTime.now()).inDays <= 3;
  }
}

class DisputeEvidence {
  final String id;
  final String disputeId;
  final String category;
  final String? fileName;
  final String? content;
  final String status;
  final DateTime createdAt;

  const DisputeEvidence({
    required this.id,
    required this.disputeId,
    required this.category,
    this.fileName,
    this.content,
    required this.status,
    required this.createdAt,
  });

  factory DisputeEvidence.fromJson(Map<String, dynamic> json) {
    return DisputeEvidence(
      id: json['id'] as String,
      disputeId: json['disputeId'] as String,
      category: json['category'] as String,
      fileName: json['fileName'] as String?,
      content: json['content'] as String?,
      status: json['status'] as String? ?? 'pending',
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}
