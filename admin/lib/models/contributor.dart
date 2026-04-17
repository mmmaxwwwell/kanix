class Contributor {
  final String id;
  final String githubUsername;
  final String? displayName;
  final String? email;
  final String royaltyStatus;
  final double royaltyRate;
  final double totalEarned;
  final double totalPaid;
  final double pendingBalance;
  final int productCount;
  final DateTime createdAt;
  final DateTime updatedAt;

  const Contributor({
    required this.id,
    required this.githubUsername,
    this.displayName,
    this.email,
    required this.royaltyStatus,
    required this.royaltyRate,
    required this.totalEarned,
    required this.totalPaid,
    required this.pendingBalance,
    required this.productCount,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Contributor.fromJson(Map<String, dynamic> json) {
    return Contributor(
      id: json['id'] as String,
      githubUsername: json['githubUsername'] as String,
      displayName: json['displayName'] as String?,
      email: json['email'] as String?,
      royaltyStatus: json['royaltyStatus'] as String? ?? 'active',
      royaltyRate: (json['royaltyRate'] as num?)?.toDouble() ?? 0.0,
      totalEarned: (json['totalEarned'] as num?)?.toDouble() ?? 0.0,
      totalPaid: (json['totalPaid'] as num?)?.toDouble() ?? 0.0,
      pendingBalance: (json['pendingBalance'] as num?)?.toDouble() ?? 0.0,
      productCount: json['productCount'] as int? ?? 0,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}
