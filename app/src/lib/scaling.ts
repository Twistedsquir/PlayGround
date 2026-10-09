// Recipe scaling + readable US measurements (SPEC section 6).
// Rules: proportional scale, keep fractions, never invent precision for
// missing/range/qualitative quantities — flag them instead.

export interface ScaleResult {
  amount: number | null;
  display: string;
  scaled: boolean;
  note: string | null;
}

// Greatest common divisor for fraction reduction.
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b > 0.5) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

// Format a positive number as a readable US fraction (denominators up to 8).
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '';
  const rounded8 = Math.round(n * 8) / 8;
  const whole = Math.floor(rounded8 + 1e-9);
  const rem8 = Math.round((rounded8 - whole) * 8);
  if (rem8 === 0) return String(whole);
  const d = gcd(rem8, 8);
  const num = rem8 / d;
  const den = 8 / d;
  const frac = den === 2 && num === 1 ? '½' : den === 4 && num === 1 ? '¼' : den === 4 && num === 3 ? '¾' : `${num}/${den}`;
  return whole === 0 ? frac : `${whole} ${frac}`;
}

export interface ScalableQty {
  qty_amount: number | null;
  qty_min?: number | null;
  qty_max?: number | null;
  unit_raw?: string | null;
  is_scalable?: boolean;
}

export function scaleQuantity(
  q: ScalableQty,
  originalServings: number,
  targetServings: number,
): ScaleResult {
  if (!originalServings || originalServings <= 0) {
    return { amount: null, display: 'servings unknown — could not scale', scaled: false, note: 'original servings missing' };
  }
  if (q.is_scalable === false || (q.qty_amount == null && q.qty_min == null && q.qty_max == null)) {
    return { amount: null, display: 'to taste — adjust as needed', scaled: false, note: 'no scalable quantity' };
  }
  const factor = targetServings / originalServings;
  // Ranges: scale both ends, keep the range shape.
  if (q.qty_amount == null && (q.qty_min != null || q.qty_max != null)) {
    const lo = q.qty_min != null ? formatAmount(q.qty_min * factor) : '';
    const hi = q.qty_max != null ? formatAmount(q.qty_max * factor) : '';
    const unit = q.unit_raw ? ` ${q.unit_raw}` : '';
    return { amount: null, display: `${lo}–${hi}${unit} (scaled range)`, scaled: true, note: null };
  }
  const amount = (q.qty_amount as number) * factor;
  return { amount, display: `${formatAmount(amount)}${q.unit_raw ? ` ${q.unit_raw}` : ''}`, scaled: true, note: null };
}

// Safe unit conversions: weight<->weight, volume<->volume only.
// Never weight<->volume (needs density) — caller must keep those separate.
const WEIGHT_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_ML: Record<string, number> = {
  ml: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41,
};

export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace('.', '');
  const map: Record<string, string> = {
    g: 'g', gram: 'g', grams: 'g', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    oz: 'oz', ounce: 'oz', ounces: 'oz', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    ml: 'ml', l: 'L', liter: 'L', liters: 'L', litre: 'L',
    tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
    tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
    'fl oz': 'fl oz', cup: 'cup', cups: 'cup', pint: 'pint', pints: 'pint',
    quart: 'quart', quarts: 'quart', gallon: 'gallon', gallons: 'gallon',
  };
  return map[t] ?? null; // unknown units stay unmerged (SPEC section 8)
}

export function canCombineUnits(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aW = a in WEIGHT_G;
  const bW = b in WEIGHT_G;
  const aV = a in VOLUME_ML;
  const bV = b in VOLUME_ML;
  return (aW && bW) || (aV && bV);
}

export function canonicalName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}
