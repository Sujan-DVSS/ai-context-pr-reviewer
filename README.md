# ReviewIQ

Hackathon MVP for an AI context-aware code peer review bot. ReviewIQ runs when a pull request is opened or updated, reads the PR diff, scans the repository for story-relevant implementation context, pulls the related user story from Jira, and produces a review that connects implementation evidence back to the story description and acceptance criteria.

The MVP is intentionally dependency-light, but story context is Jira-only. Jira REST pulls live issue details, including acceptance criteria from a custom field when configured. If a LiteLLM gateway is configured, the reviewer also runs an LLM semantic pass.

## What It Reviews

- Static quality: debug leftovers, TODOs, overly long changed lines, empty catch blocks, risky broad changes.
- Security: secrets in code, unsafe HTML injection, `eval`, SQL concatenation, auth-sensitive code without tests.
- Performance: `await` inside loops, nested-loop risk, `SELECT *`, synchronous filesystem usage in request paths.
- Product context: whether changed files and added code line up with the story description, acceptance criteria, constraints, out-of-scope notes, and expected tests.
- Traceability: an acceptance-criteria evidence matrix showing which ACs appear supported by the diff and which need reviewer attention.
- Repo context: scans unchanged repository files to identify the modules most likely related to the story, then checks whether the PR touched the expected implementation areas.
- Story alignment score: reports a percentage score based on Jira vocabulary overlap and whether the PR touches story-relevant repo files.
- Cross-story conflict detection: flags changed code that references another Jira ID or touches out-of-scope story areas.
- LLM semantic review: optional LiteLLM pass for AC fit, missing edge cases, reviewer questions, and suggested tests.

## Differentiator

Most review bots focus on generic code smells. This MVP also reviews requirement drift:

- Does the code actually implement the user story?
- Which acceptance criteria have evidence in the PR?
- Does the PR touch the repo files that already contain the domain logic implied by the story?
- Which changed files look unrelated to the story?
- Did the PR skip required tests, migration notes, security expectations, or performance expectations?
- Is the blast radius bigger than the story scope?
- Is the PR accidentally changing behavior for another Jira story?

That is the under-addressed pain point: teams often discover late that code is clean but solves the wrong problem, misses an acceptance criterion, or quietly changes behavior outside the story.

## Quick Start

Run against a real PR diff and Jira ticket:

```bash
git diff --unified=80 origin/main...HEAD > pr.diff
export JIRA_BASE_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="you@company.com"
export JIRA_API_TOKEN="..."

node src/index.js --ticket-id STRY-123 --diff pr.diff --repo-root . --out review-report.md --json review-report.json --fail-on medium
```

Disable repository scanning if you only want a diff-level review:

```bash
node src/index.js --ticket-id STRY-123 --diff pr.diff --no-repo-context
```

## Jira Integration

For GitHub Actions, Jira is integrated through REST so the workflow can run independently of Cursor. The reviewer extracts a ticket ID such as `STRY-123` from the branch name, PR title, PR body, or commit messages, then fetches that Jira issue and converts it into ReviewIQ's internal story contract.

```bash
export JIRA_BASE_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="you@company.com"
export JIRA_API_TOKEN="..."

node src/index.js \
  --story-provider jira \
  --ticket-id STRY-123 \
  --diff pr.diff \
  --repo-root .
```

For bearer-token setups:

```bash
export JIRA_BASE_URL="https://jira.your-company.com"
export JIRA_BEARER_TOKEN="..."
```

If acceptance criteria live in a Jira custom field, set:

```bash
export JIRA_AC_FIELD="customfield_12345"
```

Jira is required. Jira MCP can still be used inside Cursor for manual lookup or validation, but GitHub Actions should use the REST provider because MCP servers are not available in the GitHub runner by default.

## LiteLLM Integration

LiteLLM is supported through its OpenAI-compatible `/v1/chat/completions` API. The deterministic checks still run first; LiteLLM receives only the Jira story context, compact PR diff, deterministic findings, and top retrieved repo-context snippets.

```bash
export LITELLM_API_KEY="..."

node src/index.js \
  --ticket-id STRY-123 \
  --diff pr.diff \
  --repo-root . \
  --llm-provider litellm
```

This MVP defaults to:

