// Check a query, then run it with a hard cap on bytes billed.
// The guard is the first gate; IAM and maximumBytesBilled are the ones BigQuery enforces.
//
//   npm install @google-cloud/bigquery bigquery-sql-guard
//   gcloud auth application-default login
//   node examples/run-on-bigquery.js

import { BigQuery } from '@google-cloud/bigquery';
import { assertSafeSql, SqlGuardError } from 'bigquery-sql-guard';

const bigquery = new BigQuery();

export async function runSafely(sql) {
  try {
    assertSafeSql(sql, {
      allowedDatasets: ['bigquery-public-data.samples'],
      defaultProject: 'bigquery-public-data',
      maxLimit: 1000,
    });
  } catch (err) {
    if (err instanceof SqlGuardError) return { error: err.issues };
    throw err;
  }

  const [rows] = await bigquery.query({
    query: sql,
    maximumBytesBilled: String(1024 ** 3), // fail instead of scanning more than 1 GB
  });
  return { rows };
}

const sql = `
  SELECT word, SUM(word_count) AS uses
  FROM \`bigquery-public-data.samples.shakespeare\`
  GROUP BY word
  ORDER BY uses DESC
  LIMIT 10`;

console.log(await runSafely(sql));
console.log(await runSafely('DELETE FROM `bigquery-public-data.samples.shakespeare` WHERE true'));
