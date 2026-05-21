# AI Context PR Reviewer

Hackathon MVP for an AI context-aware code peer review bot. It runs when a pull request is opened or updated, reads the PR diff, scans the repository for story-relevant implementation context, reads the related user story from JSON, and produces a review that connects implementation evidence back to the story description and acceptance criteria.

The MVP is intentionally dependency-light and can run without API keys. JSON is the story provider today; Jira, Linear, GitHub Issues, or Confluence can be added later by implementing the same story contract. If a LiteLLM gateway is configured, the reviewer also runs an LLM semantic pass.

## What It Reviews

- Static quality: debug leftovers, TODOs, overly long changed lines, empty catch blocks, risky broad changes.
- Security: secrets in code, unsafe HTML injection, `eval`, SQL concatenation, auth-sensitive code without tests.
- Performance: `await` inside loops, nested-loop risk, `SELECT *`, synchronous filesystem usage in request paths.
- Product context: whether changed files and added code line up with the story description, acceptance criteria, constraints, out-of-scope notes, and expected tests.
- Traceability: an acceptance-criteria evidence matrix showing which ACs appear supported by the diff and which need reviewer attention.
- Repo context: scans unchanged repository files to identify the modules most likely related to the story, then checks whether the PR touched the expected implementation areas.
- LLM semantic review: optional LiteLLM pass for AC fit, missing edge cases, reviewer questions, and suggested tests.

## Differentiator

Most review bots focus on generic code smells. This MVP also reviews requirement drift:

- Does the code actually implement the user story?
- Which acceptance criteria have evidence in the PR?
- Does the PR touch the repo files that already contain the domain logic implied by the story?
- Which changed files look unrelated to the story?
- Did the PR skip required tests, migration notes, security expectations, or performance expectations?
- Is the blast radius bigger than the story scope?

That is the under-addressed pain point: teams often discover late that code is clean but solves the wrong problem, misses an acceptance criterion, or quietly changes behavior outside the story.

## Quick Start

```bash
npm run sample
```

This writes:

- `review-report.md` for a PR comment.
- `review-report.json` for automation and dashboards.

Run against a real PR diff:

```bash
git diff --unified=80 origin/main...HEAD > pr.diff
node src/index.js --story stories/sample-story.json --diff pr.diff --repo-root . --out review-report.md --json review-report.json --fail-on high
```

Disable repository scanning if you only want a diff-level review:

```bash
node src/index.js --story stories/sample-story.json --diff pr.diff --no-repo-context
```

## LiteLLM Integration

LiteLLM is supported through its OpenAI-compatible `/v1/chat/completions` API. The deterministic checks still run first; LiteLLM receives only the story JSON, compact PR diff, deterministic findings, and top retrieved repo-context snippets.

```bash
export LITELLM_API_KEY="..."

node src/index.js \
  --story stories/sample-story.json \
  --diff pr.diff \
  --repo-root . \
  --llm-provider litellm
```

This MVP defaults to:

- `LITELLM_BASE_URL=https://llmgw.codefest2026.marriott.com/`
- `LITELLM_MODEL=us.anthropic.claude-opus-4-7`

You only need to provide `LITELLM_API_KEY`. Override the gateway or model with `--llm-base-url`, `--llm-model`, `LITELLM_BASE_URL`, or `LITELLM_MODEL` if needed.

Use `--llm-provider auto` in CI to run the LLM only when `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_MODEL` are present. Without those values, the reviewer falls back to deterministic + repo-context review.

If the gateway is configured but temporarily fails, the GitHub Action still writes the deterministic report and marks the LiteLLM section as failed. Add `--llm-required` if you want the workflow to fail when the LLM semantic pass cannot complete.

## Story JSON Contract

```json
{
  "id": "PAY-123",
  "title": "Add idempotency for payment retries",
  "description": "Customers should not be double charged when checkout retry requests are sent.",
  "acceptanceCriteria": [
    {
      "id": "AC1",
      "text": "Requests with the same Idempotency-Key return the original payment result.",
      "keywords": ["idempotency", "Idempotency-Key", "original payment result"],
      "mustTouch": ["src/payments/**"],
      "risk": "critical"
    }
  ],
  "technicalConstraints": ["Do not store raw card data."],
  "securityExpectations": ["No secrets or card data should be logged."],
  "performanceExpectations": ["Idempotency lookup should not add more than one database query."],
  "testExpectations": ["Add retry tests for duplicate payment requests."],
  "outOfScope": ["Refund flow"]
}
```

## GitHub Actions

The workflow in `.github/workflows/context-pr-review.yml` runs on pull requests, creates a diff, runs the reviewer, uploads artifacts, and posts or updates a PR comment.

For other repositories, use the reusable workflow from this central repo instead of copying the engine. See `docs/consumer-setup.md`.

Minimal consumer workflow:

```yaml
name: AI Context PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: Sujan-DVSS/ai-context-pr-reviewer/.github/workflows/reusable-review.yml@main
    secrets:
      LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
```

For the hackathon, keep a story file in `stories/<ticket-id>.json` and include the ticket ID in the branch name, PR title, PR body, or commit messages. If there is no exact match, the sample story is used as a fallback so the workflow still demonstrates end-to-end behavior.

Examples that resolve to `stories/STRY-123.json`:

- Branch: `STRY-123-change-feature-logic`
- PR title: `STRY-123 change feature logic`
- Commit message: `STRY-123 update feature eligibility`

In GitHub Actions, `--repo-root .` lets the reviewer use the entire checked-out repository as context. It indexes a bounded number of text files, skips heavy generated folders such as `.git`, `node_modules`, `dist`, and `build`, and reports the top story-relevant files in the PR comment.

To enable LiteLLM in GitHub Actions, add:

- Secret `LITELLM_API_KEY`

The workflow already defaults to the CodeFest LiteLLM gateway and `us.anthropic.claude-opus-4-7`. Optionally add:

- Secret `LITELLM_BASE_URL` to override the gateway
- Variable `LITELLM_MODEL` to override the model

The workflow uses `--llm-provider auto`, so app repos can share the same workflow safely. Repos without LiteLLM secrets still get deterministic + repo-context review, while repos with LiteLLM configured get the semantic AI analysis automatically.

## Future Integrations

- Jira/Linear/GitHub Issues story provider.
- More LLM providers and model-specific prompt packs.
- Repository-specific policy packs.
- Inline review comments on exact diff lines.
- Team dashboards for AC coverage and review debt trends.
- Learning loop from merged PRs and escaped defects.
