import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRepoContext,
  markLlmFailure,
  mergeLlmReview,
  parseUnifiedDiff,
  renderMarkdownReport,
  resolveStoryPath,
  runReview,
  shouldFail
} from "../src/core.js";
import { runLiteLlmSemanticReview, shouldRunLlm } from "../src/llm.js";

const sampleDiff = readFileSync(new URL("./fixtures/sample.diff", import.meta.url), "utf8");
const sampleStory = JSON.parse(readFileSync(new URL("../stories/sample-story.json", import.meta.url), "utf8"));
const fixtureRepo = new URL("./fixtures/repo", import.meta.url).pathname;

test("parseUnifiedDiff returns changed files and added lines", () => {
  const files = parseUnifiedDiff(sampleDiff);

  assert.equal(files.length, 2);
  assert.equal(files[0].newPath, "src/payments/createPayment.js");
  assert.ok(files[0].additions.some((line) => line.content.includes("Idempotency-Key")));
});

test("runReview finds story, security, performance, and test risks", () => {
  const repoContext = buildRepoContext(sampleStory, { rootDir: fixtureRepo });
  const report = runReview({ story: sampleStory, diffText: sampleDiff, repoContext });

  assert.equal(report.metadata.storyId, "PAY-123");
  assert.ok(report.repoContext.relevantFiles.some((file) => file.path === "src/payments/createPayment.js"));
  assert.ok(report.findings.some((finding) => finding.category === "security"));
  assert.ok(report.findings.some((finding) => finding.category === "performance"));
  assert.ok(report.findings.some((finding) => finding.id === "TRACE003"));
  assert.ok(report.findings.some((finding) => finding.id === "TEST001"));
  assert.equal(report.metadata.gate, "fail");
});

test("renderMarkdownReport includes the AC evidence matrix", () => {
  const repoContext = buildRepoContext(sampleStory, { rootDir: fixtureRepo });
  const report = runReview({ story: sampleStory, diffText: sampleDiff, repoContext });
  const markdown = renderMarkdownReport(report);

  assert.match(markdown, /Acceptance Criteria Evidence/);
  assert.match(markdown, /Repo Context/);
  assert.match(markdown, /AC1/);
  assert.match(markdown, /AI Context PR Review/);
});

test("buildRepoContext scores repository files against story terms", () => {
  const repoContext = buildRepoContext(sampleStory, { rootDir: fixtureRepo });

  assert.ok(repoContext.indexedFiles >= 3);
  assert.ok(repoContext.relevantFiles.some((file) => file.path === "src/payments/createPayment.js"));
  assert.ok(repoContext.relevantFiles.some((file) => file.matchedTerms.includes("payment")));
});

test("resolveStoryPath extracts ticket IDs from commit-style refs case-insensitively", () => {
  const root = mkdtempSync(join(tmpdir(), "context-reviewer-"));
  const storiesDir = join(root, "stories");
  mkdirSync(storiesDir);
  writeFileSync(join(storiesDir, "STRY-123.json"), JSON.stringify(sampleStory));

  const storyPath = resolveStoryPath({
    storiesDir,
    refs: ["fix feature logic", "commit: stry-123 update eligibility checks"]
  });

  assert.equal(storyPath, join(storiesDir, "STRY-123.json"));
});

test("shouldFail respects configured threshold", () => {
  const report = runReview({ story: sampleStory, diffText: sampleDiff });

  assert.equal(shouldFail(report, "critical"), true);
  assert.equal(shouldFail(report, "none"), false);
});

test("mergeLlmReview adds semantic findings and updates report metadata", () => {
  const report = runReview({ story: sampleStory, diffText: sampleDiff });
  const merged = mergeLlmReview(report, {
    metadata: {
      provider: "litellm",
      model: "demo-model"
    },
    summary: "Semantic review found missing edge cases.",
    riskLevel: "high",
    acceptanceCriteria: [],
    findings: [
      {
        id: "LLM001",
        category: "semantic",
        severity: "high",
        title: "Missing retry race-condition handling",
        details: "The implementation does not show concurrent duplicate request behavior.",
        recommendation: "Add an atomic insert or unique-key test."
      }
    ],
    suggestedTests: ["Concurrent duplicate checkout requests"],
    reviewerQuestions: ["What happens when duplicate requests arrive concurrently?"]
  });

  assert.equal(merged.metadata.llmProvider, "litellm");
  assert.equal(merged.metadata.llmModel, "demo-model");
  assert.ok(merged.findings.some((finding) => finding.id === "LLM001"));
  assert.ok(merged.reviewerQuestions.includes("What happens when duplicate requests arrive concurrently?"));
});

test("markLlmFailure records LiteLLM errors without dropping deterministic findings", () => {
  const report = runReview({ story: sampleStory, diffText: sampleDiff });
  const failed = markLlmFailure(report, new Error("gateway timeout"));

  assert.equal(failed.metadata.llmStatus, "failed");
  assert.match(failed.metadata.llmError, /gateway timeout/);
  assert.equal(failed.findings.length, report.findings.length);
  assert.match(renderMarkdownReport(failed), /LiteLLM Semantic Review/);
});

test("shouldRunLlm supports auto mode only when LiteLLM config is present", () => {
  assert.equal(shouldRunLlm({ "llm-provider": "none" }, {}), false);
  assert.equal(shouldRunLlm({ "llm-provider": "auto" }, {}), false);
  assert.equal(shouldRunLlm(
    { "llm-provider": "auto" },
    {
      LITELLM_API_KEY: "test"
    }
  ), true);
});

test("runLiteLlmSemanticReview accepts array-shaped Anthropic content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  summary: "Looks aligned with one missing test.",
                  riskLevel: "medium",
                  acceptanceCriteria: [],
                  findings: [],
                  suggestedTests: ["Add discount cap test"],
                  reviewerQuestions: []
                })
              }
            ]
          }
        }
      ]
    })
  });

  try {
    const deterministicReport = runReview({ story: sampleStory, diffText: sampleDiff });
    const review = await runLiteLlmSemanticReview({
      story: sampleStory,
      diffText: sampleDiff,
      deterministicReport,
      args: {
        "llm-api-key": "test"
      }
    });

    assert.equal(review.summary, "Looks aligned with one missing test.");
    assert.deepEqual(review.suggestedTests, ["Add discount cap test"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
