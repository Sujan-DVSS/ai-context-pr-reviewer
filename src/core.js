import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const SEVERITY_ORDER = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "should",
  "shall",
  "when",
  "then",
  "must",
  "user",
  "story",
  "able",
  "will",
  "have",
  "has",
  "are",
  "not",
  "more",
  "than",
  "into",
  "using",
  "return",
  "returns"
]);

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "bin",
  "obj"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml"
]);

export function parseUnifiedDiff(diffText) {
  const files = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;
  let currentHunk = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  const pushFile = () => {
    if (currentFile) {
      files.push(currentFile);
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = {
        oldPath: match?.[1] ?? "unknown",
        newPath: match?.[2] ?? "unknown",
        status: "modified",
        hunks: [],
        additions: [],
        deletions: []
      };
      currentHunk = null;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("new file mode")) {
      currentFile.status = "added";
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      currentFile.status = "deleted";
      continue;
    }

    if (line.startsWith("rename from ")) {
      currentFile.oldPath = line.slice("rename from ".length);
      currentFile.status = "renamed";
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentFile.newPath = line.slice("rename to ".length);
      currentFile.status = "renamed";
      continue;
    }

    if (line.startsWith("--- ")) {
      currentFile.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentFile.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[2]);
      currentHunk = {
        header: line,
        lines: []
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      const addition = {
        type: "add",
        file: currentFile.newPath,
        lineNumber: newLineNumber,
        content: line.slice(1)
      };
      currentFile.additions.push(addition);
      currentHunk.lines.push(addition);
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith("-")) {
      const deletion = {
        type: "delete",
        file: currentFile.oldPath,
        lineNumber: oldLineNumber,
        content: line.slice(1)
      };
      currentFile.deletions.push(deletion);
      currentHunk.lines.push(deletion);
      oldLineNumber += 1;
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    currentHunk.lines.push({
      type: "context",
      file: currentFile.newPath,
      lineNumber: newLineNumber,
      content: line.startsWith(" ") ? line.slice(1) : line
    });
    oldLineNumber += 1;
    newLineNumber += 1;
  }

  pushFile();
  return files.filter((file) => file.newPath !== "/dev/null" || file.oldPath !== "/dev/null");
}

function normalizeDiffPath(path) {
  if (path === "/dev/null") {
    return path;
  }
  return path.replace(/^[ab]\//, "");
}

export function loadStory(storyPath) {
  const raw = readFileSync(storyPath, "utf8");
  const story = JSON.parse(raw);
  validateStory(story, storyPath);
  return story;
}

export function validateStory(story, source = "story JSON") {
  if (!story || typeof story !== "object") {
    throw new Error(`${source} must contain a JSON object.`);
  }
  for (const key of ["id", "title", "description"]) {
    if (!story[key] || typeof story[key] !== "string") {
      throw new Error(`${source} is missing required string field "${key}".`);
    }
  }
  if (!Array.isArray(story.acceptanceCriteria) || story.acceptanceCriteria.length === 0) {
    throw new Error(`${source} must include at least one acceptance criterion.`);
  }
}

export function resolveStoryPath({ explicitStoryPath, storiesDir = "stories", refs = [] }) {
  if (explicitStoryPath) {
    return explicitStoryPath;
  }

  const ticketIds = extractTicketIds(refs);
  for (const ticketId of ticketIds) {
    const candidates = [
      join(storiesDir, `${ticketId}.json`),
      join(storiesDir, `${ticketId.toLowerCase()}.json`)
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) {
      return match;
    }
  }

  const fallback = join(storiesDir, "sample-story.json");
  if (existsSync(fallback)) {
    return fallback;
  }

  const firstStory = existsSync(storiesDir)
    ? readdirSync(storiesDir).find((entry) => entry.endsWith(".json"))
    : undefined;
  if (firstStory) {
    return join(storiesDir, firstStory);
  }

  throw new Error("No story JSON found. Pass --story or add stories/sample-story.json.");
}

export function extractTicketIds(refs = []) {
  const haystack = refs.filter(Boolean).join(" ");
  return [...new Set((haystack.match(/[A-Z][A-Z0-9]+-\d+/gi) ?? []).map((ticketId) => ticketId.toUpperCase()))];
}

export function buildRepoContext(story, {
  rootDir = ".",
  maxFiles = 500,
  maxFileBytes = 220_000,
  maxRelevantFiles = 12
} = {}) {
  validateStory(story);
  const storyTerms = getStoryTerms(story);
  const files = listRepoFiles(rootDir, { maxFiles });
  const relevantFiles = [];
  let indexedFiles = 0;
  let skippedFiles = 0;

  for (const absolutePath of files) {
    const path = toPosix(relative(rootDir, absolutePath));
    if (!path || shouldIgnoreFile(path)) {
      skippedFiles += 1;
      continue;
    }

    const stats = statSync(absolutePath);
    if (stats.size > maxFileBytes || !isLikelyTextFile(path)) {
      skippedFiles += 1;
      continue;
    }

    const content = readFileSync(absolutePath, "utf8");
    indexedFiles += 1;

    const scored = scoreRepoFile(path, content, storyTerms);
    if (scored.score > 0) {
      relevantFiles.push(scored);
    }
  }

  relevantFiles.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    rootDir,
    indexedFiles,
    skippedFiles,
    storyTerms,
    relevantFiles: relevantFiles.slice(0, maxRelevantFiles)
  };
}

export function runReview({ story, diffText, repoContext, metadata = {} }) {
  validateStory(story);
  const files = parseUnifiedDiff(diffText);
  const additions = files.flatMap((file) => file.additions);
  const deletions = files.flatMap((file) => file.deletions);
  const findings = [];
  const acceptance = evaluateAcceptanceCriteria(story, files, additions, findings, repoContext);

  reviewTraceability(story, files, additions, acceptance, findings, repoContext);
  reviewStaticQuality(files, additions, findings);
  reviewSecurity(story, files, additions, findings);
  reviewPerformance(files, additions, findings);
  reviewTestExpectations(story, files, findings);

  const findingCounts = countFindings(findings);
  const maxSeverity = getMaxSeverity(findings);
  const gate = maxSeverity === "critical" || maxSeverity === "high" ? "fail" : findings.length ? "warn" : "pass";

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      storyId: story.id,
      storyTitle: story.title,
      changedFiles: files.length,
      additions: additions.length,
      deletions: deletions.length,
      maxSeverity,
      gate,
      ...metadata
    },
    repoContext: repoContext
      ? {
          rootDir: repoContext.rootDir,
          indexedFiles: repoContext.indexedFiles,
          skippedFiles: repoContext.skippedFiles,
          relevantFiles: repoContext.relevantFiles.slice(0, 8)
        }
      : undefined,
    story,
    files: files.map((file) => ({
      path: displayPath(file),
      status: file.status,
      additions: file.additions.length,
      deletions: file.deletions.length
    })),
    acceptanceCriteria: acceptance,
    findings,
    findingCounts,
    reviewerQuestions: buildReviewerQuestions(story, acceptance, findings)
  };
}

