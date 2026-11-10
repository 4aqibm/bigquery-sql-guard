# Changelog

## 0.1.0

First release.

- `checkSql` and `assertSafeSql`
- One read-only SELECT (WITH and parentheses allowed), no second statement
- `allowedDatasets` checked through subqueries, joins and comma joins
- `INFORMATION_SCHEMA` and table functions blocked unless allowed
- `requireLimit` and `maxLimit`
- Correct handling of comments, raw and triple-quoted strings, and backtick paths
