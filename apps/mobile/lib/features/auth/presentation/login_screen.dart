import 'package:flutter/material.dart';
import '../../../core/theme/theme.dart';
import '../../../core/widgets/brand_button.dart';
import 'auth_notifier.dart';
import 'otp_screen.dart';

class LoginScreen extends StatefulWidget {
  final AuthNotifier authNotifier;

  const LoginScreen({Key? key, required this.authNotifier}) : super(key: key);

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _phoneController = TextEditingController(text: '+91');
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _phoneController.dispose();
    super.dispose();
  }

  void _submit() async {
    if (_formKey.currentState!.validate()) {
      FocusScope.of(context).unfocus();
      final success = await widget.authNotifier.sendOtp(_phoneController.text.trim());
      // If Android auto-retrieval signed the user in, AppRoot will swap to HomeScreen — skip OTP screen.
      if (success && mounted && !widget.authNotifier.isAuthenticated) {
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (context) => OtpScreen(authNotifier: widget.authNotifier),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final notifier = widget.authNotifier;

    return ListenableBuilder(
      listenable: notifier,
      builder: (context, _) {
        return Scaffold(
          backgroundColor: AppColors.background,
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 8),
                    // Logo Image (compact)
                    Center(
                      child: Container(
                        height: 64,
                        width: 64,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.brand.withOpacity(0.15),
                              blurRadius: 16,
                              offset: const Offset(0, 6),
                            )
                          ],
                        ),
                        child: ClipOval(
                          child: Image.asset(
                            'assets/logo.png',
                            fit: BoxFit.contain,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Welcome Slogan (compact)
                    Text(
                      'Skip the courier queue.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 20),

                    // Input Card — moved up so it's visible without scrolling
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.02),
                            blurRadius: 10,
                            offset: const Offset(0, 4),
                          )
                        ],
                        border: Border.all(color: AppColors.border, width: 1),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            'Sign in to book',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            "We'll text you a 6-digit verification code",
                            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                          ),
                          const SizedBox(height: 16),

                          // Mobile Input
                          TextFormField(
                            controller: _phoneController,
                            keyboardType: TextInputType.phone,
                            validator: (val) {
                              if (val == null || val.trim().isEmpty) {
                                return 'Mobile number is required';
                              }
                              if (val.length < 10) {
                                return 'Enter a valid mobile number';
                              }
                              return null;
                            },
                            decoration: const InputDecoration(
                              labelText: 'Mobile number',
                              hintText: '+91XXXXXXXXXX',
                              prefixIcon: Icon(Icons.phone_iphone_rounded, color: AppColors.textSecondary),
                            ),
                          ),

                          if (notifier.error != null) ...[
                            const SizedBox(height: 8),
                            Text(
                              notifier.error!,
                              style: const TextStyle(color: Colors.redAccent, fontSize: 13, fontWeight: FontWeight.w500),
                            ),
                          ],

                          const SizedBox(height: 16),
                          BrandButton(
                            text: 'Send OTP',
                            loading: notifier.loading,
                            onPressed: _submit,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'By continuing you agree to our Terms and Privacy Policy.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                    const SizedBox(height: 28),

                    // Description + bullets (below the fold — informational)
                    Text(
                      'Book a pickup from your office or home — our agent collects your parcel, ships it through the courier you choose, and sends you a tracking ID. No standing in line.',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppColors.textSecondary,
                        height: 1.5,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppColors.border, width: 1),
                      ),
                      child: const Column(
                        children: [
                          BulletRow(icon: '📤', text: 'Send via DTDC, Delhivery, BlueDart or India Post'),
                          SizedBox(height: 10),
                          BulletRow(icon: '📥', text: 'Receive from any courier office on your behalf'),
                          SizedBox(height: 10),
                          BulletRow(icon: '📍', text: 'Real-time tracking — see exactly where your agent is'),
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

class BulletRow extends StatelessWidget {
  final String icon;
  final String text;

  const BulletRow({Key? key, required this.icon, required this.text}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(icon, style: const TextStyle(fontSize: 16)),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.3),
          ),
        ),
      ],
    );
  }
}