- `LITELLM_BASE_URL=https://llmgw.codefest2026.marriott.com/`
- `LITELLM_API_PATH=/chat/completions`
- `LITELLM_MODEL=us.anthropic.claude-opus-4-7`

You only need to provide `LITELLM_API_KEY`. Override the gateway, API path, or model with `--llm-base-url`, `--llm-api-path`, `--llm-model`, `LITELLM_BASE_URL`, `LITELLM_API_PATH`, or `LITELLM_MODEL` if needed.

Use `--llm-provider auto` in CI to run the LLM only when `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_MODEL` are present. Without those values, the reviewer falls back to deterministic + repo-context review.

If the gateway is configured but temporarily fails, the GitHub Action still writes the deterministic report and marks the LiteLLM section as failed. Add `--llm-required` if you want the workflow to fail when the LLM semantic pass cannot complete.

If LLM review is mandatory and the LiteLLM gateway returns `403 Forbidden` from GitHub Actions, the most common cause is that the gateway blocks GitHub-hosted runner IPs. Use the reusable workflow input `runner-label: self-hosted` with a runner inside the allowed network, or ask the gateway owner to allow GitHub Actions runner egress.

## GitHub Actions

The workflow in `.github/workflows/context-pr-review.yml` runs on pull requests, creates a diff, runs the reviewer, uploads artifacts, and posts or updates a PR comment.

For other repositories, use the reusable workflow from this central repo instead of copying the engine. See `docs/consumer-setup.md`.

Minimal consumer workflow:

```yaml
name: ReviewIQ

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: Sujan-DVSS/ai-context-pr-reviewer/.github/workflows/reusable-review.yml@main
    secrets:
      LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
      JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
      JIRA_BEARER_TOKEN: ${{ secrets.JIRA_BEARER_TOKEN }}
    with:
      story-provider: jira
      jira-base-url: https://your-company.atlassian.net
      fail-on: medium
      llm-provider: litellm
      llm-required: true
```

Include the Jira ticket ID in the branch name, PR title, PR body, or commit messages so ReviewIQ knows which Jira issue to pull.

- Branch: `STRY-123-change-feature-logic`
- PR title: `STRY-123 change feature logic`
- Commit message: `STRY-123 update feature eligibility`

In GitHub Actions, `--repo-root .` lets the reviewer use the entire checked-out repository as context. It indexes a bounded number of text files, skips heavy generated folders such as `.git`, `node_modules`, `dist`, and `build`, and reports the top story-relevant files in the PR comment.

The workflow uploads `review-dashboard.html` as an artifact with AC coverage percentage, severity counts, changed files vs relevant repo files, LiteLLM status, story alignment score, and merge recommendation.

ReviewIQ treats `medium`, `high`, and `critical` findings as must-fix issues that should block merging. `Low` findings may still appear as inline suggestions, but they are optional cleanup and should not make the merge check fail.

Reviewers can intentionally skip ReviewIQ by adding the `reviewiq-ignore` label to the PR or by putting `[reviewiq ignore]` or `[skip reviewiq]` in the PR body. The workflow posts a skipped report, clears previous ReviewIQ inline comments when it has permission, and keeps the merge check green. Reusable workflow consumers can rename the label with `ignore-label`.

To enable LiteLLM in GitHub Actions, add:

- Secret `LITELLM_API_KEY`

The workflow already defaults to the CodeFest LiteLLM gateway and `us.anthropic.claude-opus-4-7`. Optionally add:

- Secret `LITELLM_BASE_URL` to override the gateway
- Variable `LITELLM_API_PATH` to override the chat completion path
- Variable `LITELLM_MODEL` to override the model

The workflow uses `--llm-provider auto`, so app repos can share the same workflow safely. Repos without LiteLLM secrets still get deterministic + repo-context review, while repos with LiteLLM configured get the semantic AI analysis automatically.

To enable Jira in GitHub Actions, add either:

- Secrets `JIRA_EMAIL` and `JIRA_API_TOKEN`
- Or secret `JIRA_BEARER_TOKEN`

And set workflow input `jira-base-url`. Optionally set `jira-ac-field` if ACs are stored in a custom Jira field.

## Future Integrations

- Linear/GitHub Issues story providers.
- More LLM providers and model-specific prompt packs.
- Repository-specific policy packs.
- Inline review comments on exact diff lines.
- Team dashboards for AC coverage and review debt trends.
- Learning loop from merged PRs and escaped defects.
