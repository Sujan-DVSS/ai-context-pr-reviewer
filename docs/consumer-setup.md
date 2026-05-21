# Consumer Repository Setup

Use this when you want another repository to run the central ReviewIQ reviewer without copying the engine.

## 1. Connect Story Context

Option A: use Jira. The reusable workflow can pull the story directly from Jira when a PR references a ticket ID.

Option B: use JSON. Create a story file in the application repository:

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
name: ReviewIQ

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
      JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
    with:
      story-provider: auto
      stories-dir: stories
      jira-base-url: https://your-company.atlassian.net
      fail-on: high
      llm-provider: auto
```

## 3. Configure Jira

For Jira Cloud basic auth, add these repository or organization secrets:

```text
JIRA_EMAIL
JIRA_API_TOKEN
```

For bearer-token setups, add:

```text
JIRA_BEARER_TOKEN
```

If acceptance criteria are stored in a custom Jira field, pass:

```yaml
with:
  jira-ac-field: customfield_12345
```

When `story-provider: auto`, Jira is used if credentials are present. Otherwise, the workflow falls back to `stories/<ticket-id>.json`.

Jira MCP can be used inside Cursor for manual issue lookup, but GitHub Actions uses Jira REST because the MCP server is not present on GitHub-hosted runners by default.

## 4. Configure LiteLLM

Add this repository or organization secret:

```text
LITELLM_API_KEY
```

The reusable workflow defaults to:

```text
LITELLM_BASE_URL=https://llmgw.codefest2026.marriott.com/
LITELLM_API_PATH=/chat/completions
LITELLM_MODEL=us.anthropic.claude-opus-4-7
```

Override them if needed:

```yaml
with:
  litellm-base-url: https://llmgw.codefest2026.marriott.com/
  litellm-api-path: /chat/completions
  litellm-model: us.anthropic.claude-opus-4-7
```

## 5. Test

Open a PR whose branch, title, body, or commit message contains the story ID. The workflow will:

- Generate the PR diff.
- Load Jira issue details when Jira is configured, otherwise load `stories/<ticket-id>.json`.
- Scan the repository for relevant context.
- Run static, security, performance, and traceability checks.
- Run LiteLLM semantic analysis when the key is configured.
- Post or update a PR comment.
- Post inline review comments for findings that map to changed PR lines.
