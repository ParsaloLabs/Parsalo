import 'dart:async';
import 'dart:io' show Platform;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../core/api_client.dart';
import '../core/token_storage.dart';
import '../models/agent_profile.dart';
import '../models/profits.dart';
import '../services/agent_service.dart';
import '../services/auth_service.dart';
import '../services/directions_service.dart';
import '../services/location_service.dart';
import '../services/push_service.dart';

// ─── Foundation ──────────────────────────────────────────────────────────────

final tokenStorageProvider = Provider<TokenStorage>((ref) => TokenStorage());

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(ref.read(tokenStorageProvider));
});

final authServiceProvider = Provider<AuthService>((ref) {
  return AuthService(
    ref.read(apiClientProvider),
    ref.read(tokenStorageProvider),
  );
});

final agentServiceProvider = Provider<AgentService>((ref) {
  return AgentService(ref.read(apiClientProvider));
});

final locationServiceProvider = Provider<LocationService>((ref) {
  return LocationService(ref.read(agentServiceProvider));
});

final directionsServiceProvider = Provider<DirectionsService>((ref) {
  return DirectionsService();
});

// ─── Auth state ──────────────────────────────────────────────────────────────

enum AuthStatus { unknown, signedIn, signedOut }

class AuthStateNotifier extends StateNotifier<AuthStatus> {
  final AuthService _auth;
  final AgentService _agent;
  StreamSubscription<String>? _tokenSub;

  AuthStateNotifier(this._auth, this._agent) : super(AuthStatus.unknown) {
    _tokenSub = pushService.tokenChanges.listen((t) {
      if (state == AuthStatus.signedIn) unawaited(_pushToken(t));
    });
    _bootstrap();
  }

  @override
  void dispose() {
    _tokenSub?.cancel();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final signedIn = await _auth.hasSession();
    state = signedIn ? AuthStatus.signedIn : AuthStatus.signedOut;
    if (signedIn) unawaited(_syncPushToken());
  }

  Future<void> login(String phone, String password) async {
    await _auth.login(phone, password);
    state = AuthStatus.signedIn;
    unawaited(_syncPushToken());
  }

  Future<void> logout() async {
    final token = pushService.currentToken;
    if (token != null) {
      unawaited(_agent.unregisterDeviceToken(token));
    }
    await _auth.logout();
    state = AuthStatus.signedOut;
  }

  /// Resolve the FCM token (re-fetching if the cached value is null) and POST
  /// it. On cold launch the cached field can still be null while FCM is
  /// finishing registration — `ensureToken` handles that race.
  Future<void> _syncPushToken() async {
    final token = await pushService.ensureToken();
    if (token == null || token.isEmpty) return;
    await _pushToken(token);
  }

  Future<void> _pushToken(String token) async {
    final platform = Platform.isIOS ? 'ios' : 'android';
    await _agent.registerDeviceToken(token, platform);
  }
}

final authStateProvider =
    StateNotifierProvider<AuthStateNotifier, AuthStatus>((ref) {
  return AuthStateNotifier(
    ref.read(authServiceProvider),
    ref.read(agentServiceProvider),
  );
});

// ─── Agent profile (loaded once on sign-in) ──────────────────────────────────

final agentProfileProvider = FutureProvider<AgentProfile>((ref) async {
  return ref.read(agentServiceProvider).getMe();
});

// ─── Jobs + profits dashboard feed (polls every 8s) ──────────────────────────

class DashboardSnapshot {
  final JobsResponse jobs;
  final Profits profits;
  const DashboardSnapshot({required this.jobs, required this.profits});
}

final dashboardFeedProvider =
    StreamProvider.autoDispose<DashboardSnapshot>((ref) {
  final svc = ref.read(agentServiceProvider);
  final controller = StreamController<DashboardSnapshot>();
  Timer? timer;
  var cancelled = false;

  Future<void> tick() async {
    try {
      final jobs = await svc.getJobs();
      final profits = await svc.getProfits();
      if (!cancelled) {
        controller.add(DashboardSnapshot(jobs: jobs, profits: profits));
      }
    } catch (e) {
      if (!cancelled) controller.addError(e);
    }
  }

  tick();
  timer = Timer.periodic(const Duration(seconds: 8), (_) => tick());

  ref.onDispose(() {
    cancelled = true;
    timer?.cancel();
    controller.close();
  });

  return controller.stream;
});

// ─── Online status ───────────────────────────────────────────────────────────

class OnlineStatusNotifier extends StateNotifier<bool> {
  final AgentService _agent;
  final LocationService _location;

  OnlineStatusNotifier(this._agent, this._location, bool initial)
      : super(initial);

