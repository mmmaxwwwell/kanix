# Feature Specification: Kanix Commerce Platform

**Created**: 2026-04-16
**Status**: Draft
**Preset**: Enterprise
**Input**: Full ecommerce platform for Kanix modular dog handler belt system — admin app, customer app, public site, backend API, infrastructure

---

## Overview

Kanix is building a full commerce platform to sell its modular dog handler belt system. The platform consists of:

- **Astro public site** — marketing, product catalog, guest checkout (no login required to buy)
- **Flutter customer app** — web, iOS, Android — catalog browsing, authenticated checkout, order tracking, support, warranty claims, contributor royalty dashboard
- **Flutter admin app** — web — order management, fulfillment, inventory, support tickets, disputes, evidence, contributor management
- **Fastify + TypeScript backend API** — REST-first, WebSocket for real-time, Postgres, Stripe, SuperTokens, EasyPost
- **NixOS infrastructure** — OpenTofu IaC, Cloudflare DNS, Let's Encrypt TLS, hierarchical Nix flakes

---

## User Scenarios & Testing

### User Story 1 — Guest Purchases a Product (Priority: P1)

A visitor discovers Kanix through search or social media, lands on the Astro site, browses the product catalog, selects a product and material variant (TPU/PA11/TPC), adds it to cart, enters email + shipping address, pays via Stripe, and receives an order confirmation email. No account creation required.

**Why this priority**: Revenue generation is the core business function. If customers can't buy, nothing else matters.

**Independent Test**: Can be fully tested by placing a guest order through the Astro checkout flow with Stripe test mode and verifying order creation, inventory reservation, and confirmation email (stubbed).

**Acceptance Scenarios**:

1. **Given** a product with available inventory, **When** a guest completes checkout with valid email + address + payment, **Then** an order is created with status `confirmed`, payment_status `paid`, inventory is reserved then consumed, and a confirmation email is queued.
2. **Given** a product variant with zero available stock, **When** a guest tries to add it to cart, **Then** the variant shows "Out of Stock" and cannot be added.
3. **Given** a guest with items in cart, **When** payment fails via Stripe, **Then** the order moves to `pending_payment` with payment_status `failed`, inventory reservations are released, and the guest sees a clear error with retry option.

---

### User Story 2 — Customer Purchases a Starter Kit (Priority: P1)

A customer (guest or authenticated) wants to buy a starter kit. The kit is defined as a class-based composition (e.g., 2 of class A plates + 3 of class B modules + 1 of class C belt). The customer picks specific products from each class. All class requirements must be satisfied and all selected items must be in stock for the kit to be purchasable.

**Why this priority**: Kits are the primary product offering — the "starter kit" is the entry point for new customers.

**Independent Test**: Can be tested by configuring a kit definition, selecting products per class, and completing checkout. Verify inventory reservation per component, bundle pricing, and order line snapshots.

**Acceptance Scenarios**:

1. **Given** a kit requiring 2 of class A + 3 of class B + 1 of class C, **When** the customer selects valid products for each class and all are in stock, **Then** the kit can be added to cart at the bundle price.
2. **Given** a kit with all classes filled, **When** one selected item goes out of stock before checkout completes, **Then** the customer is notified and must pick a different item from that class.
3. **Given** a kit definition, **When** the customer has only selected items for 2 of 3 required classes, **Then** the "Add to Cart" button is disabled with a message indicating which classes still need selections.

---

### User Story 3 — Admin Manages Orders and Fulfillment (Priority: P1)

An admin operator logs into the admin app, sees the dashboard with operational counts (orders awaiting fulfillment, open tickets, low stock, open disputes), navigates to the order list, views order details across all status dimensions, and processes fulfillment tasks (assign → pick → pack → ship).

**Why this priority**: Without order management and fulfillment, purchased products can't be shipped. This is the operational backbone.

**Independent Test**: Can be tested by creating an order via the API, then walking it through the fulfillment pipeline in the admin app: assign task → pick → pack → create shipment → buy label → mark shipped. Verify state machine transitions and audit log entries.

**Acceptance Scenarios**:

1. **Given** a confirmed order with payment_status `paid`, **When** an admin with `orders.read` + fulfillment permissions views the order, **Then** they see all four status dimensions (order, payment, fulfillment, shipping) and can initiate fulfillment.
2. **Given** a fulfillment task in `assigned` status, **When** the assigned admin progresses through pick → pack → shipment_pending, **Then** each transition is recorded in order_status_history with actor attribution.
3. **Given** an admin without `orders.refund` permission, **When** they attempt to issue a refund, **Then** they receive a 403 error.

---

### User Story 4 — Customer Creates Account and Tracks Orders (Priority: P2)

A customer who previously placed guest orders decides to create an account in the Flutter app. They sign up with email/password, verify their email, and immediately see all previous guest orders placed with that email. They can now track order status in real-time, view shipping tracking, and access support.

**Why this priority**: Account creation unlocks the premium post-purchase experience — real-time tracking, support, warranty.

**Independent Test**: Create guest orders with a specific email, then create an account with that email, verify email, and confirm all orders appear in order history.

**Acceptance Scenarios**:

