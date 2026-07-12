/**
 * Metrics report generator.
 *
 * Reads the `runs.ndjson` produced by the metrics collector (one metrics
 * record per line, schema v1 — see parse-execution.ts) and computes:
 *   - total and mean `cost_usd`
 *   - mean `num_turns`
 *   - mean `duration_ms`
 *   - run counts per workflow
 *   - first-pass success rate over merged PRs authored by the agent
 * then emits a markdown report to stdout.
 *
 * FIRST-PASS DEFINITION (documented verbatim, per the task contract):
 *   merged agent PR with zero commits pushed after the first review summary
 *   comment.
 *
 * We approximate "zero commits pushed after the first review summary comment"
 * with a commit-count proxy: a merged agent PR is first-pass iff the number of
 * commits at merge equals the number of commits present when the review summary
 * first appeared. Editing the living summary comment does not change its
 * `created_at`, so that timestamp is the review's first appearance even under
 * the `gh pr comment --edit-last` pattern.
 *
 * The `gh` calls are isolated behind an injectable runner (`GhRunner`) so the
 * aggregation math and the first-pass classifier are pure and unit-testable
 * without touching the network.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The PR author whose merged PRs are measured for first-pass success. This is
 * the REST login of the implement app bot. VERIFY-ON-BRINGUP: confirm against
 * live PR history (#9, #12) that the app bot surfaces as this login.
 */
export const DEFAULT_AGENT_AUTHOR = 'asdlc-agent[bot]';

/**
 * Logins that author the review summary comment. The reviewer posts through the
 * default `GITHUB_TOKEN`, so its comments come from `github-actions[bot]`.
 * VERIFY-ON-BRINGUP against #9 / #12.
 */
export const DEFAULT_REVIEWER_LOGINS = ['github-actions[bot]'];

// ---------------------------------------------------------------------------
// Aggregation over the NDJSON metrics records
// ---------------------------------------------------------------------------

/** The subset of a metrics record this report reads. Records are open-shaped. */
export interface MetricsLine {
  workflow?: string | null;
  cost_usd?: number | null;
  num_turns?: number | null;
  duration_ms?: number | null;
  [extra: string]: unknown;
}

export interface Aggregates {
  totalRuns: number;
  /** Sum of every finite `cost_usd`. */
  totalCostUsd: number;
  /** Means over the finite samples of each field; `null` when there are none. */
  meanCostUsd: number | null;
  meanNumTurns: number | null;
  meanDurationMs: number | null;
  /** Run count keyed by `workflow` (a null/missing workflow is "unknown"). */
  runsPerWorkflow: Record<string, number>;
  /** Lines that were present but could not be parsed as JSON. */
  malformedLines: number;
}

