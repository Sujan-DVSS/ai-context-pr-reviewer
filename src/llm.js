import { parseUnifiedDiff } from "./core.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_LITELLM_BASE_URL = "https://llmgw.codefest2026.marriott.com/";
const DEFAULT_LITELLM_MODEL = "us.anthropic.claude-opus-4-7";

export function shouldRunLlm(args, env = process.env) {
  const provider = args["llm-provider"] ?? env.LLM_PROVIDER ?? "none";
  if (provider === "none") {
    return false;
  }
  if (provider === "auto") {
    return Boolean(resolveLiteLlmConfig(args, env, { requireAll: false }));
  }
  return provider === "litellm";
}

export async function runLiteLlmSemanticReview({ story, diffText, repoContext, deterministicReport, args = {}, env = process.env }) {
  const config = resolveLiteLlmConfig(args, env, { requireAll: true });
  const payload = buildReviewPayload({ story, diffText, repoContext, deterministicReport });

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: Number(args["llm-temperature"] ?? env.LLM_TEMPERATURE ?? 0.1),
      messages: [
        {
          role: "system",
          content: [
            "You are a senior code reviewer.",
            "Review only the provided PR diff, story, deterministic findings, and retrieved repository context.",
            "Return strict JSON only. Do not wrap it in markdown.",
            "Prefer high-signal findings. Avoid duplicating deterministic findings unless you add semantic requirement context."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    }),
    signal: AbortSignal.timeout(Number(args["llm-timeout-ms"] ?? env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS))
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM request failed with ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LiteLLM response did not include message content.");
  }

  return normalizeLlmReview(parseJsonObject(content), {
    provider: "litellm",
    model: config.model,
    baseUrl: config.baseUrl
  });
}

function resolveLiteLlmConfig(args, env, { requireAll }) {
  const baseUrl = normalizeBaseUrl(firstPresent(args["llm-base-url"], env.LITELLM_BASE_URL, env.OPENAI_BASE_URL, DEFAULT_LITELLM_BASE_URL));
  const apiKey = firstPresent(args["llm-api-key"], env.LITELLM_API_KEY, env.OPENAI_API_KEY);
  const model = firstPresent(args["llm-model"], env.LITELLM_MODEL, env.OPENAI_MODEL, DEFAULT_LITELLM_MODEL);

  if (!baseUrl || !apiKey || !model) {
    if (!requireAll) {
      return undefined;
    }
    throw new Error("LiteLLM requires --llm-base-url, --llm-model, and LITELLM_API_KEY or --llm-api-key.");
  }

  return { baseUrl, apiKey, model };
}

function buildReviewPayload({ story, diffText, repoContext, deterministicReport }) {
  const files = parseUnifiedDiff(diffText);

  return {
    task: "Review whether this PR satisfies the story and acceptance criteria using the diff and retrieved repository context.",
    requiredJsonShape: {
      summary: "short review summary",
      riskLevel: "low|medium|high|critical",
      acceptanceCriteria: [
        {
          id: "AC id",
          status: "covered|partially-covered|missing|unclear",
          reasoning: "why",
          missingEvidence: ["specific missing evidence"]
        }
      ],
      findings: [
        {
          severity: "low|medium|high|critical",
          category: "semantic|traceability|security|performance|tests",
          title: "short title",
          details: "specific evidence",
          recommendation: "actionable recommendation",
          file: "optional file path",
          line: "optional line number"
        }
      ],
      suggestedTests: ["test idea"],
      reviewerQuestions: ["question"]
    },
    story,
    prSummary: {
      changedFiles: deterministicReport.files,
      deterministicFindings: deterministicReport.findings.slice(0, 12),
      acceptanceCriteria: deterministicReport.acceptanceCriteria
    },
    repoContext: repoContext
      ? {
          indexedFiles: repoContext.indexedFiles,
          relevantFiles: repoContext.relevantFiles.slice(0, 8).map((file) => ({
            path: file.path,
            matchedTerms: file.matchedTerms.slice(0, 10),
            snippets: file.snippets
          }))
        }
      : undefined,
    diff: compactDiff(files)
  };
}

function compactDiff(files) {
  return files.map((file) => ({
    path: file.newPath === "/dev/null" ? file.oldPath : file.newPath,
    status: file.status,
    additions: file.additions.slice(0, 120).map((line) => ({
      line: line.lineNumber,
      text: line.content
    })),
    deletions: file.deletions.slice(0, 60).map((line) => ({
      line: line.lineNumber,
      text: line.content
    }))
  })).slice(0, 40);
}

function normalizeLlmReview(review, metadata) {
  const findings = Array.isArray(review.findings) ? review.findings : [];

  return {
    metadata,
    summary: stringOrDefault(review.summary, "LiteLLM semantic review completed."),
    riskLevel: normalizeSeverity(review.riskLevel ?? "medium"),
    acceptanceCriteria: Array.isArray(review.acceptanceCriteria) ? review.acceptanceCriteria : [],
    findings: findings.map((finding, index) => ({
      id: `LLM${String(index + 1).padStart(3, "0")}`,
      category: normalizeCategory(finding.category),
      severity: normalizeSeverity(finding.severity),
      title: stringOrDefault(finding.title, "LLM semantic review finding"),
      file: typeof finding.file === "string" ? finding.file : undefined,
      line: Number.isInteger(finding.line) ? finding.line : undefined,
      details: stringOrDefault(finding.details, "No details provided."),
      recommendation: stringOrDefault(finding.recommendation, "Review manually.")
    })),
    suggestedTests: Array.isArray(review.suggestedTests) ? review.suggestedTests.filter((item) => typeof item === "string") : [],
    reviewerQuestions: Array.isArray(review.reviewerQuestions) ? review.reviewerQuestions.filter((item) => typeof item === "string") : []
  };
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("LiteLLM response was not parseable JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function normalizeBaseUrl(value) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function normalizeSeverity(value) {
  return ["low", "medium", "high", "critical"].includes(value) ? value : "medium";
}

function normalizeCategory(value) {
  return ["semantic", "traceability", "security", "performance", "tests"].includes(value) ? value : "semantic";
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
