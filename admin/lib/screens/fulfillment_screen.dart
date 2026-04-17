import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/api_client.dart';
import '../models/fulfillment.dart';
import '../providers/fulfillment_provider.dart';
import '../providers/websocket_provider.dart';

/// Stream of fulfillment-related WebSocket messages.
final fulfillmentUpdatesProvider =
    StreamProvider.autoDispose<WsMessage>((ref) {
  final ws = ref.watch(webSocketProvider.notifier);
  return ws.messagesForSubject('fulfillment');
});

class FulfillmentScreen extends ConsumerWidget {
  const FulfillmentScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasksAsync = ref.watch(fulfillmentListProvider);

    // Real-time queue updates
    ref.listen(fulfillmentUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(fulfillmentListProvider);
      }
    });

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Fulfillment Queue',
                  style: Theme.of(context).textTheme.headlineMedium),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: () => ref.invalidate(fulfillmentListProvider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: tasksAsync.when(
              loading: () =>
                  const Center(child: CircularProgressIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 48, color: Colors.red),
                    const SizedBox(height: 8),
                    Text('Failed to load tasks: $error'),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: () =>
                          ref.invalidate(fulfillmentListProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (tasks) => tasks.isEmpty
                  ? const Center(child: Text('No fulfillment tasks'))
                  : _FulfillmentTaskTable(tasks: tasks),
            ),
          ),
        ],
      ),
    );
  }
}

class _FulfillmentTaskTable extends StatelessWidget {
  final List<FulfillmentTask> tasks;

