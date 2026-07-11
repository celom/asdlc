# Phase 2 friction log

Phase 2 wired agents into the loop (spec #4, tasks #5/#6, PRs #7/#10, verified end to
end via #8 → PR #9 and #11 → PR #12). This log records the friction found in each step,
as input for Phase 3 (evals, guardrails, metrics).

## One-time setup (App, secrets)

- Choosing a custom GitHub App over the official Claude app means manual creation
  (permissions, install, private key) — a one-time, non-codeable step that every
  template consumer must repeat. Documented in
  [docs/phase-2-agents.md](./phase-2-agents.md); there is no way to express it as
  config-as-code.
- The `GITHUB_TOKEN`-doesn't-trigger-CI caveat was known from research and designed
  around upfront (App token) — the one part of the bring-up that worked first try
  because it was researched, not discovered.

## Review workflow bring-up

Three failures before the first successful review — none visible in a dry read of the
workflow YAML; all discovered by running it:

1. **Implicit OIDC dependency.** Without an explicit `github_token` input,
   `claude-code-action@v1` attempts an OIDC token exchange that only works with the
   official Claude GitHub App: `Unable to get ACTIONS_ID_TOKEN_REQUEST_URL`. Fix: pass
   `github_token: ${{ secrets.GITHUB_TOKEN }}` explicitly.
2. **Default-deny tools, misleading error.** Custom prompts run with no allowed tools.
   The reviewer burned its entire 5-turn cap on permission denials and posted nothing
   ($0.13 spent). The surfaced error was `error_max_turns`; the root cause
   (`permission_denials_count: 5`) was buried in the run JSON. Fix: explicit
   `--allowedTools` for exactly the reviewer's needs, `--max-turns 25`.
3. **Bot actors refused by default.** The action rejects runs initiated by non-human
   actors, so the review failed on the first agent-authored PR (#9) — exactly the PRs
   that most need a review gate. Discovered only at the end-to-end test; fixed with
   `allowed_bots: 'asdlc-agent'` (#10). Verified on PR #12.

Pattern: each failure cost a full push → CI → review cycle, and pushes are human-gated
locally. Actions-side bring-up is expensive to iterate; front-loaded research pays.

## Review quality (working well)

- The AI first-pass review found real defects in its own wiring on PR #7: a missing
  `ready_for_review` trigger (draft→ready PRs escaped review entirely), an overstated
  security comment (Bash allowlist described as a sandbox when running the toolchain
  is code execution by construction), a docs inaccuracy (fork PRs fail, not "silently
  skip"), a missing concurrency guard on implement runs, and summary comments piling
  up per push.
- It also caught a process bug no workflow enforces: `Closes #N` on a PR whose
  acceptance criteria are only verifiable post-merge auto-closes the issue unverified.
  Switched to `Part of #N` + manual close after verification. Convention only —
  nothing validates linked-issue lifecycle.
- Summary pile-up fixed by instructing `gh pr comment --edit-last`; confirmed the
  comment count stays at one living summary per PR. The reviewer itself noted
  `--edit-last` targets the last bot comment, which is not guaranteed to be the
  summary — a latent misfire, accepted for now.
- Every push triggers a billed review (~4 min each), which changes behavior: fixes get
  batched, and minor findings are deliberately left unfixed when a dedicated push
  cycle costs more than the finding is worth (e.g. no `edited` trigger). Cost-aware
  review cadence is a real dynamic that Phase 3 metrics should capture.

## Implement workflow

- Worked first try (#8 → PR #9): correct branch naming (`agent/issue-8-…`),
  template-conformant PR body, acceptance criteria carried verbatim from the issue
  (Phase 1's top duplication complaint, now automated), real verification output from
  the runner, and correct AI-disclosure handling (checked "AI-generated", left
  "reviewed by a human" for the human).
- Git commit identity resolved itself: the action configures `claude[bot]` as
  committer; the PR is authored by the App identity (`app/asdlc-agent`). The Phase 1
  question "where do pushes originate" is answered: a bot identity in CI, with the
  local harness still blocking pushes on the dev machine.
- Lifecycle gap: PR #9 was merged while its review check had _failed_ (the bot-actor
  bug). The review job is deliberately not a required status check, so a failed or
  skipped review does not block merge — the human gate is the only backstop. Decide in
  Phase 3 whether review-ran-successfully should be required.

## Branch protection endgame

- Tightening (1 approval + `enforce_admins`) was sequenced last, after the implement
  loop was verified — the bootstrap ordering worked as planned.
- The single-maintainer deadlock is now live and immediately shaped behavior: this very
  friction log could not be delivered as a human-authored PR (GitHub forbids approving
  your own PR), so it flowed through an `agent:implement` issue. The intended norm,
  enforced by the platform.
- Verified: direct pushes to `main` are rejected even for the admin; agent PR #12
  merged only after a required human approval.

## Local verification

- One CI cycle was wasted on a prettier failure (PR #10): the pre-commit format check
  was run with output suppressed and its failure went unnoticed. `bun run verify`
  (added by the agent in #9) now makes the full local gate one visible command — run
  it before every push, unsuppressed.

## Residual gaps (Phase 3 candidates)

- No run metrics: cost, latency, and first-pass success rate of agent runs are only
  observable by digging through Actions logs (`total_cost_usd` is in the run JSON).
- Issue-form validation is still web-only; the review workflow enforces the template
  contract on PRs, but issue bodies remain convention.
- Spec lifecycle is still manual (spec #4 closed by hand after its tasks).
- No guardrail hooks yet (e.g. secret-scanning before commits) — agent-authored
  commits currently rely on the reviewer and the human gate.
