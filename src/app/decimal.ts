/**
 * A typed number, accepting a decimal comma. iOS Safari's `inputmode="decimal"`
 * pad shows the locale's separator, so in German, French and many other locales
 * it offers "," and no "." at all: "1,5" must read as 1.5. Only a single comma
 * with no point is taken as a decimal separator; anything else is left to
 * Number() as before (so "1,000.5" stays NaN rather than guessing).
 */
export function parseDecimal(text: string): number {
  const t = text.trim();
  return Number(/^[^.,]*,[^.,]*$/.test(t) ? t.replace(',', '.') : t);
}
