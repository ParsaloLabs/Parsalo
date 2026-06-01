class AgentProfile {
  final String id;
  final String phone;
  final String fullName;
  final String? email;
  final String? vehicleType;
  final String? vehicleNumber;
  final double rating;
  final int totalDeliveries;
  final bool isOnline;
  final bool acceptExtraOrders;

  const AgentProfile({
    required this.id,
    required this.phone,
    required this.fullName,
    this.email,
    this.vehicleType,
    this.vehicleNumber,
    required this.rating,
    required this.totalDeliveries,
    required this.isOnline,
    required this.acceptExtraOrders,
  });

  factory AgentProfile.fromJson(Map<String, dynamic> j) {
    double parseRating(dynamic v) {
      if (v == null) return 0;
      if (v is num) return v.toDouble();
      if (v is String) return double.tryParse(v) ?? 0;
      return 0;
    }

    return AgentProfile(
      id: j['id'] as String,
      phone: j['phone'] as String,
      fullName: j['full_name'] as String? ?? '',
      email: j['email'] as String?,
      vehicleType: j['vehicle_type'] as String?,
      vehicleNumber: j['vehicle_number'] as String?,
      rating: parseRating(j['rating']),
      totalDeliveries: (j['total_deliveries'] as num?)?.toInt() ?? 0,
      isOnline: j['is_online'] as bool? ?? false,
      acceptExtraOrders: j['accept_extra_orders'] as bool? ?? false,
    );
  }
}
