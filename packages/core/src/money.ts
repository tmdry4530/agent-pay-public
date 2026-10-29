/**
 * Exact money arithmetic for policy checks (F6). Browser-safe: no node: imports.
 *
 * Amounts stay `number` at the API boundary. For comparisons and totals they are
 * converted to integer minor units (bigint) using the decimal digits of the
 * number's shortest round-trip string (`String(n)`), which is what a JSON client
 * sent. Only the currencies the project actually uses are listed: USD (PayPal
 * seeds, cents) and NEAR (yoctoNEAR, 24 decimals). Policies in any other currency
 * are rejected by evaluate with invalid_policy until an entry is added here.
 */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({ USD: 2, NEAR: 24 });

/** Minor-unit digits for `currency` (case-insensitive), or undefined when unsupported. */
export function currencyDecimals(currency: string): number | undefined {
  const key = String(currency).toUpperCase();
  return Object.hasOwn(CURRENCY_DECIMALS, key) ? CURRENCY_DECIMALS[key] : undefined;
}

/** value = digits / 10^scale, from the shortest round-trip string of a finite number. */
function decimalOf(n: number): { digits: bigint; scale: number } {
  const [mantissa = '0', exponent] = String(n).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [int = '0', frac = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  let digits = BigInt(int + frac);
  let scale = frac.length - (exponent === undefined ? 0 : Number(exponent));
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits: negative ? -digits : digits, scale };
}

/**
 * Exact integer minor units of `amount` with `decimals` digits, or undefined when the
 * amount is not finite or has more decimal places than allowed (e.g. 10.001 USD).
 */
export function toMinorUnits(amount: number, decimals: number): bigint | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  const { digits, scale } = decimalOf(amount);
  if (scale <= decimals) return digits * 10n ** BigInt(decimals - scale);
  const div = 10n ** BigInt(scale - decimals);
  return digits % div === 0n ? digits / div : undefined;
}

/**
 * Minor units of `amount`, rounded UP when it has excess precision (conservative for
 * spend already on the books, e.g. legacy totals or old ledger entries). Undefined if not finite.
 */
export function ceilMinorUnits(amount: number, decimals: number): bigint | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  const { digits, scale } = decimalOf(amount);
  if (scale <= decimals) return digits * 10n ** BigInt(decimals - scale);
  const div = 10n ** BigInt(scale - decimals);
  const q = digits / div;
  return digits % div > 0n ? q + 1n : q;
}

/** Plain decimal string of `minor` units (trailing fractional zeros dropped): 1001n,2 → "10.01". */
export function formatMinor(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const s = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const int = decimals === 0 ? s : s.slice(0, -decimals);
  const frac = decimals === 0 ? '' : s.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}
