import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMetricsRecord,
  main,
  readExecutionFile,
  SCHEMA_VERSION,
  type RunContext,
} from './parse-execution';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const SUCCESS_FIXTURE = join(FIXTURES, 'execution-success.json');
const NOW = new Date('2026-07-11T12:00:00.000Z');

const FULL_CONTEXT: RunContext = {
  GITHUB_WORKFLOW: 'agent-implement',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'abc123def456',
  METRICS_TRIGGER: '16',
};

function recordFrom(rawContent: string | null, fileWarning?: string) {
  return buildMetricsRecord(rawContent, FULL_CONTEXT, NOW, fileWarning);
}

describe('buildMetricsRecord — happy path', () => {
  const raw = readExecutionFile(SUCCESS_FIXTURE).raw;

  it('extracts metrics from the checked-in success fixture', () => {
    const record = recordFrom(raw);

    expect(record).toMatchObject({
      schema: SCHEMA_VERSION,
      ts: '2026-07-11T12:00:00.000Z',
      workflow: 'agent-implement',
      run_id: '123456789',
      run_attempt: '1',
      trigger: '16',
      head_sha: 'abc123def456',
      conclusion: 'success',
      cost_usd: 0.4213,
      num_turns: 7,
      duration_ms: 128450,
      parse_warnings: [],
    });
  });

  it('carries the run context straight through from the environment', () => {
    const record = recordFrom(raw);
    expect(record.workflow).toBe('agent-implement');
    expect(record.trigger).toBe('16');
    expect(record.parse_warnings).toHaveLength(0);
  });
});

describe('buildMetricsRecord — fail-soft degradation', () => {
  it('nulls a missing metric and records a warning', () => {
    const raw = JSON.stringify([
      { type: 'result', subtype: 'success', num_turns: 3, duration_ms: 10 },
    ]);
    const record = recordFrom(raw);

    expect(record.cost_usd).toBeNull();
    expect(record.num_turns).toBe(3);
    expect(record.parse_warnings).toContain(
      'missing field "total_cost_usd" in execution result',
    );
  });

  it('nulls a renamed metric and records a warning', () => {
    // A future claude-code-action release renames total_cost_usd -> cost_usd.
    const raw = JSON.stringify([
      {
        type: 'result',
        subtype: 'success',
        cost_usd: 0.5,
        num_turns: 3,
        duration_ms: 10,
      },
    ]);
    const record = recordFrom(raw);

    expect(record.cost_usd).toBeNull();
    expect(record.parse_warnings).toContain(
      'missing field "total_cost_usd" in execution result',
    );
  });

  it('nulls all metrics when no result message is present', () => {
    const raw = JSON.stringify([{ type: 'assistant', message: {} }]);
    const record = recordFrom(raw);

    expect(record.cost_usd).toBeNull();
    expect(record.num_turns).toBeNull();
    expect(record.duration_ms).toBeNull();
    expect(record.conclusion).toBeNull();
    expect(record.parse_warnings).toContain(
      'no result message (type="result") found in execution file',
    );
  });

  it('nulls metrics on malformed (non-JSON) input', () => {
    const record = recordFrom('{ not valid json ');

    expect(record.cost_usd).toBeNull();
    expect(
      record.parse_warnings.some((w) =>
        w.startsWith('execution file is not valid JSON'),
      ),
    ).toBe(true);
  });

  it('nulls metrics when the file could not be read', () => {
    const { raw, warning } = readExecutionFile('/no/such/execution-file.json');
    const record = recordFrom(raw, warning);

    expect(raw).toBeNull();
    expect(record.cost_usd).toBeNull();
    expect(record.num_turns).toBeNull();
    expect(
      record.parse_warnings.some((w) =>
        w.startsWith('could not read execution file'),
      ),
    ).toBe(true);
  });

  it('flags a wrong-typed metric field', () => {
    const raw = JSON.stringify([
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 'free',
        num_turns: 3,
        duration_ms: 10,
      },
    ]);
    const record = recordFrom(raw);

    expect(record.cost_usd).toBeNull();
    expect(record.parse_warnings).toContain(
      'field "total_cost_usd" in execution result is not a finite number',
    );
  });

  it('leaves run context null when the environment is empty', () => {
    const record = buildMetricsRecord(
      null,
      {},
      NOW,
      'no execution file path provided',
    );
    expect(record.workflow).toBeNull();
    expect(record.run_id).toBeNull();
    expect(record.trigger).toBeNull();
  });
});

describe('main — CLI behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureMain(argv: string[], context: RunContext = FULL_CONTEXT) {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = main(argv, context, NOW);
    return { code, output: writes.join('') };
  }

  it('prints a single-line JSON record and exits 0 on the fixture', () => {
    const { code, output } = captureMain([
      'bun',
      'parse-execution.ts',
      SUCCESS_FIXTURE,
    ]);

    expect(code).toBe(0);
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trimEnd()).not.toContain('\n');

    const record = JSON.parse(output);
    expect(record).toMatchObject({
      schema: SCHEMA_VERSION,
      workflow: 'agent-implement',
      run_id: '123456789',
      cost_usd: 0.4213,
      num_turns: 7,
      duration_ms: 128450,
      conclusion: 'success',
    });
    expect(typeof record.ts).toBe('string');
  });

  it('exits 0 even when no file argument is given', () => {
    const { code, output } = captureMain(['bun', 'parse-execution.ts']);

    expect(code).toBe(0);
    const record = JSON.parse(output);
    expect(record.cost_usd).toBeNull();
    expect(record.parse_warnings).toContain('no execution file path provided');
  });

  it('exits 0 on a missing input file', () => {
    const { code, output } = captureMain([
      'bun',
      'parse-execution.ts',
      '/no/such/file.json',
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(output).num_turns).toBeNull();
  });
});
