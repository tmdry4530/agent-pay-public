/**
 * NEAR amounts in yoctoNEAR (1 NEAR = 10^24 yocto) without binary floating-point math.
 * Decimal digits are taken from a string (or from Number#toString, including
 * exponent form such as "1e-7") and combined with BigInt.
 */

const YOCTO_DECIMALS = 24;
const YOCTO_FACTOR = 10n ** BigInt(YOCTO_DECIMALS);
const MAX_EXPONENT = 10_000;

export function parseNearToYocto(amount: number | string): string {
  const decimal = toPlainDecimal(amount);
  if (decimal.startsWith('-')) {
    throw new Error('amount must be greater than 0');
  }
  const unsigned = decimal.startsWith('+') ? decimal.slice(1) : decimal;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (!/^\d+$/.test(intPart) || (fracPart !== '' && !/^\d+$/.test(fracPart))) {
    throw new Error('invalid amount');
  }
  if (fracPart.length > YOCTO_DECIMALS) {
    throw new Error('amount has more than 24 decimal places');
  }
  const yocto = BigInt(intPart) * YOCTO_FACTOR + BigInt(fracPart.padEnd(YOCTO_DECIMALS, '0'));
  if (yocto <= 0n) {
    throw new Error('amount must be greater than 0');
  }
  return yocto.toString();
}

/** Display helper. Strips trailing fractional zeros. */
export function formatYoctoToNear(yocto: string): string {
  if (!/^-?\d+$/.test(yocto)) {
    throw new Error('yocto must be an integer string');
  }
  const value = BigInt(yocto);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / YOCTO_FACTOR;
  const frac = abs % YOCTO_FACTOR;
  let body = whole.toString();
  if (frac !== 0n) {
    const fracStr = frac.toString().padStart(YOCTO_DECIMALS, '0').replace(/0+$/, '');
    body = `${body}.${fracStr}`;
  }
  return negative ? `-${body}` : body;
}

function toPlainDecimal(amount: number | string): string {
  if (typeof amount === 'number') {
    if (Number.isNaN(amount)) {
      throw new Error('amount is NaN');
    }
    if (!Number.isFinite(amount)) {
      throw new Error('amount must be finite');
    }
    return expandExponent(amount.toString());
  }
  if (typeof amount !== 'string') {
    throw new Error('amount must be a number or string');
  }
  const trimmed = amount.trim();
  if (trimmed === '') {
    throw new Error('invalid amount');
  }
  return expandExponent(trimmed);
}

/**
 * Expand a decimal or scientific string ("1.5e+21", "1e-7") into a plain
 * decimal using digit shifting only.
 */
function expandExponent(raw: string): string {
  const match = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) {
    throw new Error('invalid amount');
  }
  const sign = match[1] === '-' ? '-' : '';
  const intDigits = match[2];
  if (intDigits === undefined) {
    throw new Error('invalid amount');
  }
  const fracDigits = match[3] ?? '';
  const expGroup = match[4];
  const exp = expGroup === undefined ? 0 : Number.parseInt(expGroup, 10);
  if (!Number.isInteger(exp)) {
    throw new Error('invalid amount');
  }
  const digits = `${intDigits}${fracDigits}`;
  if (Math.abs(exp) > MAX_EXPONENT || digits.length + Math.abs(exp) > MAX_EXPONENT) {
    throw new Error('amount is too large');
  }
  const point = intDigits.length + exp;
  let body: string;
  if (point <= 0) {
    body = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    body = `${digits}${'0'.repeat(point - digits.length)}`;
  } else {
    body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const dot = body.indexOf('.');
  const wholeRaw = dot === -1 ? body : body.slice(0, dot);
  const fracRaw = dot === -1 ? undefined : body.slice(dot + 1);
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const normalized = fracRaw === undefined ? whole : `${whole}.${fracRaw}`;
  return sign === '' ? normalized : `${sign}${normalized}`;
}
