/**
 * Tabular data for `artboard bulk` -- the CSV/TSV/JSON reader and the
 * placeholder substitution that turns one template into one document per row.
 *
 * Substitution happens on the template's RAW TEXT, before it is parsed as a
 * document, and that ordering is deliberate. A placeholder can sit in a field
 * the schema constrains -- `"color": "{{brand}}"`, `"x": {{left}}` -- and
 * parsing first would hand those to the validator, which would reject or
 * default them away before the row's real value ever arrived. Substituting
 * first means every row is parsed as the document it actually is, and a bad
 * value produces a diagnostic naming the row rather than a silently corrected
 * one that renders the wrong thing.
 *
 * Values are escaped with JSON.stringify, so a cell containing a quote, a
 * backslash or a newline stays inside its string instead of breaking out of
 * it. The same escape leaves digits untouched, which is why an unquoted
 * `"x": {{left}}` also works.
 */

export class DataError extends Error {
  constructor(message: string) { super(message); this.name = 'DataError'; }
}

export interface DataSet {
  /** Column names, in file order. */
  columns: string[];
  /** One record per row, every column present. */
  rows: Record<string, string>[];
}

/* -- delimited text (RFC 4180) -------------------------------------------- */

/**
 * Split delimited text into records of fields. Handles quoted fields, `""`
 * as an escaped quote inside one, delimiters and newlines inside quotes, and
 * CRLF. An unterminated quote is an error, not a field that runs to EOF --
 * the latter reads a whole file as one cell and looks like it worked.
 */
export function splitRecords(raw: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;   // anything at all since the last record boundary
  let line = 1;
  let quoteLine = 1;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;

    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 1; continue; }
        quoted = false;
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      continue;
    }

    if (c === '"' && field === '') { quoted = true; quoteLine = line; started = true; continue; }
    if (c === delimiter) { record.push(field); field = ''; started = true; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && raw[i + 1] === '\n') i += 1;
      line += 1;
      record.push(field);
      records.push(record);
      record = []; field = ''; started = false;
      continue;
    }
    field += c;
    started = true;
  }

  if (quoted) throw new DataError(`Unterminated quote: the " opened on line ${quoteLine} is never closed.`);
  if (started || field !== '' || record.length > 0) { record.push(field); records.push(record); }

  return records;
}

const isBlank = (record: readonly string[]): boolean => record.every(f => f.trim() === '');

/** `,` unless the file is a .tsv, or the caller said otherwise. */
export function delimiterFor(path: string, override: string | undefined): string {
  if (override !== undefined) {
    const d = override === '\\t' ? '\t' : override;
    if (d.length !== 1) throw new DataError(`--delimiter must be a single character (or \\t), got ${JSON.stringify(override)}.`);
    return d;
  }
  return /\.tsv$/i.test(path) ? '\t' : ',';
}

export function parseDelimited(raw: string, delimiter: string): DataSet {
  const records = splitRecords(raw, delimiter).filter(r => !isBlank(r));
  const header = records.shift();
  if (!header) throw new DataError('No rows: the data file is empty.');

  const columns = header.map(h => h.trim());
  const blank = columns.indexOf('');
  if (blank !== -1) throw new DataError(`Column ${blank + 1} of the header has no name. Every column needs one to be referenced as {{name}}.`);
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c)) throw new DataError(`Duplicate column "${c}". Two columns with one name means {{${c}}} would silently pick one.`);
    seen.add(c);
  }

  const rows = records.map((record, i) => {
    if (record.length !== columns.length) {
      throw new DataError(
        `Row ${i + 1} has ${record.length} field${record.length === 1 ? '' : 's'}, the header has ${columns.length}. ` +
        `A short row would fill some columns and silently blank the rest.`);
    }
    const row: Record<string, string> = {};
    columns.forEach((c, j) => { row[c] = record[j]!; });
    return row;
  });

  if (!rows.length) throw new DataError('No data rows: the file has a header and nothing under it.');
  return { columns, rows };
}

/* -- json ----------------------------------------------------------------- */

