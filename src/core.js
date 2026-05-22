import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  ".ai-context-pr-reviewer",
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

export function validateStory(story, source = "Jira story") {
  if (!story || typeof story !== "object") {
    throw new Error(`${source} must contain a story object.`);
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
  const storyAlignment = buildStoryAlignment(story, files, additions, repoContext);
  reviewJiraClarity(story, findings);
  const acceptance = evaluateAcceptanceCriteria(story, files, additions, findings, repoContext);

  reviewTraceability(story, files, additions, acceptance, findings, repoContext, storyAlignment);
  reviewCrossStoryConflicts(story, files, additions, findings, metadata);
  reviewStaticQuality(files, additions, findings);
  reviewSecurity(story, files, additions, findings);
  reviewPerformance(files, additions, findings);
  reviewTestExpectations(story, files, findings);

  const findingCounts = countFindings(findings);
  const maxSeverity = getMaxSeverity(findings);
  const gate = computeGate(maxSeverity, findings);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      storyId: story.id,
      storyTitle: story.title,
      changedFiles: files.length,
      additions: additions.length,
      deletions: deletions.length,
      storyAlignmentScore: storyAlignment.score,
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
    storyAlignment,
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
        title: `AC ${criterion.id ?? ""} is not clear in this PR`.trim(),
        details: criterion.text,
        recommendation: "Add the code or test that proves this AC is done. If the AC changed, update the Jira story."
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

function reviewJiraClarity(story, findings) {
  const issues = [];
  const criteria = story.acceptanceCriteria ?? [];

  if (tokenize(story.description ?? "").length < 5) {
    issues.push("The Jira description is too short to explain the expected behavior.");
  }

  for (const criterion of criteria) {
    const text = String(criterion.text ?? "").trim();
    if (isGenericFallbackCriterion(text)) {
      issues.push(`${criterion.id ?? "AC"} is missing. Jira did not provide a clear acceptance criterion.`);
      continue;
    }
    if (isVagueCriterion(text)) {
      issues.push(`${criterion.id ?? "AC"} is vague: "${shortenText(text, 140)}"`);
    }
  }

  const conflicts = findConflictingCriteria(criteria);
  issues.push(...conflicts);

  if (issues.length === 0) {
    return;
  }

  findings.push({
    id: "JIRA001",
    category: "traceability",
    severity: isHighRiskStory(story) ? "high" : "medium",
    title: "Jira story needs clarification",
    details: issues.slice(0, 4).join(" "),
    recommendation: "Clarify the Jira story before merge. Add exact expected behavior, edge cases, and what is out of scope."
  });
}

function buildStoryAlignment(story, files, additions, repoContext) {
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
  const overlapTerms = [...storyTokens].filter((token) => changedTokens.has(token));
  const denominator = Math.min(storyTokens.size, 40) || 1;
  const vocabularyScore = Math.min(100, Math.round((overlapTerms.length / denominator) * 100));
  const changedPaths = new Set(files.map(displayPath));
  const topRelevantFiles = repoContext?.relevantFiles?.slice(0, 5) ?? [];
  const changedRelevantFiles = topRelevantFiles.filter((file) => changedPaths.has(file.path));
  const repoScore = topRelevantFiles.length === 0
    ? 100
    : Math.round((changedRelevantFiles.length / topRelevantFiles.length) * 100);
  const score = files.length === 0
    ? 100
    : Math.round((vocabularyScore * 0.7) + (repoScore * 0.3));

  return {
    score,
    vocabularyScore,
    repoScore,
    overlapTerms,
    totalStoryTerms: storyTokens.size,
    changedRelevantFiles: changedRelevantFiles.map((file) => file.path),
    topRelevantFiles: topRelevantFiles.map((file) => file.path),
    summary: `${overlapTerms.length} story terms matched; ${changedRelevantFiles.length}/${topRelevantFiles.length} top repo-context files touched.`
  };
}

function reviewTraceability(story, files, additions, acceptance, findings, repoContext, storyAlignment) {
  const overlap = storyAlignment.overlapTerms;
  const ratio = storyAlignment.vocabularyScore / 100;

  if (files.length > 0 && overlap.length < 2) {
    findings.push({
      id: "TRACE001",
      category: "traceability",
      severity: "high",
      title: "This PR may not match the Jira story",
      details: "The changed files and new code do not look related to the Jira story or ACs.",
      recommendation: "Check that this PR is linked to the correct Jira story. If it is correct, add clearer code or tests for the ACs."
    });
  } else if (files.length > 0 && ratio < 0.12) {
    findings.push({
      id: "TRACE001",
      category: "traceability",
      severity: "medium",
      title: "This PR may be moving away from the Jira story",
      details: `Only ${overlap.length} important Jira story words were found in the changed code or file paths.`,
      recommendation: "Check if the PR is too broad, changing the wrong area, or missing code/tests for the story."
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
        title: "This PR changes files outside the story",
        details: `Unexpected files: ${driftedFiles.slice(0, 8).join(", ")}`,
        recommendation: "Move unrelated changes to another PR, or explain in Jira why these files are needed."
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
        title: `This PR changes an out-of-scope area: ${outOfScope}`,
        details: "The Jira story says this area is not part of the work.",
        recommendation: "Remove this change, or update Jira after product approval."
      });
    }
  }

  if (acceptance.some((criterion) => criterion.status !== "covered")) {
    findings.push({
      id: "TRACE005",
      category: "traceability",
      severity: "medium",
      title: "Some ACs are not clearly covered",
      details: "One or more ACs do not have clear proof in the changed files.",
      recommendation: "Check the AC table before approving this PR."
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
        title: "This PR may not change the right files",
        details: `Most relevant repo files: ${highContextFiles.map((file) => file.path).join(", ")}`,
        recommendation: "Check if the change should be made in one of these files. If not, explain why in the PR."
      });
    }
  }
}

