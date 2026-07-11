# Phase 2 — Agents in the loop: operator manual

Phase 2 wires agents into the platform ([spec #4](https://github.com/celom/asdlc/issues/4)).
Two workflows do the work; humans remain the final gate. This doc records the one-time
setup a template consumer must repeat (config-as-code cannot carry secrets or app
installs) and how the loop operates.

## The loop

```
task issue ──label agent:implement──▶ agent-implement.yml
                                          │  (custom App token)
                                          ▼
                                    agent branch + PR
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                        CI (checks)            agent-review.yml
                              │                       │
                              └───────────┬───────────┘
                                          ▼
                            human review + approval (required)
                                          ▼
                                    squash-merge → issue auto-closes
```

- **`agent-implement.yml`** — an issue labeled `agent:implement` triggers a Claude Code
  run that implements the issue, verifies with the full CI gate locally, and opens a PR
  following the PR template, carrying the issue's acceptance criteria verbatim (the
  friction log's most mechanical duplication, now automated).
- **`agent-review.yml`** — every non-draft PR gets an AI first-pass review (bugs,
  security, style) that also checks the PR body against the template, turning that
  convention into an enforced check. The job has `contents: read` — the reviewer
  structurally cannot push code — and it never approves; approval is human-only.

## One-time setup

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps → New), e.g.
   `asdlc-agent`:
   - Repository permissions: **Contents, Issues, Pull requests → Read & write**
   - Webhook: disabled
   - Install it on the repository. Note the App ID and generate a private key (`.pem`).

   Why a custom App instead of the default `GITHUB_TOKEN`: pushes and PRs made with
   `GITHUB_TOKEN` do **not** trigger downstream workflows, so CI would never run on
   agent PRs. An App token gives the agent a distinct bot identity and CI triggers
   normally.

2. **Set repository secrets:**

   ```sh
   gh secret set APP_ID
   gh secret set APP_PRIVATE_KEY < asdlc-agent.private-key.pem
   gh secret set ANTHROPIC_API_KEY
   ```

3. **Create the routing label:**

   ```sh
   gh label create "agent:implement" \
     --description "Route this issue to the Claude Code implement workflow" \
     --color "8250DF"
   ```

## Branch protection

Once the loop is verified end to end, tighten `main` (the PUT replaces the whole
object — send the full payload):

```sh
gh api -X PUT repos/celom/asdlc/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "checks" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Note: the required check context `checks` is the CI job id in
[`ci.yml`](../.github/workflows/ci.yml); if that job is ever renamed, update the
protection payload in lockstep.

With 1 required approval enforced for admins, a single maintainer cannot approve
their own PRs — human-authored PRs deadlock. That is intentional: the norm is that
changes flow through `agent:implement` issues (agent authors, human approves).

**Break-glass** for emergency human-authored fixes:

```sh
gh api -X DELETE repos/celom/asdlc/branches/main/protection/enforce_admins  # lift
gh api -X POST   repos/celom/asdlc/branches/main/protection/enforce_admins  # restore
```

## Cost controls

- `agent-implement.yml`: `--max-turns 40` caps the implement run; tune after real runs.
- `agent-review.yml`: `--max-turns 25`, plus per-PR concurrency-cancel so rapid pushes
  don't pay for stale reviews.
- Both workflows pass an explicit `--allowedTools` list — custom prompts run
  default-deny, so every tool must be allowlisted. Keep the lists minimal: the
  reviewer gets read + comment tools only; the implementer's Bash is scoped to
  bun/git/gh so an injected issue body can't run arbitrary commands against the
  runner's secrets.
- There is no monthly cap; run-cost metrics are a Phase 3 item.

## Known limitations

- **Fork PRs**: secrets are not available to `pull_request` runs from forks, so the
  review workflow silently skips external contributions. Acceptable while
  single-maintainer; revisit (`pull_request_target` with care) if outside
  contributors appear.
- **Issue-form validation is still web-only**: agents creating issues via `gh` follow
  the template by convention. The review workflow now enforces the contract on the PR
  side; an issue-body validator remains open (see the
  [friction log](./phase-1-friction.md)).
- **Spec lifecycle**: merging a task PR auto-closes the task but not the parent spec;
  specs are closed manually (Phase 3 candidate).
