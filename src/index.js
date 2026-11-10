import { tokenize } from './tokenize.js';

// Words that can never be a table name or a table alias. Seeing one means the
// FROM / JOIN item has ended.
const CLAUSE_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'BY', 'HAVING', 'QUALIFY', 'WINDOW',
  'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'FULL', 'CROSS', 'OUTER', 'NATURAL', 'ON', 'USING', 'FOR', 'TABLESAMPLE', 'PIVOT',
  'UNPIVOT', 'WITH', 'AS', 'SET', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
]);

export class SqlGuardError extends Error {
  /** @param {Array<{code: string, message: string}>} issues */
  constructor(issues) {
    super(`Query rejected: ${issues.map((i) => i.message).join(' ')}`);
    this.name = 'SqlGuardError';
    this.issues = issues;
  }
}

/**
 * Check one BigQuery query before running it.
 * Never throws for a bad query: problems come back in `issues`.
 *
 * @param {string} sql
 * @param {import('../index').CheckOptions} [options]
 * @returns {import('../index').CheckResult}
 */
export function checkSql(sql, options = {}) {
  if (typeof sql !== 'string') throw new TypeError('checkSql: sql must be a string');

  const issues = [];
  const { tokens, errors } = tokenize(sql);
  if (errors.length) return { ok: false, issues: errors, tables: [] };

  // A trailing semicolon is fine; anything after it is a second statement.
  let end = tokens.length;
  while (end > 0 && isPunct(tokens[end - 1], ';')) end--;
  const body = tokens.slice(0, end);

  if (body.length === 0) {
    return { ok: false, issues: [{ code: 'empty', message: 'The query is empty.' }], tables: [] };
  }
  if (body.some((t) => isPunct(t, ';'))) {
    issues.push({ code: 'multiple_statements', message: 'Only one statement is allowed per query.' });
  }

  const shape = parenShape(body);
  if (!shape.balanced) {
    issues.push({ code: 'unbalanced_parentheses', message: 'The parentheses do not match.' });
    return { ok: false, issues, tables: [] };
  }

  const cteNames = collectCteNames(body);
  const topDepth = checkReadOnly(body, issues);
  const tables = findTables(body, shape, cteNames, options, issues);
  checkLimit(body, shape, topDepth, options, issues);

  return { ok: issues.length === 0, issues, tables };
}

/**
 * Same check as checkSql, but throws SqlGuardError when the query is not allowed.
 * @param {string} sql
 * @param {import('../index').CheckOptions} [options]
 */
export function assertSafeSql(sql, options = {}) {
  const result = checkSql(sql, options);
  if (!result.ok) throw new SqlGuardError(result.issues);
  return result;
}

// ---------------------------------------------------------------------------
// Read-only: the one statement must be a SELECT (optionally behind WITH and
// wrapping parentheses). BigQuery has no data-changing CTEs, so a SELECT
// statement cannot write. Returns how many "(" wrap the main statement.
function checkReadOnly(body, issues) {
  let k = 0;
  while (k < body.length && isPunct(body[k], '(')) k++;
  const first = body[k];

  if (!isWord(first, 'SELECT') && !isWord(first, 'WITH')) {
    issues.push({
      code: 'not_read_only',
      message: `Only SELECT queries are allowed; this one starts with ${describe(first)}.`,
    });
    return k;
  }

  if (isWord(first, 'WITH')) {
    let main = skipCteList(body, k, new Set());
    while (main !== -1 && isPunct(body[main], '(')) main++;
    if (main === -1 || !isWord(body[main], 'SELECT')) {
      issues.push({
        code: 'not_read_only',
        message: 'After the WITH clause, the main statement must be a SELECT.',
      });
    }
  }
  return k;
}

// Returns the index right after "WITH name AS (...), name AS (...)", or -1.
// Names are added to `names` only when the whole list parses.
function skipCteList(tokens, withIndex, names) {
  const found = [];
  let i = withIndex + 1;
  if (isWord(tokens[i], 'RECURSIVE')) i++;
  for (;;) {
    const name = tokens[i];
    if (!name || (name.type !== 'word' && name.type !== 'ident')) return -1;
    found.push(name.value.toLowerCase());
    i++;
    if (!isWord(tokens[i], 'AS')) return -1;
    i++;
    if (!isPunct(tokens[i], '(')) return -1;
    i = matchingParen(tokens, i);
    if (i === -1) return -1;
    i++;
    if (isPunct(tokens[i], ',')) {
      i++;
      continue;
    }
    for (const f of found) names.add(f);
    return i;
  }
}