1. **Given** 3 guest orders placed with `jane@example.com`, **When** Jane creates an account with that email and verifies it, **Then** all 3 orders appear in her order history.
2. **Given** an authenticated customer with an active order, **When** a shipment tracking event occurs (e.g., `in_transit`), **Then** the customer receives a real-time push notification in the app and the order detail page updates live.
3. **Given** a customer with an unverified email, **When** they attempt to access order history, **Then** they are prompted to verify their email first.

---

### User Story 5 — Customer Files a Warranty Claim (Priority: P2)

An authenticated customer with a verified email navigates to a past order, selects a defective item, and files a warranty claim. The claim creates a support ticket with category `warranty_claim`. The customer describes the defect and optionally uploads photos. Admin reviews and resolves (replacement, refund, or denial with reason).

**Why this priority**: Warranty support is essential for a premium product brand and for customer retention.

**Independent Test**: Create an order delivered within the last year, file a warranty claim from the customer app, verify support ticket creation with correct category and linked order, then resolve from admin app.

**Acceptance Scenarios**:

1. **Given** a delivered order within the 1-year warranty period, **When** a customer files a warranty claim for "layer delamination", **Then** a support ticket is created with category `warranty_claim`, linked to the order and specific order line, with priority `high`.
2. **Given** an order delivered 13 months ago, **When** the customer attempts to file a warranty claim, **Then** the system informs them the warranty period has expired.
3. **Given** a warranty claim for "TPU heat deformation", **When** admin reviews the claim, **Then** the system shows the material limitation disclosure and recommends denial (heat deformation is a documented exclusion).

---

### User Story 6 — Contributor Links GitHub and Tracks Royalties (Priority: P2)

An open-source contributor who has had a PR accepted links their GitHub account in the Flutter app settings. The system matches their GitHub username to the contributor record created by the CLA bot. They can now view per-design sales counts, royalty accrual, and milestone progress (25 units → 10% royalty, 50 units → starter kit reward).

**Why this priority**: The contributor incentive model is a core differentiator for the Kanix open-source ecosystem.

**Independent Test**: Create a contributor record (simulating CLA bot), create a customer account, link GitHub via OAuth, verify contributor dashboard shows correct sales data and milestone progress.

**Acceptance Scenarios**:

1. **Given** a contributor with CLA on file and a customer account, **When** they click "Link GitHub Account" and complete OAuth, **Then** their GitHub identity is linked and the contributor dashboard becomes visible in the app.
2. **Given** a contributor whose design has sold 30 units, **When** they view their royalty dashboard, **Then** they see: 30 units sold, 10% royalty rate, retroactive royalty calculation from unit 1, and option to set up payout or donate at 2x rate.
3. **Given** a contributor approaching the 25-unit threshold, **When** the system has no W-9/W-8BEN on file, **Then** the contributor is prompted to submit tax forms before royalty payment can be processed.

---

### User Story 7 — Admin Handles a Dispute (Priority: P3)

A chargeback is filed against an order. The Stripe webhook creates a dispute record. An admin navigates to the dispute, sees the evidence readiness summary (tracking present, delivery proof, customer comms, policy snapshot), generates an evidence bundle, and submits it to Stripe.

**Why this priority**: Dispute defense protects revenue and is the reason the evidence chain exists.

**Independent Test**: Create a complete order with shipment (delivered), support ticket, and policy acknowledgment. Simulate a dispute webhook. Verify evidence records exist, generate bundle, confirm all evidence types are included.

**Acceptance Scenarios**:

1. **Given** a delivered order with complete evidence chain, **When** a `charge.dispute.created` webhook fires, **Then** a dispute record is created, payment_status moves to `disputed`, and the dispute readiness summary shows all evidence types present.
2. **Given** a dispute with missing delivery proof, **When** admin views the dispute, **Then** the readiness summary flags `delivery_proof_present: false` and the bundle cannot be marked `ready_to_submit`.
3. **Given** a complete evidence bundle, **When** admin submits it, **Then** the dispute status moves to `submitted` and the submission is logged in the audit trail.

---

### User Story 8 �� Admin Manages Inventory (Priority: P2)

An admin monitors inventory levels, receives low-stock alerts (real-time push + email), performs stock adjustments when new batches arrive from the manufacturer, and reviews reservation status for active checkouts.

**Why this priority**: Inventory accuracy prevents overselling, which is a core business rule for the premium brand.

**Independent Test**: Set safety stock levels, reduce inventory below threshold, verify alert fires. Create adjustment, verify balance updates atomically. Run concurrent reservations, verify no oversell.

**Acceptance Scenarios**:

1. **Given** a variant with `available = 5` and `safety_stock = 10`, **When** the admin views inventory, **Then** the variant is flagged as low stock and a push notification + email alert is sent.
2. **Given** a restock of 100 units, **When** an admin creates an inventory adjustment with `adjustment_type = restock` and `quantity_delta = 100`, **Then** `on_hand` increases by 100, `available` increases by 100, and an audit log entry records the adjustment with actor attribution.
3. **Given** 1 unit available and 2 concurrent checkout attempts, **When** both try to reserve the last unit, **Then** exactly one reservation succeeds and the other receives a stock unavailable error.

---

### User Story 9 �� Admin Manages Support Tickets (Priority: P3)

An admin views the support ticket queue, responds to customer inquiries, adds internal notes, changes ticket status, and links tickets to orders/shipments for context. Tickets update in real-time for all admin users viewing the queue.

**Why this priority**: Customer support is essential but can launch after core commerce ops are working.

