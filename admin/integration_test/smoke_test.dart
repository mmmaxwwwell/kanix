import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:patrol/patrol.dart';
import 'package:kanix_admin/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('Admin app smoke tests', () {
    patrolTest('app launches and shows login screen', ($) async {
      app.main();
      await $.pumpAndSettle();

      expect($('Kanix Admin'), findsWidgets);
    });

    patrolTest('app renders navigation', ($) async {
      app.main();
      await $.pumpAndSettle();

      // Verify the app starts without crashing
      expect(find.byType(app.KanixAdminApp), findsOneWidget);
    });
  });
}
