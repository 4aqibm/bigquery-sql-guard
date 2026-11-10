// Splits BigQuery GoogleSQL into tokens.
// Comments are dropped. Strings and backtick identifiers stay whole, so text
// inside them can never be mistaken for a keyword or a table name.

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const SPACE = /\s/;
// No trailing-dot form ("123."), so "my-proj-123.ds.t" still splits on the dot.
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// Optional r / b / rb / br prefix right before a quote.
const STRING_PREFIX = /(?:[rR][bB]|[bB][rR]|[rR]|[bB])?(?=['"])/y;

/**
 * @param {string} sql
 * @returns {{ tokens: Array<{type: 'word'|'ident'|'string'|'number'|'punct', value: string, upper?: string}>,
 *             errors: Array<{code: string, message: string}> }}
 */
export function tokenize(sql) {
  const tokens = [];
  const errors = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const c = sql[i];

    if (SPACE.test(c)) {
      i++;
      continue;
    }

    // Line comments: -- and #
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Block comments
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        errors.push({ code: 'unterminated_comment', message: 'A /* comment is never closed.' });
        break;
      }
      i = end + 2;
      continue;
    }

    // String and bytes literals, including raw and triple-quoted forms
    STRING_PREFIX.lastIndex = i;
    const prefix = STRING_PREFIX.exec(sql);
    if (prefix) {
      let j = i + prefix[0].length;
      const quote = sql[j];
      const triple = sql.startsWith(quote.repeat(3), j);
      const close = triple ? quote.repeat(3) : quote;
      j += close.length;
      let closed = false;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2; // an escaped character never closes the string
          continue;
        }
        if (sql.startsWith(close, j)) {
          j += close.length;
          closed = true;
          break;
        }
        if (!triple && sql[j] === '\n') break; // single-quoted strings end at the line
        j++;
      }
      if (!closed) {
        errors.push({ code: 'unterminated_string', message: 'A string literal is never closed.' });
        break;
      }
      tokens.push({ type: 'string', value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Quoted identifiers: `project.dataset.table`
    if (c === '`') {
      const end = sql.indexOf('`', i + 1);
      if (end === -1) {
        errors.push({ code: 'unterminated_identifier', message: 'A `quoted identifier` is never closed.' });
        break;
      }
      tokens.push({ type: 'ident', value: sql.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    if (c >= '0' && c <= '9') {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(sql);
      tokens.push({ type: 'number', value: m[0] });
      i += m[0].length;
      continue;
    }

    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      const value = sql.slice(i, j);
      tokens.push({ type: 'word', value, upper: value.toUpperCase() });
      i = j;
      continue;
    }

    tokens.push({ type: 'punct', value: c });
    i++;
  }

  return { tokens, errors };
}
