import 'package:flutter/material.dart';

class SupportScreen extends StatelessWidget {
  const SupportScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text('Support'),
    );
  }
}

class SupportDetailScreen extends StatelessWidget {
  final String ticketId;

  const SupportDetailScreen({super.key, required this.ticketId});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text('Ticket: $ticketId'),
    );
  }
}