function evaluateAcceptanceCriteria(story, files, additions, findings, repoContext) {
  return story.acceptanceCriteria.map((criterion) => {
    const keywords = normalizeKeywords([
      ...(criterion.keywords ?? []),
      ...tokenize(criterion.text).slice(0, 8)
    ]);
    const mustTouch = criterion.mustTouch ?? [];
    const repoEvidence = getRepoEvidenceForTerms(repoContext, keywords);
    const pathEvidence = mustTouch.flatMap((pattern) =>
      files
        .filter((file) => matchesPattern(displayPath(file), pattern))
        .map((file) => ({ file: displayPath(file), pattern }))
    );
    const lineEvidence = additions
      .filter((line) => keywords.some((keyword) => containsLoose(line.content, keyword)))
      .slice(0, 6)
      .map((line) => ({
        file: line.file,
        line: line.lineNumber,
        text: line.content.trim()
      }));

    const hasKeywordEvidence = lineEvidence.length > 0;
    const hasRequiredPathEvidence = mustTouch.length === 0 || pathEvidence.length > 0;
    const changedRelevantRepoFile = repoEvidence.some((evidence) =>
      files.some((file) => displayPath(file) === evidence.file)
    );
    const status = hasKeywordEvidence && hasRequiredPathEvidence
      ? "covered"
      : changedRelevantRepoFile && hasRequiredPathEvidence
        ? "needs-review"
      : hasKeywordEvidence || hasRequiredPathEvidence
        ? "needs-review"
        : "missing-evidence";

    if (status !== "covered") {
      findings.push({
        id: "TRACE004",
        category: "traceability",
        severity: criterion.risk === "critical" ? "high" : "medium",
        title: `Acceptance criterion ${criterion.id ?? ""} needs evidence`.trim(),
        details: criterion.text,
        recommendation: "Add implementation or tests that clearly demonstrate this AC, or update the story if the scope changed."
      });
    }

    return {
      id: criterion.id ?? "AC",
      text: criterion.text,
      risk: criterion.risk ?? "normal",
      status,
      evidence: {
        paths: pathEvidence.slice(0, 5),
        lines: lineEvidence,
        repo: repoEvidence.slice(0, 4)
      }
    };
  });
}

