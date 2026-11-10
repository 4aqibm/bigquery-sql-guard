# Security

If you find a query that writes data, runs more than one statement, or reads a dataset outside `allowedDatasets` while `checkSql` returns `ok: true`, please report it privately through GitHub's "Report a vulnerability" button on the Security tab of this repository instead of opening a public issue.

I'll reply within a few days and credit you in the fix unless you'd rather not be named.

This library is a first check, not an access-control system. Always run model-written queries with a service account that can only read what it should, and set `maximumBytesBilled`.
