import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/push/push_service.dart';
import 'core/theme.dart';
import 'core/token_storage.dart';
import 'core/api_client.dart';
import 'router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.dark,
  ));

  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  await adminPushService.init();

  // Already-logged-in admins: register the FCM token now so existing devices
  // resume receiving alerts without needing to re-login.
  final tokens = TokenStorage();
  if (await tokens.hasToken()) {
    final dio = ApiClient(tokens).dio;
    unawaited(adminPushService.registerWithBackend(dio));
  }

  runApp(
    const ProviderScope(
      child: ParsaloAdminApp(),
    ),
  );
}

class ParsaloAdminApp extends ConsumerWidget {
  const ParsaloAdminApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      title: 'Parsalo Admin',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      routerConfig: router,
    );
  }
}