function collectCteNames(body) {
  const names = new Set();
  body.forEach((t, i) => {
    if (isWord(t, 'WITH')) skipCteList(body, i, names);
  });
  return names;
}

// ---------------------------------------------------------------------------
// Tables: every FROM / JOIN item, including comma joins.
function findTables(body, shape, cteNames, options, issues) {
  const tables = [];
  const seen = new Set();
  const aliases = new Set();

  // Where each FROM item starts: right after JOIN, right after FROM, and after
  // every comma at the FROM's own level until the clause ends. Walking to the
  // clause end catches "a JOIN b ON ..., c" as well as "a, b".
  const starts = [];
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (isWord(t, 'JOIN')) starts.push(i + 1);
    if (!isWord(t, 'FROM') || isNonTableFrom(body, i, shape)) continue;
    starts.push(i + 1);
    const level = shape.depth[i];
    for (let k = i + 1; k < body.length; k++) {
      const tok = body[k];
      if (shape.depth[k] < level) break; // the enclosing subquery closed
      if (shape.depth[k] > level) continue; // inside parentheses: ON (...), subqueries
      if (tok.type === 'word' && FROM_CLAUSE_END.has(tok.upper)) break;
      if (isPunct(tok, ',')) starts.push(k + 1);
    }
  }
  starts.sort((a, b) => a - b); // text order, so an alias is known before "alias.array"

  for (const start of starts) {
    let j = start;
    const tok = body[j];
    if (isPunct(tok, '(') || isWord(tok, 'UNNEST')) {
      // Subquery or UNNEST(...): a subquery's own FROM is found on its own.
      const close = matchingParen(body, isWord(tok, 'UNNEST') ? j + 1 : j);
      if (close === -1) continue;
      j = close + 1;
    } else {
      const path = readPath(body, j);
      if (!path) continue;
      j = path.next;
      if (isPunct(body[j], '(')) {
        if (!options.allowTableFunctions) {
          issues.push({
            code: 'table_function',
            message: `Table functions such as ${path.text}(...) are not allowed.`,
          });
        }
        const close = matchingParen(body, j);
        if (close === -1) continue;
        j = close + 1;
      } else {
        const ref = classify(path.text, cteNames, aliases);
        if (ref && !seen.has(ref.raw)) {
          seen.add(ref.raw);
          tables.push(ref);
          checkTable(ref, options, issues);
        }
      }
    }
    skipAlias(body, j, aliases);
  }
  return tables;
}

// Words that end a FROM clause at its own level.
const FROM_CLAUSE_END = new Set([
  'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'SELECT',
]);

// "FROM" that does not start a table list: EXTRACT(DAY FROM d) and
// a IS [NOT] DISTINCT FROM b.
function isNonTableFrom(body, i, shape) {
  if (shape.enclosingWord[i] === 'EXTRACT') return true;
  const prev = body[i - 1];
  const before = body[i - 2];
  return isWord(prev, 'DISTINCT') && (isWord(before, 'IS') || isWord(before, 'NOT'));
}

// Reads a dotted table path such as my-proj.sales.orders or `p.d.t`.
function readPath(tokens, start) {
  const first = tokens[start];
  if (!first || (first.type !== 'word' && first.type !== 'ident')) return null;
  if (first.type === 'word' && CLAUSE_WORDS.has(first.upper)) return null;

  let text = '';
  let i = start;
  for (;;) {
    const tok = tokens[i];
    if (!tok || !['word', 'ident', 'number'].includes(tok.type)) break;
    text += tok.value;
    i++;
    const sep = tokens[i];
    const after = tokens[i + 1];
    const joins = isPunct(sep, '.') || isPunct(sep, '-') || isPunct(sep, ':');
    if (joins && after && ['word', 'ident', 'number'].includes(after.type)) {
      text += sep.value;
      i++;
      continue;
    }
    break;
  }
  return { text, next: i };
}

function skipAlias(tokens, i, aliases) {
  if (isWord(tokens[i], 'WITH') && isWord(tokens[i + 1], 'OFFSET')) i += 2; // UNNEST(...) WITH OFFSET
  if (isWord(tokens[i], 'AS')) i++;
  const tok = tokens[i];
  if (tok && (tok.type === 'ident' || (tok.type === 'word' && !CLAUSE_WORDS.has(tok.upper)))) {
    aliases.add(tok.value.toLowerCase());
    i++;
  }
  return i;
}

