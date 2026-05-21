const DEFAULT_JIRA_API_VERSION = "3";

export function hasJiraConfig(args = {}, env = process.env) {
  const config = resolveJiraConfig(args, env, { requireAuth: false });
  return Boolean(config?.baseUrl && (config.bearerToken || (config.email && config.apiToken)));
}

export async function loadJiraStory(ticketId, { args = {}, env = process.env, fetchImpl = fetch } = {}) {
  if (!ticketId) {
    throw new Error("Jira provider needs a ticket ID from branch, PR title, PR body, commit message, or --ticket-id.");
  }

  const config = resolveJiraConfig(args, env, { requireAuth: true });
  const fields = [
    "summary",
    "description",
    "labels",
    "components",
    "priority",
    "issuetype",
    "status",
    config.acceptanceCriteriaField
  ].filter(Boolean).join(",");

  const url = `${config.baseUrl}/rest/api/${config.apiVersion}/issue/${encodeURIComponent(ticketId)}?fields=${encodeURIComponent(fields)}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      authorization: config.bearerToken
        ? `Bearer ${config.bearerToken}`
        : `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`
    },
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira issue ${ticketId} fetch failed with ${response.status}: ${text.slice(0, 500)}`);
  }

  const issue = await response.json();
  return jiraIssueToStory(issue, config);
}

export function jiraIssueToStory(issue, config = {}) {
  const fields = issue.fields ?? {};
  const description = adfToText(fields.description).trim();
  const acFieldValue = config.acceptanceCriteriaField ? fields[config.acceptanceCriteriaField] : undefined;
  const acText = adfToText(acFieldValue).trim();
  const acceptanceCriteria = buildAcceptanceCriteria(acText || description);
  const components = Array.isArray(fields.components) ? fields.components.map((component) => component.name).filter(Boolean) : [];
  const labels = Array.isArray(fields.labels) ? fields.labels : [];

  return {
    id: issue.key,
    title: fields.summary ?? issue.key,
    description: description || fields.summary || issue.key,
    acceptanceCriteria,
    labels,
    components,
    technicalConstraints: inferConstraints(description),
    securityExpectations: inferSecurityExpectations(description, labels, components),
    performanceExpectations: inferPerformanceExpectations(description),
    testExpectations: acceptanceCriteria.length > 0
      ? ["Add or update tests that prove the Jira acceptance criteria."]
      : [],
    outOfScope: inferOutOfScope(description),
    source: {
      provider: "jira",
      url: config.baseUrl ? `${config.baseUrl}/browse/${issue.key}` : undefined,
      issueType: fields.issuetype?.name,
      status: fields.status?.name,
      priority: fields.priority?.name
    }
  };
}

function resolveJiraConfig(args, env, { requireAuth }) {
  const baseUrl = trimTrailingSlash(firstPresent(args["jira-base-url"], env.JIRA_BASE_URL));
  const email = firstPresent(args["jira-email"], env.JIRA_EMAIL);
  const apiToken = firstPresent(args["jira-api-token"], env.JIRA_API_TOKEN);
  const bearerToken = firstPresent(args["jira-bearer-token"], env.JIRA_BEARER_TOKEN);
  const acceptanceCriteriaField = firstPresent(args["jira-ac-field"], env.JIRA_AC_FIELD);
  const apiVersion = firstPresent(args["jira-api-version"], env.JIRA_API_VERSION, DEFAULT_JIRA_API_VERSION);
  const timeoutMs = Number(firstPresent(args["jira-timeout-ms"], env.JIRA_TIMEOUT_MS, "30000"));

  if (!baseUrl || (requireAuth && !bearerToken && !(email && apiToken))) {
    if (!requireAuth) {
      return undefined;
    }
    throw new Error("Jira provider requires JIRA_BASE_URL and either JIRA_BEARER_TOKEN or JIRA_EMAIL + JIRA_API_TOKEN.");
  }

  return {
    baseUrl,
    email,
    apiToken,
    bearerToken,
    acceptanceCriteriaField,
    apiVersion,
    timeoutMs
  };
}

function buildAcceptanceCriteria(text) {
  const explicit = extractAcceptanceSection(text);
  const candidates = explicit.length > 0 ? explicit : [];

  if (candidates.length === 0 && text.trim()) {
    candidates.push("Implementation satisfies the Jira issue description and expected behavior.");
  }

  return candidates.slice(0, 12).map((criterion, index) => ({
    id: `AC${index + 1}`,
    text: criterion,
    keywords: keywordHints(criterion),
    risk: /security|payment|auth|pii|data loss|critical|revenue/i.test(criterion) ? "high" : "medium"
  }));
}

function extractAcceptanceSection(text) {
  const lines = text.split(/\r?\n/);
  const criteria = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(acceptance criteria|acceptance|acs?|requirements?)\s*:?\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s|\w[\w\s]{2,}:$/.test(line) && !/^[-*0-9. ]/.test(line)) {
      break;
    }
    if (!inSection) {
      continue;
    }
    const cleaned = line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (cleaned) {
      criteria.push(cleaned);
    }
  }

  if (criteria.length > 0) {
    return criteria;
  }

  return lines
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+[.)]\s+|given\s+|when\s+|then\s+)/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function adfToText(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(adfToText).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (typeof value.text === "string") {
    return value.text;
  }

  const childText = Array.isArray(value.content) ? value.content.map(adfToText).filter(Boolean).join(" ") : "";
  if (["paragraph", "heading", "listItem"].includes(value.type)) {
    return childText ? `${childText}\n` : "";
  }
  if (["bulletList", "orderedList", "doc"].includes(value.type)) {
    return Array.isArray(value.content) ? value.content.map(adfToText).filter(Boolean).join("\n") : "";
  }
  return childText;
}

function keywordHints(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].slice(0, 8);
}

function inferConstraints(description) {
  return extractSentences(description, /must|should|constraint|do not|don't|without/i);
}

function inferSecurityExpectations(description, labels, components) {
  const text = [description, ...labels, ...components].join(" ");
  if (!/security|auth|token|password|secret|pii|payment|guest/i.test(text)) {
    return [];
  }
  return ["Do not log or expose secrets, tokens, guest personal data, or sensitive business payloads."];
}

function inferPerformanceExpectations(description) {
  return extractSentences(description, /performance|latency|fast|slow|cache|query|external service/i);
}

function inferOutOfScope(description) {
  const match = description.match(/out of scope\s*:?\s*([\s\S]+)/i);
  if (!match) {
    return [];
  }
  return match[1].split(/\r?\n|,/).map((item) => item.replace(/^[-*]\s+/, "").trim()).filter(Boolean).slice(0, 8);
}

function extractSentences(text, pattern) {
  return String(text)
    .split(/(?<=[.!?])\s+|\r?\n/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => pattern.test(sentence))
    .slice(0, 6);
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function trimTrailingSlash(value) {
  return value?.replace(/\/+$/, "");
}
