/* global Buffer, process */

import { EliticalAuthService } from "../../src/services/elitical/auth/index.ts";
import { EliticalClient } from "../../src/services/elitical/client/index.ts";
import { EliticalProvider } from "../../src/services/elitical/provider/index.ts";

const ELITICAL_BASE_URL =
  process.env.ELITICAL_BASE_URL || "https://elitical.sayukth.com";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

let latestExtensionSync = null;
let productionProviderPromise = null;
let productionReadModelPromise = null;
let productionReadModelExpiresAt = 0;
let productionWorklogsPromise = null;
let productionWorklogsExpiresAt = 0;

const PRODUCTION_READ_CACHE_TTL_MS = 60_000;
const PRODUCTION_WORKLOG_DEADLINE_MS = 10_000;

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      ...JSON_HEADERS,
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function noContent(headers = {}) {
  return {
    statusCode: 204,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
    body: "",
  };
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

function requestPath(event) {
  const rawPath = event.path || "";
  const path = rawPath
    .replace(/^\/api\/elitical/, "")
    .replace(/^\/.netlify\/functions\/elitical/, "");

  return path || "/";
}

function authHeaders(headers = {}) {
  const authorization = headers.authorization || headers.Authorization || "";
  const sJwtToken = headers["s-jwt-token"] || headers["S-Jwt-Token"] || "";

  return {
    ...(authorization ? { Authorization: authorization } : {}),
    ...(sJwtToken ? { "s-jwt-token": sJwtToken } : {}),
  };
}

function hasAuth(headers) {
  return Boolean(headers.Authorization || headers["s-jwt-token"]);
}

function sanitizeError(error) {
  return {
    message: error?.message || "Unknown Elitical bridge error",
    status: error?.status || 0,
    endpoint: error?.endpoint || "",
  };
}

function parseJsonBody(event) {
  if (!event.body) return null;

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  return JSON.parse(raw);
}

function containsSecretKey(value) {
  const secretKeyPattern = /(token|cookie|authorization|password|secret|sessionid)/i;

  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(
    ([key, entry]) => secretKeyPattern.test(key) || containsSecretKey(entry)
  );
}

function validateExtensionPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Payload must be a JSON object.";
  }

  if (payload.source !== "elitical-worklog-extension") {
    return "Invalid extension payload source.";
  }

  if (payload.schemaVersion !== 1) {
    return "Unsupported extension payload schema version.";
  }

  if (!payload.employee?.id) {
    return "Authenticated employee id is required.";
  }

  if (containsSecretKey(payload)) {
    return "Payload must not contain authentication tokens, cookies, or credentials.";
  }

  return "";
}

function normalizedExtensionPayload(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    source: payload.source,
    receivedAt: new Date().toISOString(),
    syncedAt: payload.syncedAt || "",
    employee: payload.employee,
    project: payload.project || null,
    sprint: payload.sprint || null,
    epics: Array.isArray(payload.epics) ? payload.epics : [],
    stories: Array.isArray(payload.stories) ? payload.stories : [],
    jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
    worklogs: Array.isArray(payload.worklogs) ? payload.worklogs : [],
    counts: payload.counts || {},
  };
}

