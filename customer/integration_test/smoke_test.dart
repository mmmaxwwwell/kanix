import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:patrol/patrol.dart';
import 'package:kanix_customer/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('Customer app smoke tests', () {
    patrolTest('app launches and shows home screen', ($) async {
      app.main();
      await $.pumpAndSettle();

      expect($('Kanix'), findsWidgets);
    });

    patrolTest('app renders navigation', ($) async {
      app.main();
      await $.pumpAndSettle();

      // Verify the app starts without crashing
      expect(find.byType(app.KanixCustomerApp), findsOneWidget);
    });
  });
}
