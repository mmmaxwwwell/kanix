import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/support.dart';
import '../providers/support_provider.dart';

class SupportScreen extends ConsumerWidget {
  const SupportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ticketsAsync = ref.watch(ticketListProvider);
    final filters = ref.watch(ticketFiltersProvider);

    ref.listen(ticketUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(ticketListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Support Tickets',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(ticketListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _TicketFiltersBar(filters: filters),
          const SizedBox(height: 16),
          Expanded(
            child: ticketsAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load tickets: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () => ref.invalidate(ticketListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (tickets) => tickets.isEmpty
                  ? const Center(child: Text('No tickets found'))
                  : _TicketsDataTable(tickets: tickets),
            ),
          ),
        ],
      ),
    );
  }
}

class _TicketFiltersBar extends ConsumerWidget {
  final TicketFilters filters;

  const _TicketFiltersBar({required this.filters});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Wrap(
      spacing: 12,
      runSpacing: 8,
      children: [
        SizedBox(
          width: 200,
          child: TextField(
            decoration: const InputDecoration(
              labelText: 'Search',
              hintText: 'Ticket #, email, subject...',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
              isDense: true,
            ),
            onChanged: (value) {
              ref.read(ticketFiltersProvider.notifier).state =
                  filters.copyWith(
                      search: () => value.isEmpty ? null : value);
            },
          ),
        ),
        SizedBox(
          width: 160,
          child: DropdownButtonFormField<String>(
            initialValue: filters.status,
            decoration: const InputDecoration(
              labelText: 'Status',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            isExpanded: true,
            items: const [
              DropdownMenuItem<String>(value: null, child: Text('All')),
              DropdownMenuItem(value: 'open', child: Text('open')),
              DropdownMenuItem(
                  value: 'awaiting_customer',
                  child: Text('awaiting customer')),
              DropdownMenuItem(
                  value: 'awaiting_admin',
                  child: Text('awaiting admin')),
              DropdownMenuItem(value: 'resolved', child: Text('resolved')),
              DropdownMenuItem(value: 'closed', child: Text('closed')),
            ],
            onChanged: (v) {
              ref.read(ticketFiltersProvider.notifier).state =
                  filters.copyWith(status: () => v);
            },
          ),
        ),
        SizedBox(
          width: 160,
          child: DropdownButtonFormField<String>(
            initialValue: filters.priority,
            decoration: const InputDecoration(
              labelText: 'Priority',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            isExpanded: true,
            items: const [
              DropdownMenuItem<String>(value: null, child: Text('All')),
              DropdownMenuItem(value: 'low', child: Text('low')),
              DropdownMenuItem(value: 'normal', child: Text('normal')),
              DropdownMenuItem(value: 'high', child: Text('high')),
              DropdownMenuItem(value: 'urgent', child: Text('urgent')),
            ],
            onChanged: (v) {
              ref.read(ticketFiltersProvider.notifier).state =
                  filters.copyWith(priority: () => v);
            },
          ),
        ),
        if (filters.status != null ||
            filters.priority != null ||
            (filters.search != null && filters.search!.isNotEmpty))
          TextButton.icon(
            icon: const Icon(Icons.clear),
            label: const Text('Clear filters'),
            onPressed: () {
              ref.read(ticketFiltersProvider.notifier).state =
                  const TicketFilters();
            },
          ),
      ],
    );
  }
}

class _TicketsDataTable extends StatelessWidget {
  final List<SupportTicket> tickets;

  const _TicketsDataTable({required this.tickets});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Ticket #')),
          DataColumn(label: Text('Subject')),
          DataColumn(label: Text('Customer')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Priority')),
          DataColumn(label: Text('Updated')),
        ],
        rows: tickets.map((ticket) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/support/${ticket.id}');
            },
            cells: [
              DataCell(Text(ticket.ticketNumber)),
              DataCell(Text(
                ticket.subject,
                overflow: TextOverflow.ellipsis,
              )),
              DataCell(Text(
                ticket.customerEmail,
                overflow: TextOverflow.ellipsis,
              )),
              DataCell(_StatusChip(
                label: ticket.status,
                color: _ticketStatusColor(ticket.status),
              )),
              DataCell(_PriorityChip(priority: ticket.priority)),
              DataCell(Text(_formatDateTime(ticket.updatedAt))),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class SupportDetailScreen extends ConsumerWidget {
  final String ticketId;

  const SupportDetailScreen({super.key, required this.ticketId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ticketAsync = ref.watch(ticketDetailProvider(ticketId));

    ref.listen(ticketUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(ticketDetailProvider(ticketId));
        ref.invalidate(ticketMessagesProvider(ticketId));
      }
    });

    return ticketAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load ticket: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(ticketDetailProvider(ticketId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (ticket) => _TicketDetailContent(ticket: ticket),
    );
  }
}

class _TicketDetailContent extends ConsumerWidget {
  final SupportTicket ticket;

  const _TicketDetailContent({required this.ticket});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messagesAsync = ref.watch(ticketMessagesProvider(ticket.id));

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _TicketHeader(ticket: ticket),
          const SizedBox(height: 16),
          _TicketInfoBar(ticket: ticket),
          const SizedBox(height: 16),
          Expanded(
            child: messagesAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(
                child: Text('Failed to load messages: $e'),
              ),
              data: (messages) =>
                  _MessageThread(ticket: ticket, messages: messages),
            ),
          ),
          const SizedBox(height: 8),
          _ReplyBar(ticket: ticket),
        ],
      ),
    );
  }
}