/** Parse NDJSON text into records, skipping blank lines. */
export function parseNdjson(text: string): {
  records: MetricsLine[];
  malformedLines: number;
} {
  const records: MetricsLine[] = [];
  let malformedLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as MetricsLine;
      records.push(parsed);
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function finiteNumbers(
  records: MetricsLine[],
  key: 'cost_usd' | 'num_turns' | 'duration_ms',
): number[] {
  const out: number[] = [];
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function computeAggregates(
  records: MetricsLine[],
  malformedLines = 0,
): Aggregates {
  const costs = finiteNumbers(records, 'cost_usd');
  const turns = finiteNumbers(records, 'num_turns');
  const durations = finiteNumbers(records, 'duration_ms');

  const runsPerWorkflow: Record<string, number> = {};
  for (const record of records) {
    const key =
      typeof record.workflow === 'string' && record.workflow !== ''
        ? record.workflow
        : 'unknown';
    runsPerWorkflow[key] = (runsPerWorkflow[key] ?? 0) + 1;
  }

  return {
    totalRuns: records.length,
    totalCostUsd: costs.reduce((sum, v) => sum + v, 0),
    meanCostUsd: mean(costs),
    meanNumTurns: mean(turns),
    meanDurationMs: mean(durations),
    runsPerWorkflow,
    malformedLines,
  };
}

// ---------------------------------------------------------------------------
// First-pass classification
// ---------------------------------------------------------------------------

/** A PR's timeline, normalized from the `gh` responses (or a fixture). */
export interface PrTimeline {
  number: number;
  mergedAt: string | null;
  /** Every commit on the PR, each with its committer date (ISO 8601). */
  commits: { committedDate: string }[];
  /** Every issue comment on the PR, with author login and creation time. */
  comments: { login: string; createdAt: string }[];
}

export interface FirstPassOptions {
  reviewerLogins: string[];
}

export interface FirstPassResult {
  number: number;
  /** Whether a review summary comment was found at all. */
  reviewed: boolean;
  firstPass: boolean;
  commitsAtMerge: number;
  /** Commits present when the review summary first appeared; null if unreviewed. */
  commitsAtReview: number | null;
  firstReviewAt: string | null;
}

function countCommitsAtOrBefore(
  commits: { committedDate: string }[],
  cutoff: string,
): number {
  const cutoffMs = Date.parse(cutoff);
  return commits.filter((c) => Date.parse(c.committedDate) <= cutoffMs).length;
}

/**
 * Classify one merged agent PR as first-pass or not.
 *
 * First-pass (per the definition in the file header): the PR was merged with
 * zero commits pushed after the first review summary comment. Proxy: the commit
 * count at merge equals the commit count when that comment first appeared.
 *
 * An unreviewed merge (no review summary comment) cannot be shown to have passed
 * a first review, so it is classified as not first-pass and flagged `reviewed:
 * false` for separate reporting.
 */
export function classifyFirstPass(
  pr: PrTimeline,
  options: FirstPassOptions,
): FirstPassResult {
  const reviewerLogins = new Set(options.reviewerLogins);
  const mergeCutoff = pr.mergedAt;

  // All commits belong to a merged PR, but bound by merge time defensively.
  const commitsAtMerge = mergeCutoff
    ? countCommitsAtOrBefore(pr.commits, mergeCutoff)
    : pr.commits.length;

  const firstReview = pr.comments
    .filter((c) => reviewerLogins.has(c.login))
    .map((c) => c.createdAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  if (firstReview === undefined) {
    return {
      number: pr.number,
      reviewed: false,
      firstPass: false,
      commitsAtMerge,
      commitsAtReview: null,
      firstReviewAt: null,
    };
  }

  const commitsAtReview = countCommitsAtOrBefore(pr.commits, firstReview);
  return {
    number: pr.number,
    reviewed: true,
    firstPass: commitsAtReview === commitsAtMerge,
    commitsAtMerge,
    commitsAtReview,
    firstReviewAt: firstReview,
  };
}

export interface FirstPassSummary {
  totalMerged: number;
  reviewed: number;
  firstPass: number;
  /** first-pass / reviewed; null when nothing was reviewed. */
  rate: number | null;
  results: FirstPassResult[];
}

export function summarizeFirstPass(
  timelines: PrTimeline[],
  options: FirstPassOptions,
): FirstPassSummary {
  const results = timelines.map((pr) => classifyFirstPass(pr, options));
  const reviewed = results.filter((r) => r.reviewed).length;
  const firstPass = results.filter((r) => r.firstPass).length;
  return {
    totalMerged: results.length,
    reviewed,
    firstPass,
    rate: reviewed === 0 ? null : firstPass / reviewed,
    results,
  };
}

// ---------------------------------------------------------------------------
// The `gh` boundary (injectable so tests never touch the network)
// ---------------------------------------------------------------------------

/** Runs `gh <args>` and resolves with stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};

async function ghJson<T>(gh: GhRunner, args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

interface RawPull {
  number: number;
  merged_at: string | null;
  user: { login: string } | null;
}
interface RawCommit {
  commit: { committer: { date: string } | null } | null;
}
interface RawComment {
  user: { login: string } | null;
  created_at: string;
}

/** List merged PRs authored by `author`, newest first. */
export async function fetchMergedAgentPRs(
  gh: GhRunner,
  { owner, repo }: RepoRef,
  author: string,
): Promise<{ number: number; mergedAt: string }[]> {
  const pulls = await ghJson<RawPull[]>(gh, [
    'api',
    '--paginate',
    `repos/${owner}/${repo}/pulls?state=closed&per_page=100`,
  ]);
  return pulls
    .filter((p) => p.merged_at !== null && p.user?.login === author)
    .map((p) => ({ number: p.number, mergedAt: p.merged_at as string }));
}

/** Fetch the commit dates and comment authors for one PR. */
export async function fetchPrTimeline(
  gh: GhRunner,
  { owner, repo }: RepoRef,
  pr: { number: number; mergedAt: string },
): Promise<PrTimeline> {
  const [commits, comments] = await Promise.all([
    ghJson<RawCommit[]>(gh, [
      'api',
      '--paginate',
      `repos/${owner}/${repo}/pulls/${pr.number}/commits?per_page=100`,
    ]),
    ghJson<RawComment[]>(gh, [
      'api',
      '--paginate',
      `repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`,
    ]),
  ]);
  return {
    number: pr.number,
    mergedAt: pr.mergedAt,
    commits: commits
      .map((c) => c.commit?.committer?.date)
      .filter((d): d is string => typeof d === 'string')
      .map((committedDate) => ({ committedDate })),
    comments: comments
      .filter((c): c is RawComment & { user: { login: string } } =>
        Boolean(c.user),
      )
      .map((c) => ({ login: c.user.login, createdAt: c.created_at })),
  };
}

export async function gatherFirstPass(
  gh: GhRunner,
  ref: RepoRef,
  options: { author: string; reviewerLogins: string[] },
): Promise<FirstPassSummary> {
  const prs = await fetchMergedAgentPRs(gh, ref, options.author);
  const timelines = await Promise.all(
    prs.map((pr) => fetchPrTimeline(gh, ref, pr)),
  );
  return summarizeFirstPass(timelines, {
    reviewerLogins: options.reviewerLogins,
  });
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fmtNumber(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits);
}

function fmtInt(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('en-US');
}

function fmtRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function renderReport(
  aggregates: Aggregates,
  firstPass: FirstPassSummary | { error: string },
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push('# Agent run metrics');
  lines.push('');
  lines.push(`_Generated ${generatedAt}._`);
  lines.push('');

  lines.push('## Aggregates');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Total runs | ${aggregates.totalRuns} |`);
  lines.push(`| Total cost (USD) | ${fmtNumber(aggregates.totalCostUsd, 4)} |`);
  lines.push(`| Mean cost (USD) | ${fmtNumber(aggregates.meanCostUsd, 4)} |`);
  lines.push(`| Mean turns | ${fmtNumber(aggregates.meanNumTurns, 1)} |`);
  lines.push(`| Mean duration (ms) | ${fmtInt(aggregates.meanDurationMs)} |`);
  lines.push('');

  lines.push('## Runs per workflow');
  lines.push('');
  const workflows = Object.keys(aggregates.runsPerWorkflow).sort();
  if (workflows.length === 0) {
    lines.push('_No runs recorded._');
  } else {
    lines.push('| Workflow | Runs |');
    lines.push('| --- | --- |');
    for (const workflow of workflows) {
      lines.push(`| ${workflow} | ${aggregates.runsPerWorkflow[workflow]} |`);
    }
  }
  if (aggregates.malformedLines > 0) {
    lines.push('');
    lines.push(
      `_Skipped ${aggregates.malformedLines} malformed line(s) in runs.ndjson._`,
    );
  }
  lines.push('');

  lines.push('## First-pass success rate');
  lines.push('');
  lines.push(
    '> First-pass: merged agent PR with zero commits pushed after the first ' +
      'review summary comment.',
  );
  lines.push('');
  if ('error' in firstPass) {
    lines.push(`_First-pass rate unavailable: ${firstPass.error}_`);
  } else {
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Merged agent PRs | ${firstPass.totalMerged} |`);
    lines.push(`| Reviewed | ${firstPass.reviewed} |`);
    lines.push(`| First-pass | ${firstPass.firstPass} |`);
    lines.push(`| First-pass rate | ${fmtRate(firstPass.rate)} |`);
    const unreviewed = firstPass.totalMerged - firstPass.reviewed;
    if (unreviewed > 0) {
      lines.push('');
      lines.push(
        `_${unreviewed} merged PR(s) had no review summary comment and are ` +
          'excluded from the rate denominator._',
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface MainDeps {
  gh: GhRunner;
  now: Date;
  env: NodeJS.ProcessEnv;
}

function parseRepoRef(env: NodeJS.ProcessEnv): RepoRef | null {
  const slug = env.GITHUB_REPOSITORY;
  if (!slug) return null;
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const ndjsonPath = argv[2];
  if (!ndjsonPath) {
    process.stderr.write(
      'usage: report.ts <runs.ndjson>\n' +
        '  reads run records and prints a markdown report to stdout\n',
    );
    return 2;
  }

  let text = '';
  try {
    text = readFileSync(ndjsonPath, 'utf8');
  } catch (error) {
    process.stderr.write(
      `could not read "${ndjsonPath}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  const { records, malformedLines } = parseNdjson(text);
  const aggregates = computeAggregates(records, malformedLines);

  const ref = parseRepoRef(deps.env);
  let firstPass: FirstPassSummary | { error: string };
  if (!ref) {
    firstPass = { error: 'GITHUB_REPOSITORY is not set' };
  } else {
    try {
      firstPass = await gatherFirstPass(deps.gh, ref, {
        author: deps.env.METRICS_AGENT_AUTHOR ?? DEFAULT_AGENT_AUTHOR,
        reviewerLogins: DEFAULT_REVIEWER_LOGINS,
      });
    } catch (error) {
      firstPass = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  process.stdout.write(
    `${renderReport(aggregates, firstPass, deps.now.toISOString())}\n`,
  );
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
  main(process.argv, {
    gh: defaultGhRunner,
    now: new Date(),
    env: process.env,
  }).then((code) => process.exit(code));
}