function reviewTraceability(story, files, additions, acceptance, findings, repoContext) {
  const storyText = [
    story.title,
    story.description,
    ...(story.acceptanceCriteria ?? []).map((criterion) => criterion.text),
    ...(story.technicalConstraints ?? []),
    ...(story.securityExpectations ?? []),
    ...(story.performanceExpectations ?? [])
  ].join(" ");
  const storyTokens = new Set(tokenize(storyText));
  const changedText = [
    ...files.map((file) => displayPath(file)),
    ...additions.map((line) => line.content)
  ].join(" ");
  const changedTokens = new Set(tokenize(changedText));
  const overlap = [...storyTokens].filter((token) => changedTokens.has(token));
  const denominator = Math.min(storyTokens.size, 40) || 1;
  const ratio = overlap.length / denominator;

  if (files.length > 0 && overlap.length < 2) {
    findings.push({
      id: "TRACE001",
      category: "traceability",
      severity: "high",
      title: "PR diff has weak story alignment",
      details: "The changed paths and added lines have very little vocabulary overlap with the story description or acceptance criteria.",
      recommendation: "Confirm the PR is linked to the right story, or add clearer code/tests that reflect the story language."
    });
  } else if (files.length > 0 && ratio < 0.12) {
    findings.push({
      id: "TRACE001",
      category: "traceability",
      severity: "medium",
      title: "PR diff may be drifting from story context",
      details: `Only ${overlap.length} important story terms were found in the changed code or paths.`,
      recommendation: "Review whether the implementation is too indirect, too broad, or missing story-specific tests."
    });
  }

  const inScopePaths = story.inScopePaths ?? unique((story.acceptanceCriteria ?? []).flatMap((criterion) => criterion.mustTouch ?? []));
  if (inScopePaths.length > 0) {
    const driftedFiles = files
      .map(displayPath)
      .filter((path) => !inScopePaths.some((pattern) => matchesPattern(path, pattern)) && !isTestFile(path));

    if (driftedFiles.length > 0) {
      findings.push({
        id: "TRACE002",
        category: "traceability",
        severity: driftedFiles.length > 3 ? "high" : "medium",
        title: "Changed files fall outside the story scope",
        details: `Unexpected files: ${driftedFiles.slice(0, 8).join(", ")}`,
        recommendation: "Split unrelated changes into another PR, or add story context explaining why these files are required."
      });
    }
  }

  for (const outOfScope of story.outOfScope ?? []) {
    const touched = additions.some((line) => containsLoose(line.content, outOfScope))
      || files.some((file) => containsLoose(displayPath(file), outOfScope));
    if (touched) {
      findings.push({
        id: "TRACE003",
        category: "traceability",
        severity: "high",
        title: `PR touches out-of-scope area: ${outOfScope}`,
        details: "The story explicitly marks this area as out of scope.",
        recommendation: "Remove the change from this PR or update the story with product approval."
      });
    }
  }

  if (acceptance.some((criterion) => criterion.status !== "covered")) {
    findings.push({
      id: "TRACE005",
      category: "traceability",
      severity: "medium",
      title: "Acceptance criteria coverage is incomplete",
      details: "One or more ACs do not have clear evidence in changed files or added lines.",
      recommendation: "Use the AC evidence matrix to focus reviewer attention before approval."
    });
  }

  if (repoContext?.relevantFiles?.length > 0) {
    const changedPaths = new Set(files.map(displayPath));
    const highContextFiles = repoContext.relevantFiles.slice(0, 5);
    const touchedContextFiles = highContextFiles.filter((file) => changedPaths.has(file.path));
    const hasOnlyTests = files.length > 0 && files.every((file) => isTestFile(displayPath(file)));

    if (touchedContextFiles.length === 0 && !hasOnlyTests) {
      findings.push({
        id: "TRACE006",
        category: "traceability",
        severity: "medium",
        title: "PR does not touch the repo files most relevant to the story",
        details: `Most relevant repo files: ${highContextFiles.map((file) => file.path).join(", ")}`,
        recommendation: "Confirm this PR is changing the correct implementation area, or update story keywords/scope if the relevant files are elsewhere."
      });
    }
  }
}