class _TicketHeader extends StatelessWidget {
  final SupportTicket ticket;

  const _TicketHeader({required this.ticket});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            '${ticket.ticketNumber}: ${ticket.subject}',
            style: Theme.of(context).textTheme.headlineMedium,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 16),
        _StatusChip(
          label: ticket.status,
          color: _ticketStatusColor(ticket.status),
        ),
        const SizedBox(width: 8),
        _PriorityChip(priority: ticket.priority),
      ],
    );
  }
}

class _TicketInfoBar extends StatelessWidget {
  final SupportTicket ticket;

  const _TicketInfoBar({required this.ticket});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 24,
          runSpacing: 8,
          children: [
            _InfoItem(label: 'Customer', value: ticket.customerEmail),
            if (ticket.orderId != null)
              _InfoItem(label: 'Order', value: ticket.orderId!),
            _InfoItem(
                label: 'Created', value: _formatDateTime(ticket.createdAt)),
            _InfoItem(
                label: 'Updated', value: _formatDateTime(ticket.updatedAt)),
          ],
        ),
      ),
    );
  }
}

class _InfoItem extends StatelessWidget {
  final String label;
  final String value;

  const _InfoItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                )),
        const SizedBox(height: 2),
        Text(value, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _MessageThread extends StatelessWidget {
  final SupportTicket ticket;
  final List<TicketMessage> messages;

  const _MessageThread({required this.ticket, required this.messages});

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) {
      return const Center(child: Text('No messages yet'));
    }

    return ListView.separated(
      itemCount: messages.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final msg = messages[index];
        return _MessageBubble(message: msg);
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final TicketMessage message;

  const _MessageBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final isAdmin = message.senderType == 'admin';
    final isInternal = message.isInternal;

    return Align(
      alignment: isAdmin ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints:
            BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.6),
        decoration: BoxDecoration(
          color: isInternal
              ? Colors.amber.shade50
              : isAdmin
                  ? Theme.of(context).colorScheme.primaryContainer
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
          border: isInternal
              ? Border.all(color: Colors.amber.shade300)
              : null,
        ),
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  isAdmin ? 'Admin' : 'Customer',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                if (isInternal) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.amber.shade200,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      'Internal Note',
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ),
                ],
                const SizedBox(width: 8),
                Text(
                  _formatDateTime(message.createdAt),
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color:
                            Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(message.body),
          ],
        ),
      ),
    );
  }
}

class _ReplyBar extends ConsumerStatefulWidget {
  final SupportTicket ticket;

  const _ReplyBar({required this.ticket});

  @override
  ConsumerState<_ReplyBar> createState() => _ReplyBarState();
}

class _ReplyBarState extends ConsumerState<_ReplyBar> {
  final _controller = TextEditingController();
  bool _isInternal = false;
  bool _sending = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final body = _controller.text.trim();
    if (body.isEmpty) return;

    setState(() => _sending = true);
    try {
      final dio = ref.read(dioProvider);
      await dio.post(
        '/api/admin/support/tickets/${widget.ticket.id}/messages',
        data: {
          'body': body,
          'isInternal': _isInternal,
        },
      );
      _controller.clear();
      ref.invalidate(ticketMessagesProvider(widget.ticket.id));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to send message: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                decoration: InputDecoration(
                  hintText:
                      _isInternal ? 'Add internal note...' : 'Reply...',
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
                maxLines: 2,
                minLines: 1,
              ),
            ),
            const SizedBox(width: 8),
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Checkbox(
                      value: _isInternal,
                      onChanged: (v) =>
                          setState(() => _isInternal = v ?? false),
                    ),
                    const Text('Internal'),
                  ],
                ),
              ],
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              icon: _sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
              tooltip: _isInternal ? 'Add internal note' : 'Send reply',
              onPressed: _sending ? null : _send,
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(
        label.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

class _PriorityChip extends StatelessWidget {
  final String priority;

  const _PriorityChip({required this.priority});

  @override
  Widget build(BuildContext context) {
    final color = _priorityColor(priority);
    return Chip(
      label: Text(
        priority,
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

Color _ticketStatusColor(String status) {
  switch (status) {
    case 'open':
      return Colors.blue;
    case 'awaiting_customer':
      return Colors.orange;
    case 'awaiting_admin':
      return Colors.deepOrange;
    case 'resolved':
      return Colors.green;
    case 'closed':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

Color _priorityColor(String priority) {
  switch (priority) {
    case 'urgent':
      return Colors.red;
    case 'high':
      return Colors.deepOrange;
    case 'normal':
      return Colors.blue;
    case 'low':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
