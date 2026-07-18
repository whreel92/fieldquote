/**
 * Rate math shared by the onboarding wizard and settings (CLAUDE.md Phase 1).
 * The pricing engine (Phase 2, Python) implements the same models; goldens
 * there are the final authority on rounding.
 *
 * margin:  price = cost / (1 - pct/100)   — pct of the PRICE is profit
 * markup:  price = cost * (1 + pct/100)   — pct of the COST is added
 */

export type MarkupModel = 'margin' | 'markup';

export function priceFromCost(cost: number, model: MarkupModel, pct: number): number {
  if (!Number.isFinite(cost) || cost < 0) throw new RangeError('cost must be >= 0');
  if (!Number.isFinite(pct) || pct < 0) throw new RangeError('pct must be >= 0');
  if (model === 'margin') {
    if (pct >= 100) throw new RangeError('margin pct must be < 100');
    return round2(cost / (1 - pct / 100));
  }
  return round2(cost * (1 + pct / 100));
}

/** Effective margin % of a price (what portion of the price is profit). */
export function effectiveMarginPct(cost: number, price: number): number {
  if (price <= 0) return 0;
  return round2(((price - cost) / price) * 100);
}

/** Plain-English example line for the wizard: "a job costing $1,000 will price at $X". */
export function explainerExample(model: MarkupModel, pct: number, exampleCost = 1000): string {
  const price = priceFromCost(exampleCost, model, pct);
  const noun = model === 'margin' ? 'margin' : 'markup';
  return `A job costing $${exampleCost.toLocaleString('en-US')} will price at $${price.toLocaleString(
    'en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )} at ${pct}% ${noun}.`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
