import 'package:flutter/material.dart';
import '../../../core/theme/theme.dart';
import '../../../core/widgets/brand_button.dart';
import 'auth_notifier.dart';

class OtpScreen extends StatefulWidget {
  final AuthNotifier authNotifier;

  const OtpScreen({Key? key, required this.authNotifier}) : super(key: key);

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final TextEditingController _otpController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  void _verify() async {
    if (_formKey.currentState!.validate()) {
      FocusScope.of(context).unfocus();
      final success = await widget.authNotifier.verifyOtp(_otpController.text.trim());
      if (success && mounted) {
        // Pop back to root or notify main router to rebuild (which automatically routes to Home)
        Navigator.of(context).popUntil((route) => route.isFirst);
      }
    }
  }

  @override
  void dispose() {
    _otpController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final notifier = widget.authNotifier;

    return ListenableBuilder(
      listenable: notifier,
      builder: (context, _) {
        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            elevation: 0,
            leading: IconButton(
              icon: const Icon(Icons.arrow_back_rounded, color: AppColors.textPrimary),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Enter the OTP',
                      style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Sent to ${notifier.phone}',
                      style: const TextStyle(fontSize: 14, color: AppColors.textSecondary),
                    ),
                    const SizedBox(height: 32),

                    // Input Card
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppColors.border, width: 1),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.01),
                            blurRadius: 10,
                            offset: const Offset(0, 4),
                          )
                        ],
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            '6-digit OTP',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
                          ),
                          const SizedBox(height: 12),
                          
                          // OTP digit input
                          TextFormField(
                            controller: _otpController,
                            keyboardType: TextInputType.number,
                            maxLength: 6,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 8,
                              color: AppColors.brand,
                            ),
                            validator: (val) {
                              if (val == null || val.trim().isEmpty) {
                                return 'OTP is required';
                              }
                              if (val.trim().length < 6) {
                                return 'Enter 6 digits';
                              }
                              return null;
                            },
                            decoration: InputDecoration(
                              counterText: '',
                              hintText: '123456',
                              hintStyle: TextStyle(
                                color: AppColors.textMuted.withOpacity(0.5),
                                letterSpacing: 8,
                              ),
                            ),
                          ),
                          
                          if (notifier.error != null) ...[
                            const SizedBox(height: 10),
                            Text(
                              notifier.error!,
                              style: const TextStyle(color: Colors.redAccent, fontSize: 13, fontWeight: FontWeight.w500),
                            ),
                          ],
                          
                          const SizedBox(height: 20),
                          BrandButton(
                            text: 'Verify & continue',
                            loading: notifier.loading,
                            onPressed: _verify,
                          ),
                          const SizedBox(height: 12),
                          
                          TextButton(
                            onPressed: () {
                              notifier.clearError();
                              Navigator.of(context).pop();
                            },
                            child: const Text(
                              'Use a different number',
                              style: TextStyle(color: AppColors.textSecondary, fontSize: 13, fontWeight: FontWeight.w500),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
