import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kanix_admin/models/fulfillment.dart';
import 'package:kanix_admin/providers/fulfillment_provider.dart';
import 'package:kanix_admin/screens/fulfillment_screen.dart';

final _sampleTasks = [
  FulfillmentTask(
    id: 'task-1',
    orderId: 'order-1',
    orderNumber: 'KNX-000001',
    status: 'new',
    priority: 'high',
    createdAt: DateTime(2026, 4, 15),
    updatedAt: DateTime(2026, 4, 15),
  ),
  FulfillmentTask(
    id: 'task-2',
    orderId: 'order-2',
    orderNumber: 'KNX-000002',
    status: 'picking',
    priority: 'standard',
    assignedTo: 'admin-1',
    assignedToName: 'Jane Admin',
    createdAt: DateTime(2026, 4, 14),
    updatedAt: DateTime(2026, 4, 15),
  ),
  FulfillmentTask(
    id: 'task-3',
    orderId: 'order-3',
    orderNumber: 'KNX-000003',
    status: 'blocked',
    priority: 'standard',
    assignedTo: 'admin-1',
    assignedToName: 'Jane Admin',
    blockedReason: 'Missing inventory',
    createdAt: DateTime(2026, 4, 13),
    updatedAt: DateTime(2026, 4, 15),
  ),
];

void main() {
  group('FulfillmentScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<List<FulfillmentTask>>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider.overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Fulfillment Queue'), findsOneWidget);
    });

    testWidgets('displays task list when data loads', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider
                .overrideWith((_) => Future.value(_sampleTasks)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Fulfillment Queue'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      expect(find.text('KNX-000002'), findsOneWidget);
      expect(find.text('KNX-000003'), findsOneWidget);
      expect(find.text('Jane Admin'), findsNWidgets(2));
      expect(find.text('Unassigned'), findsOneWidget);
    });

    testWidgets('shows empty state when no tasks', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider
                .overrideWith((_) => Future.value(<FulfillmentTask>[])),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('No fulfillment tasks'), findsOneWidget);
    });

    testWidgets('shows error state with retry', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider
                .overrideWith((_) => Future.error('Network error')),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(
          find.textContaining('Failed to load tasks'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('data table has correct column headers', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider
                .overrideWith((_) => Future.value(_sampleTasks)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Order #'), findsOneWidget);
      expect(find.text('Status'), findsOneWidget);
      expect(find.text('Priority'), findsOneWidget);
      expect(find.text('Assigned To'), findsOneWidget);
      expect(find.text('Created'), findsOneWidget);
      expect(find.text('Actions'), findsOneWidget);
    });

    testWidgets('shows quick action buttons for progressable tasks',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentListProvider
                .overrideWith((_) => Future.value(_sampleTasks)),
          ],
          child: const MaterialApp(
              home: Scaffold(body: FulfillmentScreen())),
        ),
      );
      await tester.pumpAndSettle();

      // task-1 is 'new' -> can Assign
      expect(find.text('Assign'), findsOneWidget);
      // task-2 is 'picking' -> can Mark Picked
      expect(find.text('Mark Picked'), findsOneWidget);
      // task-3 is 'blocked' -> no quick action
    });
  });

  group('FulfillmentDetailScreen', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      final completer = Completer<FulfillmentTask>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentDetailProvider('task-1')
                .overrideWith((_) => completer.future),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: FulfillmentDetailScreen(taskId: 'task-1')),
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('displays task detail with workflow actions',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final task = _sampleTasks[0]; // new, high priority
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentDetailProvider('task-1')
                .overrideWith((_) => Future.value(task)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: FulfillmentDetailScreen(taskId: 'task-1')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Fulfillment Task'), findsOneWidget);
      expect(find.text('Task Details'), findsOneWidget);
      expect(find.text('task-1'), findsOneWidget);
      expect(find.text('KNX-000001'), findsOneWidget);
      expect(find.text('high'), findsWidgets);
      expect(find.text('Unassigned'), findsOneWidget);
      // Workflow actions for 'new' task
      expect(find.text('Assign'), findsWidgets);
      expect(find.text('Block'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
    });

    testWidgets('blocked task shows unblock and blocked reason',
        (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final task = _sampleTasks[2]; // blocked
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fulfillmentDetailProvider('task-3')
                .overrideWith((_) => Future.value(task)),
          ],
          child: const MaterialApp(
            home: Scaffold(
                body: FulfillmentDetailScreen(taskId: 'task-3')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Missing inventory'), findsOneWidget);
      expect(find.text('Unblock'), findsOneWidget);
    });
  });
}
