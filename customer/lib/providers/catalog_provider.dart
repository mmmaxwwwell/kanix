import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_client.dart';
import '../models/product.dart';

final catalogProvider =
    FutureProvider.autoDispose<List<Product>>((ref) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/catalog/products');
  final data = response.data as Map<String, dynamic>;
  final products = data['products'] as List<dynamic>;
  return products
      .map((e) => Product.fromJson(e as Map<String, dynamic>))
      .toList();
});

final productDetailProvider = FutureProvider.autoDispose
    .family<Product, String>((ref, productId) async {
  final dio = ref.watch(dioProvider);
  final response = await dio.get('/api/catalog/products/$productId');
  final data = response.data as Map<String, dynamic>;
  return Product.fromJson(data['product'] as Map<String, dynamic>);
});
