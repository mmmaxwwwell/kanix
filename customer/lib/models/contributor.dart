class ContributorDesign {
  final String id;
  final String name;
  final String slug;
  final int totalSales;
  final int royaltyAccruedCents;
  final String status;

  const ContributorDesign({
    required this.id,
    required this.name,
    required this.slug,
    required this.totalSales,
    required this.royaltyAccruedCents,
    this.status = 'active',
  });

  String get formattedRoyalty {
    final dollars = royaltyAccruedCents ~/ 100;
    final cents = (royaltyAccruedCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  factory ContributorDesign.fromJson(Map<String, dynamic> json) {
    return ContributorDesign(
      id: json['id'] as String,
      name: json['name'] as String,
      slug: json['slug'] as String,
      totalSales: json['totalSales'] as int? ?? 0,
      royaltyAccruedCents: json['royaltyAccruedCents'] as int? ?? 0,
      status: json['status'] as String? ?? 'active',
    );
  }
}

class ContributorMilestone {
  final String id;
  final String name;
  final String description;
  final int targetSales;
  final int currentSales;
  final int bonusCents;
  final bool achieved;

  const ContributorMilestone({
    required this.id,
    required this.name,
    required this.description,
    required this.targetSales,
    required this.currentSales,
    required this.bonusCents,
    required this.achieved,
  });

  double get progress =>
      targetSales > 0 ? (currentSales / targetSales).clamp(0.0, 1.0) : 0.0;

  String get formattedBonus {
    final dollars = bonusCents ~/ 100;
    final cents = (bonusCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  factory ContributorMilestone.fromJson(Map<String, dynamic> json) {
    return ContributorMilestone(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String? ?? '',
      targetSales: json['targetSales'] as int? ?? 0,
      currentSales: json['currentSales'] as int? ?? 0,
      bonusCents: json['bonusCents'] as int? ?? 0,
      achieved: json['achieved'] as bool? ?? false,
    );
  }
}

class ContributorPayout {
  final String id;
  final int amountCents;
  final String status;
  final DateTime paidAt;
  final String? payoutMethod;

  const ContributorPayout({
    required this.id,
    required this.amountCents,
    required this.status,
    required this.paidAt,
    this.payoutMethod,
  });

  String get formattedAmount {
    final dollars = amountCents ~/ 100;
    final cents = (amountCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  String get statusLabel {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'processing':
        return 'Processing';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return status;
    }
  }

  factory ContributorPayout.fromJson(Map<String, dynamic> json) {
    return ContributorPayout(
      id: json['id'] as String,
      amountCents: json['amountCents'] as int? ?? 0,
      status: json['status'] as String? ?? 'pending',
      paidAt: DateTime.parse(json['paidAt'] as String),
      payoutMethod: json['payoutMethod'] as String?,
    );
  }
}

class ContributorDashboardData {
  final int totalDesigns;
  final int totalSales;
  final int totalRoyaltyAccruedCents;
  final int totalPaidOutCents;
  final List<ContributorDesign> designs;
  final List<ContributorMilestone> milestones;
  final List<ContributorPayout> payouts;

  const ContributorDashboardData({
    required this.totalDesigns,
    required this.totalSales,
    required this.totalRoyaltyAccruedCents,
    required this.totalPaidOutCents,
    required this.designs,
    required this.milestones,
    required this.payouts,
  });

  String get formattedTotalRoyalty {
    final dollars = totalRoyaltyAccruedCents ~/ 100;
    final cents = (totalRoyaltyAccruedCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  String get formattedTotalPaidOut {
    final dollars = totalPaidOutCents ~/ 100;
    final cents = (totalPaidOutCents % 100).toString().padLeft(2, '0');
    return '\$$dollars.$cents';
  }

  factory ContributorDashboardData.fromJson(Map<String, dynamic> json) {
    return ContributorDashboardData(
      totalDesigns: json['totalDesigns'] as int? ?? 0,
      totalSales: json['totalSales'] as int? ?? 0,
      totalRoyaltyAccruedCents: json['totalRoyaltyAccruedCents'] as int? ?? 0,
      totalPaidOutCents: json['totalPaidOutCents'] as int? ?? 0,
      designs: (json['designs'] as List<dynamic>?)
              ?.map((d) =>
                  ContributorDesign.fromJson(d as Map<String, dynamic>))
              .toList() ??
          [],
      milestones: (json['milestones'] as List<dynamic>?)
              ?.map((m) =>
                  ContributorMilestone.fromJson(m as Map<String, dynamic>))
              .toList() ??
          [],
      payouts: (json['payouts'] as List<dynamic>?)
              ?.map((p) =>
                  ContributorPayout.fromJson(p as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}
