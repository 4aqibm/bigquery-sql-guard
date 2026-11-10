import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSql, assertSafeSql, SqlGuardError } from '../src/index.js';

const codes = (sql, opts) => checkSql(sql, opts).issues.map((i) => i.code);
const tableNames = (sql, opts) => checkSql(sql, opts).tables.map((t) => t.raw);

test('plain SELECT passes', () => {
  const r = checkSql('SELECT name, COUNT(*) AS n FROM sales.orders GROUP BY name');
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('trailing semicolons are fine, a second statement is not', () => {
  assert.deepEqual(codes('SELECT 1;;'), []);
  assert.deepEqual(codes('SELECT 1; DROP TABLE sales.orders'), ['multiple_statements']);
});

test('write and DDL statements are rejected', () => {
  for (const sql of [
    'DELETE FROM sales.orders WHERE true',
    'UPDATE sales.orders SET total = 0 WHERE true',
    'INSERT INTO sales.orders (id) VALUES (1)',
    'MERGE sales.orders t USING sales.new s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'CREATE TABLE sales.copy AS SELECT * FROM sales.orders',
    'DROP TABLE sales.orders',
    'EXPORT DATA OPTIONS(uri="gs://x/*.csv", format="CSV") AS SELECT 1',
    "EXECUTE IMMEDIATE 'DROP TABLE sales.orders'",
    'DECLARE x INT64',
  ]) {
    assert.ok(codes(sql).includes('not_read_only'), sql);
  }
});

test('WITH must lead to a SELECT', () => {
  assert.deepEqual(codes('WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b'), []);
  assert.deepEqual(codes('WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a'), []);
  assert.ok(codes('WITH a AS (SELECT 1) DELETE FROM sales.orders WHERE true').includes('not_read_only'));
});

test('parenthesised queries and set operations pass', () => {
  assert.deepEqual(codes('(SELECT 1) UNION ALL (SELECT 2)'), []);
  assert.deepEqual(codes('((WITH a AS (SELECT 1 AS x) SELECT x FROM a))'), []);
});

test('keywords inside strings and comments are ignored', () => {
  assert.deepEqual(codes("SELECT 'DROP TABLE x; DELETE' AS s -- ; DROP TABLE y\n"), []);
  assert.deepEqual(codes('SELECT 1 /* ; DELETE FROM t */ # ; also a comment'), []);
  assert.deepEqual(codes("SELECT '''multi\n;line''', r'\\d+;', b\"x;\" "), []);
  assert.deepEqual(codes("SELECT 'it\\'s; fine'"), []);
});

test('broken input is reported, not thrown', () => {
  assert.deepEqual(codes(''), ['empty']);
  assert.deepEqual(codes('  -- just a comment'), ['empty']);
  assert.deepEqual(codes("SELECT 'open"), ['unterminated_string']);
  assert.deepEqual(codes('SELECT 1 /* open'), ['unterminated_comment']);
  assert.deepEqual(codes('SELECT * FROM `p.d.t'), ['unterminated_identifier']);
  assert.deepEqual(codes('SELECT (1'), ['unbalanced_parentheses']);
  assert.throws(() => checkSql(null), TypeError);
});

test('finds tables in FROM, JOIN, comma joins and subqueries', () => {
  const sql = `
    SELECT * FROM \`my-proj.sales.orders\` o
    JOIN sales.customers AS c ON c.id = o.customer_id
    LEFT JOIN (SELECT * FROM my-proj.ref.regions) r ON r.id = c.region_id,
    other.items i
    WHERE o.id IN (SELECT id FROM audit.flags)`;
  assert.deepEqual(tableNames(sql).sort(), [
    'audit.flags',
    'my-proj.ref.regions',
    'my-proj.sales.orders',
    'other.items',
    'sales.customers',
  ]);
  const orders = checkSql(sql).tables.find((t) => t.table === 'orders');
  assert.deepEqual(orders, { raw: 'my-proj.sales.orders', project: 'my-proj', dataset: 'sales', table: 'orders' });
});

test('CTEs, UNNEST, correlated arrays and FROM inside expressions are not tables', () => {
  const sql = `
    WITH recent AS (SELECT * FROM sales.orders)
    SELECT EXTRACT(YEAR FROM r.created_at) AS y, item, off
    FROM recent AS r, r.items AS item, UNNEST([1, 2]) AS n WITH OFFSET AS off
    CROSS JOIN UNNEST(r.tags) AS tag
    WHERE r.a IS NOT DISTINCT FROM r.b`;
  assert.deepEqual(tableNames(sql), ['sales.orders']);
});

test('allowedDatasets limits which datasets can be read', () => {
  const opts = { allowedDatasets: ['sales', 'shared-proj.ref'], defaultProject: 'my-proj' };
  assert.deepEqual(codes('SELECT * FROM sales.orders', opts), []);
  assert.deepEqual(codes('SELECT * FROM `any-proj.sales.orders`', opts), []);
  assert.deepEqual(codes('SELECT * FROM `shared-proj.ref.regions`', opts), []);
  assert.deepEqual(codes('SELECT * FROM ref.regions', opts), ['dataset_not_allowed']); // default project is my-proj
  assert.deepEqual(codes('SELECT * FROM hr.salaries', opts), ['dataset_not_allowed']);
  assert.deepEqual(codes('SELECT * FROM salaries', opts), ['unqualified_table']);
  assert.deepEqual(codes('SELECT * FROM sales.o WHERE id IN (SELECT id FROM hr.x)', opts), ['dataset_not_allowed']);
  // A disallowed table hidden in a comma join, including after JOIN ... ON
  assert.deepEqual(codes('SELECT * FROM sales.o, hr.x', opts), ['dataset_not_allowed']);
  assert.deepEqual(codes('SELECT * FROM sales.o a JOIN sales.c b ON a.id = b.id, hr.x', opts), ['dataset_not_allowed']);
  assert.deepEqual(codes('SELECT a, b FROM sales.o JOIN sales.c USING (id, k) WHERE x IN (1, 2)', opts), []);
});

test('wildcard tables and time travel are read correctly', () => {
  const opts = { allowedDatasets: ['ga4', 'sales'] };
  const wildcard = "SELECT * FROM `proj.ga4.events_*` WHERE _TABLE_SUFFIX BETWEEN '20260101' AND '20260131'";
  assert.deepEqual(codes(wildcard, opts), []);
  assert.deepEqual(tableNames(wildcard), ['proj.ga4.events_*']);
  const timeTravel =
    'SELECT * FROM sales.o FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR), hr.x';
  assert.deepEqual(codes(timeTravel, opts), ['dataset_not_allowed']);
});

test('INFORMATION_SCHEMA and table functions are blocked unless allowed', () => {
  assert.deepEqual(codes('SELECT * FROM sales.INFORMATION_SCHEMA.TABLES'), ['information_schema']);
  assert.deepEqual(codes('SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS'), ['information_schema']);
  assert.deepEqual(codes('SELECT * FROM sales.INFORMATION_SCHEMA.TABLES', { allowInformationSchema: true }), []);
  assert.deepEqual(codes("SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')"), ['table_function']);
  assert.deepEqual(codes('SELECT * FROM ML.PREDICT(MODEL sales.m, TABLE sales.t)'), ['table_function']);
  assert.deepEqual(codes('SELECT * FROM sales.my_tvf(1)', { allowTableFunctions: true }), []);
});

test('LIMIT rules apply to the outermost query only', () => {
  assert.deepEqual(codes('SELECT * FROM sales.orders', { requireLimit: true }), ['missing_limit']);
  assert.deepEqual(codes('SELECT * FROM sales.orders LIMIT 10', { requireLimit: true }), []);
  assert.deepEqual(codes('SELECT ARRAY_AGG(x LIMIT 5) FROM t', { requireLimit: true }), ['missing_limit']);
  assert.deepEqual(codes('(SELECT 1 FROM t) LIMIT 5', { maxLimit: 100 }), []);
  assert.deepEqual(codes('SELECT * FROM t LIMIT 5000', { maxLimit: 1000 }), ['limit_too_high']);
  assert.deepEqual(codes('SELECT * FROM t LIMIT @n', { maxLimit: 1000 }), ['limit_not_literal']);
  assert.deepEqual(codes('SELECT * FROM t', { maxLimit: 1000 }), ['missing_limit']);
});

test('assertSafeSql throws with the issues attached', () => {
  assert.equal(assertSafeSql('SELECT 1').ok, true);
  try {
    assertSafeSql('DROP TABLE sales.orders');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof SqlGuardError);
    assert.equal(err.issues[0].code, 'not_read_only');
    assert.match(err.message, /Only SELECT queries are allowed/);
  }
});
