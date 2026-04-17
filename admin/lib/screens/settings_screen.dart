import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/admin_user_management.dart';
import '../providers/settings_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 2,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Settings',
                style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 16),
            const TabBar(
              isScrollable: true,
              tabs: [
                Tab(text: 'Admin Users'),
                Tab(text: 'Roles & Permissions'),
              ],
            ),
            const SizedBox(height: 16),
            const Expanded(
              child: TabBarView(
                children: [
                  _AdminUsersTab(),
                  _RolesTab(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AdminUsersTab extends ConsumerWidget {
  const _AdminUsersTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usersAsync = ref.watch(adminUsersProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Manage Admin Users',
                style: Theme.of(context).textTheme.titleMedium),
            const Spacer(),
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh',
              onPressed: () => ref.invalidate(adminUsersProvider),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              icon: const Icon(Icons.person_add),
              label: const Text('Add Admin'),
              onPressed: () => _showAddAdminDialog(context, ref),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: usersAsync.when(
            loading: () =>
                const Center(child: CircularProgressIndicator()),
            error: (error, _) => Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline,
                      size: 48, color: Colors.red),
                  const SizedBox(height: 8),
                  Text('Failed to load admin users: $error'),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: () => ref.invalidate(adminUsersProvider),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
            data: (users) => users.isEmpty
                ? const Center(child: Text('No admin users found'))
                : _AdminUsersDataTable(users: users),
          ),
        ),
      ],
    );
  }

  void _showAddAdminDialog(BuildContext context, WidgetRef ref) {
    final emailController = TextEditingController();
    final nameController = TextEditingController();
    String selectedRole = 'viewer';

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Admin User'),
          content: SizedBox(
            width: 400,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: emailController,
                  decoration: const InputDecoration(
                    labelText: 'Email',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: nameController,
                  decoration: const InputDecoration(
                    labelText: 'Name',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: selectedRole,
                  decoration: const InputDecoration(
                    labelText: 'Role',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'super_admin', child: Text('Super Admin')),
                    DropdownMenuItem(value: 'admin', child: Text('Admin')),
                    DropdownMenuItem(value: 'fulfillment', child: Text('Fulfillment')),
                    DropdownMenuItem(value: 'support', child: Text('Support')),
                    DropdownMenuItem(value: 'viewer', child: Text('Viewer')),
                  ],
                  onChanged: (v) {
                    if (v != null) {
                      setDialogState(() => selectedRole = v);
                    }
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () async {
                final email = emailController.text.trim();
                final name = nameController.text.trim();
                if (email.isEmpty || name.isEmpty) return;

                try {
                  final dio = ref.read(dioProvider);
                  await dio.post('/api/admin/users', data: {
                    'email': email,
                    'name': name,
                    'role': selectedRole,
                  });
                  ref.invalidate(adminUsersProvider);
                  if (ctx.mounted) Navigator.of(ctx).pop();
                } catch (e) {
                  if (ctx.mounted) {
                    ScaffoldMessenger.of(ctx).showSnackBar(
                      SnackBar(content: Text('Failed to add admin: $e')),
                    );
                  }
                }
              },
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
  }
}

class _AdminUsersDataTable extends StatelessWidget {
  final List<ManagedAdminUser> users;

  const _AdminUsersDataTable({required this.users});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: DataTable(
        showCheckboxColumn: false,
        columns: const [
          DataColumn(label: Text('Name')),
          DataColumn(label: Text('Email')),
          DataColumn(label: Text('Role')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Capabilities')),
          DataColumn(label: Text('Created')),
        ],
        rows: users.map((user) {
          return DataRow(
            cells: [
              DataCell(Text(user.name)),
              DataCell(Text(user.email)),
              DataCell(_RoleChip(role: user.role)),
              DataCell(_ActiveStatusChip(isActive: user.isActive)),
              DataCell(Text(
                user.capabilities.join(', '),
                overflow: TextOverflow.ellipsis,
              )),
              DataCell(Text(_formatDate(user.createdAt))),
            ],
          );
        }).toList(),
      ),
    );
  }
}

class _RolesTab extends ConsumerWidget {
  const _RolesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rolesAsync = ref.watch(adminRolesProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Roles & Permissions',
                style: Theme.of(context).textTheme.titleMedium),
            const Spacer(),
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh',
              onPressed: () => ref.invalidate(adminRolesProvider),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: rolesAsync.when(
            loading: () =>
                const Center(child: CircularProgressIndicator()),
            error: (error, _) => Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline,
                      size: 48, color: Colors.red),
                  const SizedBox(height: 8),
                  Text('Failed to load roles: $error'),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: () => ref.invalidate(adminRolesProvider),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
            data: (roles) => roles.isEmpty
                ? const Center(child: Text('No roles configured'))
                : _RolesListView(roles: roles),
          ),
        ),
      ],
    );
  }
}

class _RolesListView extends StatelessWidget {
  final List<AdminRole> roles;

  const _RolesListView({required this.roles});

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: roles.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final role = roles[index];
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    _RoleChip(role: role.name),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        role.description,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text('Permissions',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color:
                              Theme.of(context).colorScheme.onSurfaceVariant,
                        )),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: role.permissions
                      .map((p) => Chip(
                            label: Text(p, style: const TextStyle(fontSize: 11)),
                            padding: EdgeInsets.zero,
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            visualDensity: VisualDensity.compact,
                          ))
                      .toList(),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _RoleChip extends StatelessWidget {
  final String role;

  const _RoleChip({required this.role});

  @override
  Widget build(BuildContext context) {
    final color = _roleColor(role);
    return Chip(
      label: Text(
        role.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

class _ActiveStatusChip extends StatelessWidget {
  final bool isActive;

  const _ActiveStatusChip({required this.isActive});

  @override
  Widget build(BuildContext context) {
    final color = isActive ? Colors.green : Colors.grey;
    final label = isActive ? 'Active' : 'Inactive';
    return Chip(
      label: Text(
        label,
        style: TextStyle(fontSize: 11, color: color),
      ),
      backgroundColor: color.withValues(alpha: 0.1),
      padding: EdgeInsets.zero,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
    );
  }
}

Color _roleColor(String role) {
  switch (role) {
    case 'super_admin':
      return Colors.purple;
    case 'admin':
      return Colors.blue;
    case 'fulfillment':
      return Colors.teal;
    case 'support':
      return Colors.orange;
    case 'viewer':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

String _formatDate(DateTime dt) {
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}
