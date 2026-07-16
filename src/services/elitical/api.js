import { authHeaders, getStoredSession } from "./auth.js";

const DEFAULT_BASE_URL = "/api/elitical";
const DEFAULT_CACHE_TTL_MS = 30_000;

function envBaseUrl() {
  return import.meta.env?.VITE_ELITICAL_API_BASE_URL || DEFAULT_BASE_URL;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function withQuery(path, query) {
  const entries = Object.entries(query || {}).filter(([, value]) =>
    value !== undefined && value !== null && value !== ""
  );

  if (entries.length === 0) return path;

  const params = new URLSearchParams();
  entries.forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
      return;
    }

    params.set(key, value);
  });

  return `${path}?${params.toString()}`;
}

export const endpoints = {
  projects: () => "/projects",
  project: (projectId) => `/projects/${encodePathSegment(projectId)}`,
  sprints: (projectId) => `/projects/${encodePathSegment(projectId)}/sprints`,
  sprint: (sprintId) => `/sprints/${encodePathSegment(sprintId)}`,
  currentEmployee: () => "/session/employee",
  assignedProject: () => "/session/project",
  currentSprint: () => "/session/sprint",
  assignedEpics: () => "/session/epics",
  assignedStories: () => "/session/stories",
  assignedJobs: () => "/session/jobs",
  assignedWorklogs: () => "/session/worklogs",
  docket: (docketId) => `/dockets/${encodePathSegment(docketId)}`,
  childDockets: (docketId) => `/dockets/${encodePathSegment(docketId)}/children`,
  docketState: (docketId) => `/dockets/${encodePathSegment(docketId)}/state`,
  worklogs: (docketId) => `/dockets/${encodePathSegment(docketId)}/worklogs`,
  worklog: (worklogId) => `/worklogs/${encodePathSegment(worklogId)}`,
  employees: (projectId) => `/projects/${encodePathSegment(projectId)}/employees`,
};

export class EliticalApiError extends Error {
  constructor(message, { status = 0, payload = null, endpoint = "" } = {}) {
    super(message);
    this.name = "EliticalApiError";
    this.status = status;
    this.payload = payload;
    this.endpoint = endpoint;
  }
}

async function parseResponse(response, endpoint) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    throw new EliticalApiError(
      payload?.error ||
        payload?.message ||
        `Elitical request failed (${response.status}).`,
      {
        status: response.status,
        payload,
        endpoint,
      }
    );
  }

  return payload;
}

export function createEliticalApiClient({
  baseUrl = envBaseUrl(),
  fetchImpl = fetch,
  getSession = getStoredSession,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  const responseCache = new Map();
  const normalizedBaseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

  function cacheKey(method, endpoint) {
    return `${method}:${endpoint}`;
  }

  function readCache(key) {
    const cached = responseCache.get(key);

    if (!cached || cached.expiresAt < Date.now()) {
      responseCache.delete(key);
      return null;
    }

    return cached.value;
  }

  function writeCache(key, value) {
    responseCache.set(key, {
      value,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  async function request(method, path, {
    body,
    query,
    headers = {},
    cache = method === "GET",
    signal,
  } = {}) {
    const endpoint = withQuery(path, query);
    const key = cacheKey(method, endpoint);

    if (cache) {
      const cached = readCache(key);
      if (cached) return cached;
    }

    const response = await fetchImpl(`${normalizedBaseUrl}${endpoint}`, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(getSession()),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await parseResponse(response, endpoint);

    if (cache) writeCache(key, payload);

    return payload;
  }

  return {
    get: (path, options) => request("GET", path, options),
    post: (path, body, options) => request("POST", path, { ...options, body, cache: false }),
    put: (path, body, options) => request("PUT", path, { ...options, body, cache: false }),
    delete: (path, options) => request("DELETE", path, { ...options, cache: false }),
    clearCache: () => responseCache.clear(),
  };
}

export const eliticalApiClient = createEliticalApiClient();
