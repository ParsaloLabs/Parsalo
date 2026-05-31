import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/push/push_service.dart';
import '../core/token_storage.dart';
import '../models/admin_kpi.dart';
import '../models/admin_order.dart';
import '../models/pending_agent.dart';
import '../models/dispatch_config.dart';
import '../models/courier_office.dart';
import '../models/service_area.dart';

// ─── Foundation ──────────────────────────────────────────────────────────────

final tokenStorageProvider = Provider<TokenStorage>((ref) => TokenStorage());

final Provider<ApiClient> apiClientProvider = Provider<ApiClient>((ref) {
  final tokens = ref.read(tokenStorageProvider);
  final client = ApiClient(tokens);
  client.onUnauthorized = () {
    ref.read(authStateProvider.notifier).logout();
  };
  return client;
});

// ─── Auth State ──────────────────────────────────────────────────────────────

enum AuthStatus { unknown, signedIn, signedOut }

class AuthStateNotifier extends StateNotifier<AuthStatus> {
  final ApiClient _client;
  final TokenStorage _tokens;

  AuthStateNotifier(this._client, this._tokens) : super(AuthStatus.unknown) {
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final signedIn = await _tokens.hasToken();
    state = signedIn ? AuthStatus.signedIn : AuthStatus.signedOut;
  }

  Future<void> login(String email, String password) async {
    try {
      final res = await _client.dio.post('/auth/admin/login', data: {
        'email': email,
        'password': password,
      });
      final token = res.data['token'];
      if (token != null && token is String) {
        await _tokens.saveToken(token);
        state = AuthStatus.signedIn;
        // Hand the FCM token to the backend so this device starts receiving
        // order/payment alerts immediately after sign-in.
        unawaited(adminPushService.registerWithBackend(_client.dio));
      } else {
        throw Exception('No token returned from server');
      }
    } catch (e) {
      rethrow;
    }
  }

  Future<void> logout() async {
    // Best-effort device-token cleanup BEFORE clearing the JWT — once the
    // bearer is gone the DELETE call will 401.
    await adminPushService.unregisterFromBackend(_client.dio);
    await _tokens.deleteToken();
    state = AuthStatus.signedOut;
  }
}

final StateNotifierProvider<AuthStateNotifier, AuthStatus> authStateProvider =
    StateNotifierProvider<AuthStateNotifier, AuthStatus>((ref) {
  return AuthStateNotifier(
    ref.read(apiClientProvider),
    ref.read(tokenStorageProvider),
  );
});

// ─── Dashboard Stats Provider (Polls every 10s) ──────────────────────────────

final dashboardStatsProvider =
    StreamProvider.autoDispose<AdminKpis>((ref) {
  final client = ref.read(apiClientProvider);
  final controller = StreamController<AdminKpis>();
  Timer? timer;
  var cancelled = false;

  Future<void> tick() async {
    try {
      final res = await client.dio.get('/admin/dashboard-stats');
      if (!cancelled && res.data != null) {
        controller.add(AdminKpis.fromJson(res.data));
      }
    } catch (e) {
      if (!cancelled) controller.addError(e);
    }
  }

  tick();
  timer = Timer.periodic(const Duration(seconds: 10), (_) => tick());

  ref.onDispose(() {
    cancelled = true;
    timer?.cancel();
    controller.close();
  });

  return controller.stream;
});

// ─── Orders Feed Provider ──────────────────────────────────────────────────

class OrdersFeedNotifier extends StateNotifier<AsyncValue<List<AdminOrder>>> {
  final ApiClient _client;
  String? _currentStatus;

  OrdersFeedNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchOrders({String? status}) async {
    _currentStatus = status;
    state = const AsyncValue.loading();
    try {
      final queryParams = <String, dynamic>{'limit': 100};
      if (status != null && status != 'all') {
        queryParams['status'] = status;
      }
      final res = await _client.dio.get('/admin/orders', queryParameters: queryParams);
      final raw = res.data;
      if (raw is List) {
        final list = raw.map((j) => AdminOrder.fromJson(j)).toList();
        state = AsyncValue.data(list);
      } else {
        state = AsyncValue.error('Invalid response format', StackTrace.current);
      }
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> refresh() async {
    await fetchOrders(status: _currentStatus);
  }
}

final ordersFeedProvider =
    StateNotifierProvider.autoDispose<OrdersFeedNotifier, AsyncValue<List<AdminOrder>>>((ref) {
  final notifier = OrdersFeedNotifier(ref.read(apiClientProvider));
  notifier.fetchOrders(status: 'all');
  return notifier;
});

// ─── Pending Agents Provider ───────────────────────────────────────────────

class PendingAgentsNotifier extends StateNotifier<AsyncValue<List<PendingAgent>>> {
  final ApiClient _client;

  PendingAgentsNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchPending() async {
    state = const AsyncValue.loading();
    try {
      final res = await _client.dio.get('/admin/agents/pending');
      final raw = res.data;
      if (raw is List) {
        final list = raw.map((j) => PendingAgent.fromJson(j)).toList();
        state = AsyncValue.data(list);
      } else {
        state = AsyncValue.error('Invalid response format', StackTrace.current);
      }
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> approveAgent(String id) async {
    try {
      await _client.dio.post('/admin/agents/$id/approve');
      await fetchPending();
    } catch (e) {
      rethrow;
    }
  }

  Future<void> rejectAgent(String id, String reason) async {
    try {
      await _client.dio.post('/admin/agents/$id/reject', data: {'reason': reason});
      await fetchPending();
    } catch (e) {
      rethrow;
    }
  }
}

final pendingAgentsProvider =
    StateNotifierProvider.autoDispose<PendingAgentsNotifier, AsyncValue<List<PendingAgent>>>((ref) {
  final notifier = PendingAgentsNotifier(ref.read(apiClientProvider));
  notifier.fetchPending();
  return notifier;
});

// ─── Approved Active Agents Provider (for assignment dialog) ───────────────

final approvedAgentsProvider =
    FutureProvider.autoDispose<List<ApprovedAgent>>((ref) async {
  final client = ref.read(apiClientProvider);
  final res = await client.dio.get('/admin/agents');
  final raw = res.data;
  if (raw is List) {
    return raw.map((j) => ApprovedAgent.fromJson(j)).toList();
  }
  return [];
});

// ─── Dispatch Config Provider ───────────────────────────────────────────────

class DispatchConfigNotifier extends StateNotifier<AsyncValue<DispatchConfig>> {
  final ApiClient _client;

  DispatchConfigNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchConfig() async {
    state = const AsyncValue.loading();
    try {
      final res = await _client.dio.get('/admin/dispatch-config');
      state = AsyncValue.data(DispatchConfig.fromJson(res.data));
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> updateConfig(int radiusM, int ttlSeconds) async {
    try {
      final res = await _client.dio.post('/admin/dispatch-config', data: {
        'initial_radius_m': radiusM,
        'offer_ttl_seconds': ttlSeconds,
      });
      state = AsyncValue.data(DispatchConfig.fromJson(res.data));
    } catch (e) {
      rethrow;
    }
  }
}

final dispatchConfigProvider =
    StateNotifierProvider.autoDispose<DispatchConfigNotifier, AsyncValue<DispatchConfig>>((ref) {
  final notifier = DispatchConfigNotifier(ref.read(apiClientProvider));
  notifier.fetchConfig();
  return notifier;
});

// ─── Courier Offices & Radius Gating Providers ───────────────────────────────

class RadiusGateState {
  final bool enabled;
  final double radiusKm;
  RadiusGateState({required this.enabled, required this.radiusKm});
}

class RadiusGateNotifier extends StateNotifier<AsyncValue<RadiusGateState>> {
  final ApiClient _client;

  RadiusGateNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchFlags() async {
    state = const AsyncValue.loading();
    try {
      final res = await _client.dio.get('/admin/flags');
      final data = res.data;
      final bool enabled = data['service_area_radius_enabled'] == true;
      final rawRadius = data['service_area_radius_m'];
      final meters = rawRadius is num ? rawRadius.toDouble() : double.tryParse(rawRadius?.toString() ?? '') ?? 15000.0;
      final double radiusKm = meters / 1000.0;
      state = AsyncValue.data(RadiusGateState(enabled: enabled, radiusKm: radiusKm));
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> toggleRadius(bool value) async {
    try {
      await _client.dio.put('/admin/flags/service_area_radius_enabled', data: {'value': value});
      if (state.hasValue) {
        final current = state.value!;
        state = AsyncValue.data(RadiusGateState(enabled: value, radiusKm: current.radiusKm));
      }
    } catch (e) {
      rethrow;
    }
  }

  Future<void> saveRadius(double radiusKm) async {
    try {
      final int meters = (radiusKm * 1000).round();
      await _client.dio.put('/admin/flags/service_area_radius_m', data: {'value': meters});
      if (state.hasValue) {
        final current = state.value!;
        state = AsyncValue.data(RadiusGateState(enabled: current.enabled, radiusKm: radiusKm));
      }
    } catch (e) {
      rethrow;
    }
  }
}

final radiusGateProvider =
    StateNotifierProvider.autoDispose<RadiusGateNotifier, AsyncValue<RadiusGateState>>((ref) {
  final notifier = RadiusGateNotifier(ref.read(apiClientProvider));
  notifier.fetchFlags();
  return notifier;
});

final couriersListProvider = FutureProvider.autoDispose<List<Courier>>((ref) async {
  final client = ref.read(apiClientProvider);
  final res = await client.dio.get('/couriers');
  final raw = res.data;
  if (raw is List) {
    return raw.map((j) => Courier.fromJson(j)).toList();
  }
  return [];
});

class CourierOfficesNotifier extends StateNotifier<AsyncValue<List<CourierOffice>>> {
  final ApiClient _client;

  CourierOfficesNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchOffices() async {
    state = const AsyncValue.loading();
    try {
      final res = await _client.dio.get('/admin/courier-branches');
      final raw = res.data;
      if (raw is List) {
        final list = raw.map((j) => CourierOffice.fromJson(j)).toList();
        state = AsyncValue.data(list);
      } else {
        state = AsyncValue.error('Invalid response format', StackTrace.current);
      }
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> saveOffice({
    String? id,
    required String courierId,
    required String name,
    required String district,
    required String fullAddress,
    required String pincode,
    String? phone,
    String? openingHours,
    required double latitude,
    required double longitude,
  }) async {
    try {
      final payload = {
        'id': ?id,
        'courier_id': courierId,
        'name': name.trim(),
        'district': district.trim(),
        'full_address': fullAddress.trim(),
        'pincode': pincode.trim(),
        if (phone != null && phone.trim().isNotEmpty) 'phone': phone.trim(),
        if (openingHours != null && openingHours.trim().isNotEmpty) 'opening_hours': openingHours.trim(),
        'latitude': latitude,
        'longitude': longitude,
      };
      await _client.dio.post('/admin/courier-branches', data: payload);
      await fetchOffices();
    } catch (e) {
      rethrow;
    }
  }

  Future<void> deleteOffice(String id) async {
    try {
      await _client.dio.delete('/admin/courier-branches/$id');
      await fetchOffices();
    } catch (e) {
      rethrow;
    }
  }
}

final courierOfficesProvider =
    StateNotifierProvider.autoDispose<CourierOfficesNotifier, AsyncValue<List<CourierOffice>>>((ref) {
  final notifier = CourierOfficesNotifier(ref.read(apiClientProvider));
  notifier.fetchOffices();
  return notifier;
});

// ─── Service Areas Providers ───────────────────────────────────────────────────

class ServiceAreasNotifier extends StateNotifier<AsyncValue<List<ServiceArea>>> {
  final ApiClient _client;

  ServiceAreasNotifier(this._client) : super(const AsyncValue.loading());

  Future<void> fetchAreas() async {
    state = const AsyncValue.loading();
    try {
      final res = await _client.dio.get('/admin/service-areas');
      final raw = res.data;
      if (raw is List) {
        final list = raw.map((j) => ServiceArea.fromJson(j)).toList();
        state = AsyncValue.data(list);
      } else {
        state = AsyncValue.error('Invalid response format', StackTrace.current);
      }
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> saveArea({
    String? id,
    required String name,
    required double centerLat,
    required double centerLng,
    required int radiusM,
    required bool isActive,
  }) async {
    try {
      final payload = {
        'id': ?id,
        'name': name.trim(),
        'center_lat': centerLat,
        'center_lng': centerLng,
        'radius_m': radiusM,
        'is_active': isActive,
      };
      await _client.dio.post('/admin/service-areas', data: payload);
      await fetchAreas();
    } catch (e) {
      rethrow;
    }
  }

  Future<void> deleteArea(String id) async {
    try {
      await _client.dio.delete('/admin/service-areas/$id');
      await fetchAreas();
    } catch (e) {
      rethrow;
    }
  }
}

final serviceAreasProvider =
    StateNotifierProvider.autoDispose<ServiceAreasNotifier, AsyncValue<List<ServiceArea>>>((ref) {
  final notifier = ServiceAreasNotifier(ref.read(apiClientProvider));
  notifier.fetchAreas();
  return notifier;
});
