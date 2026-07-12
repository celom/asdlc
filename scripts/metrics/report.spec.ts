import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFirstPass,
  computeAggregates,
  DEFAULT_AGENT_AUTHOR,
  DEFAULT_REVIEWER_LOGINS,
  fetchMergedAgentPRs,
  gatherFirstPass,
  main,
  parseNdjson,
  renderReport,
  summarizeFirstPass,
  type GhRunner,
  type MainDeps,
  type PrTimeline,
} from './report';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const GH_FIXTURES = join(FIXTURES, 'gh');
const NOW = new Date('2026-07-12T00:00:00.000Z');

const REVIEWERS = { reviewerLogins: DEFAULT_REVIEWER_LOGINS };

// A gh runner backed by the checked-in JSON fixtures. It routes on the REST
// path in the final argument, standing in for the network boundary.
const fixtureGh: GhRunner = async (args) => {
  const path = args[args.length - 1] ?? '';
  const file = (name: string) => readFileSync(join(GH_FIXTURES, name), 'utf8');
  if (path.includes('/pulls?state=closed')) return file('pulls.json');
  const commits = path.match(/pulls\/(\d+)\/commits/);
  if (commits) return file(`pr-${commits[1]}-commits.json`);
  const comments = path.match(/issues\/(\d+)\/comments/);
  if (comments) return file(`pr-${comments[1]}-comments.json`);
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
};

describe('parseNdjson', () => {
  it('parses each non-blank line and skips blanks', () => {
    const { records, malformedLines } = parseNdjson('{"a":1}\n\n  \n{"a":2}\n');
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(malformedLines).toBe(0);
  });

  it('counts malformed lines without throwing', () => {
    const { records, malformedLines } = parseNdjson('{"a":1}\nnot json\n');
    expect(records).toEqual([{ a: 1 }]);
    expect(malformedLines).toBe(1);
  });

  it('returns nothing for an empty file', () => {
    expect(parseNdjson('')).toEqual({ records: [], malformedLines: 0 });
    expect(parseNdjson('\n\n')).toEqual({ records: [], malformedLines: 0 });
  });
});

describe('computeAggregates', () => {
  it('computes totals, means, and per-workflow counts from the fixture', () => {
    const text = readFileSync(join(FIXTURES, 'runs-sample.ndjson'), 'utf8');
    const { records, malformedLines } = parseNdjson(text);
    const agg = computeAggregates(records, malformedLines);

    expect(agg.totalRuns).toBe(4);
    expect(agg.totalCostUsd).toBeCloseTo(0.7, 10);
    // Means are over the finite samples only (the fourth line is all null).
    expect(agg.meanCostUsd).toBeCloseTo(0.7 / 3, 10);
    expect(agg.meanNumTurns).toBeCloseTo((10 + 60 + 8) / 3, 10);
    expect(agg.meanDurationMs).toBeCloseTo((120000 + 300000 + 60000) / 3, 10);
    expect(agg.runsPerWorkflow).toEqual({
      'Agent Implement': 2,
      'Agent Review': 2,
    });
    expect(agg.malformedLines).toBe(0);
  });

  it('yields null means for an empty set', () => {
    const agg = computeAggregates([]);
    expect(agg.totalRuns).toBe(0);
    expect(agg.totalCostUsd).toBe(0);
    expect(agg.meanCostUsd).toBeNull();
    expect(agg.meanNumTurns).toBeNull();
    expect(agg.meanDurationMs).toBeNull();
    expect(agg.runsPerWorkflow).toEqual({});
  });

  it('handles a single-line file', () => {
    const { records } = parseNdjson(
      '{"workflow":"Agent Implement","cost_usd":0.5,"num_turns":4,"duration_ms":1000}',
    );
    const agg = computeAggregates(records);
    expect(agg.totalRuns).toBe(1);
    expect(agg.totalCostUsd).toBeCloseTo(0.5, 10);
    expect(agg.meanCostUsd).toBeCloseTo(0.5, 10);
    expect(agg.meanNumTurns).toBe(4);
    expect(agg.runsPerWorkflow).toEqual({ 'Agent Implement': 1 });
  });

  it('buckets a missing workflow under "unknown"', () => {
    const agg = computeAggregates([{ cost_usd: 1 }, { workflow: null }]);
    expect(agg.runsPerWorkflow).toEqual({ unknown: 2 });
  });
});