function reviewStaticQuality(files, additions, findings) {
  if (files.length > 20) {
    findings.push({
      id: "STATIC000",
      category: "static",
      severity: "medium",
      title: "Large PR blast radius",
      details: `This PR changes ${files.length} files.`,
      recommendation: "Consider splitting the change, or provide a stronger review plan in the PR description."
    });
  }

  for (const line of additions) {
    const text = line.content;
    if (/\b(debugger|console\.log|printStackTrace)\b/.test(text)) {
      addLineFinding(findings, "STATIC001", "static", "medium", "Debug or console statement added", line, "Remove debug output or replace it with structured, safe logging.");
    }
    if (/\b(TODO|FIXME|HACK)\b/i.test(text)) {
      addLineFinding(findings, "STATIC002", "static", "low", "Unresolved marker added", line, "Resolve the marker before merge or link it to a tracked follow-up.");
    }
    if (text.length > 160) {
      addLineFinding(findings, "STATIC003", "static", "low", "Very long changed line", line, "Split the line for readability and simpler review.");
    }
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text) || /catch\s*\([^)]*\)\s*\{\s*return\s*;?\s*\}/.test(text)) {
      addLineFinding(findings, "STATIC004", "static", "high", "Exception is swallowed", line, "Handle the error, rethrow it, or explain why it is safe to ignore.");
    }
  }
}

