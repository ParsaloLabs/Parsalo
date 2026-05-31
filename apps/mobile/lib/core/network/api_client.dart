import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import '../storage/token_store.dart';

class ApiException implements Exception {
  final String message;
  ApiException(this.message);

  @override
  String toString() => message;
}

class ApiClient {
  // Automatically choose base URL based on platform for easy local dev, with override support
  static String get baseUrl {
    const override = String.fromEnvironment('API_URL');
    if (override.isNotEmpty) return override;
    try {
      if (Platform.isAndroid) {
        return 'http://10.0.2.2:4000/api/v1';
      }
    } catch (_) {}
    return 'http://localhost:4000/api/v1';
  }

  static const Map<String, String> friendlyErrors = {
    'invalid_phone': 'Enter a valid mobile number (10 digits, with or without +91).',
    'invalid_input': 'Please check your input and try again.',
    'otp_invalid_or_expired': 'OTP is incorrect or has expired. Resend a new one.',
  };

  static String getFriendlyError(String code) {
    return friendlyErrors[code] ?? code;
  }

  static Future<dynamic> request(
    String path, {
    String method = 'GET',
    dynamic body,
    bool auth = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final Map<String, String> headers = {
      'Content-Type': 'application/json',
    };

    if (auth) {
      final t = TokenStore.getToken();
      if (t != null && t.isNotEmpty) {
        headers['Authorization'] = 'Bearer $t';
      }
    }

    try {
      final http.Response response;
      final bodyStr = body != null ? jsonEncode(body) : null;

      switch (method.toUpperCase()) {
        case 'POST':
          response = await http.post(uri, headers: headers, body: bodyStr);
          break;
        case 'PUT':
          response = await http.put(uri, headers: headers, body: bodyStr);
          break;
        case 'DELETE':
          response = await http.delete(uri, headers: headers, body: bodyStr);
          break;
        default:
          response = await http.get(uri, headers: headers);
      }

      if (response.statusCode == 204) {
        return null;
      }

      final dynamic resJson = jsonDecode(response.body);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return resJson;
      } else {
        String errorMsg = 'An unknown network error occurred';
        if (resJson is Map) {
          errorMsg = resJson['error'] ?? resJson['message'] ?? 'Error ${response.statusCode}';
        }
        throw ApiException(getFriendlyError(errorMsg));
      }
    } on SocketException {
      throw ApiException('Cannot reach the Parsalo server. Please ensure the backend is running at $baseUrl');
    } on FormatException {
      throw ApiException('Malformed response received from the server.');
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException(e.toString());
    }
  }
}
