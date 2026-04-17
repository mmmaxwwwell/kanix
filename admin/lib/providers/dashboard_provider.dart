import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';

class DashboardSummary {
  final int ordersAwaitingFulfillment;
  final int openSupportTickets;
  final int lowStockVariants;
  final int openDisputes;
  final int shipmentsWithExceptions;

  const DashboardSummary({
    required this.ordersAwaitingFulfillment,
    required this.openSupportTickets,
    required this.lowStockVariants,
    required this.openDisputes,
    required this.shipmentsWithExceptions,
  });

  factory DashboardSummary.fromJson(Map<String, dynamic> json) {
    return DashboardSummary(
      ordersAwaitingFulfillment: json['ordersAwaitingFulfillment'] as int,
      openSupportTickets: json['openSupportTickets'] as int,
      lowStockVariants: json['lowStockVariants'] as int,
      openDisputes: json['openDisputes'] as int,
      shipmentsWithExceptions: json['shipmentsWithExceptions'] as int,
    );
  }
}

final dashboardSummaryProvider =
    FutureProvider.autoDispose<DashboardSummary>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/admin/dashboard/summary');
  return DashboardSummary.fromJson(response.data as Map<String, dynamic>);
});
