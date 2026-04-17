import 'package:flutter/material.dart';

class WarrantyScreen extends StatelessWidget {
  const WarrantyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text('Warranty Claims'),
    );
  }
}

class WarrantyDetailScreen extends StatelessWidget {
  final String claimId;

  const WarrantyDetailScreen({super.key, required this.claimId});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text('Warranty Claim: $claimId'),
    );
  }
}
