const SNAPSHOT_SCHEMA_VERSION = 2;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_BODY_BYTES = 1_000_000;
const TYPES = ["epic", "story", "task", "job"];
const GENERIC_TYPES = [
  "workspace",
  "sprint",
  "epic",
  "story",
  "task",
  "bug",
  "feature",
  "research",
  "job",
];
const RELATIONSHIP_TYPES = [
  "parent",
  "child",
  "assigned_to_sprint",
  "depends_on",
  "blocks",
  "related_to",
  "duplicate_of",
];
const CATEGORIES = ["feature", "enhancement", "defect", "escalation"];
const PRIORITIES = ["info", "minor", "major", "critical", "blocker"];
const DOCKET_STATES = ["concept", "design", "review", "closed", "artifact"];
const ROOT_ID = "storyRoot";
const RELATIONSHIPS = {
  [ROOT_ID]: ["epic"],
  epic: ["story", "task"],
  story: ["job"],
  task: [],
  job: [],
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function safeError(statusCode, error, details) {
  return json(statusCode, details ? { error, details } : { error });
}

function logWorklogError(stage, error) {
  const cause = error?.cause;
  const rootCause = cause?.cause || cause;

  console.error("[worklog]", stage, {
    message: error?.message || "Unknown error",
    statusCode: error?.statusCode,
    cause: rootCause
      ? {
          message: rootCause.message,
          code: rootCause.code,
          syscall: rootCause.syscall,
          hostname: rootCause.hostname,
        }
      : undefined,
    stack: error?.stack,
  });
}

function githubFetchError(error) {
  return Object.assign(
    new Error("GitHub is unavailable. Continue using cached worklog data."),
    {
      statusCode: 503,
      cause: error,
    }
  );
}

function requiredEnv() {
  const config = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_DATA_OWNER,
    repo: process.env.GITHUB_DATA_REPO,
    branch: process.env.GITHUB_DATA_BRANCH,
    path: process.env.GITHUB_DATA_PATH,
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, config };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubFileUrl({ owner, repo, path }) {
  return `https://api.github.com/repos/${encodeURIComponent(
    owner
  )}/${encodeURIComponent(repo)}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function isValidIsoDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function validateWorklog(entry, index, itemId) {
  if (!entry || typeof entry !== "object") {
    return `Worklog ${index + 1} on ${itemId} must be an object.`;
  }

  if (!isValidIsoDate(entry.date)) {
    return `Worklog ${index + 1} on ${itemId} needs a valid date.`;
  }

  if (typeof entry.description !== "string") {
    return `Worklog ${index + 1} on ${itemId} needs a description string.`;
  }

  if (normalizeNumber(entry.timeMinutes) === null) {
    return `Worklog ${index + 1} on ${itemId} has invalid time.`;
  }

  return "";
}

function validateGraphSnapshot(snapshot) {
  if (!snapshot.workspace || typeof snapshot.workspace !== "object") {
    return { valid: false, error: "Workspace is required." };
  }

  if (
    typeof snapshot.workspace.id !== "string" ||
    !snapshot.workspace.id.trim() ||
    typeof snapshot.workspace.title !== "string" ||
    !snapshot.workspace.title.trim()
  ) {
    return { valid: false, error: "Workspace needs an ID and title." };
  }

  if (!Array.isArray(snapshot.workItems)) {
    return { valid: false, error: "Work items must be an array." };
  }

  if (!Array.isArray(snapshot.relationships)) {
    return { valid: false, error: "Relationships must be an array." };
  }

  if (!Array.isArray(snapshot.sprintAssignments)) {
    return { valid: false, error: "Sprint assignments must be an array." };
  }

  const itemIds = new Set();

  for (const item of snapshot.workItems) {
    if (!item || typeof item !== "object") {
      return { valid: false, error: "Every work item must be an object." };
    }

    if (typeof item.id !== "string" || !item.id.trim()) {
      return { valid: false, error: "Every work item needs an ID." };
    }

    if (itemIds.has(item.id)) {
      return { valid: false, error: "Duplicate work item IDs are not allowed." };
    }

    itemIds.add(item.id);

    if (typeof item.title !== "string" || !item.title.trim()) {
      return { valid: false, error: `${item.id} needs a title.` };
    }

    if (!GENERIC_TYPES.includes(String(item.type || "").toLowerCase())) {
      return { valid: false, error: `${item.id} has an invalid type.` };
    }

    if (
      item.status !== undefined &&
      !DOCKET_STATES.includes(String(item.status).toLowerCase())
    ) {
      return { valid: false, error: `${item.id} has an invalid status.` };
    }

    if (
      item.priority !== undefined &&
      !PRIORITIES.includes(normalizeEnum(item.priority, PRIORITIES, ""))
    ) {
      return { valid: false, error: `${item.id} has an invalid priority.` };
    }

    if (item.storyPoints !== undefined && normalizeNumber(item.storyPoints) === null) {
      return { valid: false, error: `${item.id} has invalid story points.` };
    }

    if (item.estimatedTime !== undefined && normalizeNumber(item.estimatedTime) === null) {
      return { valid: false, error: `${item.id} has invalid estimated time.` };
    }

    if (item.loggedTime !== undefined && normalizeNumber(item.loggedTime) === null) {
      return { valid: false, error: `${item.id} has invalid logged time.` };
    }

    if (item.createdAt !== undefined && !isValidIsoDate(item.createdAt)) {
      return { valid: false, error: `${item.id} has invalid createdAt.` };
    }

    if (item.updatedAt !== undefined && !isValidIsoDate(item.updatedAt)) {
      return { valid: false, error: `${item.id} has invalid updatedAt.` };
    }

    if (item.worklogs) {
      if (!Array.isArray(item.worklogs)) {
        return { valid: false, error: `${item.id} worklogs must be an array.` };
      }

      for (let index = 0; index < item.worklogs.length; index += 1) {
        const error = validateWorklog(item.worklogs[index], index, item.id);
        if (error) return { valid: false, error };
      }
    }
  }

  for (const relationship of snapshot.relationships) {
    if (!relationship || typeof relationship !== "object") {
      return { valid: false, error: "Every relationship must be an object." };
    }

    if (
      typeof relationship.sourceId !== "string" ||
      typeof relationship.targetId !== "string" ||
      !relationship.sourceId.trim() ||
      !relationship.targetId.trim()
    ) {
      return { valid: false, error: "Relationships need source and target IDs." };
    }

    if (!RELATIONSHIP_TYPES.includes(String(relationship.relationshipType || "").toLowerCase())) {
      return { valid: false, error: "Relationship type is invalid." };
    }

    if (!itemIds.has(relationship.sourceId) || !itemIds.has(relationship.targetId)) {
      return { valid: false, error: "Relationship points to a missing work item." };
    }
  }

  for (const assignment of snapshot.sprintAssignments) {
    if (!assignment || typeof assignment !== "object") {
      return { valid: false, error: "Every sprint assignment must be an object." };
    }

    if (!itemIds.has(assignment.sprintId) || !itemIds.has(assignment.workItemId)) {
      return { valid: false, error: "Sprint assignment points to a missing work item." };
    }

    if (assignment.plannedHours !== undefined && normalizeNumber(assignment.plannedHours) === null) {
      return { valid: false, error: "Sprint assignment has invalid planned hours." };
    }

    if (assignment.loggedHours !== undefined && normalizeNumber(assignment.loggedHours) === null) {
      return { valid: false, error: "Sprint assignment has invalid logged hours." };
    }

    if (
      assignment.status !== undefined &&
      !DOCKET_STATES.includes(String(assignment.status).toLowerCase())
    ) {
      return { valid: false, error: "Sprint assignment status is invalid." };
    }

    if (assignment.assignedDate !== undefined && !isValidIsoDate(assignment.assignedDate)) {
      return { valid: false, error: "Sprint assignment date is invalid." };
    }
  }

  return { valid: true, error: "" };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { valid: false, error: "Snapshot must be an object." };
  }

  if (snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    return validateGraphSnapshot(snapshot);
  }

  if (snapshot.schemaVersion !== LEGACY_SNAPSHOT_SCHEMA_VERSION) {
    return { valid: false, error: "Unsupported snapshot schema version." };
  }

  if (!snapshot.root || typeof snapshot.root !== "object") {
    return { valid: false, error: "Snapshot root is required." };
  }

  if (typeof snapshot.root.title !== "string" || !snapshot.root.title.trim()) {
    return { valid: false, error: "Root title is required." };
  }

  if (
    snapshot.root.docketState !== undefined &&
    !DOCKET_STATES.includes(String(snapshot.root.docketState).toLowerCase())
  ) {
    return { valid: false, error: "Root docket state is invalid." };
  }

  if (!Array.isArray(snapshot.workItems)) {
    return { valid: false, error: "Work items must be an array." };
  }

  const ids = new Set();
  const itemById = new Map();

  for (const item of snapshot.workItems) {
    if (!item || typeof item !== "object") {
      return { valid: false, error: "Every work item must be an object." };
    }

    if (typeof item.id !== "string" || !item.id.trim() || item.id === ROOT_ID) {
      return { valid: false, error: "Every work item needs a valid ID." };
    }

    if (ids.has(item.id)) {
      return { valid: false, error: "Duplicate work item IDs are not allowed." };
    }

    ids.add(item.id);
    itemById.set(item.id, item);

    if (typeof item.title !== "string" || !item.title.trim()) {
      return { valid: false, error: `${item.id} needs a title.` };
    }

    if (!TYPES.includes(item.type)) {
      return { valid: false, error: `${item.id} has an invalid type.` };
    }

    if (!item.parentId || typeof item.parentId !== "string") {
      return { valid: false, error: `${item.id} needs a parent.` };
    }

    if (
      item.category !== undefined &&
      !CATEGORIES.includes(normalizeEnum(item.category, CATEGORIES, ""))
    ) {
      return { valid: false, error: `${item.id} has an invalid category.` };
    }

    if (
      item.priority !== undefined &&
      !PRIORITIES.includes(normalizeEnum(item.priority, PRIORITIES, ""))
    ) {
      return { valid: false, error: `${item.id} has an invalid priority.` };
    }

    if (
      item.docketState !== undefined &&
      !DOCKET_STATES.includes(normalizeEnum(item.docketState, DOCKET_STATES, ""))
    ) {
      return { valid: false, error: `${item.id} has an invalid docket state.` };
    }

    if (item.type === "story" && normalizeNumber(item.storyPoints) === null) {
      return { valid: false, error: `${item.id} has invalid story points.` };
    }

    if ((item.type === "story" || item.type === "job") && item.worklogs) {
      if (!Array.isArray(item.worklogs)) {
        return { valid: false, error: `${item.id} worklogs must be an array.` };
      }

      for (let index = 0; index < item.worklogs.length; index += 1) {
        const error = validateWorklog(item.worklogs[index], index, item.id);
        if (error) return { valid: false, error };
      }
    }

    if ((item.type === "story" || item.type === "job") && item.timeMinutes !== undefined) {
      if (normalizeNumber(item.timeMinutes) === null) {
        return { valid: false, error: `${item.id} has invalid time.` };
      }
    }

    if (item.createdAt !== undefined && !isValidIsoDate(item.createdAt)) {
      return { valid: false, error: `${item.id} has invalid createdAt.` };
    }

    if (item.updatedAt !== undefined && !isValidIsoDate(item.updatedAt)) {
      return { valid: false, error: `${item.id} has invalid updatedAt.` };
    }
  }

  for (const item of snapshot.workItems) {
    const parentType =
      item.parentId === ROOT_ID ? ROOT_ID : itemById.get(item.parentId)?.type;

    if (!parentType || !RELATIONSHIPS[parentType].includes(item.type)) {
      return {
        valid: false,
        error: `${item.id} has an invalid parent relationship.`,
      };
    }

    const visited = new Set([item.id]);
    let parentId = item.parentId;

    while (parentId && parentId !== ROOT_ID) {
      if (visited.has(parentId)) {
        return { valid: false, error: `${item.id} is part of a cycle.` };
      }

      visited.add(parentId);
      parentId = itemById.get(parentId)?.parentId;
    }
  }

  return { valid: true, error: "" };
}

async function getGitHubFile(config) {
  let response;

  try {
    response = await fetch(`${githubFileUrl(config)}?ref=${encodeURIComponent(config.branch)}`, {
      headers: githubHeaders(config.token),
    });
  } catch (error) {
    throw githubFetchError(error);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 404) {
      throw Object.assign(new Error("GitHub data file was not found."), {
        statusCode: 404,
      });
    }

    throw Object.assign(new Error(payload?.message || "GitHub load failed."), {
      statusCode: response.status,
    });
  }

  if (!payload?.sha || typeof payload.content !== "string") {
    throw Object.assign(new Error("GitHub file response was malformed."), {
      statusCode: 502,
    });
  }

  return payload;
}

async function loadSnapshot(config) {
  const file = await getGitHubFile(config);
  let snapshot;

  try {
    snapshot = JSON.parse(decodeBase64(file.content));
  } catch {
    throw Object.assign(new Error("GitHub worklog JSON is malformed."), {
      statusCode: 502,
    });
  }

  const validation = validateSnapshot(snapshot);

  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), {
      statusCode: 502,
    });
  }

  return {
    snapshot,
    sha: file.sha,
  };
}

async function parseBody(event) {
  const rawBody = event.body || "";
  const size = Buffer.byteLength(rawBody, event.isBase64Encoded ? "base64" : "utf8");

  if (size > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Snapshot payload is too large."), {
      statusCode: 413,
    });
  }

  try {
    return JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(rawBody, "base64").toString("utf8")
        : rawBody
    );
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      statusCode: 400,
    });
  }
}

async function saveSnapshot(event, config) {
  const body = await parseBody(event);

  if (!body?.snapshot || typeof body.baseSha !== "string" || !body.baseSha) {
    return safeError(400, "snapshot and baseSha are required.");
  }

  const validation = validateSnapshot(body.snapshot);

  if (!validation.valid) {
    return safeError(400, validation.error);
  }

  const current = await getGitHubFile(config);

  if (current.sha !== body.baseSha) {
    return safeError(409, "Remote worklog changed since you loaded it.");
  }

  const content = `${JSON.stringify(body.snapshot, null, 2)}\n`;
  let response;

  try {
    response = await fetch(githubFileUrl(config), {
      method: "PUT",
      headers: {
        ...githubHeaders(config.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: body.commitMessage || "worklog: save snapshot",
        content: encodeBase64(content),
        sha: current.sha,
        branch: config.branch,
      }),
    });
  } catch (error) {
    throw githubFetchError(error);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return safeError(response.status, payload?.message || "GitHub save failed.");
  }

  const newSha = payload?.content?.sha;

  if (!newSha) {
    return safeError(502, "GitHub save response was malformed.");
  }

  return json(200, {
    snapshot: body.snapshot,
    sha: newSha,
  });
}

export async function handler(event) {
  const env = requiredEnv();

  if (!env.ok) {
    return safeError(
      500,
      "Worklog GitHub storage is not configured.",
      env.missing
    );
  }

  try {
    if (event.httpMethod === "GET") {
      const result = await loadSnapshot(env.config);
      return json(200, result);
    }

    if (event.httpMethod === "PUT") {
      return await saveSnapshot(event, env.config);
    }

    return safeError(405, "Method not allowed.");
  } catch (error) {
    logWorklogError(`${event.httpMethod || "UNKNOWN"} /.netlify/functions/worklog`, error);
    return safeError(error.statusCode || 500, error.message || "Worklog request failed.");
  }
}