  Future<void> setOnline(bool next) async {
    final previous = state;
    state = next;
    try {
      await _agent.setOnline(next);
      if (next) {
        try {
          await _location.start();
        } catch (e) {
          // Revert online if we can't get location.
          await _agent.setOnline(false);
          state = previous;
          rethrow;
        }
      } else {
        await _location.stop();
      }
    } catch (e) {
      state = previous;
      rethrow;
    }
  }
}

final onlineStatusProvider =
    StateNotifierProvider<OnlineStatusNotifier, bool>((ref) {
  final profile = ref.watch(agentProfileProvider).valueOrNull;
  return OnlineStatusNotifier(
    ref.read(agentServiceProvider),
    ref.read(locationServiceProvider),
    profile?.isOnline ?? false,
  );
});

// ─── Per-shift dispatch-cap override ─────────────────────────────────────────

class AcceptExtraOrdersNotifier extends StateNotifier<bool> {
  final AgentService _agent;

  AcceptExtraOrdersNotifier(this._agent, bool initial) : super(initial);

  Future<void> setEnabled(bool next) async {
    final previous = state;
    state = next;
    try {
      await _agent.setAcceptExtraOrders(next);
    } catch (e) {
      state = previous;
      rethrow;
    }
  }

  // Server auto-clears the flag when the agent goes offline. Mirror that here
  // so the UI doesn't show the switch as "on" until the next /me poll.
  void resetLocal() {
    if (state) state = false;
  }
}

final acceptExtraOrdersProvider =
    StateNotifierProvider<AcceptExtraOrdersNotifier, bool>((ref) {
  final profile = ref.watch(agentProfileProvider).valueOrNull;
  final notifier = AcceptExtraOrdersNotifier(
    ref.read(agentServiceProvider),
    profile?.acceptExtraOrders ?? false,
  );
  ref.listen<bool>(onlineStatusProvider, (prev, next) {
    if (!next) notifier.resetLocal();
  });
  // Server auto-clears accept_extra_orders once active load drops below the
  // global cap. Mirror that locally as soon as the dashboard reports <2.
  ref.listen<AsyncValue<DashboardSnapshot>>(dashboardFeedProvider, (prev, next) {
    next.whenData((snap) {
      if (snap.jobs.assigned.length < 2) notifier.resetLocal();
    });
  });
  return notifier;
});

// ─── Dismissed offer ids (session-scoped, no server roundtrip) ───────────────

class DismissedOffersNotifier extends StateNotifier<Set<String>> {
  DismissedOffersNotifier() : super(const <String>{});

  void dismiss(String id) {
    if (state.contains(id)) return;
    state = {...state, id};
  }

  void prune(Set<String> stillAvailable) {
    final next = state.intersection(stillAvailable);
    if (next.length != state.length) state = next;
  }

  void clear() {
    if (state.isEmpty) return;
    state = const <String>{};
  }
}

final dismissedOffersProvider =
    StateNotifierProvider<DismissedOffersNotifier, Set<String>>((ref) {
  return DismissedOffersNotifier();
});

// ─── Live agent position (auto-disposes when no listeners) ───────────────────

final agentPositionProvider = StreamProvider.autoDispose<Position>((ref) {
  return ref.read(locationServiceProvider).positions;
});

// ─── One-shot current-locality label for the dashboard hero ──────────────────
// Permission-passive: only fetches if the user has already granted location.
// We don't want this side-effect to surface a permission prompt — the duty
// toggle is the canonical permission moment.

final currentLocationLabelProvider =
    FutureProvider.autoDispose<String>((ref) async {
  final servicesOn = await Geolocator.isLocationServiceEnabled();
  if (!servicesOn) return 'Location off';

  final perm = await Geolocator.checkPermission();
  if (perm == LocationPermission.denied ||
      perm == LocationPermission.deniedForever) {
    return 'Permission off';
  }

  final Position pos;
  try {
    pos = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.low,
        timeLimit: Duration(seconds: 8),
      ),
    );
  } catch (_) {
    return 'Unavailable';
  }

  // Reverse geocode via BigDataCloud's free client endpoint. No key, CORS-
  // open — same provider the agent web app uses, so the two stay in sync.
  try {
    final res = await Dio().get<Map<String, dynamic>>(
      'https://api.bigdatacloud.net/data/reverse-geocode-client',
      queryParameters: {
        'latitude': pos.latitude,
        'longitude': pos.longitude,
        'localityLanguage': 'en',
      },
      options: Options(receiveTimeout: const Duration(seconds: 6)),
    );
    final d = res.data ?? const <String, dynamic>{};
    final name = (d['locality'] ??
            d['city'] ??
            d['principalSubdivision'] ??
            '')
        .toString();
    if (name.isNotEmpty) return name;
  } catch (_) {
    // Fall through to coords.
  }
  return '${pos.latitude.toStringAsFixed(3)}, ${pos.longitude.toStringAsFixed(3)}';
});