function classify(text, cteNames, aliases) {
  const parts = text.split('.');
  const head = parts[0].toLowerCase();

  if (parts.length === 1 && cteNames.has(head)) return null; // a CTE, not a table
  if (parts.length === 2 && aliases.has(head)) return null; // t.array_column after "FROM t AS t,"

  const isIndex = parts.findIndex((p) => p.toUpperCase() === 'INFORMATION_SCHEMA');
  if (isIndex !== -1) {
    return { raw: text, table: parts.slice(isIndex).join('.'), informationSchema: true };
  }
  if (parts.length === 1) return { raw: text, table: parts[0] };
  if (parts.length === 2) return { raw: text, dataset: parts[0], table: parts[1] };
  return {
    raw: text,
    project: parts.slice(0, -2).join('.'),
    dataset: parts[parts.length - 2],
    table: parts[parts.length - 1],
  };
}

function checkTable(ref, options, issues) {
  if (ref.informationSchema) {
    if (!options.allowInformationSchema) {
      issues.push({
        code: 'information_schema',
        message: `Metadata views (${ref.raw}) are not allowed.`,
      });
    }
    return;
  }

  const allowed = options.allowedDatasets;
  if (!allowed) return;

  if (!ref.dataset) {
    issues.push({
      code: 'unqualified_table',
      message: `Table "${ref.raw}" has no dataset, so it cannot be checked. Write it as dataset.table.`,
    });
    return;
  }

  const project = ref.project ?? options.defaultProject;
  const ok = allowed.some((entry) => {
    const dot = entry.lastIndexOf('.');
    if (dot === -1) return entry === ref.dataset;
    return entry.slice(dot + 1) === ref.dataset && entry.slice(0, dot) === project;
  });
  if (!ok) {
    issues.push({
      code: 'dataset_not_allowed',
      message: `Table "${ref.raw}" is outside the allowed datasets.`,
    });
  }
}

// ---------------------------------------------------------------------------
// LIMIT on the outermost query.
function checkLimit(body, shape, topDepth, options, issues) {
  const { requireLimit, maxLimit } = options;
  if (!requireLimit && maxLimit === undefined) return;

  let limitAt = -1;
  body.forEach((t, i) => {
    if (isWord(t, 'LIMIT') && shape.depth[i] <= topDepth) limitAt = i;
  });

  if (limitAt === -1) {
    issues.push({ code: 'missing_limit', message: 'The query needs a LIMIT on its final result.' });
    return;
  }
  if (maxLimit === undefined) return;

  const value = body[limitAt + 1];
  if (!value || value.type !== 'number' || !/^\d+$/.test(value.value)) {
    issues.push({ code: 'limit_not_literal', message: 'LIMIT must be a whole number written in the query.' });
    return;
  }
  if (Number(value.value) > maxLimit) {
    issues.push({
      code: 'limit_too_high',
      message: `LIMIT ${value.value} is above the maximum of ${maxLimit}.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers

// depth[i]: how many "(" surround token i. enclosingWord[i]: the word right
// before the innermost "(" around token i (e.g. EXTRACT), if any.
function parenShape(tokens) {
  const depth = new Array(tokens.length);
  const enclosingWord = new Array(tokens.length);
  const stack = [];
  let balanced = true;
  tokens.forEach((t, i) => {
    if (isPunct(t, ')')) {
      if (stack.length === 0) balanced = false;
      else stack.pop();
    }
    depth[i] = stack.length;
    enclosingWord[i] = stack.length ? stack[stack.length - 1] : undefined;
    if (isPunct(t, '(')) {
      const prev = tokens[i - 1];
      stack.push(prev && prev.type === 'word' ? prev.upper : undefined);
    }
  });
  if (stack.length) balanced = false;
  return { depth, enclosingWord, balanced };
}

function matchingParen(tokens, open) {
  if (!isPunct(tokens[open], '(')) return -1;
  let level = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) level++;
    else if (isPunct(tokens[i], ')') && --level === 0) return i;
  }
  return -1;
}

function isWord(t, upper) {
  return !!t && t.type === 'word' && t.upper === upper;
}

function isPunct(t, value) {
  return !!t && t.type === 'punct' && t.value === value;
}

function describe(t) {
  if (!t) return 'nothing';
  return t.type === 'word' ? t.upper : `"${t.value}"`;
}
