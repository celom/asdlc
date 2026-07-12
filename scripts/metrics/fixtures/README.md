# Metrics fixtures

These fixtures let the metrics scripts be tested without a live agent run or a
network call.

## Parser fixtures (`parse-execution.ts`)

They stand in for the `execution_file` output of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action).

## `execution-success.json`

A successful run. It is an array of Claude Code stream-json messages whose final
entry is the terminal `result` message the parser reads.

### `VERIFY-ON-BRINGUP`

The following field names are taken from claude-code-action / Claude Code
**documentation and stream-json conventions, not from an observed live run in
this repo**. JSON has no comments, so they are catalogued here. The first live
`agent-implement` run must be diffed against this fixture and any mismatch
corrected (see parent spec #15, "Open questions").

- `result[].type === "result"` — the terminal summary message marker. **VERIFY-ON-BRINGUP**
- `total_cost_usd` — mapped to `cost_usd`. **VERIFY-ON-BRINGUP**
- `num_turns` — mapped to `num_turns`. **VERIFY-ON-BRINGUP**
- `duration_ms` — mapped to `duration_ms`. **VERIFY-ON-BRINGUP**
- `subtype` — mapped to `conclusion` (e.g. `success`, `error_max_turns`). **VERIFY-ON-BRINGUP**

The parser is fail-soft by design: if any of these names is wrong or absent, the
corresponding record field is `null` with an entry in `parse_warnings`, and the
run is never failed. So a bring-up mismatch degrades metrics quality without
breaking the pipeline.

## Report fixtures (`report.ts`)

- `runs-sample.ndjson` — a small `runs.ndjson` (the collector's output) covering
  both workflows and a fully-null record, for the aggregation math.
- `gh/pulls.json` — a `GET .../pulls?state=closed` response mixing merged agent
  PRs, a non-agent PR, and an unmerged PR, so the author/merge filter is
  exercised.
- `gh/pr-{101,102,103}-{commits,comments}.json` — per-PR
  `GET .../pulls/{n}/commits` and `GET .../issues/{n}/comments` responses for the
  three first-pass cases: first-pass (101), fixup-after-review (102), and
  unreviewed-merge (103).

These drive a mock `GhRunner` in `report.spec.ts` — the `gh` boundary is never
called over the network in tests. The agent-author and reviewer logins the
classifier keys on (`asdlc-agent[bot]`, `github-actions[bot]`) are documented in
the `report.ts` header and are **VERIFY-ON-BRINGUP** against live PR history.