function reviewCrossStoryConflicts(story, files, additions, findings, metadata) {
  const currentTicketIds = new Set([story.id, metadata.ticketId].filter(Boolean).map((ticketId) => String(ticketId).toUpperCase()));
  const referencedTicketIds = extractTicketIds([
    ...files.map(displayPath),
    ...additions.map((line) => line.content)
  ]);
  const otherTicketIds = referencedTicketIds.filter((ticketId) => !currentTicketIds.has(ticketId));

  if (otherTicketIds.length > 0) {
    findings.push({
      id: "CROSS001",
      category: "traceability",
      severity: "high",
      title: "This PR may include work from another Jira story",
      details: `Other Jira IDs found in changed code or paths: ${otherTicketIds.slice(0, 5).join(", ")}`,
      recommendation: "Move that work to the correct PR, or confirm in Jira that this story includes it."
    });
  }
}

function reviewStaticQuality(files, additions, findings) {
  if (files.length > 20) {
    findings.push({
      id: "STATIC000",
      category: "static",
      severity: "medium",
      title: "This PR changes many files",
      details: `This PR changes ${files.length} files.`,
      recommendation: "Split the PR if possible. If not, add a short review plan in the PR description."
    });
  }

  for (const line of additions) {
    const text = line.content;
    if (/\b(debugger|console\.log|printStackTrace)\b/.test(text)) {
      addLineFinding(findings, "STATIC001", "static", "medium", "Debug log added", line, "Remove this debug log. If the log is needed, make sure it is safe for production.", {
        suggestedReplacement: ""
      });
    }
    if (/\b(TODO|FIXME|HACK)\b/i.test(text)) {
      addLineFinding(findings, "STATIC002", "static", "low", "TODO/FIXME added", line, "Finish this item or link it to a tracked follow-up.");
    }
    if (text.length > 160) {
      addLineFinding(findings, "STATIC003", "static", "low", "Very long changed line", line, "Split the line for readability and simpler review.");
    }
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text) || /catch\s*\([^)]*\)\s*\{\s*return\s*;?\s*\}/.test(text)) {
      addLineFinding(findings, "STATIC004", "static", "high", "Error is ignored", line, "Handle the error, throw it again, or explain why it is safe to ignore.");
    }
  }
}

