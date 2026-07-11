# Execution-file fixtures

These fixtures stand in for the `execution_file` output of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
so the metrics parser can be tested without a live agent run.

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
