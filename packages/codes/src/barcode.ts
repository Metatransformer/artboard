/**
 * @artboard/codes — linear barcodes.
 *
 * Code 128 (sets B and C) and EAN-13, written from the symbology
 * specifications. Both encoders return a plain module run: one boolean per
 * narrow module, `true` for a bar. Quiet zones are NOT included — the node
 * builder adds them, so callers who want raw modules get exactly the symbol.
 */

import { CodeError } from './qr.js';

/* ── Code 128 ───────────────────────────────────────────────────────────────
 * Each of the 106 symbol values is six alternating element widths, bar first,
 * summing to 11 modules. The stop character is the one exception: seven
 * elements, 13 modules, ending in the two-module termination bar.
 * -------------------------------------------------------------------------- */

const C128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const C128_CODE_C = 99;   // from set B: switch to set C
const C128_CODE_B = 100;  // from set C: switch to set B
const C128_START_B = 104;
const C128_START_C = 105;
const C128_STOP = 106;

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** Length of the run of digits starting at `i`. */
const digitRun = (text: string, i: number): number => {
  let n = 0;
  while (i + n < text.length && isDigit(text[i + n]!)) n++;
  return n;
};

/**
 * Encodes `text` as Code 128.
 *
 * Starts in code set B (printable ASCII 32-126) and switches to the
 * double-density set C across long digit runs: four or more digits at either
 * end of the string, six or more in the middle, switching back when the run
 * ends. Set C swallows digits two at a time, so an odd-length run gives up its
 * first digit to set B to keep the pairing aligned.
 *
 * @returns the module run, `true` for a bar, quiet zones excluded.
 * @throws {CodeError} on any character set B cannot represent.
 */
export function code128(text: string): boolean[] {
  if (text.length === 0) throw new CodeError('Code 128 needs at least one character.');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new CodeError(
        `Code 128 (set B) cannot encode character ${JSON.stringify(text[i])} ` +
        `(code point ${code}) at index ${i}. Only printable ASCII 32-126 is supported.`,
      );
    }
  }

  const values: number[] = [];
  const lead = digitRun(text, 0);
  // Start in C for four or more leading digits, or for a bare digit pair.
  let inC = lead >= 4 || (lead === 2 && text.length === 2);
  values.push(inC ? C128_START_C : C128_START_B);

  let i = 0;
  while (i < text.length) {
    if (inC) {
      if (digitRun(text, i) >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
      } else {
        values.push(C128_CODE_B);
        inC = false;
      }
    } else {
      const run = digitRun(text, i);
      const pairs = run - (run % 2);           // digits set C can actually take
      const trailing = i + run === text.length;
      if (pairs >= 6 || (trailing && pairs >= 4)) {
        // An odd run starts one character late so the pairs stay aligned.
        if (run % 2 === 1) { values.push(text.charCodeAt(i) - 32); i++; }
        values.push(C128_CODE_C);
        inC = true;
      } else {
        values.push(text.charCodeAt(i) - 32);
        i++;
      }
    }
  }

  // Modulo-103 check: the start value plus each following value times its
  // 1-based position.
  let sum = values[0]!;
  for (let k = 1; k < values.length; k++) sum += k * values[k]!;
  values.push(sum % 103);
  values.push(C128_STOP);

  return expandWidths(values.map((v) => C128_PATTERNS[v]!));
}

/** Turns alternating element widths (bar first) into a module run. */
const expandWidths = (patterns: readonly string[]): boolean[] => {
  const modules: boolean[] = [];
  for (const pattern of patterns) {
    for (let i = 0; i < pattern.length; i++) {
      const width = pattern.charCodeAt(i) - 48;
      const bar = i % 2 === 0;
      for (let w = 0; w < width; w++) modules.push(bar);
    }
  }
  return modules;
};

/* ── EAN-13 ─────────────────────────────────────────────────────────────────
 * 95 modules: 101 guard, six digits from the L/G sets, 01010 centre guard,
 * six digits from the R set, 101 guard. The first digit is not drawn — it is
 * carried by which of L or G each of digits 2-7 uses.
 * -------------------------------------------------------------------------- */

const EAN_L: readonly string[] = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

const flip = (s: string): string => s.replace(/[01]/g, (c) => (c === '0' ? '1' : '0'));
const reverse = (s: string): string => s.split('').reverse().join('');

/** R = complement of L; G = R reversed. */
const EAN_R: readonly string[] = EAN_L.map(flip);
const EAN_G: readonly string[] = EAN_R.map(reverse);

/** Which of digits 2-7 use the G set, keyed by the first digit. `1` = G. */
const EAN_PARITY: readonly string[] = [
  '000000', '001011', '001101', '001110', '010011',
  '011001', '011100', '010101', '010110', '011010',
];

/** Module index ranges the guard bars occupy, used for the descender look. */
export const EAN13_GUARDS: ReadonlyArray<readonly [number, number]> = [
  [0, 3], [45, 50], [92, 95],
];

/** The EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += (first12.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/** Normalises 12 or 13 digits to the full 13, validating any check digit given. */
export function ean13Digits(digits: string): string {
  if (!/^[0-9]+$/.test(digits)) {
    throw new CodeError(`EAN-13 accepts digits only; got ${JSON.stringify(digits)}.`);
  }
  if (digits.length !== 12 && digits.length !== 13) {
    throw new CodeError(`EAN-13 needs 12 or 13 digits; got ${digits.length}.`);
  }
  const body = digits.slice(0, 12);
  const check = ean13CheckDigit(body);
  if (digits.length === 13 && digits.charCodeAt(12) - 48 !== check) {
    throw new CodeError(
      `EAN-13 check digit is wrong: ${digits} ends in ${digits[12]}, expected ${check}.`,
    );
  }
  return body + String(check);
}

/**
 * Encodes an EAN-13 barcode. Accepts 12 digits (the check digit is computed)
 * or 13 (the check digit is verified).
 *
 * @returns the 95-module run, `true` for a bar, quiet zones excluded.
 * @throws {CodeError} on a non-digit, a wrong length, or a bad check digit.
 */
export function ean13(digits: string): boolean[] {
  const full = ean13Digits(digits);
  const parity = EAN_PARITY[full.charCodeAt(0) - 48]!;

  let bits = '101';
  for (let i = 1; i <= 6; i++) {
    const d = full.charCodeAt(i) - 48;
    bits += parity[i - 1] === '1' ? EAN_G[d]! : EAN_L[d]!;
  }
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[full.charCodeAt(i) - 48]!;
  bits += '101';

  return Array.from(bits, (c) => c === '1');
}