function reviewSecurity(story, files, additions, findings) {
  const sensitivePaths = files.filter((file) => /auth|login|permission|payment|secret|token|credential|pii|user/i.test(displayPath(file)));
  const changedTests = files.some((file) => isTestFile(displayPath(file)));

  for (const line of additions) {
    const text = line.content;
    if (/(api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i.test(text) || /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      addLineFinding(findings, "SEC001", "security", "critical", "Possible secret in code", line, "Remove the secret, rotate it, and read it from a secret manager.");
    }
    if (/\beval\s*\(|new Function\s*\(/.test(text)) {
      addLineFinding(findings, "SEC002", "security", "critical", "Code runs dynamically", line, "Avoid running generated code. Use a safer approach.");
    }
    if (/\b(innerHTML|dangerouslySetInnerHTML)\b/.test(text)) {
      addLineFinding(findings, "SEC003", "security", "high", "Unsafe HTML may be shown", line, "Use safe rendering, or clean the HTML before showing it.");
    }
    if (/(SELECT|UPDATE|INSERT|DELETE).*(\+|\$\{)/i.test(text)) {
      addLineFinding(findings, "SEC004", "security", "high", "SQL query may be unsafe", line, "Use query parameters instead of joining SQL strings.");
    }
    if (/console\.(log|info|warn|error)\(.*(card|password|token|secret|payload|authorization)/i.test(text)) {
      addLineFinding(findings, "SEC005", "security", "high", "Sensitive data may be logged", line, "Do not log secrets, card data, tokens, or raw request payloads.", {
        suggestedReplacement: ""
      });
    }
  }

  if (sensitivePaths.length > 0 && !changedTests) {
    findings.push({
      id: "SEC006",
      category: "security",
      severity: "medium",
      title: "Sensitive code changed without tests",
      details: `Sensitive paths changed: ${sensitivePaths.map(displayPath).slice(0, 6).join(", ")}`,
      recommendation: "Add tests for the risky path, such as access checks, retries, or failure handling."
    });
  }

  for (const expectation of story.securityExpectations ?? []) {
    if (/log|secret|token|card|pii/i.test(expectation)) {
      const riskyLine = additions.find((line) => /console\.|logger\.|log\(/i.test(line.content));
      if (riskyLine) {
        addLineFinding(findings, "SEC007", "security", "medium", "Security rule needs a closer check", riskyLine, `Jira says: ${expectation}`);
      }
    }
  }
}

function reviewPerformance(files, additions, findings) {
  const byFile = groupBy(additions, (line) => line.file);

  for (const line of additions) {
    const text = line.content;
    if (/SELECT\s+\*/i.test(text)) {
      addLineFinding(findings, "PERF003", "performance", "medium", "Database query may fetch too much data", line, "Select only the fields this flow needs.");
    }
    if (/\b(readFileSync|writeFileSync|readdirSync|execSync)\s*\(/.test(text)) {
      addLineFinding(findings, "PERF004", "performance", "medium", "This may block the app", line, "Use a non-blocking option in user-facing code.");
    }
  }

  for (const fileLines of byFile.values()) {
    const loopLines = fileLines.filter((line) => /\b(for|while)\s*\(|\.forEach\s*\(/.test(line.content));
    for (const loopLine of loopLines) {
      const nearby = fileLines.filter((line) => line.lineNumber >= loopLine.lineNumber && line.lineNumber <= loopLine.lineNumber + 8);
      const awaitLine = nearby.find((line) => /\bawait\b/.test(line.content));
      if (awaitLine) {
        addLineFinding(findings, "PERF001", "performance", "high", "This waits inside a loop", awaitLine, "Run the work in batches, or explain why each item must run one after another.");
      }
      const nestedLoop = nearby.find((line) => line.lineNumber !== loopLine.lineNumber && /\b(for|while)\s*\(|\.forEach\s*\(/.test(line.content));
      if (nestedLoop) {
        addLineFinding(findings, "PERF002", "performance", "medium", "Loop inside another loop", nestedLoop, "Check how much data this handles. Use a map or lookup if the list can grow.");
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
      title: "Jira asks for tests, but no test changed",
      details: (story.testExpectations ?? []).join(" ") || "Acceptance criteria explicitly mention tests.",
      recommendation: "Add the missing test, or explain in the PR why existing tests already cover it."
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
    `**Story Alignment:** ${report.metadata.storyAlignmentScore}% - ${report.storyAlignment.summary}`,
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

export function renderHtmlDashboard(report) {
  const acCoverage = acceptanceCoveragePercent(report);
  const severityCards = ["critical", "high", "medium", "low"].map((severity) => `
      <div class="card">
        <span class="label">${escapeHtml(severity.toUpperCase())}</span>
        <strong>${report.findingCounts[severity] ?? 0}</strong>
      </div>`).join("");
  const changedPaths = new Set(report.files.map((file) => file.path));
  const relevantFiles = report.repoContext?.relevantFiles ?? [];
  const touchedRelevant = relevantFiles.filter((file) => changedPaths.has(file.path));
  const llmStatus = report.metadata.llmStatus === "completed"
    ? `Completed (${report.metadata.llmModel ?? "model unknown"})`
    : report.metadata.llmStatus === "failed"
      ? `Failed: ${report.metadata.llmError ?? "unknown error"}`
      : "Not run";
  const recommendation = report.metadata.gate === "fail"
    ? "Do not merge until medium/high/critical findings are resolved."
    : report.metadata.gate === "warn"
      ? "Merge is allowed, but review low-severity suggestions first."
      : "No ReviewIQ blockers found.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ReviewIQ Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172033; background: #f7f8fb; }
    h1 { margin-bottom: 4px; }
    .muted { color: #5f6b7a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin: 24px 0; }
    .card { background: #fff; border: 1px solid #dde3ee; border-radius: 12px; padding: 18px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .card strong { display: block; font-size: 30px; margin-top: 8px; }
    .label { color: #5f6b7a; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
    .fail { color: #b42318; }
    .pass { color: #027a48; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde3ee; border-radius: 12px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #edf1f7; }
    th { background: #eef2ff; }
  </style>
</head>
<body>
  <h1>ReviewIQ Dashboard</h1>
  <p class="muted">${escapeHtml(report.metadata.storyId)} - ${escapeHtml(report.metadata.storyTitle)}</p>
  <div class="grid">
    <div class="card"><span class="label">AC COVERAGE</span><strong>${acCoverage}%</strong></div>
    <div class="card"><span class="label">STORY ALIGNMENT</span><strong>${report.metadata.storyAlignmentScore}%</strong></div>
    <div class="card"><span class="label">MERGE RECOMMENDATION</span><strong class="${report.metadata.gate === "fail" ? "fail" : "pass"}">${escapeHtml(report.metadata.gate.toUpperCase())}</strong></div>
    <div class="card"><span class="label">CHANGED VS RELEVANT</span><strong>${touchedRelevant.length}/${relevantFiles.length}</strong><p class="muted">Top repo-context files touched</p></div>
  </div>
  <h2>Severity Count</h2>
  <div class="grid">${severityCards}</div>
  <h2>LLM Result</h2>
  <div class="card">${escapeHtml(llmStatus)}</div>
  <h2>Merge Recommendation</h2>
  <div class="card">${escapeHtml(recommendation)}</div>
  <h2>Acceptance Criteria</h2>
  <table>
    <thead><tr><th>AC</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>
      ${report.acceptanceCriteria.map((criterion) => {
        const evidence = [
          ...criterion.evidence.paths.map((pathEvidence) => `path ${pathEvidence.file}`),
          ...criterion.evidence.lines.map((line) => `${line.file}:${line.line}`),
          ...criterion.evidence.repo.map((repoEvidence) => `repo ${repoEvidence.file}`)
        ].slice(0, 4).join("; ") || "No clear diff evidence";
        return `<tr><td>${escapeHtml(criterion.id)}</td><td>${escapeHtml(criterion.status)}</td><td>${escapeHtml(evidence)}</td></tr>`;
      }).join("")}
    </tbody>
  </table>
</body>
</html>
`;
}

export function writeReports(report, { markdownPath, jsonPath, htmlPath }) {
  if (markdownPath) {
    writeFileSync(markdownPath, renderMarkdownReport(report));
  }
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (htmlPath) {
    writeFileSync(htmlPath, renderHtmlDashboard(report));
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
  const gate = computeGate(maxSeverity, findings);

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

function isGenericFallbackCriterion(text) {
  return /^Implementation satisfies the Jira issue description and expected behavior\.?$/i.test(text);
}

function isVagueCriterion(text) {
  const normalized = text.toLowerCase();
  if (tokenize(text).length < 4) {
    return true;
  }
  return /\b(correct|proper|properly|as expected|should work|works as expected|handle appropriately|support this|update logic|improve|enhance|tbd|to be decided)\b/i.test(normalized);
}

function findConflictingCriteria(criteria) {
  const conflicts = [];
  for (let i = 0; i < criteria.length; i += 1) {
    for (let j = i + 1; j < criteria.length; j += 1) {
      const first = String(criteria[i].text ?? "");
      const second = String(criteria[j].text ?? "");
      const overlap = tokenize(first).filter((token) => tokenize(second).includes(token));
      if (overlap.length < 2) {
        continue;
      }
      const firstNegative = /\b(must not|should not|do not|don't|never|without|not applied|not apply)\b/i.test(first);
      const secondNegative = /\b(must not|should not|do not|don't|never|without|not applied|not apply)\b/i.test(second);
      if (firstNegative !== secondNegative) {
        conflicts.push(`${criteria[i].id ?? "AC"} and ${criteria[j].id ?? "AC"} may conflict. Please clarify the expected behavior in Jira.`);
      }
    }
  }
  return conflicts.slice(0, 3);
}

function isHighRiskStory(story) {
  return /payment|pricing|discount|revenue|security|auth|token|pii|guest|card/i.test([
    story.title,
    story.description,
    ...(story.labels ?? []),
    ...(story.components ?? [])
  ].join(" "));
}

function shortenText(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}...`;
}

function shouldIgnoreFile(path) {
  return path === "review-report.md"
    || path === "review-report.json"
    || path === "review-dashboard.html"
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

function addLineFinding(findings, id, category, severity, title, line, recommendation, options = {}) {
  findings.push({
    id,
    category,
    severity,
    title,
    file: line.file,
    line: line.lineNumber,
    details: line.content.trim(),
    recommendation,
    ...(Object.hasOwn(options, "suggestedReplacement")
      ? { suggestedReplacement: options.suggestedReplacement }
      : {})
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
  if (findings.some((finding) => finding.id === "JIRA001")) {
    questions.push("Can the product owner clarify the Jira story before this PR is merged?");
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

function computeGate(maxSeverity, findings) {
  if (SEVERITY_ORDER[maxSeverity] >= SEVERITY_ORDER.medium) {
    return "fail";
  }
  return findings.length ? "warn" : "pass";
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function acceptanceCoveragePercent(report) {
  const criteria = report.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    return 100;
  }
  const covered = criteria.filter((criterion) => criterion.status === "covered").length;
  return Math.round((covered / criteria.length) * 100);
}
