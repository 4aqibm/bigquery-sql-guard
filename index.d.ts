export interface CheckOptions {
  /** Datasets the query may read: "dataset" (any project) or "project.dataset". Unset = no dataset check. */
  allowedDatasets?: string[];
  /** Project assumed for dataset.table references when matching "project.dataset" entries. */
  defaultProject?: string;
  /** Require a LIMIT on the final result. */
  requireLimit?: boolean;
  /** Require a literal LIMIT no larger than this. Implies requireLimit. */
  maxLimit?: number;
  /** Allow INFORMATION_SCHEMA views. Default false. */
  allowInformationSchema?: boolean;
  /** Allow table-valued functions in FROM (ML.PREDICT, EXTERNAL_QUERY, your own TVFs). Default false. */
  allowTableFunctions?: boolean;
}

export type IssueCode =
  | 'empty'
  | 'unterminated_string'
  | 'unterminated_comment'
  | 'unterminated_identifier'
  | 'unbalanced_parentheses'
  | 'multiple_statements'
  | 'not_read_only'
  | 'table_function'
  | 'information_schema'
  | 'unqualified_table'
  | 'dataset_not_allowed'
  | 'missing_limit'
  | 'limit_not_literal'
  | 'limit_too_high';

export interface Issue {
  code: IssueCode;
  /** Plain-language reason, safe to show a user or feed back to a model. */
  message: string;
}

export interface TableRef {
  /** The path as written, without backticks. */
  raw: string;
  project?: string;
  dataset?: string;
  table: string;
  informationSchema?: true;
}

export interface CheckResult {
  ok: boolean;
  issues: Issue[];
  tables: TableRef[];
}

export function checkSql(sql: string, options?: CheckOptions): CheckResult;
export function assertSafeSql(sql: string, options?: CheckOptions): CheckResult;

export class SqlGuardError extends Error {
  issues: Issue[];
}
