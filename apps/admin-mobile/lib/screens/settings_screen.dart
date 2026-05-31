import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../core/api_client.dart';
import '../core/push/push_service.dart';
import '../core/theme.dart';
import '../models/dispatch_config.dart';
import '../state/providers.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _radiusController = TextEditingController();
  final _ttlController = TextEditingController();
  bool _saving = false;
  String? _error;
  String? _savedAt;

  bool? _pushEnabled;
  bool _pushBusy = false;
  String? _pushError;

  @override
  void initState() {
    super.initState();
    _loadPushPreference();
  }

  Future<void> _loadPushPreference() async {
    final dio = ref.read(apiClientProvider).dio;
    final value = await adminPushService.fetchPreference(dio);
    if (!mounted) return;
    setState(() => _pushEnabled = value ?? true);
  }

  Future<void> _togglePush(bool next) async {
    setState(() {
      _pushBusy = true;
      _pushError = null;
    });
    final dio = ref.read(apiClientProvider).dio;
    final ok = await adminPushService.setPreference(dio, next);
    if (!mounted) return;
    setState(() {
      _pushBusy = false;
      if (ok) {
        _pushEnabled = next;
      } else {
        _pushError = 'Could not update — check connection and retry.';
      }
    });
  }

  @override
  void dispose() {
    _radiusController.dispose();
    _ttlController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
      _savedAt = null;
    });

    try {
      final radiusM = (double.parse(_radiusController.text) * 1000).round();
      final ttlSeconds = int.parse(_ttlController.text);
      await ref
          .read(dispatchConfigProvider.notifier)
          .updateConfig(radiusM, ttlSeconds);
      
      setState(() {
        _savedAt = DateFormat('hh:mm:ss a').format(DateTime.now());
      });
    } catch (e) {
      setState(() {
        _error = humanizeError(extractErrorCode(e));
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final configState = ref.watch(dispatchConfigProvider);

    // Initialize inputs when data loads
    ref.listen<AsyncValue<DispatchConfig>>(dispatchConfigProvider, (prev, next) {
      next.whenData((config) {
        if (_radiusController.text.isEmpty && _ttlController.text.isEmpty) {
          _radiusController.text = (config.initialRadiusM / 1000).toString();
          _ttlController.text = config.offerTtlSeconds.toString();
        }
      });
    });

    return Scaffold(
      backgroundColor: BrandColors.creamBg,
      appBar: AppBar(
        title: const Text('Dispatch & Settings'),
      ),
      body: configState.when(
        data: (config) => SingleChildScrollView(
          padding: const EdgeInsets.all(20.0),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Global Dispatch Options',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: BrandColors.primary),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Adjust core operational metrics. Modifications reflect immediately across dispatcher sweets.',
                  style: TextStyle(fontSize: 13, color: BrandColors.textMuted),
                ),
                const SizedBox(height: 24),

                if (_error != null) ...[
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.red.shade200),
                    ),
                    child: Text(_error!, style: TextStyle(color: Colors.red.shade900, fontSize: 13)),
                  ),
                  const SizedBox(height: 16),
                ],

                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: BrandColors.creamCard,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: BrandColors.creamBorder),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: Text(
                              'Push notifications on this device',
                              style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: BrandColors.primary),
                            ),
                          ),
                          if (_pushEnabled == null)
                            const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          else
                            Switch(
                              value: _pushEnabled!,
                              onChanged: _pushBusy ? null : _togglePush,
                            ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'Alerts for new orders, payments, and cancellations. Affects only this phone — other admin devices stay on.',
                        style: TextStyle(fontSize: 12, color: BrandColors.textMuted),
                      ),
                      if (_pushError != null) ...[
                        const SizedBox(height: 8),
                        Text(_pushError!, style: TextStyle(color: Colors.red.shade900, fontSize: 12)),
                      ],
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: BrandColors.creamCard,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: BrandColors.creamBorder),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Initial Search Radius (km)',
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: BrandColors.primary),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'The initial circular range used to query online delivery candidates. Multiplies to 2× and 3× on subsequent sweeps.',
                        style: TextStyle(fontSize: 12, color: BrandColors.textMuted),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _radiusController,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: const InputDecoration(
                          hintText: 'e.g. 5',
                          suffixText: 'km',
                        ),
                        validator: (val) {
                          if (val == null || val.isEmpty) return 'Enter radius';
                          if (double.tryParse(val) == null) return 'Enter a number';
                          return null;
                        },
                      ),
                      
                      const SizedBox(height: 24),
                      
                      const Text(
                        'Offer TTL Duration (seconds)',
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: BrandColors.primary),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'Amount of time a delivery driver has to accept a targeted offer before it ages out and moves to the next candidate.',
                        style: TextStyle(fontSize: 12, color: BrandColors.textMuted),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _ttlController,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          hintText: 'e.g. 30',
                          suffixText: 'sec',
                        ),
                        validator: (val) {
                          if (val == null || val.isEmpty) return 'Enter offer duration';
                          if (int.tryParse(val) == null) return 'Enter an integer';
                          return null;
                        },
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 32),

                ElevatedButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          height: 24,
                          width: 24,
                          child: CircularProgressIndicator(valueColor: AlwaysStoppedAnimation<Color>(Colors.white)),
                        )
                      : const Text('Save Parameters'),
                ),

                if (_savedAt != null) ...[
                  const SizedBox(height: 12),
                  Center(
                    child: Text(
                      'Successfully saved changes at $_savedAt',
                      style: const TextStyle(color: BrandColors.accentGreen, fontSize: 13, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        loading: () => const Center(
          child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation<Color>(BrandColors.accentOrange),
          ),
        ),
        error: (err, _) => Center(child: Text('Error loading config: $err')),
      ),
    );
  }
}