describe('classifyFirstPass', () => {
  it('flags a PR merged with no commits after review as first-pass', () => {
    const pr: PrTimeline = {
      number: 101,
      mergedAt: '2026-07-05T12:00:00Z',
      commits: [{ committedDate: '2026-07-05T09:00:00Z' }],
      comments: [
        { login: 'github-actions[bot]', createdAt: '2026-07-05T10:00:00Z' },
      ],
    };
    const result = classifyFirstPass(pr, REVIEWERS);
    expect(result).toMatchObject({
      number: 101,
      reviewed: true,
      firstPass: true,
      commitsAtMerge: 1,
      commitsAtReview: 1,
    });
  });

  it('rejects a PR with a fixup commit pushed after review', () => {
    const pr: PrTimeline = {
      number: 102,
      mergedAt: '2026-07-06T12:00:00Z',
      commits: [
        { committedDate: '2026-07-06T09:00:00Z' },
        { committedDate: '2026-07-06T11:00:00Z' },
      ],
      comments: [
        { login: 'github-actions[bot]', createdAt: '2026-07-06T10:00:00Z' },
      ],
    };
    const result = classifyFirstPass(pr, REVIEWERS);
    expect(result.reviewed).toBe(true);
    expect(result.firstPass).toBe(false);
    expect(result.commitsAtMerge).toBe(2);
    expect(result.commitsAtReview).toBe(1);
  });

  it('marks an unreviewed merge as not first-pass', () => {
    const pr: PrTimeline = {
      number: 103,
      mergedAt: '2026-07-07T12:00:00Z',
      commits: [{ committedDate: '2026-07-07T09:00:00Z' }],
      comments: [{ login: 'celom', createdAt: '2026-07-07T09:30:00Z' }],
    };
    const result = classifyFirstPass(pr, REVIEWERS);
    expect(result.reviewed).toBe(false);
    expect(result.firstPass).toBe(false);
    expect(result.commitsAtReview).toBeNull();
    expect(result.firstReviewAt).toBeNull();
  });

  it('uses the earliest reviewer comment when several exist', () => {
    const pr: PrTimeline = {
      number: 104,
      mergedAt: '2026-07-08T12:00:00Z',
      commits: [
        { committedDate: '2026-07-08T09:00:00Z' },
        { committedDate: '2026-07-08T10:30:00Z' },
      ],
      comments: [
        { login: 'github-actions[bot]', createdAt: '2026-07-08T11:00:00Z' },
        { login: 'github-actions[bot]', createdAt: '2026-07-08T10:00:00Z' },
      ],
    };
    // Earliest review is 10:00, before the second commit at 10:30 -> not first-pass.
    const result = classifyFirstPass(pr, REVIEWERS);
    expect(result.firstReviewAt).toBe('2026-07-08T10:00:00Z');
    expect(result.firstPass).toBe(false);
  });
});

describe('summarizeFirstPass', () => {
  it('computes the rate over reviewed PRs and excludes unreviewed', () => {
    const summary = summarizeFirstPass(
      [
        {
          number: 1,
          mergedAt: '2026-07-01T02:00:00Z',
          commits: [{ committedDate: '2026-07-01T00:00:00Z' }],
          comments: [
            { login: 'github-actions[bot]', createdAt: '2026-07-01T01:00:00Z' },
          ],
        },
        {
          number: 2,
          mergedAt: '2026-07-02T03:00:00Z',
          commits: [
            { committedDate: '2026-07-02T00:00:00Z' },
            { committedDate: '2026-07-02T02:00:00Z' },
          ],
          comments: [
            { login: 'github-actions[bot]', createdAt: '2026-07-02T01:00:00Z' },
          ],
        },
        {
          number: 3,
          mergedAt: '2026-07-03T02:00:00Z',
          commits: [{ committedDate: '2026-07-03T00:00:00Z' }],
          comments: [],
        },
      ],
      REVIEWERS,
    );
    expect(summary.totalMerged).toBe(3);
    expect(summary.reviewed).toBe(2);
    expect(summary.firstPass).toBe(1);
    expect(summary.rate).toBeCloseTo(0.5, 10);
  });

  it('reports a null rate when nothing was reviewed', () => {
    const summary = summarizeFirstPass([], REVIEWERS);
    expect(summary.rate).toBeNull();
  });
});

