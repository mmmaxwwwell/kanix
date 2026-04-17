class ManagedAdminUser {
  final String id;
  final String email;
  final String name;
  final String role;
  final List<String> capabilities;
  final bool isActive;
  final DateTime createdAt;
  final DateTime updatedAt;

  const ManagedAdminUser({
    required this.id,
    required this.email,
    required this.name,
    required this.role,
    required this.capabilities,
    required this.isActive,
    required this.createdAt,
    required this.updatedAt,
  });

  factory ManagedAdminUser.fromJson(Map<String, dynamic> json) {
    return ManagedAdminUser(
      id: json['id'] as String,
      email: json['email'] as String,
      name: json['name'] as String,
      role: json['role'] as String? ?? 'viewer',
      capabilities: (json['capabilities'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [],
      isActive: json['isActive'] as bool? ?? true,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class AdminRole {
  final String id;
  final String name;
  final String description;
  final List<String> permissions;

  const AdminRole({
    required this.id,
    required this.name,
    required this.description,
    required this.permissions,
  });

  factory AdminRole.fromJson(Map<String, dynamic> json) {
    return AdminRole(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String? ?? '',
      permissions: (json['permissions'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [],
    );
  }
}
