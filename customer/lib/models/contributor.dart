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
      name: (json['productTitle'] ?? json['name'] ?? '') as String,
      slug: (json['productSlug'] ?? json['slug'] ?? '') as String,
      totalSales: (json['salesCount'] ?? json['totalSales'] ?? 0) as int,
      royaltyAccruedCents:
          (json['royaltyAccruedCents'] ?? 0) as int,
      status: (json['status'] ?? 'active') as String,
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

  static String _milestoneTypeName(String? milestoneType) {
    switch (milestoneType) {
      case 'royalty_activation':
        return 'Royalty Activation';
      case 'starter_kit':
        return 'Starter Kit';
      case 'veteran':
        return 'Veteran';
      case 'accepted_pr':
        return 'Accepted PR';
      default:
        return milestoneType ?? 'Milestone';
    }
  }

  static int _milestoneTargetSales(String? milestoneType) {
    switch (milestoneType) {
      case 'royalty_activation':
        return 25;
      case 'starter_kit':
        return 50;
      case 'veteran':
        return 500;
      default:
        return 0;
    }
  }

  factory ContributorMilestone.fromJson(Map<String, dynamic> json) {
    final milestoneType = json['milestoneType'] as String?;
    final isAchieved = json['reachedAt'] != null || json['achieved'] == true;
    final targetSales = json['targetSales'] as int? ??
        _milestoneTargetSales(milestoneType);
    return ContributorMilestone(
      id: json['id'] as String,
      name: (json['name'] as String?) ?? _milestoneTypeName(milestoneType),
      description: (json['description'] as String?) ??
          (json['notes'] as String?) ??
          '',
      targetSales: targetSales,
      currentSales: isAchieved
          ? targetSales
          : (json['currentSales'] as int? ?? 0),
      bonusCents: json['bonusCents'] as int? ?? 0,
      achieved: isAchieved,
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
    final paidAtStr = (json['completedAt'] ?? json['paidAt'] ?? json['initiatedAt']) as String?;
    return ContributorPayout(
      id: json['id'] as String,
      amountCents: (json['amountMinor'] ?? json['amountCents'] ?? 0) as int,
      status: (json['status'] as String?) ?? 'pending',
      paidAt: paidAtStr != null ? DateTime.parse(paidAtStr) : DateTime.now(),
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
    final designList = (json['designs'] as List<dynamic>?)
            ?.map((d) => ContributorDesign.fromJson(d as Map<String, dynamic>))
            .toList() ??
        [];
    final milestoneList = (json['milestones'] as List<dynamic>?)
            ?.map((m) =>
                ContributorMilestone.fromJson(m as Map<String, dynamic>))
            .toList() ??
        [];
    final payoutList = (json['payouts'] as List<dynamic>?)
            ?.map((p) => ContributorPayout.fromJson(p as Map<String, dynamic>))
            .toList() ??
        [];

    // API returns royaltySummary object; flat fields (totalDesigns etc.) are
    // not present — compute them from the nested structure.
    final royaltySummary = json['royaltySummary'] as Map<String, dynamic>?;
    final totalRoyaltyAccruedCents =
        (royaltySummary?['totalMinor'] ?? json['totalRoyaltyAccruedCents'] ?? 0)
            as int;
    final totalPaidOutCents =
        (royaltySummary?['paidMinor'] ?? json['totalPaidOutCents'] ?? 0) as int;
    final totalSales = json['totalSales'] as int? ??
        designList.fold<int>(0, (sum, d) => sum + d.totalSales);

    return ContributorDashboardData(
      totalDesigns: json['totalDesigns'] as int? ?? designList.length,
      totalSales: totalSales,
      totalRoyaltyAccruedCents: totalRoyaltyAccruedCents,
      totalPaidOutCents: totalPaidOutCents,
      designs: designList,
      milestones: milestoneList,
      payouts: payoutList,
    );
  }
}
