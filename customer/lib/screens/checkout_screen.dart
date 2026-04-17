import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../models/cart.dart';
import '../providers/cart_provider.dart';

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Address? _selectedAddress;
  ShippingRate? _selectedRate;
  bool _showNewAddressForm = false;
  bool _isProcessing = false;

  // New address form
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _street1Controller = TextEditingController();
  final _street2Controller = TextEditingController();
  final _cityController = TextEditingController();
  final _stateController = TextEditingController();
  final _zipController = TextEditingController();

  @override
  void dispose() {
    _nameController.dispose();
    _street1Controller.dispose();
    _street2Controller.dispose();
    _cityController.dispose();
    _stateController.dispose();
    _zipController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = ref.watch(cartProvider);
    final subtotal = ref.watch(cartSubtotalProvider);
    final theme = Theme.of(context);

    if (items.isEmpty) {
      return Scaffold(
        appBar: AppBar(title: const Text('Checkout')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Your cart is empty'),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => context.go('/catalog'),
                child: const Text('Browse Catalog'),
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Checkout')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Order items summary
            Text('Order Summary',
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ...items.map((item) => _OrderItemRow(item: item)),
            const Divider(height: 24),

            // Shipping address
            Text('Shipping Address',
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            _AddressSection(
              selectedAddress: _selectedAddress,
              showNewForm: _showNewAddressForm,
              onAddressSelected: (addr) =>
                  setState(() {
                    _selectedAddress = addr;
                    _selectedRate = null;
                    _showNewAddressForm = false;
                  }),
              onShowNewForm: () =>
                  setState(() => _showNewAddressForm = true),
              formKey: _formKey,
              nameController: _nameController,
              street1Controller: _street1Controller,
              street2Controller: _street2Controller,
              cityController: _cityController,
              stateController: _stateController,
              zipController: _zipController,
              onNewAddressSubmit: () {
                if (_formKey.currentState!.validate()) {
                  final addr = Address(
                    name: _nameController.text.trim(),
                    street1: _street1Controller.text.trim(),
                    street2: _street2Controller.text.trim().isEmpty
                        ? null
                        : _street2Controller.text.trim(),
                    city: _cityController.text.trim(),
                    state: _stateController.text.trim(),
                    zip: _zipController.text.trim(),
                  );
                  setState(() {
                    _selectedAddress = addr;
                    _selectedRate = null;
                    _showNewAddressForm = false;
                  });
                }
              },
            ),
            const Divider(height: 24),

            // Shipping rates
            if (_selectedAddress != null) ...[
              Text('Shipping Method',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              _ShippingRatesSection(
                address: _selectedAddress!,
                selectedRate: _selectedRate,
                onRateSelected: (rate) =>
                    setState(() => _selectedRate = rate),
              ),
              const Divider(height: 24),
            ],

            // Tax display
            if (_selectedAddress != null && _selectedRate != null) ...[
              Text('Tax',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              _TaxSection(address: _selectedAddress!),
              const Divider(height: 24),
            ],

            // Payment section
            if (_selectedAddress != null && _selectedRate != null) ...[
              Text('Payment',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      Icon(Icons.credit_card,
                          color: theme.colorScheme.primary),
                      const SizedBox(width: 12),
                      const Expanded(
                        child: Text('Stripe Secure Payment'),
                      ),
                      Icon(Icons.lock,
                          size: 16, color: theme.colorScheme.outline),
                    ],
                  ),
                ),
              ),
              const Divider(height: 24),
            ],

            // Order total
            _OrderTotalSection(
              subtotalCents: subtotal,
              shippingRate: _selectedRate,
              address: _selectedAddress,
            ),

            const SizedBox(height: 16),

            // Place order button
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed:
                    _selectedAddress != null &&
                            _selectedRate != null &&
                            !_isProcessing
                        ? _placeOrder
                        : null,
                child: _isProcessing
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Text('Place Order'),
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Future<void> _placeOrder() async {
    setState(() => _isProcessing = true);
    try {
      final confirmation =
          await ref.read(checkoutProvider.notifier).placeOrder(
                address: _selectedAddress!,
                shippingRateId: _selectedRate!.id,
                paymentMethodId: 'pm_stripe_placeholder',
              );
      if (mounted) {
        context.go('/checkout/confirmation', extra: confirmation);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Order failed: ${e.toString()}'),
            backgroundColor: Theme.of(context).colorScheme.error,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isProcessing = false);
      }
    }
  }
}

class _OrderItemRow extends StatelessWidget {
  final CartItem item;

  const _OrderItemRow({required this.item});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '${item.productTitle} (${item.material}) x${item.quantity}',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          Text(item.formattedPrice),
        ],
      ),
    );
  }
}

