/**
 * Terminal formatting. Colour is a courtesy, never load-bearing: every message
 * reads the same with NO_COLOR=1 or when stdout is a pipe (which is how the
 * gauntlet captures us).
 */

const ESC = String.fromCharCode(27);
const SGR_PATTERN = new RegExp(ESC + '\\[[0-9;]*m', 'g');

function colorEnabled(): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return process.stdout.isTTY === true;
}

const ON = colorEnabled();
const wrap = (open: string) => (s: string): string => (ON ? ESC + '[' + open + 'm' + s + ESC + '[0m' : s);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

/** Pad to a visible width, ignoring any escape codes we injected. */
export function pad(s: string, width: number): string {
  const visible = s.replace(SGR_PATTERN, '').length;
  return s + ' '.repeat(Math.max(0, width - visible));
}

/* -- diagnostics --------------------------------------------------------- */
export interface DiagnosticLike {
  level: 'info' | 'warn' | 'error';
  code: string;
  nodeId: string | null;
  message: string;
}

const LEVEL_STYLE: Record<DiagnosticLike['level'], (s: string) => string> = {
  error: red,
  warn: yellow,
  info: cyan,
};

export function formatDiagnostic(d: DiagnosticLike): string {
  const label = LEVEL_STYLE[d.level](d.level.padEnd(5));
  const where = d.nodeId ? dim(` (${d.nodeId})`) : '';
  return `  ${label} ${dim(d.code)} ${d.message}${where}`;
}

export function countDiagnostics(diagnostics: readonly DiagnosticLike[]): { error: number; warn: number; info: number } {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const d of diagnostics) counts[d.level] += 1;
  return counts;
}

export function summarizeDiagnostics(diagnostics: readonly DiagnosticLike[]): string {
  const c = countDiagnostics(diagnostics);
  if (c.error + c.warn + c.info === 0) return green('none');
  const parts: string[] = [];
  if (c.error) parts.push(red(`${c.error} error${c.error === 1 ? '' : 's'}`));
  if (c.warn) parts.push(yellow(`${c.warn} warning${c.warn === 1 ? '' : 's'}`));
  if (c.info) parts.push(cyan(`${c.info} info`));
  return parts.join(', ');
}

export const hasErrors = (diagnostics: readonly DiagnosticLike[]): boolean =>
  diagnostics.some(d => d.level === 'error');

/**
 * Named errors only. Anything thrown gets its constructor name and message
 * printed -- nothing is ever swallowed into a generic "something went wrong".
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return `ThrownString: ${e}`;
  return `ThrownValue: ${JSON.stringify(e)}`;
}
