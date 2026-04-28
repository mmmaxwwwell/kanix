# Research: BUG-028 — GET /api/admin/contributors/:id/designs does not return salesCount field

## Root cause analysis

`listDesignsByContributor` in `api/src/db/queries/contributor.ts:217` performs a SELECT
that omits `salesCount`. The `ContributorDesignRow` interface (line 73) also omits it.
The DB column `contributor_design.sales_count` exists (schema line 35, mapped as
`contributorDesign.salesCount` in drizzle).

## Evidence

```ts
// contributor.ts:217 — select does NOT include salesCount
.select({
  id: contributorDesign.id,
  contributorId: contributorDesign.contributorId,
  productId: contributorDesign.productId,
  createdAt: contributorDesign.createdAt,
  productTitle: product.title,
  productSlug: product.slug,
})
```

The field is used elsewhere in contributor.ts (e.g. line 262 `getDesignSalesCount`,
line 339, line 1028 in other queries) — confirming the column exists in the ORM schema.

## Recommended fix strategy

1. Add `salesCount: number` to `ContributorDesignRow` interface (contributor.ts:73).
2. Add `salesCount: contributorDesign.salesCount` to the `.select()` in
   `listDesignsByContributor` (contributor.ts:221).
No other files need changing — server.ts just passes the result through.

## What NOT to do

- Do not add a second query to fetch salesCount separately — it's in the same table.

## Confidence

High — one-line select omission with clear evidence.
