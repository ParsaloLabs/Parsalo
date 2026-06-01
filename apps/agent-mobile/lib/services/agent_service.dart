import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../models/agent_profile.dart';
import '../models/order.dart';
import '../models/profits.dart';

class JobsResponse {
  final List<AgentOrder> assigned;
  final List<AgentOrder> offered;
  const JobsResponse({required this.assigned, required this.offered});
}

class HistoryResponse {
  final List<AgentOrder> orders;
  final int total;
  const HistoryResponse({required this.orders, required this.total});
}

class AgentService {
  final ApiClient _api;
  AgentService(this._api);

  Future<AgentProfile> getMe() async {
    try {
      final res = await _api.dio.get<Map<String, dynamic>>('/agent/me');
      return AgentProfile.fromJson(res.data!);
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<JobsResponse> getJobs() async {
    try {
      final res = await _api.dio.get<Map<String, dynamic>>('/agent/jobs');
      final data = res.data!;
      final assigned = (data['assigned'] as List)
          .map((j) => AgentOrder.fromJson(j as Map<String, dynamic>))
          .toList();
      final offered = (data['offered'] as List? ?? const [])
          .map((j) => AgentOrder.fromJson(j as Map<String, dynamic>))
          .toList();
      return JobsResponse(assigned: assigned, offered: offered);
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<Profits> getProfits() async {
    try {
      final res = await _api.dio.get<Map<String, dynamic>>('/agent/profits');
      return Profits.fromJson(res.data!);
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<void> setOnline(bool isOnline) async {
    try {
      await _api.dio.post('/agent/online-status', data: {'is_online': isOnline});
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<void> setAcceptExtraOrders(bool enabled) async {
    try {
      await _api.dio.post(
        '/agent/accept-extra-orders',
        data: {'enabled': enabled},
      );
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<void> postLocation(double lat, double lng) async {
    try {
      await _api.dio.post('/agent/location', data: {'lat': lat, 'lng': lng});
    } on DioException catch (_) {
      // Location pings are fire-and-forget; ignore failures.
    }
  }

  Future<void> registerDeviceToken(String token, String platform) async {
    try {
      await _api.dio.post(
        '/agent/device-token',
        data: {'token': token, 'platform': platform},
      );
      debugPrint('[push] device-token registered (platform=$platform)');
    } on DioException catch (e) {
      // Best-effort: agent still sees offers via the 8s dashboard poll. But
      // log so we can tell when push is silently broken.
      debugPrint(
        '[push] device-token register FAILED '
        'status=${e.response?.statusCode} body=${e.response?.data} msg=${e.message}',
      );
    }
  }

  Future<void> unregisterDeviceToken(String token) async {
    try {
      await _api.dio.delete('/agent/device-token', data: {'token': token});
    } on DioException catch (e) {
      debugPrint('[push] device-token unregister failed: ${e.message}');
    }
  }

  Future<void> acceptJob(String id) async {
    try {
      await _api.dio.post('/agent/jobs/$id/accept');
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<void> declineJob(String id) async {
    try {
      await _api.dio.post('/agent/jobs/$id/decline');
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<void> updateStatus(
    String id, {
    required String status,
    String? deliveryOtp,
    String? failureReason,
    String? notes,
    String? photoUrl,
    double? lat,
    double? lng,
  }) async {
    try {
      final body = <String, dynamic>{'status': status};
      if (deliveryOtp != null) body['delivery_otp'] = deliveryOtp;
      if (failureReason != null) body['failure_reason'] = failureReason;
      if (notes != null) body['notes'] = notes;
      if (photoUrl != null) body['photo_url'] = photoUrl;
      if (lat != null && lng != null) {
        body['location'] = {'lat': lat, 'lng': lng};
      }
      await _api.dio.post('/agent/jobs/$id/update-status', data: body);
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<Uint8List> downloadAuthorizationPdf(String orderId) async {
    try {
      final res = await _api.dio.get<List<int>>(
        '/orders/$orderId/authorization.pdf',
        options: Options(responseType: ResponseType.bytes),
      );
      return Uint8List.fromList(res.data!);
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }

  Future<HistoryResponse> getHistory({int limit = 30, int offset = 0}) async {
    try {
      final res = await _api.dio.get<Map<String, dynamic>>(
        '/agent/history',
        queryParameters: {'limit': limit, 'offset': offset},
      );
      final data = res.data!;
      final orders = (data['orders'] as List)
          .map((j) => AgentOrder.fromJson(j as Map<String, dynamic>))
          .toList();
      return HistoryResponse(
        orders: orders,
        total: (data['total'] as num?)?.toInt() ?? 0,
      );
    } on DioException catch (e) {
      throw extractErrorCode(e);
    }
  }
}
