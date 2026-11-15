// Install @langchain/core, @langchain/google-genai, @google-cloud/bigquery, and zod.
// Configure Application Default Credentials and set GOOGLE_CLOUD_PROJECT,
// BIGQUERY_DATASET, GOOGLE_API_KEY, and GOOGLE_MODEL_NAME before running this example.
import { BigQuery } from '@google-cloud/bigquery';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { checkSql } from '../src/index.js';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const dataset = process.env.BIGQUERY_DATASET;
const modelName = process.env.GOOGLE_MODEL_NAME;
if (!project || !dataset || !process.env.GOOGLE_API_KEY || !modelName) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT, BIGQUERY_DATASET, GOOGLE_API_KEY, and GOOGLE_MODEL_NAME.');
}

const bigquery = new BigQuery({ projectId: project });
const runQuery = tool(
  async ({ sql }) => {
    const checked = checkSql(sql, {
      allowedDatasets: [`${project}.${dataset}`],
      maxLimit: 500,
      defaultProject: project,
    });
    if (!checked.ok) {
      return JSON.stringify({ ok: false, issues: checked.issues });
    }

    const [rows] = await bigquery.query({
      query: sql,
      maximumBytesBilled: '1000000000',
    });
    return JSON.stringify({ ok: true, rows });
  },
  {
    name: 'run_read_only_query',
    description: 'Run a read-only query in the allowed dataset with a row limit.',
    schema: z.object({ sql: z.string() }),
  },
);

const model = new ChatGoogleGenerativeAI({ model: modelName }).bindTools([runQuery]);
const messages = [
  { role: 'user', content: process.argv.slice(2).join(' ') || 'Describe the tables in this dataset.' },
];

for (let turn = 0; turn < 5; turn++) {
  const response = await model.invoke(messages);
  messages.push(response);
  if (!response.tool_calls.length) {
    console.log(response.content);
    break;
  }

  for (const call of response.tool_calls) {
    const result = await runQuery.invoke(call.args);
    messages.push(new ToolMessage({ tool_call_id: call.id, content: result }));
  }
}
