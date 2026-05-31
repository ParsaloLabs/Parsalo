import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/push/push_service.dart';
import '../../../core/storage/token_store.dart';

class AuthNotifier extends ChangeNotifier {
  bool _loading = false;
  String? _error;
  String _phone = '+91';
  bool _isAuthenticated = false;

  String? _verificationId;
  int? _resendToken;

  bool get loading => _loading;
  String? get error => _error;
  String get phone => _phone;
  bool get isAuthenticated => _isAuthenticated;

  AuthNotifier() {
    _isAuthenticated = TokenStore.hasToken();
  }

  void setPhone(String val) {
    _phone = val;
    notifyListeners();
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }

  Future<bool> sendOtp(String mobileNumber) async {
    _loading = true;
    _error = null;
    _phone = mobileNumber;
    _verificationId = null;
    notifyListeners();

    final completer = Completer<bool>();

    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: mobileNumber,
        timeout: const Duration(seconds: 60),
        forceResendingToken: _resendToken,
        verificationCompleted: (PhoneAuthCredential credential) async {
          // Android auto-retrieval — sign in immediately, no manual OTP entry.
          final ok = await _signInWithCredential(credential);
          if (!completer.isCompleted) completer.complete(ok);
        },
        verificationFailed: (FirebaseAuthException e) {
          _error = _friendlyFirebaseError(e);
          _loading = false;
          notifyListeners();
          if (!completer.isCompleted) completer.complete(false);
        },
        codeSent: (String verificationId, int? resendToken) {
          _verificationId = verificationId;
          _resendToken = resendToken;
          _loading = false;
          notifyListeners();
          if (!completer.isCompleted) completer.complete(true);
        },
        codeAutoRetrievalTimeout: (String verificationId) {
          _verificationId = verificationId;
        },
      );
    } catch (e) {
      _error = e.toString();
      _loading = false;
      notifyListeners();
      if (!completer.isCompleted) completer.complete(false);
    }

    return completer.future;
  }

  Future<bool> verifyOtp(String otpCode) async {
    if (_verificationId == null) {
      _error = 'Session expired. Send OTP again.';
      notifyListeners();
      return false;
    }

    _loading = true;
    _error = null;
    notifyListeners();

    final credential = PhoneAuthProvider.credential(
      verificationId: _verificationId!,
      smsCode: otpCode,
    );
    return _signInWithCredential(credential);
  }

  Future<bool> _signInWithCredential(PhoneAuthCredential credential) async {
    try {
      final userCred =
          await FirebaseAuth.instance.signInWithCredential(credential);
      final idToken = await userCred.user!.getIdToken(true);
      if (idToken == null) throw Exception('No ID token from Firebase');

      final res = await ApiClient.request(
        '/auth/firebase-login',
        method: 'POST',
        body: {'id_token': idToken},
        auth: false,
      );

      final token = res['token'];
      if (token == null) throw ApiException('Invalid token returned from server');

      await TokenStore.setToken(token);
      _isAuthenticated = true;
      _loading = false;
      notifyListeners();
      // Now that we have a session token, hand the FCM token to the backend
      // so this device starts receiving order pushes.
      unawaited(pushService.registerWithBackend());
      return true;
    } on FirebaseAuthException catch (e) {
      _error = _friendlyFirebaseError(e);
      _loading = false;
      notifyListeners();
      return false;
    } catch (e) {
      _error = e is ApiException ? e.message : e.toString();
      _loading = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> logout() async {
    // Best-effort device-token cleanup BEFORE clearing the JWT — once the
    // bearer is gone the DELETE call will 401.
    await pushService.unregisterFromBackend();
    await TokenStore.setToken(null);
    await FirebaseAuth.instance.signOut();
    _isAuthenticated = false;
    notifyListeners();
  }

  String _friendlyFirebaseError(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-phone-number':
        return 'Enter a valid mobile number with country code.';
      case 'too-many-requests':
        return 'Too many attempts. Try again later.';
      case 'invalid-verification-code':
        return 'Wrong OTP. Check and try again.';
      case 'session-expired':
      case 'code-expired':
        return 'OTP expired. Request a new one.';
      case 'quota-exceeded':
        return 'Daily SMS quota reached. Try later.';
      case 'app-not-authorized':
        return 'App not authorised for OTP. Check Firebase SHA fingerprints.';
      default:
        return e.message ?? e.code;
    }
  }
}
