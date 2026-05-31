import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'core/config/pricing_config.dart';
import 'core/config/service_area_config.dart';
import 'core/push/push_service.dart';
import 'core/storage/token_store.dart';
import 'core/theme/theme.dart';
import 'features/auth/presentation/auth_notifier.dart';
import 'features/auth/presentation/login_screen.dart';
import 'features/dashboard/presentation/dashboard_notifier.dart';
import 'features/dashboard/presentation/home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  await TokenStore.init();
  await pushService.init();
  // Already-logged-in users: register the FCM token now so existing devices
  // start receiving pushes without needing to re-login.
  if (TokenStore.hasToken()) {
    unawaited(pushService.registerWithBackend());
  }
  // Fire-and-forget: defaults match backend, so UI is usable before this returns.
  unawaited(PricingConfig.instance.load());
  unawaited(ServiceAreaConfig.instance.load());
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Parsalo',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      home: const AppRoot(),
    );
  }
}

class AppRoot extends StatefulWidget {
  const AppRoot({super.key});

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  final AuthNotifier _authNotifier = AuthNotifier();
  final DashboardNotifier _dashboardNotifier = DashboardNotifier();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _authNotifier,
      builder: (context, _) {
        if (_authNotifier.isAuthenticated) {
          return HomeScreen(
            authNotifier: _authNotifier,
            dashboardNotifier: _dashboardNotifier,
          );
        } else {
          return LoginScreen(
            authNotifier: _authNotifier,
          );
        }
      },
    );
  }
}
