#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildRepoContext,
  loadStory,
  markLlmFailure,
  mergeLlmReview,
  renderMarkdownReport,
  resolveStoryPath,
  runReview,
  shouldFail,
  writeReports
} from "./core.js";
import { runLiteLlmSemanticReview, shouldRunLlm } from "./llm.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const refs = [
    args.ref,
    process.env.GITHUB_HEAD_REF,
    process.env.GITHUB_REF_NAME,
    process.env.PR_TITLE,
    process.env.PR_BODY,
    process.env.PR_COMMITS
  ];
  const storyPath = resolveStoryPath({
    explicitStoryPath: args.story,
    storiesDir: args["stories-dir"] ?? "stories",
    refs
  });
  const story = loadStory(storyPath);
  const diffText = readDiff(args);
  const repoContext = args["no-repo-context"]
    ? undefined
    : buildRepoContext(story, {
        rootDir: args["repo-root"] ?? ".",
        maxFiles: Number(args["max-context-files"] ?? 500)
      });

  let report = runReview({
    story,
    diffText,
    repoContext,
    metadata: {
      storyPath,
      repoRoot: repoContext?.rootDir,
      source: args.diff ? "diff-file" : "git"
    }
  });

  let llmFailed = false;
  if (shouldRunLlm(args)) {
    try {
      const llmReview = await runLiteLlmSemanticReview({
        story,
        diffText,
        repoContext,
        deterministicReport: report,
        args
      });
      report = mergeLlmReview(report, llmReview);
    } catch (error) {
      llmFailed = true;
      report = markLlmFailure(report, error);
      console.warn(`LiteLLM semantic review failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const markdownPath = args.out ?? "review-report.md";
  const jsonPath = args.json ?? "review-report.json";
  writeReports(report, { markdownPath, jsonPath });

  if (args.stdout) {
    process.stdout.write(renderMarkdownReport(report));
  } else {
    console.log(`Review complete: ${markdownPath}`);
    console.log(`Machine-readable report: ${jsonPath}`);
    console.log(`Gate: ${report.metadata.gate}, max severity: ${report.metadata.maxSeverity}, findings: ${report.findings.length}`);
  }

  if (shouldFail(report, args["fail-on"])) {
    console.error(`Failing because max severity ${report.metadata.maxSeverity} meets --fail-on ${args["fail-on"]}.`);
    process.exitCode = 1;
  }
  if (llmFailed && args["llm-required"]) {
    console.error("Failing because --llm-required was set and LiteLLM semantic review failed.");
    process.exitCode = 1;
  }
}

function readDiff(args) {
  if (args.diff) {
    if (!existsSync(args.diff)) {
      throw new Error(`Diff file not found: ${args.diff}`);
    }
    return readFileSync(args.diff, "utf8");
  }

  const range = args.range ?? process.env.PR_DIFF_RANGE ?? "origin/main...HEAD";
  return execFileSync("git", ["diff", "--unified=80", range], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    if (["help", "stdout", "no-repo-context", "llm-required"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function printHelp() {
  console.log(`AI Context PR Reviewer

Usage:
  node src/index.js --story stories/ABC-123.json --diff pr.diff

Options:
  --story <path>        Story JSON file. If omitted, tries ticket IDs from PR metadata.
  --stories-dir <dir>   Directory containing story JSON files. Default: stories.
  --diff <path>         Unified diff file. If omitted, runs git diff.
  --range <git-range>   Git diff range when --diff is omitted. Default: origin/main...HEAD.
  --repo-root <path>    Repository root to scan for story-relevant context. Default: current directory.
  --max-context-files   Max repo files to index for context. Default: 500.
  --no-repo-context     Disable full-repository context indexing.
  --llm-provider        none, auto, or litellm. Default: none.
  --llm-base-url        LiteLLM gateway base URL. Can also use LITELLM_BASE_URL.
  --llm-api-path        LiteLLM chat completion path. Default: /chat/completions.
  --llm-model           LiteLLM model name. Can also use LITELLM_MODEL.
  --llm-api-key         LiteLLM API key. Prefer LITELLM_API_KEY in CI.
  --llm-timeout-ms      LiteLLM request timeout. Default: 45000.
  --llm-required        Fail the workflow if LiteLLM is configured but the semantic review fails.
  --out <path>          Markdown report path. Default: review-report.md.
  --json <path>         JSON report path. Default: review-report.json.
  --fail-on <severity>  none, low, medium, high, or critical.
  --ref <text>          Extra text used to discover ticket IDs.
  --stdout             Print markdown report to stdout too.
  --help               Show this help.
`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
