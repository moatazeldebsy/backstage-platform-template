{% if values.enableFirebase %}import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
{% endif %}import 'package:flutter/material.dart';

// A top-level constant so no formatted line's length depends on the app name:
// inlined, a long name made `dart format --set-exit-if-changed` fail on the
// first CI run. The widget test reads it too.
const appTitle = '${{ values.name }}';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
{% if values.enableFirebase %}  await Firebase.initializeApp();
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
{% endif %}  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: appTitle,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      home: const HomePage(title: appTitle),
    );
  }
}

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: Text(title),
      ),
      body: const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Welcome!', style: TextStyle(fontSize: 24)),
            SizedBox(height: 8),
            Text('Scaffolded via the IDP Platform'),
          ],
        ),
      ),
    );
  }
}