**Independent Test**: Create a ticket from customer app, respond from admin app, verify message threading, internal notes (not visible to customer), status transitions, and real-time updates across admin sessions.

**Acceptance Scenarios**:

1. **Given** a customer-created ticket about a missing package, **When** admin views the ticket, **Then** they see the linked order, shipment tracking status, and full message thread.
2. **Given** an open ticket, **When** admin adds an internal note, **Then** the note is visible to other admins but NOT visible to the customer.
3. **Given** an admin viewing the ticket queue, **When** a new ticket is created by a customer, **Then** the queue updates in real-time without page refresh.

---

## Edge Cases & Failure Modes

### Cart & Checkout
- **FR-E001**: If a product variant's inventory reaches zero while items are in a guest's cart (before checkout), the cart MUST show the item as unavailable and prevent checkout until resolved.
- **FR-E002**: If a Stripe payment intent succeeds but the server crashes before confirming the order, the webhook handler MUST be idempotent — processing the `payment_intent.succeeded` event creates the order if it doesn't exist.
- **FR-E003**: Inventory reservations created during checkout MUST have a TTL (configurable, default 15 minutes). Expired reservations are automatically released back to available stock.
- **FR-E004**: If the same email places multiple concurrent guest orders, each order MUST have independent inventory reservations and payment processing.

### Kit Composition
- **FR-E005**: If a kit definition is updated (e.g., class requirements change) while a customer has a partially-configured kit in cart, the cart MUST re-validate against the new definition and notify the customer of any invalid selections.
- **FR-E006**: Kit pricing MUST be calculated at checkout time from the current bundle discount, not cached at cart-add time.

### Inventory
- **FR-E007**: Inventory balance `available` MUST never go negative. This is enforced by a database CHECK constraint, not just application logic.
- **FR-E008**: If the reservation cleanup cron releases an expired reservation for an order that subsequently has its payment succeed (race condition), the system MUST detect the conflict and either re-reserve or flag the order for manual review.
- **FR-E009**: Inventory adjustments MUST be idempotent — duplicate adjustment requests with the same idempotency key produce the same result.

### Payments
- **FR-E010**: Stripe webhook handlers MUST be idempotent. The same event delivered multiple times produces the same result.
- **FR-E011**: Refund amount MUST NOT exceed original payment amount. Partial refunds track cumulative refunded amount.
- **FR-E012**: If Stripe is unreachable during checkout, the system MUST return a clear error and NOT create an order. Retry is the customer's responsibility.

### State Machines
- **FR-E013**: An order in `confirmed` status with a shipped shipment MUST NOT be cancellable without a return flow.
- **FR-E014**: An order MUST NOT be marked `completed` until fulfillment_status is `fulfilled` AND shipping_status is `delivered`.
- **FR-E015**: Payment status `disputed` can only transition to `paid` (dispute won) or `refunded` (dispute lost), depending on the dispute outcome.