class _AddressSection extends ConsumerWidget {
  final Address? selectedAddress;
  final bool showNewForm;
  final ValueChanged<Address> onAddressSelected;
  final VoidCallback onShowNewForm;
  final GlobalKey<FormState> formKey;
  final TextEditingController nameController;
  final TextEditingController street1Controller;
  final TextEditingController street2Controller;
  final TextEditingController cityController;
  final TextEditingController stateController;
  final TextEditingController zipController;
  final VoidCallback onNewAddressSubmit;

  const _AddressSection({
    required this.selectedAddress,
    required this.showNewForm,
    required this.onAddressSelected,
    required this.onShowNewForm,
    required this.formKey,
    required this.nameController,
    required this.street1Controller,
    required this.street2Controller,
    required this.cityController,
    required this.stateController,
    required this.zipController,
    required this.onNewAddressSubmit,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final addressesAsync = ref.watch(savedAddressesProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        addressesAsync.when(
          loading: () =>
              const Center(child: CircularProgressIndicator()),
          error: (_, _) => const Text('Could not load saved addresses'),
          data: (addresses) {
            if (addresses.isEmpty && !showNewForm) {
              return _NewAddressForm(
                formKey: formKey,
                nameController: nameController,
                street1Controller: street1Controller,
                street2Controller: street2Controller,
                cityController: cityController,
                stateController: stateController,
                zipController: zipController,
                onSubmit: onNewAddressSubmit,
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                RadioGroup<String>(
                  groupValue: selectedAddress?.id ?? selectedAddress?.formatted ?? '',
                  onChanged: (value) {
                    final addr = addresses.firstWhere(
                        (a) => (a.id ?? a.formatted) == value);
                    onAddressSelected(addr);
                  },
                  child: Column(
                    children: addresses
                        .map((addr) => RadioListTile<String>(
                              title: Text(addr.name),
                              subtitle: Text(addr.formatted),
                              value: addr.id ?? addr.formatted,
                              dense: true,
                            ))
                        .toList(),
                  ),
                ),
                if (!showNewForm)
                  TextButton.icon(
                    onPressed: onShowNewForm,
                    icon: const Icon(Icons.add),
                    label: const Text('New Address'),
                  ),
              ],
            );
          },
        ),
        if (showNewForm)
          _NewAddressForm(
            formKey: formKey,
            nameController: nameController,
            street1Controller: street1Controller,
            street2Controller: street2Controller,
            cityController: cityController,
            stateController: stateController,
            zipController: zipController,
            onSubmit: onNewAddressSubmit,
          ),
        if (selectedAddress != null && !showNewForm)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    const Icon(Icons.location_on, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                          '${selectedAddress!.name}\n${selectedAddress!.formatted}'),
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _NewAddressForm extends StatelessWidget {
  final GlobalKey<FormState> formKey;
  final TextEditingController nameController;
  final TextEditingController street1Controller;
  final TextEditingController street2Controller;
  final TextEditingController cityController;
  final TextEditingController stateController;
  final TextEditingController zipController;
  final VoidCallback onSubmit;

  const _NewAddressForm({
    required this.formKey,
    required this.nameController,
    required this.street1Controller,
    required this.street2Controller,
    required this.cityController,
    required this.stateController,
    required this.zipController,
    required this.onSubmit,
  });

  @override
  Widget build(BuildContext context) {
    return Form(
      key: formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: nameController,
            decoration: const InputDecoration(
              labelText: 'Full Name',
              border: OutlineInputBorder(),
            ),
            validator: (v) =>
                (v == null || v.trim().isEmpty) ? 'Name is required' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: street1Controller,
            decoration: const InputDecoration(
              labelText: 'Street Address',
              border: OutlineInputBorder(),
            ),
            validator: (v) =>
                (v == null || v.trim().isEmpty) ? 'Address is required' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: street2Controller,
            decoration: const InputDecoration(
              labelText: 'Apt / Suite (optional)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                flex: 2,
                child: TextFormField(
                  controller: cityController,
                  decoration: const InputDecoration(
                    labelText: 'City',
                    border: OutlineInputBorder(),
                  ),
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'City is required'
                      : null,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: stateController,
                  decoration: const InputDecoration(
                    labelText: 'State',
                    border: OutlineInputBorder(),
                  ),
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'Required'
                      : null,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: zipController,
            decoration: const InputDecoration(
              labelText: 'ZIP Code',
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.number,
            validator: (v) =>
                (v == null || v.trim().isEmpty) ? 'ZIP is required' : null,
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: onSubmit,
              child: const Text('Use This Address'),
            ),
          ),
        ],
      ),
    );
  }
}

class _ShippingRatesSection extends ConsumerWidget {
  final Address address;
  final ShippingRate? selectedRate;
  final ValueChanged<ShippingRate> onRateSelected;

  const _ShippingRatesSection({
    required this.address,
    required this.selectedRate,
    required this.onRateSelected,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ratesAsync = ref.watch(shippingRatesProvider(address));

    return ratesAsync.when(
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (_, _) => const Text('Failed to load shipping rates'),
      data: (rates) {
        if (rates.isEmpty) {
          return const Text('No shipping options available');
        }
        return RadioGroup<String>(
          groupValue: selectedRate?.id ?? '',
          onChanged: (value) {
            final rate = rates.firstWhere((r) => r.id == value);
            onRateSelected(rate);
          },
          child: Column(
            children: rates
                .map((rate) => RadioListTile<String>(
                      title: Text('${rate.carrier} ${rate.service}'),
                      subtitle: Text(
                        '${rate.formattedRate}'
                        '${rate.estDeliveryDays != null ? ' \u2022 ${rate.estDeliveryDays} days' : ''}',
                      ),
                      value: rate.id,
                      dense: true,
                    ))
                .toList(),
          ),
        );
      },
    );
  }
}

class _TaxSection extends ConsumerWidget {
  final Address address;

  const _TaxSection({required this.address});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final taxAsync = ref.watch(taxAmountProvider(address));

    return taxAsync.when(
      loading: () => const Text('Calculating tax...'),
      error: (_, _) => const Text('Could not calculate tax'),
      data: (taxCents) {
        final dollars = taxCents ~/ 100;
        final cents = (taxCents % 100).toString().padLeft(2, '0');
        return Text('Tax: \$$dollars.$cents');
      },
    );
  }
}

class _OrderTotalSection extends ConsumerWidget {
  final int subtotalCents;
  final ShippingRate? shippingRate;
  final Address? address;

  const _OrderTotalSection({
    required this.subtotalCents,
    required this.shippingRate,
    required this.address,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final subDollars = subtotalCents ~/ 100;
    final subCents = (subtotalCents % 100).toString().padLeft(2, '0');

    return Column(
      children: [
        _TotalRow(label: 'Subtotal', value: '\$$subDollars.$subCents'),
        if (shippingRate != null)
          _TotalRow(label: 'Shipping', value: shippingRate!.formattedRate),
        if (address != null) _TaxTotalRow(address: address!),
        const Divider(),
        if (address != null && shippingRate != null)
          _GrandTotalRow(
            subtotalCents: subtotalCents,
            shippingCents: shippingRate!.rateCents,
            address: address!,
          )
        else
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Total',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
              Text('\$$subDollars.$subCents',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
            ],
          ),
      ],
    );
  }
}

class _TotalRow extends StatelessWidget {
  final String label;
  final String value;

  const _TotalRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label), Text(value)],
      ),
    );
  }
}

