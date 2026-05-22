# Consumer Repository Setup

Use this when you want another repository to run the central ReviewIQ reviewer without copying the engine.

## 1. Connect Story Context

ReviewIQ is Jira-only for story context. The reusable workflow pulls the story directly from Jira when a PR references a ticket ID.

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
      REVIEWIQ_APP_ID: ${{ secrets.REVIEWIQ_APP_ID }}
      REVIEWIQ_APP_PRIVATE_KEY: ${{ secrets.REVIEWIQ_APP_PRIVATE_KEY }}
    with:
      story-provider: jira
      jira-base-url: https://your-company.atlassian.net
      fail-on: medium
      llm-provider: litellm
      llm-required: true
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

Jira configuration is required. If ReviewIQ cannot find the ticket ID or cannot load the Jira issue, the workflow fails instead of falling back to local JSON.

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

If the LiteLLM gateway blocks GitHub-hosted runner IPs, use a self-hosted runner inside the allowed network:

```yaml
with:
  runner-label: self-hosted
  llm-provider: litellm
  llm-required: true
```

## 5. Optional ReviewIQ Bot Identity

To make PR comments appear from `ReviewIQ[bot]` with the GitHub App logo instead of `github-actions[bot]`, create and install the ReviewIQ GitHub App, generate a private key, and add these repository or organization secrets:

```text
REVIEWIQ_APP_ID
REVIEWIQ_APP_PRIVATE_KEY
```

Pass those secrets to the reusable workflow as shown above. If the app secrets are missing or the app token cannot be created, ReviewIQ falls back to the default GitHub Actions token so the review still runs.

## 6. Optional Reviewer Bypass

If a human reviewer decides the AI review should not block the PR, add the `reviewiq-ignore` label to the PR or put `[reviewiq ignore]` / `[skip reviewiq]` in the PR body.

The workflow will skip ReviewIQ, post a skipped report, clear previous ReviewIQ inline comments when the GitHub token has permission, and keep the check green. To use a different label name:

```yaml
with:
  ignore-label: ai-review-ignored
```

## 7. Test

Open a PR whose branch, title, body, or commit message contains the story ID. The workflow will:

- Generate the PR diff.
- Load Jira issue details.
- Scan the repository for relevant context.
- Run static, security, performance, and traceability checks.
- Run LiteLLM semantic analysis when the key is configured.
- Post or update a PR comment.
- Post plain-English inline review comments for findings that map to changed PR lines.
- Include GitHub suggestion blocks for safe single-line fixes.
- Upload `review-dashboard.html` with AC coverage, severity count, changed-vs-relevant files, LLM result, story alignment score, and merge recommendation.
- Flag cross-story conflicts when changed code references a different Jira ID or an out-of-scope story area.
- Fail the merge check for `medium`, `high`, and `critical` findings. `Low` findings can appear as optional inline suggestions without blocking the PR.
- Skip the AI review when a reviewer uses the configured ignore label or skip marker.