async function handleExtensionSync(event) {
  if (event.httpMethod === "OPTIONS") {
    return noContent({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Worklog-Extension",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
  }

  if (event.httpMethod === "GET") {
    return response(200, latestExtensionSync || { status: "empty" }, {
      "Access-Control-Allow-Origin": "*",
    });
  }

  if (event.httpMethod !== "POST") {
    return response(405, {
      error: "Method Not Allowed",
    });
  }

  if (event.headers["x-worklog-extension"] !== "elitical-phase1") {
    return response(403, {
      error: "Forbidden",
      message: "Missing Worklog extension marker.",
    });
  }

  let payload;

  try {
    payload = parseJsonBody(event);
  } catch {
    return response(400, {
      error: "Invalid JSON",
      message: "Extension sync payload must be valid JSON.",
    });
  }

  const validationError = validateExtensionPayload(payload);

  if (validationError) {
    return response(400, {
      error: "Invalid extension payload",
      message: validationError,
    });
  }

  latestExtensionSync = normalizedExtensionPayload(payload);

  console.info("[elitical] extension sync accepted", {
    employeeId: latestExtensionSync.employee.id,
    projectId: latestExtensionSync.project?.id || "",
    sprintId: latestExtensionSync.sprint?.id || "",
    counts: latestExtensionSync.counts,
  });

  return response(202, {
    status: "accepted",
    receivedAt: latestExtensionSync.receivedAt,
    counts: latestExtensionSync.counts,
  }, {
    "Access-Control-Allow-Origin": "*",
  });
}

async function readPayload(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }

  return response.text().catch(() => "");
}

async function eliticalRequest(endpoint, {
  method = "GET",
  query,
  body,
  auth,
} = {}) {
  const url = new URL(endpoint, ELITICAL_BASE_URL);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const upstream = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...auth,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await readPayload(upstream);

  if (!upstream.ok) {
    const error = new Error(
      payload?.message ||
        payload?.error ||
        `Elitical request failed (${upstream.status})`
    );
    error.status = upstream.status;
    error.endpoint = endpoint;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function asArray(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.docketList)) return payload.docketList;
  if (payload?.docketListMap && typeof payload.docketListMap === "object") {
    return Object.values(payload.docketListMap).flatMap((value) =>
      Array.isArray(value) ? value : []
    );
  }
  return [];
}

function firstString(...values) {
  const value = values.find(
    (entry) => entry !== undefined && entry !== null && String(entry) !== ""
  );

  return value === undefined || value === null ? "" : String(value);
}

function officialId(item) {
  return firstString(item?.id, item?.docketId, item?.dktId, item?.cx);
}

async function productionProvider() {
  if (!productionProviderPromise) {
    productionProviderPromise = (async () => {
      const authService = new EliticalAuthService({
        baseUrl: ELITICAL_BASE_URL,
        dataDir: process.env.ELITICAL_DATA_DIR || undefined,
        storageStatePath: process.env.ELITICAL_STORAGE_STATE_PATH || undefined,
      });

      await authService.initialize();

      return new EliticalProvider(new EliticalClient(authService));
    })();
  }

  return productionProviderPromise;
}

async function productionReadModel(provider) {
  const now = Date.now();

  if (productionReadModelPromise && now < productionReadModelExpiresAt) {
    return productionReadModelPromise;
  }

  productionReadModelExpiresAt = now + PRODUCTION_READ_CACHE_TTL_MS;
  productionReadModelPromise = (async () => {
    const projects = await provider.getProjects();
    const project = projects[0] || null;
    const projectId = firstString(project?.id, project?.projectId, project?.cx);
    const [sprints, issues] = projectId
      ? await Promise.all([
          provider.getSprints(projectId),
          provider.getIssues(projectId),
        ])
      : [[], []];
    const sprint = sprints[0] || null;

    return {
      projects,
      project,
      projectId,
      sprints,
      sprint,
      issues,
    };
  })();

  try {
    return await productionReadModelPromise;
  } catch (error) {
    productionReadModelPromise = null;
    productionReadModelExpiresAt = 0;
    throw error;
  }
}

async function productionProject(provider) {
  const { project } = await productionReadModel(provider);

  return project;
}

async function productionProjectId(provider) {
  const { projectId } = await productionReadModel(provider);

  return projectId;
}

async function productionSprint(provider) {
  const { sprint } = await productionReadModel(provider);

  return sprint;
}

async function productionIssues(provider) {
  const { issues } = await productionReadModel(provider);

  return issues;
}

async function productionDockets(provider, type) {
  const issues = await productionIssues(provider);

  return issues.filter((issue) => issue.type === type);
}

async function productionWorklogs(provider) {
  const now = Date.now();

  if (productionWorklogsPromise && now < productionWorklogsExpiresAt) {
    return productionWorklogsPromise;
  }

  productionWorklogsExpiresAt = now + PRODUCTION_READ_CACHE_TTL_MS;
  productionWorklogsPromise = (async () => {
    const issues = await productionIssues(provider);
    const worklogGroups = [];
    const deadline = Date.now() + PRODUCTION_WORKLOG_DEADLINE_MS;

    for (const issue of issues) {
      if (Date.now() >= deadline) break;

      const docketId = officialId(issue);

      if (!docketId) {
        worklogGroups.push([]);
        continue;
      }

      try {
        worklogGroups.push(await provider.getWorklogs(docketId));
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          worklogGroups.push([]);
          continue;
        }

        throw error;
      }
    }

    return worklogGroups.flat();
  })();

  try {
    return await productionWorklogsPromise;
  } catch (error) {
    productionWorklogsPromise = null;
    productionWorklogsExpiresAt = 0;
    throw error;
  }
}

function typeValue(...values) {
  const value = values.find(
    (entry) => entry !== undefined && entry !== null && String(entry) !== ""
  );

  if (!value || typeof value !== "object") return firstString(value);

  return firstString(
    value.name,
    value.type,
    value.code,
    value.value,
    value.label,
    value.displayName,
    value.title
  );
}

function itemType(item) {
  const normalized = typeValue(
    item?.type,
    item?.docketType,
    item?.dktType,
    item?.docketTypeName,
    item?.dktTypeName,
    item?.issueType,
    item?.workItemType
  )
    .toLowerCase()
    .replace(/^dockettype\./, "")
    .replace(/[^a-z0-9]+/g, "");

  if (normalized.includes("epic")) return "epic";
  if (normalized.includes("story")) return "story";
  if (
    normalized.includes("job") ||
    normalized.includes("task") ||
    normalized.includes("ticket") ||
    normalized.includes("bug") ||
    normalized.includes("work")
  ) {
    return "job";
  }

  return normalized;
}

async function currentSession(auth) {
  return eliticalRequest("/api/1/UserSessionDto", { auth });
}

