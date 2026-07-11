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

- [x] GitHub repo created and pushed (`celom/asdlc`)
- [ ] CI workflow: format check, typecheck, test, build on every push/PR
- [ ] PR template: linked issue, acceptance criteria, verification evidence, AI disclosure
- [ ] Issue templates encoding the spec-driven flow: spec → task, plus bug reports
- [ ] Labels for the workflow (`spec`, `task`)

## Phase 1 — A target to build

The pipeline needs something to produce. Drive one small, deliberately boring package
through the full loop **manually first**, so each step is understood before it is automated.

- [ ] Create a first package in `packages/` with unit tests
- [ ] Exercise the loop end to end: issue → spec → task → implementation → tests → PR → CI → merge
- [ ] Document friction found in each step (this feeds Phase 2 automation choices)

## Phase 2 — Agents in the loop

Wire agents into the platform, with humans as the final gate.

- [ ] Claude Code GitHub Action: an issue labeled `agent:implement` produces a PR
- [ ] AI first-pass review workflow on PRs (bugs, security, style) before human review
- [ ] Branch protection: CI green + human approval required to merge

## Phase 3 — Feedback and observability

The whitepaper's "quality flywheel": evaluate → diagnose → optimize → verify → monitor.

- [ ] Evals for agent output quality (trajectory + final response), not just tests
- [ ] Guardrail hooks (e.g. block commits containing secrets)
- [ ] Lightweight metrics on agent runs: cost, latency, first-pass success rate
