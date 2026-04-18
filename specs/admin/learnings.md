# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T090 — Implement SSG product catalog pages
- Astro SSG product pages must gracefully handle missing API (`PUBLIC_API_URL` not set) — `fetchProducts()` returns `[]` so the build succeeds with an empty catalog and a "Coming Soon" placeholder
- Product-to-module STL viewer matching uses slug substring matching (`product.slug.includes(mod.slug)`) since product slugs may contain the module slug plus a material suffix (e.g. `waste-bag-dispenser-tpu`)
- OpenGraph meta tags added to `Base.astro` via optional props (`ogImage`, `ogType`, `canonicalUrl`) — all existing pages get default OG tags without changes since the new props have sensible defaults

## T091 — Implement guest checkout as Astro islands
- Astro checkout uses vanilla JS `<script>` tags (not React/Vue islands) since the project has no framework integration — Astro bundles these into separate JS files in `_astro/`, so integration tests checking for inline JS strings must also grep the bundled files
- The API's `POST /api/checkout` combines shipping calc + tax calc + Stripe PaymentIntent creation in one call, returning `client_secret` — the checkout flow is: address form → checkout API → show totals → Stripe `confirmPayment()` → redirect to confirmation
- Stripe.js loaded from CDN (`js.stripe.com/v3/`) with the Payment Element (not Card Element) for PCI compliance — uses `appearance: { theme: "night" }` to match the dark Kanix theme

## T092 — Implement kit builder page
- Kit builder uses the public `GET /api/kits` endpoint (from T085's `findActiveKitsWithDetails`) which returns kit definitions with nested requirements, product classes, products, and variant-level inventory — no auth required
- Kit variant selection UI uses `data-class-id` attributes on buttons to scope selections per class, with CSS class toggling for selected state (`border-amber-500 bg-amber-500/10`) — savings calculated client-side as `sum(individual prices) - kit price`
- The `POST /api/cart/kits` endpoint expects `{ kit_definition_id, selections: [{ product_class_id, variant_id }] }` and returns `{ kit, cart }` — the cart library's `addKitToCart` auto-creates a cart if no token exists (same pattern as `addToCart`)

## T093 — Add contributions model page
- Astro content pages (contributions, warranty, etc.) are pure static pages — no API data fetching needed, just use the Base layout with matching nav/footer patterns from index.astro
- Royalty spec details are spread across FR-069 through FR-076 — the key numbers are: 10% royalty at 25-unit threshold (retroactive), 20% for 501(c)(3) donation option, 50-unit starter kit milestone

## T094 — Add warranty, returns, and care instructions pages
- Material temperature thresholds already defined in `MATERIAL_WARNINGS` in `site/src/data/products.ts` — reuse these values (TPU 60°C, TPC 130°C, PLA 50°C, PETG 80°C, ABS 100°C) for consistency across warranty and care pages
- Footer links must be added to every page individually since there's no shared footer component — 10 pages total needed updating (7 existing + 3 new)

## T095 — Update README with contributions model
- T093 already added the full Contributions Model section to README (milestones table, contributions page link, CLA instructions) — T095 was redundant and required no code changes

## T095a — Add nix-mcp-debugkit flake input + re-export packages + config writers
- Config writers use `pkgs.writeTextFile` with `destination` to produce a directory containing `mcp/*.json` — `nix build .#mcp-android-config` outputs a store path with `mcp/android.json` inside it
- MCP config JSON pins commands to Nix store paths via string interpolation (`"${mcp-android}/bin/mcp-android"`) so the config is reproducible and doesn't rely on PATH

## T095b — Register MCP servers + required permissions in `.claude/settings.json`
- MCP server registrations go in `.mcp.json` (project root), not in `.claude/settings.json` — the settings schema does not accept `mcpServers` directly
- `enableAllProjectMcpServers: true` in settings.json auto-approves all servers from `.mcp.json` so agents don't get prompted

## T095c — KVM + emulator prereq verification + backend setup/teardown scripts
- `kvm-ok` is not always installed (not in the Nix devshell); the prereqs script falls back to checking `/dev/kvm` readability when `kvm-ok` is unavailable
- Astro dev server default port is 4321 (not 3000) — setup.sh uses `--port 4321` explicitly to avoid conflicts with the API on port 3000
- `pg_ctl start` is idempotent-safe (returns 0 even if already running) making the setup script re-runnable without killing existing services first
