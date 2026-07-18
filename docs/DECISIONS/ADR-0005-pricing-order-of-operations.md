# ADR-0005 — Pricing engine order of operations

**Status:** accepted · **Phase:** 2 · **Date:** 2026-07-18

## Context

Rule §0.1.1: the LLM never prices — all dollar amounts come from a deterministic
engine over versioned data. For estimates to be explainable line-by-line in the
editor ("show the math"), the sequence in which rates, modifiers, rounding, and
company policy apply must be fixed and documented, because different orders give
different totals (e.g. rounding before vs after margin).

## Decision

`fieldquote.pricing` is a pure module: `price(PricingRequest, Catalog) →
PricedEstimate`. No I/O, no clock, no randomness. All arithmetic in `Decimal`.

Order (normative — mirrored in `engine.py` docstring; changing it requires a
golden-file snapshot-update commit with rationale):

1. **Validation.** Assembly codes, modifier codes, tier selections, and BOM SKUs
   must resolve against the catalog snapshot; unknowns raise typed errors
   (`unknown_assembly`, `unknown_modifier`, `modifier_not_allowed`,
   `unknown_sku`, `tier_not_available`, `invalid_margin`). These error codes
   feed the Phase 3 AI repair loop.
2. **Materials.** Per SKU: `base_price × region_multiplier` (default 1 when the
   region is not in the SKU's map), rounded HALF_UP to cents ⇒ unit price.
   Extended = unit price × BOM qty × line qty, rounded to cents. A modifier
   `material_mult` (e.g. long-run wire) multiplies the line's material cost.
3. **Labor hours.** Per unit: assembly `labor_hours` × company per-assembly
   override multiplier (Phase 9 feedback loop), then **all multiplicative
   modifier effects, then all additive effects**, each in request order. Hours
   round HALF_UP to 0.01 at every step so the trace shown to the contractor sums
   exactly.
4. **Labor cost.** Total hours × labor rate; helper hours × helper rate (helper
   rate falls back to labor rate). Rounded to cents.
5. **Line price.** Cost = materials + labor + helper. Company model:
   `margin` → `cost / (1 − pct/100)` (pct ≥ 100 is an error); `markup` →
   `cost × (1 + pct/100)`. `pct` is the estimate-level override if provided,
   else company target. **Line-level rounding is authoritative**: totals are
   sums of rounded line totals (HALF_UP to cents). `unit_price` is display-only
   (`total / qty` rounded).
6. **Option tiers.** An assembly with `option_tiers` expands to one line per
   tier (`option_good|better|best`); a tier fully replaces base hours/BOM. Only
   the selected tier (default `good`) is `included` in totals.
7. **Allowances.** Fixed amounts, no margin/modifiers, `confidence: allowance`.
8. **Discount.** Applied after all lines, capped at the running subtotal (the
   subtotal can never go negative).
9. **Job minimum.** If the post-discount subtotal is below the company minimum,
   a "Minimum job charge" line tops it up to exactly the minimum.
10. **Tax.** `subtotal × tax_rate_pct`, rounded to cents; total = subtotal + tax.
11. **Margin check.** Effective margin over cost-bearing included lines only
    (allowances excluded — they carry price but no engine-known cost, and would
    inflate apparent margin). Flags `below_target` and `below_floor`.

## Consequences

- Golden files pin exact byte-level outputs; hypothesis property tests assert
  determinism, non-negative totals, and monotonicity in qty.
- The editor renders `LineBreakdown` verbatim — no client-side math.
- Allowance-heavy estimates show honest (cost-bearing-only) margin.
