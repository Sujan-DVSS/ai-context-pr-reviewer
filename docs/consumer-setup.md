# Consumer Repository Setup

Use this when you want another repository to run the central AI Context PR Reviewer without copying the engine.

## 1. Add Story JSON

Create a story file in the application repository:

```text
stories/STRY-123.json
```

The PR can reference the story ID in the branch name, PR title, PR body, or commit message:

```text
STRY-123-change-feature-logic
STRY-123 change feature logic
STRY-123 update eligibility checks
```

## 2. Add Workflow

Create `.github/workflows/ai-context-pr-review.yml` in the application repository:

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
    with:
      stories-dir: stories
      fail-on: high
      llm-provider: auto
```

## 3. Configure LiteLLM

Add this repository or organization secret:

```text
LITELLM_API_KEY
```

The reusable workflow defaults to:

```text
LITELLM_BASE_URL=https://llmgw.codefest2026.marriott.com/
LITELLM_MODEL=us.anthropic.claude-opus-4-7
```

Override them if needed:

```yaml
with:
  litellm-base-url: https://llmgw.codefest2026.marriott.com/
  litellm-model: us.anthropic.claude-opus-4-7
```

## 4. Test

Open a PR whose branch, title, body, or commit message contains the story ID. The workflow will:

- Generate the PR diff.
- Load `stories/<ticket-id>.json`.
- Scan the repository for relevant context.
- Run static, security, performance, and traceability checks.
- Run LiteLLM semantic analysis when the key is configured.
- Post or update a PR comment.