  const _FulfillmentTaskTable({required this.tasks});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Order #')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Priority')),
          DataColumn(label: Text('Assigned To')),
          DataColumn(label: Text('Created')),
          DataColumn(label: Text('Actions')),
        ],
        rows: tasks.map((task) {
          return DataRow(
            onSelectChanged: (_) {
              context.go('/fulfillment/${task.id}');
            },
            cells: [
              DataCell(Text(task.orderNumber)),
              DataCell(FulfillmentStatusChip(status: task.status)),
              DataCell(_PriorityChip(priority: task.priority)),
              DataCell(Text(task.assignedToName ?? 'Unassigned')),
              DataCell(Text(_formatDate(task.createdAt))),
              DataCell(_QuickActions(task: task)),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class FulfillmentStatusChip extends StatelessWidget {
  final String status;

  const FulfillmentStatusChip({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: _colorForStatus(status)),
      ),
      backgroundColor: _colorForStatus(status).withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }

  Color _colorForStatus(String s) {
    switch (s) {
      case 'done':
        return Colors.green;
      case 'picking':
      case 'packing':
      case 'picked':
      case 'packed':
        return Colors.blue;
      case 'assigned':
      case 'shipment_pending':
        return Colors.orange;
      case 'blocked':
        return Colors.red;
      case 'canceled':
        return Colors.red;
      default:
        return Colors.grey;
    }
  }
}

class _PriorityChip extends StatelessWidget {
  final String priority;

  const _PriorityChip({required this.priority});

  @override
  Widget build(BuildContext context) {
    final isHigh = priority == 'high';
    return Chip(
      label: Text(
        priority,
        style: TextStyle(
          fontSize: 11,
          color: isHigh ? Colors.red : Colors.grey,
        ),
      ),
      backgroundColor: isHigh
          ? Colors.red.withValues(alpha: 0.1)
          : Colors.grey.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

class _QuickActions extends ConsumerWidget {
  final FulfillmentTask task;

  const _QuickActions({required this.task});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!task.canProgress) return const SizedBox.shrink();

    return TextButton(
      onPressed: () => _progressTask(context, ref),
      child: Text(task.nextStatusLabel),
    );
  }

  Future<void> _progressTask(BuildContext context, WidgetRef ref) async {
    final next = task.nextStatus;
    if (next == null) return;

    try {
      final dio = ref.read(dioProvider);
      await dio.post(
        '/api/admin/fulfillment/${task.id}/transition',
        data: {'status': next},
      );
      ref.invalidate(fulfillmentListProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content:
                  Text('Task updated to ${next.replaceAll('_', ' ')}')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to update task: $e')),
        );
      }
    }
  }
}

class FulfillmentDetailScreen extends ConsumerWidget {
  final String taskId;

  const FulfillmentDetailScreen({super.key, required this.taskId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final taskAsync = ref.watch(fulfillmentDetailProvider(taskId));

    // Real-time updates
    ref.listen(fulfillmentUpdatesProvider, (_, next) {
      if (next.hasValue) {
        ref.invalidate(fulfillmentDetailProvider(taskId));
      }
    });

    return taskAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 8),
            Text('Failed to load task: $error'),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: () =>
                  ref.invalidate(fulfillmentDetailProvider(taskId)),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (task) => _FulfillmentDetailContent(task: task),
    );
  }
}

class _FulfillmentDetailContent extends ConsumerWidget {
  final FulfillmentTask task;

  const _FulfillmentDetailContent({required this.task});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/fulfillment'),
              ),
              const SizedBox(width: 8),
              Text(
                'Fulfillment Task',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(width: 16),
              FulfillmentStatusChip(status: task.status),
              const SizedBox(width: 8),
              _PriorityChip(priority: task.priority),
            ],
          ),
          const SizedBox(height: 24),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailCard(
                    title: 'Task Details',
                    children: [
                      _DetailRow(label: 'Task ID', value: task.id),
                      _DetailRow(label: 'Order', value: task.orderNumber),
                      _DetailRow(
                          label: 'Status',
                          value: task.status.replaceAll('_', ' ')),
                      _DetailRow(label: 'Priority', value: task.priority),
                      _DetailRow(
                          label: 'Assigned To',
                          value: task.assignedToName ?? 'Unassigned'),
                      _DetailRow(
                          label: 'Created',
                          value: _formatDateTime(task.createdAt)),
                      _DetailRow(
                          label: 'Updated',
                          value: _formatDateTime(task.updatedAt)),
                      if (task.blockedReason != null)
                        _DetailRow(
                            label: 'Blocked Reason',
                            value: task.blockedReason!),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _WorkflowActions(task: task),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _WorkflowActions extends ConsumerWidget {
  final FulfillmentTask task;

  const _WorkflowActions({required this.task});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _DetailCard(
      title: 'Workflow Actions',
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            if (task.canProgress)
              FilledButton.icon(
                icon: const Icon(Icons.arrow_forward),
                label: Text(task.nextStatusLabel),
                onPressed: () =>
                    _transition(context, ref, task.nextStatus!),
              ),
            if (task.status != 'done' &&
                task.status != 'canceled' &&
                task.status != 'blocked')
              OutlinedButton.icon(
                icon: const Icon(Icons.block, color: Colors.orange),
                label: const Text('Block'),
                onPressed: () => _showBlockDialog(context, ref),
              ),
            if (task.status == 'blocked')
              FilledButton.icon(
                icon: const Icon(Icons.play_arrow),
                label: const Text('Unblock'),
                onPressed: () => _unblock(context, ref),
              ),
            if (task.status != 'done' && task.status != 'canceled')
              OutlinedButton.icon(
                icon: const Icon(Icons.cancel, color: Colors.red),
                label: const Text('Cancel',
                    style: TextStyle(color: Colors.red)),
                style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: Colors.red)),
                onPressed: () => _showCancelDialog(context, ref),
              ),
            if (task.status == 'new')
              OutlinedButton.icon(
                icon: const Icon(Icons.person_add),
                label: const Text('Assign'),
                onPressed: () => _showAssignDialog(context, ref),
              ),
          ],
        ),
      ],
    );
  }

  Future<void> _transition(
      BuildContext context, WidgetRef ref, String newStatus) async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post(
        '/api/admin/fulfillment/${task.id}/transition',
        data: {'status': newStatus},
      );
      ref.invalidate(fulfillmentDetailProvider(task.id));
      ref.invalidate(fulfillmentListProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(
                  'Task updated to ${newStatus.replaceAll('_', ' ')}')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to update: $e')),
        );
      }
    }
  }

  Future<void> _showBlockDialog(BuildContext context, WidgetRef ref) async {
    final reasonController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Block Fulfillment Task'),
        content: Form(
          key: formKey,
          child: TextFormField(
            controller: reasonController,
            decoration: const InputDecoration(
              labelText: 'Block reason',
              border: OutlineInputBorder(),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return 'Reason is required';
              return null;
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Block'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/fulfillment/${task.id}/transition',
          data: {
            'status': 'blocked',
            'reason': reasonController.text,
          },
        );
        ref.invalidate(fulfillmentDetailProvider(task.id));
        ref.invalidate(fulfillmentListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Task blocked')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to block: $e')),
          );
        }
      }
    }
  }

  Future<void> _unblock(BuildContext context, WidgetRef ref) async {
    try {
      final dio = ref.read(dioProvider);
      await dio.post(
        '/api/admin/fulfillment/${task.id}/transition',
        data: {'status': 'assigned'},
      );
      ref.invalidate(fulfillmentDetailProvider(task.id));
      ref.invalidate(fulfillmentListProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Task unblocked')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to unblock: $e')),
        );
      }
    }
  }

  Future<void> _showCancelDialog(
      BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel Fulfillment Task'),
        content: const Text(
          'Are you sure you want to cancel this fulfillment task? '
          'Any picked items will be returned to inventory.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Keep'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Cancel Task'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/fulfillment/${task.id}/transition',
          data: {'status': 'canceled'},
        );
        ref.invalidate(fulfillmentDetailProvider(task.id));
        ref.invalidate(fulfillmentListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Task canceled')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to cancel: $e')),
          );
        }
      }
    }
  }

  Future<void> _showAssignDialog(
      BuildContext context, WidgetRef ref) async {
    final adminIdController = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Assign Task'),
        content: Form(
          key: formKey,
          child: TextFormField(
            controller: adminIdController,
            decoration: const InputDecoration(
              labelText: 'Admin User ID',
              border: OutlineInputBorder(),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return 'Admin ID is required';
              return null;
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.of(ctx).pop(true);
              }
            },
            child: const Text('Assign'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final dio = ref.read(dioProvider);
        await dio.post(
          '/api/admin/fulfillment/${task.id}/assign',
          data: {'adminUserId': adminIdController.text},
        );
        ref.invalidate(fulfillmentDetailProvider(task.id));
        ref.invalidate(fulfillmentListProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Task assigned')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to assign: $e')),
          );
        }
      }
    }
  }
}

class _DetailCard extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _DetailCard({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;

  const _DetailRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 140,
            child: Text(label,
                style: const TextStyle(fontWeight: FontWeight.w500)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

String _formatDateTime(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
