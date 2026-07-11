# ASDLC Roadmap

This repo builds an Agentic Software Development Lifecycle (ASDLC) pipeline, step by step,
following the [agentic SDLC whitepaper](./docs/agentic-sdlc-google.txt). The guiding idea is
the whitepaper's **factory model**: the primary output is not code — it's the system that
produces code. That system (the **harness**) is built in the phases below, each phase a
prerequisite for the next.

The sequencing principle: quality gates (tests, CI) must exist _before_ agent generation is
turned on. Otherwise the pipeline reproduces the whitepaper's "low CapEx, high OpEx"
vibe-coding debt curve.

## Phase 0 — Platform (configuring the harness)

GitHub is the platform of record. Nothing agentic can run until the repo has gates and
structured entry points.

- [x] GitHub repo created and pushed (`celom/asdlc`, public)
- [x] CI workflow: format check, typecheck, test, build on every push/PR
- [x] PR template: linked issue, acceptance criteria, verification evidence, AI disclosure
- [x] Issue templates encoding the spec-driven flow: spec → task, plus bug reports
- [x] Labels for the workflow (`spec`, `task`)
- [x] Branch protection on `main`: PRs required, CI check must pass, no force pushes
      (approvals set to 0 while the repo is single-maintainer; admins may still push
      directly until the loop moves fully to PRs)

## Phase 1 — A target to build

The pipeline needs something to produce. Drive one small, deliberately boring package
through the full loop **manually first**, so each step is understood before it is automated.

- [x] Create a first package in `packages/` with unit tests (`packages/tictactoe`, #3)
- [x] Exercise the loop end to end: issue → spec → task → implementation → tests → PR → CI → merge
      (spec #1 → task #2 → PR #3)
- [x] Document friction found in each step (this feeds Phase 2 automation choices):
      [docs/phase-1-friction.md](./docs/phase-1-friction.md)

## Phase 2 — Agents in the loop

Wire agents into the platform, with humans as the final gate. Operator manual (setup,
loop, cost controls): [docs/phase-2-agents.md](./docs/phase-2-agents.md). Spec #4.

- [ ] Claude Code GitHub Action: an issue labeled `agent:implement` produces a PR
- [x] AI first-pass review workflow on PRs (bugs, security, style) before human review
- [ ] Tighten branch protection: require an approving review and enforce for admins,
      once the review flow (human + AI first-pass) exists

## Phase 3 — Feedback and observability

The whitepaper's "quality flywheel": evaluate → diagnose → optimize → verify → monitor.

- [ ] Evals for agent output quality (trajectory + final response), not just tests
- [ ] Guardrail hooks (e.g. block commits containing secrets)
- [ ] Lightweight metrics on agent runs: cost, latency, first-pass success rate
