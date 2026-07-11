/**
 * Metrics execution-file parser (record schema v1).
 *
 * Reads a claude-code-action `execution_file` (the turn-by-turn JSON log Claude
 * Code emits) plus run context from environment variables, and prints one
 * single-line metrics JSON record to stdout.
 *
 * Design contract: this parser is **fail-soft**. Metrics must never fail a run.
 * Unknown, missing, or renamed fields in the input become `null` and add an
 * entry to `parse_warnings`; the process always exits 0 — including on a
 * missing, unreadable, or malformed input file.
 *
 * The emitted record is intentionally open to extra fields: later tasks merge
 * optional `rubric` and `judge` objects into the same record shape.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;

export interface MetricsRecord {
  schema: number;
  ts: string;
  workflow: string | null;
  run_id: string | null;
  run_attempt: string | null;
  trigger: string | null;
  head_sha: string | null;
  conclusion: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  parse_warnings: string[];
  // Later tasks graft optional `rubric` / `judge` objects onto this record;
  // keep the shape open so the emitter never has to change to carry them.
  [extra: string]: unknown;
}

/** Run context sourced from the workflow environment. */
export interface RunContext {
  GITHUB_WORKFLOW?: string | undefined;
  GITHUB_RUN_ID?: string | undefined;
  GITHUB_RUN_ATTEMPT?: string | undefined;
  GITHUB_SHA?: string | undefined;
  METRICS_TRIGGER?: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Locate the terminal `result` message inside a parsed execution file.
 *
 * Claude Code emits an array of stream messages whose final entry is the
 * `{ type: "result", ... }` summary. We also accept a bare result object in
 * case the action ever hands us just that.
 */
function findResultMessage(parsed: unknown): Record<string, unknown> | null {
  const isResult = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'result';

  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (isResult(parsed[i])) return parsed[i] as Record<string, unknown>;
    }
    return null;
  }
  if (isResult(parsed)) return parsed;
  return null;
}

function numberField(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  warnings.push(
    value === undefined
      ? `missing field "${key}" in execution result`
      : `field "${key}" in execution result is not a finite number`,
  );
  return null;
}

function stringField(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
): string | null {
  const value = source[key];
  if (typeof value === 'string') return value;
  warnings.push(
    value === undefined
      ? `missing field "${key}" in execution result`
      : `field "${key}" in execution result is not a string`,
  );
  return null;
}

/**
 * Build a metrics record from raw execution-file content and run context.
 *
 * @param rawContent The execution file's text, or `null` if it could not be read.
 * @param context    Workflow environment variables.
 * @param now        The emission timestamp (injected for deterministic tests).
 * @param fileWarning A warning to seed for a missing/unreadable file.
 */
export function buildMetricsRecord(
  rawContent: string | null,
  context: RunContext,
  now: Date,
  fileWarning?: string,
): MetricsRecord {
  const parse_warnings: string[] = [];
  if (fileWarning) parse_warnings.push(fileWarning);

  const record: MetricsRecord = {
    schema: SCHEMA_VERSION,
    ts: now.toISOString(),
    workflow: context.GITHUB_WORKFLOW ?? null,
    run_id: context.GITHUB_RUN_ID ?? null,
    run_attempt: context.GITHUB_RUN_ATTEMPT ?? null,
    trigger: context.METRICS_TRIGGER ?? null,
    head_sha: context.GITHUB_SHA ?? null,
    conclusion: null,
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
    parse_warnings,
  };

  if (rawContent === null) {
    return record;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    parse_warnings.push(
      `execution file is not valid JSON: ${errorMessage(error)}`,
    );
    return record;
  }

  const result = findResultMessage(parsed);
  if (!result) {
    parse_warnings.push(
      'no result message (type="result") found in execution file',
    );
    return record;
  }

  record.cost_usd = numberField(result, 'total_cost_usd', parse_warnings);
  record.num_turns = numberField(result, 'num_turns', parse_warnings);
  record.duration_ms = numberField(result, 'duration_ms', parse_warnings);
  record.conclusion = stringField(result, 'subtype', parse_warnings);

  return record;
}

/** Read an execution file, returning its text or a warning if that fails. */
export function readExecutionFile(filePath: string | undefined): {
  raw: string | null;
  warning?: string;
} {
  if (!filePath) {
    return { raw: null, warning: 'no execution file path provided' };
  }
  try {
    return { raw: readFileSync(filePath, 'utf8') };
  } catch (error) {
    return {
      raw: null,
      warning: `could not read execution file "${filePath}": ${errorMessage(error)}`,
    };
  }
}

export function main(argv: string[], context: RunContext, now: Date): number {
  const { raw, warning } = readExecutionFile(argv[2]);
  const record = buildMetricsRecord(raw, context, now, warning);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  // Fail-soft: metrics never fail a run.
  return 0;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv, process.env, new Date()));
}
