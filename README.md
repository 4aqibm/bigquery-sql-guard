# bigquery-sql-guard

[![npm](https://img.shields.io/npm/v/bigquery-sql-guard.svg)](https://www.npmjs.com/package/bigquery-sql-guard)
[![CI](https://github.com/4aqibm/bigquery-sql-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/4aqibm/bigquery-sql-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Check BigQuery SQL before it runs.

If an LLM writes SQL for your users (text-to-SQL, chat-with-your-data, agents), you need a cheap, predictable check between the model and the warehouse. `bigquery-sql-guard` reads the query without calling BigQuery and tells you, in plain language, why it should not run:

- it is not a single read-only `SELECT` (no `DELETE`, `MERGE`, `CREATE`, `EXPORT DATA`, scripting, or a second statement after `;`)
- it reads a dataset you did not allow, including through subqueries, joins and comma joins
- it reads `INFORMATION_SCHEMA` metadata or calls a table function such as `EXTERNAL_QUERY`
- it has no `LIMIT`, or a `LIMIT` above your maximum

Comments, strings, raw strings and backtick identifiers are tokenized properly, so `'DROP TABLE'` inside a string or `-- ; DELETE` in a comment never trips it.

No dependencies. Node 18+.

## Install

```sh
npm install bigquery-sql-guard
```

## Use

```js
import { checkSql } from 'bigquery-sql-guard';

const result = checkSql(sqlFromModel, {
  allowedDatasets: ['sales', 'shared-project.reference'],
  defaultProject: 'my-project',
  maxLimit: 10000,
});

if (!result.ok) {
  // Each message is short and plain, so you can show it to the user
  // or send it back to the model and ask for a corrected query.
  console.log(result.issues);
  // [{ code: 'dataset_not_allowed', message: 'Table "hr.salaries" is outside the allowed datasets.' }]
}

console.log(result.tables);
// [{ raw: 'my-project.sales.orders', project: 'my-project', dataset: 'sales', table: 'orders' }, ...]
```

Prefer exceptions?

```js
import { assertSafeSql, SqlGuardError } from 'bigquery-sql-guard';

try {
  assertSafeSql(sql, { allowedDatasets: ['sales'] });
} catch (err) {
  if (err instanceof SqlGuardError) console.log(err.issues);
}
```

## Examples

- [examples/claude-retry-loop.js](examples/claude-retry-loop.js): ask Claude for SQL, check it, and send the reasons back until the query passes.
- [examples/run-on-bigquery.js](examples/run-on-bigquery.js): check a query, then run it on BigQuery with a cap on bytes billed.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `allowedDatasets` | not set (no check) | Datasets the query may read. `"sales"` matches that dataset in any project; `"proj.sales"` matches only that project. |
| `defaultProject` | not set | Project used for `dataset.table` references when matching `"project.dataset"` entries. |
| `requireLimit` | `false` | The final result must have a `LIMIT`. |
| `maxLimit` | not set | The final result must have a literal `LIMIT` no larger than this. |
| `allowInformationSchema` | `false` | Allow `INFORMATION_SCHEMA` views. |
| `allowTableFunctions` | `false` | Allow table functions in `FROM` (`ML.PREDICT`, `EXTERNAL_QUERY`, your own TVFs). |

## Issue codes

`empty`, `unterminated_string`, `unterminated_comment`, `unterminated_identifier`, `unbalanced_parentheses`, `multiple_statements`, `not_read_only`, `table_function`, `information_schema`, `unqualified_table`, `dataset_not_allowed`, `missing_limit`, `limit_not_literal`, `limit_too_high`.

## What it is not

This is a fast first gate, not a replacement for BigQuery permissions. Run queries with a service account that can only read what it should, and use `maximumBytesBilled` to cap cost. The guard catches mistakes early and gives the model a clear reason to retry. IAM is what enforces access.

It does not fully parse GoogleSQL. A query it accepts can still fail in BigQuery; the goal is that queries it accepts cannot write data or reach datasets you did not allow.

## Contributing

Issues and pull requests are welcome, especially real queries that the guard gets wrong. See [CONTRIBUTING.md](CONTRIBUTING.md), and look for `good first issue` labels. Security problems go through [SECURITY.md](SECURITY.md).

```sh
npm test
```

## License

MIT
