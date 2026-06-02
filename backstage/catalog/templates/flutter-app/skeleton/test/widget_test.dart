import 'package:flutter_test/flutter_test.dart';
import 'package:${{ values.name | replace("-", "_") }}/main.dart';

void main() {
  testWidgets('App renders home page', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());

    expect(find.text('Welcome!'), findsOneWidget);
    expect(find.text('${{ values.name }}'), findsOneWidget);
  });
}