### Account Linking
- **FR-E016**: If a customer creates an account with an email that has guest orders, the orders MUST appear immediately after email verification — no manual claiming flow.
- **FR-E017**: If two different customers verify the same email (shouldn't happen with proper verification), the system MUST prevent the second verification and flag the conflict for admin review.

### Evidence
- **FR-E018**: Evidence records MUST be immutable — no updates, no deletes, ever. This is enforced at the database level (no UPDATE/DELETE permissions on the evidence_record table for the application user).
- **FR-E019**: If a dispute is opened for an order with incomplete evidence, the dispute readiness summary MUST clearly list which evidence types are missing.

### Fulfillment
- **FR-E023**: If inventory is discovered missing during picking (physical count doesn't match system), the fulfillment task MUST be blockable with a reason. Blocking triggers an admin alert and the admin can create an inventory adjustment to correct the discrepancy.
- **FR-E024**: If a fulfillment task is canceled after picking has begun, any items already picked MUST be returned to available inventory via an automatic adjustment.

### Shipping
- **FR-E025**: If EasyPost label purchase fails (API error, invalid address, carrier rejection), the shipment MUST remain in `label_pending` status with a clear error message. The admin can retry or choose a different carrier/service.
- **FR-E026**: If a delivery exception event is received from EasyPost, the system MUST create an admin alert and update shipment status to `exception`. Admin can monitor for recovery (`exception` → `in_transit`) or escalate.
- **FR-E027**: If a shipment label is voided, the label cost MUST be refunded/credited if applicable, and the shipment status MUST transition to `voided`.

### Support
- **FR-E028**: Duplicate tickets for the same order from the same customer within 24 hours MUST be flagged for potential merge by admin (not auto-merged — admin decides).

### Contributor Royalties
- **FR-E020**: Royalty calculations MUST be retroactive to unit 1 when the 25-unit threshold is crossed. The system MUST calculate the lump sum for units 1-25 at the 10% rate.
- **FR-E021**: If a contributor chooses the 501(c)(3) donation option, the donation amount is 2x the royalty rate (20%). The system MUST track the designated charity and generate appropriate records.
- **FR-E022**: If a sale is later refunded, the royalty for that unit MUST be clawed back from the contributor's accrual.

---

## Requirements

### Functional Requirements

#### Catalog & Products

- **FR-001**: System MUST support products with a `status` state machine: `draft` ↔ `active` → `archived`. Products can be unpublished (`active` → `draft`) but `archived` is terminal.
- **FR-002**: System MUST support product variants with material as the variant axis (TPU, PA11, TPC). Each variant has independent pricing, inventory, and SKU.
- **FR-003**: System MUST support product classification into categories (class A, class B, class C, etc.) for kit composition.
- **FR-004**: System MUST support product media (images) with sort ordering and alt text.
- **FR-005**: System MUST support collections for grouping products (e.g., "starter kit modules", "accessories").
- **FR-006**: Product pages MUST display material-specific warranty limitations (TPU heat deformation exclusion, TPC heat resistance rating).

#### Kit / Bundle System

- **FR-007**: System MUST support kit definitions as class-based compositions: "N of class A + M of class B + P of class C".
- **FR-008**: Kit purchase MUST require ALL class requirements to be satisfied — partial kits cannot be purchased.
- **FR-009**: Kit pricing MUST apply a fixed bundle price set by admin, independent of individual component prices. The kit has its own `price_minor` field. The UI shows the savings vs. buying components individually.
  Example: Kit requires 2 plates + 3 modules + 1 belt. Individual total = $180. Kit price = $149. Savings displayed: "Save $31".
- **FR-010**: If any selected kit component is out of stock, the kit MUST NOT be purchasable. Customer must select an alternative from that class.
- **FR-011**: Kit inventory reservation MUST reserve each selected component individually.

#### Cart & Checkout

- **FR-012**: System MUST support guest checkout on the Astro site — email + shipping address + Stripe payment, no account required. Guest carts are server-side, identified by a cart token stored in the browser (cookie or localStorage). Cart tokens are opaque UUIDs.
- **FR-012a**: Astro checkout is a client-side JavaScript flow (Astro islands) that calls the backend API directly for cart operations, shipping rates, tax calculation, and Stripe PaymentIntent creation. Product catalog pages are SSG; checkout pages are client-rendered.
- **FR-013**: System MUST support authenticated checkout in the Flutter app with saved addresses and payment methods. Authenticated carts are linked to the customer ID.
- **FR-014**: Cart MUST validate inventory availability for all items before proceeding to payment.
- **FR-015**: Checkout MUST create inventory reservations with a configurable TTL (default 15 minutes) before payment processing.
- **FR-016**: System MUST calculate US sales tax based on shipping address using a tax calculation service (e.g., TaxJar, Avalara, or Stripe Tax). Tax rates are determined by destination state/county/city. Tax calculation is abstracted behind an adapter interface.
  Example: Order shipped to Austin, TX → 8.25% sales tax applied. Order shipped to Portland, OR → 0% (no sales tax).
- **FR-017**: System MUST calculate shipping cost via EasyPost rate API before payment.
- **FR-018**: Shipping MUST be limited to US addresses only. Non-US addresses are rejected with a clear message.

#### Orders

- **FR-019**: Orders MUST use four orthogonal state machines: `order.status`, `payment_status`, `fulfillment_status`, `shipping_status` (as defined in architecture spec section 3.A).
- **FR-020**: All state transitions MUST be validated — invalid transitions are rejected with a descriptive error.
- **FR-021**: All state changes MUST create an `order_status_history` entry with actor attribution.
- **FR-022**: Order lines MUST store snapshot data: `sku_snapshot`, `title_snapshot`, `option_values_snapshot_json`, `unit_price_minor`. These MUST NOT change when the source product is modified.
- **FR-023**: Orders MUST store `billing_address_snapshot_json` and `shipping_address_snapshot_json` at placement time.
- **FR-024**: Order cancellation MUST release all inventory reservations and, if payment was collected, initiate a full refund.
- **FR-025**: System MUST generate a unique, human-readable `order_number` for each order. Format: `KNX-` prefix + 6-digit zero-padded sequential number (e.g., `KNX-000001`). Sequential, no gaps.
  Example: First order → `KNX-000001`, second → `KNX-000002`.

#### Payments (Stripe)

- **FR-026**: System MUST create Stripe PaymentIntents for all orders with correct amount and currency (USD).
- **FR-027**: System MUST process Stripe webhooks for: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.
- **FR-028**: Webhook handlers MUST validate Stripe signature and be idempotent.
- **FR-029**: All Stripe API calls MUST use idempotency keys.
- **FR-030**: System MUST support full and partial refunds with reason codes and actor attribution.
- **FR-031**: Payment events MUST be stored as `payment_event` records with the raw Stripe payload for audit trail.

#### Inventory

- **FR-032**: System MUST track inventory per variant per location: `on_hand`, `reserved`, `available`, `safety_stock`. V1 uses a single default inventory location (since manufacturing is outsourced and ships from one warehouse). The multi-location schema is preserved for future expansion but the UI and logic default to the single location.
- **FR-033**: `available` MUST equal `on_hand - reserved` and MUST never go negative (database CHECK constraint).
- **FR-034**: Inventory reservations MUST follow the state machine: `pending` → `active` → `consumed`/`released`/`expired`; `pending` → `canceled` (architecture spec section 3.B).
- **FR-035**: Reservation creation MUST atomically decrement `available` via `reserved` increment using database-level locking.
- **FR-036**: Inventory movements MUST be recorded as immutable `inventory_movement` ledger entries.
- **FR-037**: Inventory adjustments MUST require actor attribution and create audit log entries.
- **FR-038**: System MUST generate low-stock alerts (push notification + email) when `available` falls below `safety_stock`.

#### Fulfillment

- **FR-039**: System MUST support fulfillment tasks with state machine: `new` → `assigned` → `picking` → `picked` → `packing` → `packed` → `shipment_pending` → `done`; any active state → `blocked` (with reason); pre-shipment states → `canceled` (architecture spec section 3.D).
- **FR-040**: Fulfillment tasks MUST be assignable to specific admin users.
- **FR-041**: Fulfillment queue MUST update in real-time for all admin users.
- **FR-042**: Fulfillment MUST NOT begin until payment_status is `paid`.
- **FR-042a**: System MUST support a next-day shipping SLA: orders confirmed before a configurable cutoff time (default 2:00 PM local) MUST have fulfillment tasks created with priority `high` and flagged for same-day processing. Orders after cutoff are standard priority. The admin dashboard MUST highlight orders at risk of missing the SLA.

#### Shipping (EasyPost)

- **FR-043**: System MUST integrate with EasyPost behind an adapter interface for rate quotes, label purchases, and tracking.
- **FR-044**: Shipments MUST follow the state machine: `draft` → `label_pending` → `label_purchased` → `ready` → `shipped` → `in_transit` → `delivered`; `in_transit` → `exception`; `exception` → `in_transit` (recovery); delivered → `returned`; pre-ship states → `voided` (architecture spec section 3.E).
- **FR-045**: System MUST process EasyPost tracking webhooks and update shipment status in real-time.
- **FR-046**: System MUST store all tracking events as `shipment_event` records.
- **FR-047**: Shipping label purchases MUST be recorded with cost for accounting.
- **FR-048**: Shipment lines MUST map order lines to shipments with quantities.
- **FR-049**: Shipping provider MUST be swappable via the adapter interface without code changes (only config changes).

#### Support

- **FR-050**: System MUST support tickets with state machine: `open` → `waiting_on_customer`/`waiting_on_internal` → `resolved` → `closed`; `open` → `spam`; `resolved` → `open` (reopen) (architecture spec section 3.C).
- **FR-051**: Tickets MUST support message threading with both customer-visible messages and admin-only internal notes.
- **FR-052**: Tickets MUST be linkable to orders, shipments, and disputes for context.
- **FR-053**: Ticket attachments MUST support file upload (photos for warranty claims). Accepted types: JPEG, PNG, PDF. Max file size: 10MB per file, 5 files per message. Storage: S3-compatible object store (abstracted behind adapter, local filesystem for dev).
- **FR-054**: Ticket queue MUST update in real-time for admin users.
- **FR-055**: System MUST support warranty claim tickets with automatic warranty period validation (1 year from delivery date).

#### Disputes & Evidence

- **FR-056**: Dispute records MUST be auto-created from Stripe `charge.dispute.created` webhooks.
- **FR-057**: Disputes MUST follow the state machine: `opened` → `evidence_gathering` → `ready_to_submit` → `submitted` → `won`/`lost`/`accepted` → `closed` (architecture spec section 3.F).
- **FR-058**: System MUST auto-generate evidence records with canonical types: shipment tracking events → `tracking_history`, shipment delivery confirmation → `delivery_proof`, support ticket messages → `customer_communication`, payment events → `payment_receipt`, policy acknowledgments → `policy_acceptance`.
- **FR-059**: Evidence records MUST be immutable (no updates, no deletes).
- **FR-060**: System MUST generate evidence bundles that compile all evidence for a dispute into a downloadable package.
- **FR-061**: Dispute readiness summary MUST show which evidence types are present/missing: `tracking_history_present`, `delivery_proof_present`, `policy_acceptance_present`, `customer_communication_present`, `payment_receipt_present`.
- **FR-062**: Policy snapshots MUST capture versioned copies of return, warranty, and terms policies.
- **FR-063**: Order policy acknowledgments MUST record which policy version the customer saw at checkout.

#### Customers

- **FR-064**: Customer accounts MUST use SuperTokens with email/password authentication.
- **FR-065**: Email verification MUST be required before accessing account features (order history, support, warranty).
- **FR-066**: Upon email verification, all guest orders placed with that email MUST appear in the customer's order history automatically.
- **FR-067**: Customers MUST be able to save multiple shipping addresses.
- **FR-068**: Customer accounts MUST support linking a GitHub identity via OAuth for contributor features.

#### Contributor / Royalty System

- **FR-069**: System MUST maintain a contributor registry linked to GitHub usernames (populated by CLA bot at first PR).
- **FR-070**: System MUST track per-design sales counts via a `contributor_design` entity that links a contributor to one or more product variants they designed. Each sale of a linked variant increments the contributor's per-design sales count.
  Example: Contributor "alice" designed the Waste Bag Holder → `contributor_design` links alice to all variants (TPU/PA11/TPC) of that product. Each sale of any variant counts toward alice's royalty threshold.
- **FR-071**: System MUST calculate royalties at 10% retroactive to unit 1 when the 25-unit threshold is crossed.
- **FR-072**: System MUST support the 501(c)(3) donation option at 2x rate (20%) with designated charity tracking.
- **FR-073**: System MUST collect W-9/W-8BEN tax forms from contributors before first royalty payment.
- **FR-074**: System MUST track milestone rewards: accepted PR (2 plates + 2 modules), 25 units (royalty activation), 50 units (starter kit).
- **FR-075**: Contributor dashboard MUST show: designs contributed, per-design sales, royalty accrual, milestone progress, payout history.
- **FR-076**: If a sale is refunded, the corresponding royalty MUST be clawed back from the contributor's accrual.

#### Admin Identity & Authorization

- **FR-077**: Admin users MUST authenticate via SuperTokens (separate from customer auth).
- **FR-078**: Admin authorization MUST use capability-based permissions, not just role checks. Roles are named bundles of capabilities.
- **FR-079**: All privileged admin actions MUST create `admin_audit_log` entries with: actor, action, entity_type, entity_id, before_json, after_json, ip_address.
- **FR-080**: Permission checks MUST be enforced at the API layer — every admin endpoint validates required capabilities.

#### Real-Time Updates

- **FR-081**: Admin app MUST receive real-time push updates for: new orders, fulfillment queue changes, support ticket updates, inventory alerts, dispute notifications.
- **FR-082**: Customer app MUST receive real-time push updates for: order status changes, shipping tracking updates, support ticket replies.
- **FR-083**: Real-time transport MUST use WebSocket with automatic reconnection (exponential backoff, max 30s) and message buffering (server buffers messages for disconnected clients for up to 5 minutes; client replays missed messages on reconnect using a sequence ID).
- **FR-083a**: WebSocket connections MUST be authenticated. Admin connections use admin session tokens. Customer connections use customer session tokens. Guest connections (for cart/checkout status on Astro) use the cart token. The WebSocket handshake validates the token before upgrading the connection.

#### Notifications

- **FR-084**: System MUST send notifications for: order confirmation, shipping + tracking, support ticket replies, admin alerts (low stock, new dispute, delivery exception).
- **FR-085**: Email delivery MUST be abstracted behind an adapter interface, stubbed for v1 (log to console/file).
- **FR-086**: Admin alert notifications MUST be configurable per admin user (push notification, email, or both).
- **FR-087**: Push notifications for mobile (Flutter app) MUST be designed as an adapter (provider TBD).

#### Public Site (Astro)

- **FR-088**: Astro site MUST serve as the SEO-friendly marketing and product catalog with SSG.
- **FR-089**: Astro site MUST support full guest checkout flow without requiring login.
- **FR-090**: Astro site MUST display the contributions model (contributor incentives, milestones, royalty structure).
- **FR-091**: Astro site MUST display warranty and returns policy with material-specific disclaimers (TPU heat, safety).
- **FR-092**: Astro site MUST display care instructions per material tier.

#### Infrastructure

- **FR-093**: All infrastructure MUST be provisioned via OpenTofu (IaC).
- **FR-094**: DNS MUST be managed via Cloudflare through OpenTofu.
- **FR-095**: TLS certificates MUST be provisioned via Let's Encrypt with Nginx.
- **FR-096**: NixOS MUST be used for server configuration with hierarchical flakes.
- **FR-097**: Nix VM tests MUST validate server configuration, firewall rules, and service binding (per TEST-METHODOLOGY.md).
- **FR-098**: Repo MUST use hierarchical Nix flake system: root flake composes sub-flakes for scad/, site/, api/, admin/, customer/, deploy/.

#### DX & Operations

- **FR-099**: One-command developer setup: `nix develop` (via direnv) then `npm run dev` starts all services.
- **FR-100**: Full script inventory MUST be provided: dev, test, test:unit, test:integration, lint, lint:fix, typecheck, build, db:migrate, db:seed, db:reset, codegen (if applicable), clean, clean:all, check.
- **FR-101**: Database migrations MUST use Liquibase with SQL-first changelogs and rollback support.
- **FR-102**: Operations runbook MUST document all maintenance tasks with cadence and failure recovery procedures.
- **FR-103**: Health check endpoints: `GET /health` (liveness) and `GET /ready` (readiness with dependency checks).

#### Logging & Error Handling

- **FR-104**: All logging MUST use Pino with structured JSON output, 5 levels, and correlation IDs per request.
- **FR-105**: Error handling MUST use a typed hierarchy: `AppError` → `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409), `AuthenticationError` (401), `AuthorizationError` (403), `ExternalServiceError` (502), `RateLimitError` (429), `InternalError` (500).
- **FR-106**: Unhandled exceptions MUST trigger graceful shutdown (30s timeout, ordered cleanup).

#### Security

- **FR-107**: All API input MUST be validated via JSON schema at the boundary.
- **FR-108**: Security headers MUST be set on all responses: HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
- **FR-109**: CORS MUST be restrictive — specific allowed origins only, not wildcard.
- **FR-110**: Rate limiting MUST be applied per-IP on public endpoints and per-user on authenticated endpoints with standard headers.
- **FR-111**: Security scanning in CI: Trivy (SCA), Semgrep (SAST), Gitleaks (secrets), npm audit, with SARIF uploads to GitHub Security tab.

#### Configuration

- **FR-112**: All configuration MUST be loaded from a single config module with three-layer precedence: defaults → config file → env vars.
- **FR-113**: Config MUST fail-fast on startup if required values are missing or invalid.
- **FR-114**: All backing services (Postgres, Stripe, SuperTokens, EasyPost, email) MUST be swappable via config without code changes.

#### File Storage

- **FR-115**: File uploads (ticket attachments, W-9/W-8BEN documents, evidence files) MUST be stored via an abstracted storage adapter. Dev: local filesystem. Production: S3-compatible object store.
- **FR-116**: Uploaded files MUST be access-controlled — ticket attachments visible only to the ticket's customer and admin users. Tax documents visible only to the contributor and finance admins.

#### Tax Calculation

- **FR-117**: US sales tax MUST be calculated via Stripe Tax as the production implementation. A stub adapter (zero tax) is available for development when no Stripe Tax API key is configured. The system MUST detect whether the Stripe Tax key is present and use the real implementation when available, stub when not. This is gated on the `STRIPE_TAX_ENABLED` config flag + valid Stripe API key with Tax permissions.
- **FR-118**: Tax amount MUST be displayed to the customer before payment confirmation and stored as `tax_minor` on the order.
- **FR-119**: Tax calculation MUST support automatic tax registration detection — Stripe Tax handles nexus determination based on Kanix's registered tax jurisdictions.
- **FR-120**: Tax line items MUST be included in Stripe PaymentIntent metadata for compliance reporting.

### Key Entities

As defined in the architecture spec (section 1), the core entities are:

- **customer / customer_address** — account with email, verified status, optional GitHub link, saved addresses
- **product / product_variant / product_media** — catalog entity with material variants (TPU/PA11/TPC), media
- **product_class / product_class_membership** — classification for kit composition
- **kit_definition / kit_class_requirement** — class-based composition rule (N of class A + M of class B...)
- **collection / collection_product** — product groupings
- **cart / cart_line / cart_kit_selection** — pre-order basket with variant and kit selections, `token` for guest lookup
- **order / order_line / order_status_history** — placed order with snapshot data, `email` for guest linking, four orthogonal state machines
- **payment / payment_event / refund** — Stripe-backed payment records
- **inventory_location / inventory_balance / inventory_reservation / inventory_movement / inventory_adjustment** — stock tracking with `idempotency_key` on adjustments
- **fulfillment_task** — operational unit for pick/pack/ship
- **shipment / shipment_line / shipment_event / shipment_package / shipping_label_purchase** — shipping entities
- **support_ticket / support_ticket_message / support_ticket_attachment / support_ticket_status_history** — support system
- **dispute / evidence_record / evidence_bundle** — chargeback defense, evidence types: `delivery_proof`, `tracking_history`, `customer_communication`, `policy_acceptance`, `payment_receipt`
- **policy_snapshot / order_policy_acknowledgment** — policy versioning
- **contributor / contributor_design / contributor_royalty / contributor_milestone / contributor_tax_document / contributor_payout / contributor_donation** — royalty system
- **admin_user / admin_role / admin_user_role / admin_audit_log** — admin identity

---

## Non-Goals (v1)

- **No custom orders or custom colors** — all products are black, standard catalog. Rationale: simplifies inventory and manufacturing during launch.
- **No subscription or recurring orders** — one-time purchases only. Rationale: not a consumable product.
- **No marketplace** — no third-party sellers. Rationale: Kanix manufactures all products.
- **No international shipping** — US only. Rationale: simplifies tax, customs, and shipping logistics for launch.
- **No manufacturing integration** — inventory is managed manually via admin app after batches arrive from outsourced manufacturer. Rationale: manufacturing workflow is out of scope.
- **No live chat support** — ticket-based only. Rationale: keeps support manageable with small team.
- **No cloud sync of 3D model files** — models are in the git repo. Rationale: git is the source of truth for designs.
- **No plugin or extension system** — platform is purpose-built. Rationale: no third-party integrations needed at launch.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Guest can complete purchase on Astro site in under 3 minutes from product page to confirmation [validates FR-012, FR-014, FR-015, FR-026]
- **SC-002**: All state machine transitions are validated — zero invalid transitions possible via API [validates FR-019, FR-020, FR-034, FR-039, FR-044, FR-050, FR-057]
- **SC-003**: Concurrent inventory reservations for the last available unit result in exactly one success and one failure [validates FR-035, FR-E007]
- **SC-004**: Guest orders appear in account order history within 1 second of email verification [validates FR-066, FR-E016]
- **SC-005**: Dispute evidence bundle contains all auto-collected evidence types for a complete order lifecycle [validates FR-058, FR-060, FR-061]
- **SC-006**: Admin audit log captures every privileged action with full before/after state [validates FR-079, FR-037]
- **SC-007**: Real-time updates arrive at admin and customer clients within 2 seconds of state change [validates FR-081, FR-082, FR-083]
- **SC-008**: Zero critical security vulnerabilities in CI scan pipeline [validates FR-107, FR-108, FR-109, FR-110, FR-111]
- **SC-009**: New developer can go from `git clone` to running local dev environment in under 5 minutes [validates FR-099, FR-100]
- **SC-010**: Kit composition enforces class requirements — incomplete kits cannot be purchased [validates FR-007, FR-008, FR-010]
- **SC-011**: Contributor royalty calculations are correct: retroactive 10% from unit 1 at 25-unit threshold, 2x for donations [validates FR-071, FR-072, FR-076]
- **SC-012**: Health check endpoints return correct status during startup, normal operation, and shutdown [validates FR-103, FR-106]
- **SC-013**: All infrastructure is reproducible — `tofu apply` from a fresh state produces identical configuration [validates FR-093, FR-094, FR-095, FR-096]
- **SC-014**: Webhook handlers are idempotent — duplicate Stripe/EasyPost events produce identical results [validates FR-028, FR-E010]
- **SC-015**: API returns correct error codes and messages for all invalid input scenarios [validates FR-105, FR-107]
- **SC-016**: File uploads are access-controlled — ticket attachments only accessible by ticket owner and admins, tax documents only by contributor and finance admins [validates FR-115, FR-116]
- **SC-017**: Tax calculation is correct for sample US addresses across states with and without sales tax [validates FR-117, FR-118]
- **SC-018**: Warranty claims are auto-validated against the 1-year warranty period from delivery date [validates FR-055]

---

## Enterprise Infrastructure Decisions

### Logging
- **Library**: Pino (Fastify's built-in logger)
- **Format**: Structured JSON, 5 levels (DEBUG/INFO/WARN/ERROR/FATAL)
- **Correlation IDs**: Per-request, propagated to downstream calls
- **Config**: Log level via `LOG_LEVEL` env var (WARN in production, DEBUG in development)
- **Destination**: stderr

### Error Handling
- **Hierarchy**: `AppError` → `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409), `AuthenticationError` (401), `AuthorizationError` (403), `ExternalServiceError` (502), `RateLimitError` (429), `InternalError` (500)
- **Error codes**: Machine-readable strings (e.g., `ERR_ORDER_NOT_FOUND`, `ERR_INVENTORY_INSUFFICIENT`)
- **Propagation**: Throw at failure point, catch at Fastify error handler boundary, log with correlation ID, return sanitized response

### Configuration
- **Module**: `api/src/config.ts`
- **Precedence**: App defaults → config file → environment variables
- **Validation**: Fail-fast at startup
- **Secrets**: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPERTOKENS_API_KEY`, `SUPERTOKENS_CONNECTION_URI`, `EASYPOST_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`

### Auth (SuperTokens)
- **Customer**: Email/password, email verification required
- **Contributor**: GitHub OAuth link (links GitHub identity to existing account)
- **Admin**: Separate SuperTokens recipe, capability-based permissions
- **Sessions**: SuperTokens managed, configurable expiration

### CORS
- **Policy**: Restrictive — allowed origins: Astro site domain, Flutter web app domain
- **Not wildcard**

### Rate Limiting
- **Public endpoints**: Per-IP, sliding window
- **Authenticated endpoints**: Per-user, sliding window
- **Headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **429 response**: `Retry-After` header, structured error body
- **Timeout budgets**: All external calls (Stripe, EasyPost, SuperTokens) have explicit timeouts

### Observability
- Pino structured logging as base layer
- Correlation IDs for request tracing
- **[DEFERRED]** Prometheus/OpenTelemetry metrics — add when traffic warrants monitoring
- **[DEFERRED]** Distributed tracing — add when multi-service architecture materializes

### Graceful Shutdown
- **Timeout**: 30 seconds
- **Sequence**: Stop accepting connections → drain in-flight requests → close WebSocket connections → close DB pool → close external connections (Stripe, EasyPost, SuperTokens) → flush logs → exit 0 (or exit 1 if timeout exceeded)

### Health Checks
- **`GET /health`** (liveness): 200 if alive, JSON body with uptime, version, dependency status
- **`GET /ready`** (readiness): 200 when ready, 503 during startup/shutdown/dependency failure
- **Active checks**: Postgres ping, SuperTokens reachability
- **[DEFERRED]** Stripe/EasyPost cached/background health checks

### Security Scanning
- **Tier 1**: Trivy (SCA), Semgrep (SAST), Gitleaks (pre-commit secrets), npm audit
- **Tier 1.5**: Snyk (open source), SonarCloud, OpenSSF Scorecard
- **CI**: SARIF uploads to GitHub Security tab
- **TypeScript**: Strict mode enabled
- **Headers**: HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy

### CI/CD
- **Platform**: GitHub Actions
- **Quality gates**: Tests pass, type check clean, lint clean, no critical vulns, no leaked secrets
- **Branching**: Feature branches with PRs, squash-merge to main
- **Branch naming**: `feature/<name>`, `fix/<name>`

### DX Tooling
- **Nix**: Hierarchical flakes with direnv auto-activation
- **Scripts**: Full inventory (dev, test, lint, build, db:migrate, db:seed, db:reset, clean, check)
- **Dev server**: process-compose for Postgres + SuperTokens, Fastify with HMR, Astro dev server
- **Debugging**: VS Code launch.json
- **Env management**: `.env.example` → `.env` pattern

### Database Migrations
- **Tool**: Liquibase
- **Format**: SQL-first changelogs with rollback support
- **Seeding**: Seed script for dev bootstrapping and test fixtures

---

## Assumptions

- Kanix has a GitHub organization where the CLA bot is already configured (or will be configured as part of this project)
- The outsourced manufacturer delivers products in batches; inventory is manually adjusted in the admin app when batches arrive
- Stripe test mode is used for development; production Stripe keys are configured via environment variables
- SuperTokens is self-hosted (not managed cloud) — the NixOS configuration includes SuperTokens core
- EasyPost test mode is used for development; production keys configured via env vars
- All monetary amounts are stored in minor units (cents) as integers to avoid floating-point issues
- The domain name for the Kanix site is already owned and DNS is ready to be pointed to Cloudflare
- The existing Astro site in `site/` will be evolved (not rewritten from scratch) to include product pages and checkout
- The existing OpenSCAD models in `scad/` are preserved as-is, just reorganized under their own flake
