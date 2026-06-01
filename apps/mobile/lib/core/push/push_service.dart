import 'dart:async';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../network/api_client.dart';

const String _channelId = 'order_updates';
const String _channelName = 'Order updates';

/// Background isolate handler. Firebase already renders system tray
/// notifications when payload contains a `notification` block, so this stays
/// empty intentionally.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage _) async {}

/// Owns FCM lifecycle for the customer app: permission, token, foreground
/// display, and a tap stream the app can listen to for deep-linking into
/// the matching order detail screen.
class PushService {
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
          description: 'Updates on your orders — pickup, delivery, etc.',
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

  /// Re-fetch the token (sometimes null on cold launch while Play Services
  /// finishes registration) and POST it to the backend so the user starts
  /// receiving pushes for their orders.
  Future<void> registerWithBackend() async {
    if (_registering) return;
    _registering = true;
    try {
      _token ??= await FirebaseMessaging.instance.getToken();
      await _registerCurrentToken();
    } finally {
      _registering = false;
    }
  }

  Future<void> _registerCurrentToken() async {
    final t = _token;
    if (t == null || t.isEmpty) return;
    try {
      await ApiClient.request(
        '/device-token',
        method: 'POST',
        body: {
          'token': t,
          'platform': Platform.isAndroid ? 'android' : 'ios',
        },
      );
    } catch (e) {
      debugPrint('[push] register failed: $e');
    }
  }

  Future<void> unregisterFromBackend() async {
    final t = _token;
    if (t == null || t.isEmpty) return;
    try {
      await ApiClient.request(
        '/device-token',
        method: 'DELETE',
        body: {'token': t},
      );
    } catch (e) {
      debugPrint('[push] unregister failed: $e');
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

/// Singleton — wiring is bootstrap, not state, so no need to thread it through
/// providers.
final PushService pushService = PushService();
