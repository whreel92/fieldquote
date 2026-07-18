import { describe, expect, it } from 'vitest';

import { effectiveMarginPct, explainerExample, priceFromCost } from './rates';

describe('priceFromCost', () => {
  it('margin model: 50% margin doubles the cost', () => {
    expect(priceFromCost(1000, 'margin', 50)).toBe(2000);
  });

  it('margin model: 45% margin', () => {
    expect(priceFromCost(1000, 'margin', 45)).toBe(1818.18);
  });

  it('markup model: 50% markup adds half the cost', () => {
    expect(priceFromCost(1000, 'markup', 50)).toBe(1500);
  });

  it('0% leaves cost unchanged in both models', () => {
    expect(priceFromCost(1234.56, 'margin', 0)).toBe(1234.56);
    expect(priceFromCost(1234.56, 'markup', 0)).toBe(1234.56);
  });

  it('rejects margin >= 100%', () => {
    expect(() => priceFromCost(1000, 'margin', 100)).toThrow(RangeError);
  });

  it('rejects negative inputs', () => {
    expect(() => priceFromCost(-1, 'margin', 50)).toThrow(RangeError);
    expect(() => priceFromCost(1000, 'markup', -5)).toThrow(RangeError);
  });

  it('same pct yields higher price under margin than markup', () => {
    for (const pct of [10, 25, 45, 60]) {
      expect(priceFromCost(1000, 'margin', pct)).toBeGreaterThan(
        priceFromCost(1000, 'markup', pct),
      );
    }
  });
});

describe('effectiveMarginPct', () => {
  it('round-trips with priceFromCost margin model', () => {
    const price = priceFromCost(1000, 'margin', 45);
    expect(effectiveMarginPct(1000, price)).toBeCloseTo(45, 1);
  });

  it('markup 50% is a 33.33% effective margin', () => {
    expect(effectiveMarginPct(1000, 1500)).toBe(33.33);
  });

  it('guards zero price', () => {
    expect(effectiveMarginPct(1000, 0)).toBe(0);
  });
});

describe('explainerExample', () => {
  it('renders the wizard sentence', () => {
    expect(explainerExample('margin', 50)).toBe(
      'A job costing $1,000 will price at $2,000.00 at 50% margin.',
    );
  });
});
