import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

const String _channelId = 'admin_alerts';
const String _channelName = 'Order alerts';

/// Background isolate handler — Firebase renders the system notification when
/// the payload contains a `notification` block, so the Dart side stays empty.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage _) async {}

/// Owns FCM lifecycle for the admin app: permission, token, foreground
/// display, register/unregister with the backend, and the per-device
/// push_enabled preference toggle.
class AdminPushService {
  final FlutterLocalNotificationsPlugin _local =
      FlutterLocalNotificationsPlugin();
  final StreamController<RemoteMessage> _taps =
      StreamController<RemoteMessage>.broadcast();

  String? _token;
  bool _ready = false;
  bool _registering = false;

  Stream<RemoteMessage> get taps => _taps.stream;
  String? get currentToken => _token;

  Future<void> init() async {
    if (_ready) return;
    _ready = true;

    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@drawable/ic_notification'),
      ),
    );

    await _local
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(const AndroidNotificationChannel(
          _channelId,
          _channelName,
          description: 'New orders, payments, cancellations and failures.',
          importance: Importance.high,
        ));

    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);

    _token = await messaging.getToken();
    messaging.onTokenRefresh.listen((t) async {
      _token = t;
      await _registerCurrentToken();
    });

    FirebaseMessaging.onMessage.listen(_onForegroundMessage);
    FirebaseMessaging.onMessageOpenedApp.listen(_taps.add);
    final initial = await messaging.getInitialMessage();
    if (initial != null) _taps.add(initial);
  }

  /// POST the current token to the backend. Cold launch can return null while
  /// Play Services finishes registering, so we re-fetch once before giving up.
  Future<void> registerWithBackend(Dio dio) async {
    if (_registering) return;
    _registering = true;
    try {
      _token ??= await FirebaseMessaging.instance.getToken();
      await _registerCurrentToken(dio: dio);
    } finally {
      _registering = false;
    }
  }

  Dio? _dio;
  Future<void> _registerCurrentToken({Dio? dio}) async {
    if (dio != null) _dio = dio;
    final client = _dio;
    final t = _token;
    if (client == null || t == null || t.isEmpty) return;
    try {
      await client.post('/admin/device-token', data: {
        'token': t,
        'platform': Platform.isAndroid ? 'android' : 'ios',
      });
    } catch (e) {
      debugPrint('[push] register failed: $e');
    }
  }

  Future<void> unregisterFromBackend(Dio dio) async {
    final t = _token;
    if (t == null || t.isEmpty) return;
    try {
      await dio.delete('/admin/device-token', data: {'token': t});
    } catch (e) {
      debugPrint('[push] unregister failed: $e');
    }
  }

  /// Fetch this device's notification preference from the backend.
  Future<bool?> fetchPreference(Dio dio) async {
    final t = _token;
    if (t == null || t.isEmpty) return null;
    try {
      final res = await dio.get(
        '/admin/device-token/preferences',
        queryParameters: {'token': t},
      );
      final raw = res.data;
      if (raw is Map && raw['push_enabled'] is bool) {
        return raw['push_enabled'] as bool;
      }
      return null;
    } catch (e) {
      debugPrint('[push] fetch pref failed: $e');
      return null;
    }
  }

  /// Flip the on/off flag for this device. Returns true on success.
  Future<bool> setPreference(Dio dio, bool enabled) async {
    final t = _token;
    if (t == null || t.isEmpty) return false;
    try {
      await dio.patch('/admin/device-token/preferences', data: {
        'token': t,
        'push_enabled': enabled,
      });
      return true;
    } catch (e) {
      debugPrint('[push] set pref failed: $e');
      return false;
    }
  }

  Future<void> _onForegroundMessage(RemoteMessage msg) async {
    final n = msg.notification;
    if (n == null) return;
    await _local.show(
      msg.hashCode,
      n.title,
      n.body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
    );
  }
}

/// Singleton — wiring is bootstrap, not state, so no need to thread it
/// through Riverpod providers.
final AdminPushService adminPushService = AdminPushService();
