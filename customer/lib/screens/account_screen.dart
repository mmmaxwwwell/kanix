import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/auth_provider.dart';

class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authStateProvider);
    final user = authState.value?.user;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Profile',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 16),
                ListTile(
                  leading: const Icon(Icons.person),
                  title: const Text('Name'),
                  subtitle: Text(user?.name ?? ''),
                ),
                ListTile(
                  leading: const Icon(Icons.email),
                  title: const Text('Email'),
                  subtitle: Text(user?.email ?? ''),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Linked Accounts',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 16),
                ListTile(
                  leading: const Icon(Icons.code),
                  title: const Text('GitHub'),
                  subtitle: Text(user?.githubLinked != null
                      ? 'Linked: ${user!.githubLinked}'
                      : 'Not linked'),
                  trailing: user?.githubLinked == null
                      ? FilledButton.tonal(
                          onPressed: () {
                            ref.read(authStateProvider.notifier).linkGitHub();
                          },
                          child: const Text('Link GitHub'),
                        )
                      : const Icon(Icons.check_circle, color: Colors.green),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.tonal(
          onPressed: () {
            ref.read(authStateProvider.notifier).signOut();
          },
          child: const Text('Sign Out'),
        ),
      ],
    );
  }
}