export function parseJsonRows(raw: string): DataSet {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new DataError(`Not valid JSON: ${(e as Error).message}`); }

  if (!Array.isArray(parsed)) throw new DataError('JSON data must be an array of objects, one per row.');
  if (!parsed.length) throw new DataError('No rows: the JSON array is empty.');

  const columns: string[] = [];
  const rows = parsed.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DataError(`Row ${i + 1} is ${Array.isArray(entry) ? 'an array' : JSON.stringify(entry)}; every entry must be an object of column -> value.`);
    }
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        throw new DataError(`Row ${i + 1} column "${k}" is ${Array.isArray(v) ? 'an array' : 'an object'}. Cells are scalars -- a nested value has no text to substitute.`);
      }
      row[k] = v === null ? '' : String(v);
      if (!columns.includes(k)) columns.push(k);
    }
    return row;
  });

  // Ragged objects are the JSON equivalent of a short CSV row, and just as
  // quiet: the missing key becomes an unresolved placeholder several steps
  // later, blamed on the template instead of the data.
  rows.forEach((row, i) => {
    const missing = columns.filter(c => !(c in row));
    if (missing.length) throw new DataError(`Row ${i + 1} is missing ${missing.map(m => `"${m}"`).join(', ')}, which other rows have.`);
  });

  return { columns, rows };
}

export function parseData(rawWithBom: string, path: string, delimiter: string | undefined): DataSet {
  // Excel writes a UTF-8 BOM. Header trimming happens to absorb it (U+FEFF is
  // whitespace to String.trim), but JSON.parse is not so forgiving, and a
  // load-bearing accident is worth replacing with a line that says so.
  const raw = rawWithBom.charCodeAt(0) === 0xfeff ? rawWithBom.slice(1) : rawWithBom;

  if (/\.json$/i.test(path)) {
    if (delimiter !== undefined) throw new DataError('--delimiter applies to csv/tsv data, not json.');
    return parseJsonRows(raw);
  }
  return parseDelimited(raw, delimiterFor(path, delimiter));
}

/* -- placeholders --------------------------------------------------------- */

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Every distinct `{{name}}` in the template, in first-seen order. */
export function findPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** JSON-escaped, minus the wrapping quotes, so it is safe inside a string. */
const escape = (value: string): string => JSON.stringify(value).slice(1, -1);

/**
 * Substitute one row into the template. Every placeholder must have a column;
 * an unresolved one is an error rather than an empty string, because an empty
 * string renders as a blank card that looks like a design decision.
 */
export function fillTemplate(template: string, row: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = row[name];
    if (value === undefined) {
      throw new DataError(`{{${name}}} has no column. The data has: ${Object.keys(row).join(', ')}`);
    }
    return escape(value);
  });
}

/* -- output names --------------------------------------------------------- */

const slug = (value: string): string =>
  value.normalize('NFKD')
    // Drop the combining marks NFKD just split off. Without this "Emile" keeps
    // its acute as a separate character, that character is not \w, and the file
    // lands as "e-mile-rousseau" -- which is how the first real run named it.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

/**
 * A per-row file stem. `--name <column>` uses that column, falling back to the
 * numbered form for a cell that slugs to nothing. Collisions get a numeric
 * suffix: two rows named "Ana Ruiz" must not write the same file, and the
 * second silently overwriting the first is the worst version of that.
 */
export function nameRows(rows: readonly Record<string, string>[], stem: string, column: string | undefined): string[] {
  const width = String(rows.length).length;
  const taken = new Map<string, number>();

  return rows.map((row, i) => {
    const numbered = `${stem}-${String(i + 1).padStart(width, '0')}`;
    let base = numbered;
    if (column !== undefined) {
      const cell = row[column];
      if (cell === undefined) throw new DataError(`--name ${column}: no such column. The data has: ${Object.keys(row).join(', ')}`);
      base = slug(cell) || numbered;
    }
    const seen = taken.get(base);
    taken.set(base, (seen ?? 0) + 1);
    return seen === undefined ? base : `${base}-${seen + 1}`;
  });
}
