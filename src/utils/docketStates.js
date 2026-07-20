export const DOCKET_STATE_OPTIONS = Object.freeze([
  {
    value: "concept",
    label: "Concept",
    apiName: "Concept",
    apiCode: "CNC",
    apiId: "875c558b-60da-4192-8981-fd6e3d4e62c3",
    category: "OPEN",
  },
  {
    value: "design",
    label: "Design",
    apiName: "Design",
    apiCode: "DES",
    apiId: "29a14b10-583d-4fe8-ad35-3314cb5d74db",
    category: "IN_PROGRESS",
  },
  {
    value: "in-review",
    label: "In Review",
    apiName: "Review",
    apiCode: "REV",
    apiId: "d3e8a03f-b37e-4c62-92b1-e653866b217f",
    category: "IN_PROGRESS",
  },
  {
    value: "artifact",
    label: "Artifact",
    apiName: "Artifact",
    apiCode: "ARTF",
    apiId: "15276243-f143-4681-b1a9-1971f3aebaa0",
    category: "COMPLETED",
  },
  {
    value: "closed",
    label: "Closed",
    apiName: "Closed",
    apiCode: "CLO",
    apiId: "e75cccf5-12a4-464a-8732-15ea367361b0",
    category: "CLOSED",
  },
]);

export const CANONICAL_DOCKET_STATES = Object.freeze(
  DOCKET_STATE_OPTIONS.map((option) => option.value)
);

export const BACKLOG_ACTIVE_DOCKET_STATES = Object.freeze([
  "concept",
  "design",
  "in-review",
  "artifact",
]);

const OPTION_BY_VALUE = new Map(
  DOCKET_STATE_OPTIONS.map((option) => [option.value, option])
);

const LEGACY_STATE_ALIASES = new Map([
  ["concept", "concept"],
  ["concepts", "concept"],
  ["cnc", "concept"],
  ["design", "design"],
  ["designs", "design"],
  ["des", "design"],
  ["review", "in-review"],
  ["reviews", "in-review"],
  ["in-review", "in-review"],
  ["inreview", "in-review"],
  ["in_review", "in-review"],
  ["in review", "in-review"],
  ["rev", "in-review"],
  ["artifact", "artifact"],
  ["artifacts", "artifact"],
  ["artf", "artifact"],
  ["closed", "closed"],
  ["close", "closed"],
  ["clo", "closed"],
]);

function compactKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function spacedKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function normalizeDocketState(value, fallback = "concept") {
  const raw = String(value ?? "").trim();
  if (!raw) return CANONICAL_DOCKET_STATES.includes(fallback) ? fallback : "concept";

  const keys = [
    raw.toLowerCase(),
    compactKey(raw),
    compactKey(raw).replace(/-/g, ""),
    spacedKey(raw),
  ];

  for (const key of keys) {
    const match = LEGACY_STATE_ALIASES.get(key);
    if (match) return match;
  }

  const normalizedFallback = LEGACY_STATE_ALIASES.get(compactKey(fallback));
  return normalizedFallback || (CANONICAL_DOCKET_STATES.includes(fallback) ? fallback : "concept");
}

export function isCanonicalDocketState(value) {
  return CANONICAL_DOCKET_STATES.includes(value);
}

export function docketStateOption(value) {
  return OPTION_BY_VALUE.get(normalizeDocketState(value));
}

export function docketStateLabel(value) {
  return docketStateOption(value)?.label || "Concept";
}

export function docketStateApiName(value) {
  return docketStateOption(value)?.apiName || "Concept";
}

export function docketStateApiId(value) {
  return docketStateOption(value)?.apiId || "";
}

export function docketStateCssClass(value) {
  return normalizeDocketState(value);
}

export function isClosedDocketState(value) {
  return normalizeDocketState(value) === "closed";
}

export function isBacklogDocketState(value) {
  return BACKLOG_ACTIVE_DOCKET_STATES.includes(normalizeDocketState(value));
}