function reviewSecurity(story, files, additions, findings) {
  const sensitivePaths = files.filter((file) => /auth|login|permission|payment|secret|token|credential|pii|user/i.test(displayPath(file)));
  const changedTests = files.some((file) => isTestFile(displayPath(file)));

  for (const line of additions) {
    const text = line.content;
    if (/(api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i.test(text) || /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      addLineFinding(findings, "SEC001", "security", "critical", "Possible secret committed", line, "Remove the secret, rotate it, and load it from a secret manager.");
    }
    if (/\beval\s*\(|new Function\s*\(/.test(text)) {
      addLineFinding(findings, "SEC002", "security", "critical", "Dynamic code execution added", line, "Avoid dynamic execution or strictly sandbox trusted input.");
    }
    if (/\b(innerHTML|dangerouslySetInnerHTML)\b/.test(text)) {
      addLineFinding(findings, "SEC003", "security", "high", "Unsafe HTML injection surface added", line, "Use safe rendering APIs or sanitize trusted HTML explicitly.");
    }
    if (/(SELECT|UPDATE|INSERT|DELETE).*(\+|\$\{)/i.test(text)) {
      addLineFinding(findings, "SEC004", "security", "high", "Possible SQL injection pattern", line, "Use parameterized queries instead of string concatenation.");
    }
    if (/console\.(log|info|warn|error)\(.*(card|password|token|secret|payload|authorization)/i.test(text)) {
      addLineFinding(findings, "SEC005", "security", "high", "Sensitive data may be logged", line, "Do not log secrets, card data, tokens, or raw request payloads.");
    }
  }

  if (sensitivePaths.length > 0 && !changedTests) {
    findings.push({
      id: "SEC006",
      category: "security",
      severity: "medium",
      title: "Sensitive area changed without tests",
      details: `Sensitive paths changed: ${sensitivePaths.map(displayPath).slice(0, 6).join(", ")}`,
      recommendation: "Add tests for authorization, access control, idempotency, or failure handling as appropriate."
    });
  }

  for (const expectation of story.securityExpectations ?? []) {
    if (/log|secret|token|card|pii/i.test(expectation)) {
      const riskyLine = additions.find((line) => /console\.|logger\.|log\(/i.test(line.content));
      if (riskyLine) {
        addLineFinding(findings, "SEC007", "security", "medium", "Security expectation needs manual verification", riskyLine, `Story expectation: ${expectation}`);
      }
    }
  }
}

function reviewPerformance(files, additions, findings) {
  const byFile = groupBy(additions, (line) => line.file);

  for (const line of additions) {
    const text = line.content;
    if (/SELECT\s+\*/i.test(text)) {
      addLineFinding(findings, "PERF003", "performance", "medium", "Broad database query added", line, "Select only the columns needed by this flow.");
    }
    if (/\b(readFileSync|writeFileSync|readdirSync|execSync)\s*\(/.test(text)) {
      addLineFinding(findings, "PERF004", "performance", "medium", "Synchronous operation added", line, "Avoid blocking operations in request or hot paths.");
    }
  }

  for (const fileLines of byFile.values()) {
    const loopLines = fileLines.filter((line) => /\b(for|while)\s*\(|\.forEach\s*\(/.test(line.content));
    for (const loopLine of loopLines) {
      const nearby = fileLines.filter((line) => line.lineNumber >= loopLine.lineNumber && line.lineNumber <= loopLine.lineNumber + 8);
      const awaitLine = nearby.find((line) => /\bawait\b/.test(line.content));
      if (awaitLine) {
        addLineFinding(findings, "PERF001", "performance", "high", "Await inside loop risk", awaitLine, "Batch the work, use Promise.all with limits, or document why sequential execution is required.");
      }
      const nestedLoop = nearby.find((line) => line.lineNumber !== loopLine.lineNumber && /\b(for|while)\s*\(|\.forEach\s*\(/.test(line.content));
      if (nestedLoop) {
        addLineFinding(findings, "PERF002", "performance", "medium", "Nested loop added", nestedLoop, "Check input sizes and consider indexing or a map-based lookup.");
      }
    }
  }
}

function reviewTestExpectations(story, files, findings) {
  const expectsTests = (story.testExpectations ?? []).length > 0
    || story.acceptanceCriteria.some((criterion) =>
      /test|unit test|integration test|automated test|coverage/i.test(criterion.text)
      || (criterion.mustTouch ?? []).some((pattern) => /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(pattern))
    );
  const hasTestChange = files.some((file) => isTestFile(displayPath(file)));

  if (expectsTests && !hasTestChange) {
    findings.push({
      id: "TEST001",
      category: "tests",
      severity: "medium",
      title: "Story expects tests but no test file changed",
      details: (story.testExpectations ?? []).join(" ") || "Acceptance criteria explicitly mention tests.",
      recommendation: "Add focused tests or explain in the PR why existing coverage is sufficient."
    });
  }
}

export function renderMarkdownReport(report) {
  const counts = report.findingCounts;
  const countSummary = ["critical", "high", "medium", "low"]
    .map((severity) => `${severity}: ${counts[severity] ?? 0}`)
    .join(", ");

  const lines = [
    "# ReviewIQ",
    "",
    `**Gate:** ${report.metadata.gate.toUpperCase()} | **Max severity:** ${report.metadata.maxSeverity ?? "none"} | **Findings:** ${report.findings.length}`,
    "",
    `**Story:** ${report.metadata.storyId} - ${report.metadata.storyTitle}`,
    "",
    `**Diff size:** ${report.metadata.changedFiles} files, +${report.metadata.additions}/-${report.metadata.deletions}`,
    "",
    ...(report.repoContext
      ? [
          `**Repo context:** indexed ${report.repoContext.indexedFiles} files, top matches: ${report.repoContext.relevantFiles.slice(0, 3).map((file) => file.path).join(", ") || "none"}`,
          ""
        ]
      : []),
    `**Finding counts:** ${countSummary}`,
    "",
    "## Acceptance Criteria Evidence",
    "",
    "| AC | Risk | Status | Evidence |",
    "| --- | --- | --- | --- |",
    ...report.acceptanceCriteria.map((criterion) => {
      const evidence = [
        ...criterion.evidence.paths.map((pathEvidence) => `path ${pathEvidence.file}`),
        ...criterion.evidence.lines.map((line) => `${line.file}:${line.line}`),
        ...criterion.evidence.repo.map((repoEvidence) => `repo ${repoEvidence.file}`)
      ].slice(0, 4).join("<br>") || "No clear diff evidence";
      return `| ${escapeTable(criterion.id)} | ${escapeTable(criterion.risk)} | ${escapeTable(criterion.status)} | ${escapeTable(evidence)} |`;
    }),
    "",
    ...(report.repoContext
      ? [
          "## Repo Context",
          "",
          "| File | Score | Matched Terms |",
          "| --- | ---: | --- |",
          ...report.repoContext.relevantFiles.map((file) =>
            `| ${escapeTable(file.path)} | ${file.score} | ${escapeTable(file.matchedTerms.slice(0, 8).join(", "))} |`
          ),
          ""
        ]
      : []),
    ...(report.llmReview
      ? [
          "## LiteLLM Semantic Review",
          "",
          "**Status:** completed",
          "",
          `**Model:** ${report.llmReview.metadata.model}`,
          "",
          `**Summary:** ${report.llmReview.summary}`,
          "",
          ...(report.llmReview.acceptanceCriteria.length > 0
            ? [
                "| AC | LLM Status | Reasoning |",
                "| --- | --- | --- |",
                ...report.llmReview.acceptanceCriteria.map((criterion) =>
                  `| ${escapeTable(criterion.id ?? "AC")} | ${escapeTable(criterion.status ?? "unclear")} | ${escapeTable(criterion.reasoning ?? "")} |`
                ),
                ""
              ]
            : []),
          ...(report.llmReview.suggestedTests.length > 0
            ? [
                "**Suggested tests:**",
                "",
                ...report.llmReview.suggestedTests.map((test) => `- ${test}`),
                ""
              ]
            : [])
        ]
      : report.metadata.llmStatus === "failed"
        ? [
            "## LiteLLM Semantic Review",
            "",
            "**Status:** failed",
            "",
            `**Error:** ${report.metadata.llmError}`,
            "",
            "Deterministic and repository-context checks still completed.",
            ""
          ]
        : []),
    "## Findings",
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No findings detected by the MVP reviewer.");
  } else {
    for (const finding of report.findings) {
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push("");
      lines.push(`- Category: ${finding.category}`);
      lines.push(`- Rule: ${finding.id}`);
      if (finding.file) {
        lines.push(`- Location: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
      }
      lines.push(`- Details: ${finding.details}`);
      lines.push(`- Recommendation: ${finding.recommendation}`);
      lines.push("");
    }
  }

  lines.push("## Reviewer Questions");
  lines.push("");
  for (const question of report.reviewerQuestions) {
    lines.push(`- ${question}`);
  }

  lines.push("");
  lines.push("_Generated by ReviewIQ._");
  lines.push("");
  return lines.join("\n");
}

export function writeReports(report, { markdownPath, jsonPath }) {
  if (markdownPath) {
    writeFileSync(markdownPath, renderMarkdownReport(report));
  }
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

export function shouldFail(report, failOn = "none") {
  if (!failOn || failOn === "none") {
    return false;
  }
  const threshold = SEVERITY_ORDER[failOn] ?? SEVERITY_ORDER.critical;
  const max = SEVERITY_ORDER[report.metadata.maxSeverity] ?? 0;
  return max >= threshold;
}

export function mergeLlmReview(report, llmReview) {
  if (!llmReview) {
    return report;
  }

  const findings = [
    ...report.findings,
    ...llmReview.findings.map((finding) => ({
      ...finding,
      category: finding.category === "semantic" ? "traceability" : finding.category,
      source: "llm"
    }))
  ];
  const reviewerQuestions = unique([
    ...report.reviewerQuestions,
    ...llmReview.reviewerQuestions
  ]);
  const findingCounts = countFindings(findings);
  const maxSeverity = getMaxSeverity(findings);
  const gate = maxSeverity === "critical" || maxSeverity === "high" ? "fail" : findings.length ? "warn" : "pass";

  return {
    ...report,
    metadata: {
      ...report.metadata,
      maxSeverity,
      gate,
      llmProvider: llmReview.metadata.provider,
      llmModel: llmReview.metadata.model,
      llmStatus: "completed"
    },
    llmReview,
    findings,
    findingCounts,
    reviewerQuestions
  };
}

export function markLlmFailure(report, error) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    ...report,
    metadata: {
      ...report.metadata,
      llmProvider: "litellm",
      llmStatus: "failed",
      llmError: message.slice(0, 500)
    }
  };
}

function listRepoFiles(rootDir, { maxFiles }) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry.name)) {
          stack.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return files;
}

function scoreRepoFile(path, content, storyTerms) {
  const lowerPath = path.toLowerCase();
  const lowerContent = content.toLowerCase();
  const matchedTerms = [];
  let score = 0;

  for (const term of storyTerms) {
    const normalizedTerm = term.toLowerCase();
    const pathHit = lowerPath.includes(normalizedTerm);
    const contentHits = countOccurrences(lowerContent, normalizedTerm);

    if (pathHit || contentHits > 0) {
      matchedTerms.push(term);
      score += contentHits;
      if (pathHit) {
        score += 5;
      }
    }
  }

  if (path.startsWith("src/") || path.startsWith("app/") || path.startsWith("lib/")) {
    score += 4;
  }
  if (isTestFile(path)) {
    score = Math.max(0, score - 6);
  }

  return {
    path,
    score,
    matchedTerms,
    snippets: buildSnippets(path, content, matchedTerms)
  };
}

function getStoryTerms(story) {
  return normalizeKeywords([
    ...tokenize(story.title),
    ...tokenize(story.description),
    ...(story.acceptanceCriteria ?? []).flatMap((criterion) => [
      ...(criterion.keywords ?? []),
      ...tokenize(criterion.text)
    ]),
    ...(story.technicalConstraints ?? []).flatMap(tokenize),
    ...(story.securityExpectations ?? []).flatMap(tokenize),
    ...(story.performanceExpectations ?? []).flatMap(tokenize),
    ...(story.testExpectations ?? []).flatMap(tokenize),
    ...(story.outOfScope ?? []).flatMap(tokenize)
  ]).slice(0, 80);
}

function buildSnippets(path, content, matchedTerms) {
  if (matchedTerms.length === 0) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((text, index) => ({ file: path, line: index + 1, text: text.trim() }))
    .filter((line) => line.text && matchedTerms.some((term) => containsLoose(line.text, term)))
    .slice(0, 3);
}

function getRepoEvidenceForTerms(repoContext, terms) {
  if (!repoContext?.relevantFiles) {
    return [];
  }

  return repoContext.relevantFiles
    .filter((file) => file.matchedTerms.some((term) => terms.some((expected) => containsLoose(term, expected) || containsLoose(expected, term))))
    .slice(0, 4)
    .map((file) => ({
      file: file.path,
      score: file.score,
      terms: file.matchedTerms.slice(0, 5),
      snippets: file.snippets
    }));
}

function countOccurrences(text, term) {
  if (term.length < 3) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1 && count < 20) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function shouldIgnoreFile(path) {
  return path === "review-report.md"
    || path === "review-report.json"
    || path === "pr.diff"
    || path.endsWith(".lock");
}

function isLikelyTextFile(path) {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension);
}

function toPosix(path) {
  return path.split("\\").join("/");
}

function addLineFinding(findings, id, category, severity, title, line, recommendation) {
  findings.push({
    id,
    category,
    severity,
    title,
    file: line.file,
    line: line.lineNumber,
    details: line.content.trim(),
    recommendation
  });
}

function buildReviewerQuestions(story, acceptance, findings) {
  const questions = [];
  const missing = acceptance.filter((criterion) => criterion.status !== "covered");
  if (missing.length > 0) {
    questions.push(`Which reviewer can verify ${missing.map((criterion) => criterion.id).join(", ")} against the story acceptance criteria?`);
  }
  if (findings.some((finding) => finding.category === "security")) {
    questions.push("Do the security-sensitive changes need an owner or AppSec review before merge?");
  }
  if (findings.some((finding) => finding.category === "performance")) {
    questions.push("Is there enough evidence that this will hold up for production-sized inputs?");
  }
  if ((story.outOfScope ?? []).length > 0 && findings.some((finding) => finding.id === "TRACE003" || finding.id === "TRACE002")) {
    questions.push("Has product approved the apparent scope expansion?");
  }
  if (questions.length === 0) {
    questions.push("Are the changed tests enough to prove the story behavior and prevent regression?");
  }
  return questions;
}

function countFindings(findings) {
  return findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
}

function getMaxSeverity(findings) {
  return findings
    .map((finding) => finding.severity)
    .sort((a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a])[0] ?? "none";
}

function displayPath(file) {
  return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((token) => token.replace(/^[-_/]+|[-_/]+$/g, ""))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function normalizeKeywords(keywords) {
  return unique(keywords.map((keyword) => String(keyword).trim()).filter(Boolean));
}

function containsLoose(text, needle) {
  const normalizedText = String(text).toLowerCase();
  const normalizedNeedle = String(needle).toLowerCase();
  return normalizedText.includes(normalizedNeedle) || tokenize(normalizedNeedle).some((token) => normalizedText.includes(token));
}

function matchesPattern(path, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*");
  const regex = escaped.replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${regex}$`).test(path) || path.includes(pattern.replace(/\*\*?\/?/g, ""));
}

function isTestFile(path) {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(path) || /\.(test|spec)\.[jt]sx?$/i.test(path);
}

function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

function unique(items) {
  return [...new Set(items)];
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|");
}
