// Ask Claude for BigQuery SQL, check it, and send the problems back until it passes.
//
//   npm install @anthropic-ai/sdk bigquery-sql-guard
//   export ANTHROPIC_API_KEY=...
//   node examples/claude-retry-loop.js "Top 5 products by revenue last month"

import Anthropic from '@anthropic-ai/sdk';
import { checkSql } from 'bigquery-sql-guard';

const client = new Anthropic();

const GUARD = {
  allowedDatasets: ['shop'],
  maxLimit: 1000,
};

const SYSTEM = `You write one BigQuery GoogleSQL SELECT query.
Tables you may use:
  shop.orders(order_id STRING, product_id STRING, amount NUMERIC, created_at TIMESTAMP)
  shop.products(product_id STRING, name STRING, category STRING)
Rules: read-only, one statement, always end with LIMIT (at most ${GUARD.maxLimit}).
Reply with the SQL only, no explanation and no code fences.`;

async function writeSql(question, maxAttempts = 3) {
  const messages = [{ role: 'user', content: question }];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      // If a safety check declines the request, the API retries it on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('The model declined this question.');
    }

    const sql = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const result = checkSql(sql, GUARD);
    if (result.ok) return { sql, tables: result.tables, attempts: attempt };

    // Send the model its own answer plus the plain-language reasons it was rejected.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: `That query was rejected:\n${result.issues.map((i) => `- ${i.message}`).join('\n')}\nPlease fix it.`,
    });
  }

  throw new Error(`No safe query after ${maxAttempts} attempts.`);
}

const question = process.argv[2] ?? 'Top 5 products by revenue last month';
const { sql, tables, attempts } = await writeSql(question);
console.log(`Accepted after ${attempts} attempt(s). Reads: ${tables.map((t) => t.raw).join(', ')}`);
console.log(sql);