class _TaxTotalRow extends ConsumerWidget {
  final Address address;

  const _TaxTotalRow({required this.address});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final taxAsync = ref.watch(taxAmountProvider(address));

    return taxAsync.when(
      loading: () => const _TotalRow(label: 'Tax', value: '...'),
      error: (_, _) => const _TotalRow(label: 'Tax', value: '--'),
      data: (taxCents) {
        final dollars = taxCents ~/ 100;
        final cents = (taxCents % 100).toString().padLeft(2, '0');
        return _TotalRow(label: 'Tax', value: '\$$dollars.$cents');
      },
    );
  }
}

class _GrandTotalRow extends ConsumerWidget {
  final int subtotalCents;
  final int shippingCents;
  final Address address;

  const _GrandTotalRow({
    required this.subtotalCents,
    required this.shippingCents,
    required this.address,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final taxAsync = ref.watch(taxAmountProvider(address));

    return taxAsync.when(
      loading: () => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('Total',
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const Text('Calculating...'),
        ],
      ),
      error: (_, _) => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('Total',
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
          const Text('--'),
        ],
      ),
      data: (taxCents) {
        final total = subtotalCents + shippingCents + taxCents;
        final dollars = total ~/ 100;
        final cents = (total % 100).toString().padLeft(2, '0');
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Total',
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold)),
            Text('\$$dollars.$cents',
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold)),
          ],
        );
      },
    );
  }
}