async function currentEmployee(auth) {
  const session = await currentSession(auth);
  const employeeId = session?.employeeId || session?.empId || "";

  if (!employeeId) return session;

  try {
    return await eliticalRequest("/api/1/Employee", {
      auth,
      query: { id: employeeId },
    });
  } catch (error) {
    console.warn("[elitical] employee lookup fell back to session payload", {
      status: error.status,
      endpoint: error.endpoint,
    });
    return session;
  }
}

async function assignedProjects(auth) {
  return asArray(await eliticalRequest("/api/1/Project/user", { auth }));
}

async function assignedProject(auth) {
  const projects = await assignedProjects(auth);

  return projects[0] || null;
}

async function currentSprint(auth) {
  const project = await assignedProject(auth);
  const projectId = project?.id || project?.projectId || project?.cx || "";

  if (!projectId) return null;

  const payload = await eliticalRequest("/api/1/Sprint/activeList/projectId", {
    auth,
    query: { projectId },
  });

  return asArray(payload, "sprintList")[0] || null;
}

async function sprintBoard(auth) {
  const project = await assignedProject(auth);
  const projectId = project?.id || project?.projectId || project?.cx || "";
  const sprint = await currentSprint(auth);
  const sprintId = sprint?.id || sprint?.sprintId || sprint?.cx || "";

  if (!projectId) return [];

  const payload = await eliticalRequest("/api/1/SprintBoard", {
    auth,
    query: { projectId, sprintId },
  });

  return asArray(payload, "docketList");
}

async function assignedDockets(auth, type) {
  const dockets = await sprintBoard(auth);

  return dockets.filter((item) => itemType(item) === type);
}

async function assignedWorklogs(auth) {
  const session = await currentSession(auth);
  const project = await assignedProject(auth);
  const employeeId = session?.employeeId || session?.empId || "";
  const projectId = project?.id || project?.projectId || project?.cx || "";
  const today = new Date().toISOString().slice(0, 10);

  if (!employeeId || !projectId) return [];

  return asArray(
    await eliticalRequest("/api/1/Worklog/employee", {
      auth,
      query: { employeeId, projectId, worklogDate: today },
    }),
    "worklogs"
  );
}

async function sessionRoute(path, auth) {
  if (path === "/session/employee") return currentEmployee(auth);
  if (path === "/session/project") return assignedProject(auth);
  if (path === "/session/sprint") return currentSprint(auth);
  if (path === "/session/epics") return assignedDockets(auth, "epic");
  if (path === "/session/stories") return assignedDockets(auth, "story");
  if (path === "/session/jobs") return assignedDockets(auth, "job");
  if (path === "/session/worklogs") return assignedWorklogs(auth);

  return null;
}

async function productionSessionRoute(path) {
  const provider = await productionProvider();

  if (path === "/session/employee") return {};
  if (path === "/session/project") return productionProject(provider);
  if (path === "/session/sprint") return productionSprint(provider);
  if (path === "/session/epics") return productionDockets(provider, "epic");
  if (path === "/session/stories") return productionDockets(provider, "story");
  if (path === "/session/jobs") return productionDockets(provider, "job");
  if (path === "/session/worklogs") return productionWorklogs(provider);

  return null;
}

export async function handler(event) {
  const path = requestPath(event);

  if (event.httpMethod === "GET" && path === "/login") {
    return redirect(new URL("/auth/login", ELITICAL_BASE_URL).toString());
  }

  if (path === "/extension-sync") {
    return handleExtensionSync(event);
  }

  const auth = authHeaders(event.headers);

  if (!hasAuth(auth)) {
    try {
      const payload = await productionSessionRoute(path);

      if (payload !== null) return response(200, payload);
    } catch (error) {
      const safeError = sanitizeError(error);

      console.error("[elitical] production provider request failed", safeError);

      return response(error.status || 502, {
        error:
          error.status === 401 || error.status === 403
            ? "Session Expired"
            : "Elitical request failed",
        message: error.message || "Unable to reach Elitical.",
        endpoint: error.endpoint || "",
      });
    }

    return response(401, {
      error: "Authentication Required",
      message:
        "Elitical uses its own HRMS login and does not expose an OAuth callback to this app. Authenticate at Elitical first, then connect through an approved session bridge/token exchange.",
      loginUrl: new URL("/auth/login", ELITICAL_BASE_URL).toString(),
    });
  }

  try {
    const payload = await sessionRoute(path, auth);

    if (payload !== null) return response(200, payload);

    return response(404, {
      error: "Unknown Elitical bridge route",
      path,
    });
  } catch (error) {
    const safeError = sanitizeError(error);

    console.error("[elitical] bridge request failed", safeError);

    return response(error.status || 502, {
      error:
        error.status === 401 || error.status === 403
          ? "Session Expired"
          : "Elitical request failed",
      message: error.message || "Unable to reach Elitical.",
      endpoint: error.endpoint || "",
    });
  }
}
