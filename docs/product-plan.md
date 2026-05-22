# Product Plan

## Problem

Pull request reviews are overloaded. Existing tools catch lint, vulnerabilities, and style issues, but they rarely answer the higher-value question: "Does this PR satisfy the story we agreed to build?"

That gap creates hidden costs:

- Clean code can miss acceptance criteria.
- Reviewers manually jump between Jira, PRs, tests, and docs.
- Story drift is found late in QA or after release.
- Security and performance expectations in user stories are not consistently checked.
- Large PRs hide unrelated changes and scope creep.

## MVP Goal

Build a PR-triggered reviewer that combines code-diff review with story-aware validation.

Today:

- PR diff comes from `git diff`.
- Story context comes from Jira.
- Review is deterministic and explainable.
- Output is Markdown for PR comments and JSON for automation.

Later:

- Story context can also come from Linear, GitHub Issues, Confluence, or any internal tool.
- The deterministic engine can be paired with an LLM agent for deeper semantic review.

## Workflow

1. Pull request is opened, synchronized, or reopened.
2. GitHub Actions checks out the branch.
3. Workflow finds the Jira ticket ID from branch, PR title, PR body, or commit messages.
4. Workflow generates a unified diff.
5. Reviewer builds bounded repository context by scanning text files and ranking modules against story and AC terms.
6. Reviewer runs a set of specialized review agents:
   - Story alignment agent
   - Acceptance criteria agent
   - Repository context agent
   - Cross-story conflict agent
   - Static quality agent
   - Security agent
   - Performance agent
   - Test coverage expectation agent
7. Reviewer produces:
   - Review summary
   - Risk level
   - Findings by category
   - AC evidence matrix
   - Story alignment score
   - HTML reviewer dashboard
   - Top story-relevant repository files
   - Suggested reviewer questions
8. Workflow posts or updates a PR comment.
9. Optional quality gate fails the check on high or critical findings.

## What Makes It Different

The unique wedge is "requirement traceability at PR time." Instead of only saying code has a smell, it explains whether the code appears to satisfy the story and where evidence exists in the diff.

Examples:

- "AC2 requires duplicate retry behavior, but no test or implementation evidence mentions retry/idempotency."
- "The story is scoped to checkout, but this PR changes refund logic."
- "The repo already has checkout/payment modules that strongly match this story, but this PR only changes a shared helper."
- "Security expectation says no card data should be logged; this diff adds `console.log(paymentPayload)`."
- "Performance expectation allows one DB lookup; this diff adds a lookup inside a loop."

## Hackathon Demo Script

1. Show a Jira story with description, ACs, risks, constraints, and expected tests.
2. Show a sample PR diff with a few intentional issues.
3. Run ReviewIQ against a PR that references the Jira ticket.
4. Open `review-report.md`.
5. Point out:
   - Findings across static/security/performance.
   - AC coverage matrix.
   - Repo context section showing story-relevant files from unchanged code.
   - Scope drift detection.
   - Machine-readable JSON output.
   - GitHub Actions workflow.

## Additional Use Cases

- Product owner review assistant: summarizes what ACs appear implemented before PO review.
- QA test planning: generates risk-based test questions from uncovered ACs.
- Release risk gate: blocks PRs that modify critical flows without linked story evidence.
- Security review router: escalates auth, payment, PII, or secrets-related PRs.
- Architecture governance: flags changes outside allowed bounded contexts.
- Compliance evidence: stores AC-to-code traceability for audits.
- Onboarding: helps new reviewers understand why a PR exists and where to inspect.
- Change impact: highlights unrelated modules touched by a narrowly scoped story.
- Retrospective analytics: measures escaped defects against missing AC review signals.

## Success Criteria

- Runs locally with one command.
- Runs in GitHub Actions on pull requests.
- Does not require paid APIs for the MVP.
- Produces a useful review on a sample diff.
- Cleanly separates story loading, diff parsing, review agents, and report generation.