describe('gh boundary (mocked)', () => {
  it('lists only merged PRs by the agent author', async () => {
    const prs = await fetchMergedAgentPRs(
      fixtureGh,
      { owner: 'celom', repo: 'asdlc' },
      DEFAULT_AGENT_AUTHOR,
    );
    expect(prs.map((p) => p.number)).toEqual([101, 102, 103]);
  });

  it('gathers and classifies the fixture PR timelines end to end', async () => {
    const summary = await gatherFirstPass(
      fixtureGh,
      { owner: 'celom', repo: 'asdlc' },
      { author: DEFAULT_AGENT_AUTHOR, reviewerLogins: DEFAULT_REVIEWER_LOGINS },
    );
    expect(summary.totalMerged).toBe(3);
    expect(summary.reviewed).toBe(2);
    expect(summary.firstPass).toBe(1);
    expect(summary.rate).toBeCloseTo(0.5, 10);

    const byNumber = Object.fromEntries(
      summary.results.map((r) => [r.number, r]),
    );
    expect(byNumber[101].firstPass).toBe(true);
    expect(byNumber[102].firstPass).toBe(false);
    expect(byNumber[103].reviewed).toBe(false);
  });
});

describe('renderReport', () => {
  const agg = computeAggregates(
    parseNdjson(readFileSync(join(FIXTURES, 'runs-sample.ndjson'), 'utf8'))
      .records,
  );

  it('documents the first-pass definition verbatim', () => {
    const md = renderReport(
      agg,
      { totalMerged: 0, reviewed: 0, firstPass: 0, rate: null, results: [] },
      NOW.toISOString(),
    );
    expect(md).toContain(
      'merged agent PR with zero commits pushed after the first review summary comment.',
    );
  });

  it('renders aggregates, per-workflow counts, and the rate', () => {
    const md = renderReport(
      agg,
      {
        totalMerged: 3,
        reviewed: 2,
        firstPass: 1,
        rate: 0.5,
        results: [],
      },
      NOW.toISOString(),
    );
    expect(md).toContain('| Total runs | 4 |');
    expect(md).toContain('| Total cost (USD) | 0.7000 |');
    expect(md).toContain('| Agent Implement | 2 |');
    expect(md).toContain('| Agent Review | 2 |');
    expect(md).toContain('| First-pass rate | 50.0% |');
    expect(md).toContain('1 merged PR(s) had no review summary comment');
  });

  it('renders an error note when first-pass is unavailable', () => {
    const md = renderReport(agg, { error: 'gh exploded' }, NOW.toISOString());
    expect(md).toContain('First-pass rate unavailable: gh exploded');
  });
});

describe('main (CLI)', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureMain(argv: string[], deps: MainDeps) {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { code: main(argv, deps), output: () => writes.join('') };
  }

  it('reads the fixture, computes first-pass via gh, and prints markdown', async () => {
    const { code, output } = captureMain(
      ['bun', 'report.ts', join(FIXTURES, 'runs-sample.ndjson')],
      {
        gh: fixtureGh,
        now: NOW,
        env: { GITHUB_REPOSITORY: 'celom/asdlc' },
      },
    );
    expect(await code).toBe(0);
    const md = output();
    expect(md).toContain('# Agent run metrics');
    expect(md).toContain('| Total runs | 4 |');
    expect(md).toContain('| First-pass rate | 50.0% |');
  });

  it('notes when GITHUB_REPOSITORY is unset instead of failing', async () => {
    const { code, output } = captureMain(
      ['bun', 'report.ts', join(FIXTURES, 'runs-sample.ndjson')],
      { gh: fixtureGh, now: NOW, env: {} },
    );
    expect(await code).toBe(0);
    expect(output()).toContain(
      'First-pass rate unavailable: GITHUB_REPOSITORY is not set',
    );
  });

  it('degrades to an error note if gh throws', async () => {
    const { code, output } = captureMain(
      ['bun', 'report.ts', join(FIXTURES, 'runs-sample.ndjson')],
      {
        gh: async () => {
          throw new Error('gh not found');
        },
        now: NOW,
        env: { GITHUB_REPOSITORY: 'celom/asdlc' },
      },
    );
    expect(await code).toBe(0);
    expect(output()).toContain('First-pass rate unavailable: gh not found');
  });

  it('exits 2 with usage when no path is given', async () => {
    const { code } = captureMain(['bun', 'report.ts'], {
      gh: fixtureGh,
      now: NOW,
      env: {},
    });
    expect(await code).toBe(2);
  });

  it('exits 1 when the file cannot be read', async () => {
    const { code } = captureMain(['bun', 'report.ts', '/no/such/runs.ndjson'], {
      gh: fixtureGh,
      now: NOW,
      env: {},
    });
    expect(await code).toBe(1);
  });
});
