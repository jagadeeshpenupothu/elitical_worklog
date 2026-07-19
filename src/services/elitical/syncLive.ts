import { loadEnvFile } from "node:process";
import { importEliticalLiveData } from "./importer/index.js";

const TARGET_PROJECT_CODE = "DES";
const TARGET_PROJECT_NAME = "UX Designer";
const DETAIL_RETRY_ATTEMPTS = 3;
const HIERARCHY_FIELDS = [
  "epicId",
  "epicName",
  "epicNum",
  "storyId",
  "storyName",
  "storyNum",
  "parentId",
] as const;

type ProgressPhase =
  | "authenticating"
  | "loading-project"
  | "loading-sprints"
  | "fetching-issues"
  | "fetching-details"
  | "fetching-worklogs"
  | "normalizing"
  | "complete";

export type EliticalLiveSyncProgress = {
  phase: ProgressPhase;
  message: string;
  current?: number;
  total?: number;
};

function maskSecret(value: string | undefined) {
  if (!value) return "";
  if (value.length <= 8) return "***";

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function logRuntimeConfiguration(stage: string) {
  console.info("[EliticalSyncLive] runtime configuration", {
    stage,
    cwd: process.cwd(),
    envPath: process.env.ELITICAL_ENV_PATH || ".env",
    baseUrl: process.env.ELITICAL_BASE_URL || "(default)",
    dataDir: process.env.ELITICAL_DATA_DIR || "",
    storageStatePath: process.env.ELITICAL_STORAGE_STATE_PATH || "",
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || "",
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    githubToken: maskSecret(process.env.GITHUB_TOKEN),
    hasGithubOwner: Boolean(process.env.GITHUB_DATA_OWNER),
    hasGithubRepo: Boolean(process.env.GITHUB_DATA_REPO),
  });
}

export type EliticalLiveSyncOptions = {
  writeOutput?: boolean;
  onProgress?: (progress: EliticalLiveSyncProgress) => void;
  previousGraph?: Record<string, unknown> | null;
  syncIndex?: EliticalSyncIndex | null;
  cachedWorklogs?: EliticalWorklogCache | null;
};

type ClosableAuthService = {
  close: () => Promise<void>;
};

type DocketTimestampIndexEntry = {
  docketId: string;
  modifiedTimestamp: string;
  createdTimestamp: string;
  fingerprint?: string;
};

export type EliticalSyncIndex = {
  lastSuccessfulSync?: string;
  projectId?: string;
  dockets?: Record<string, DocketTimestampIndexEntry>;
};

type DetailFetchResult = {
  details: Array<{ id: string; detail: Record<string, unknown> | null }>;
  successfulDetailRequests: number;
  failedDetailRequests: number;
};

export type NormalizedEliticalWorklog = {
  id: string;
  docketId: string;
  projectId: string;
  projectName: string;
  docketType: string;
  docketNumber: string;
  docketTitle: string;
  employeeId: string;
  employeeName: string;
  worklogDate: string;
  durationMinutes: number;
  comment: string;
  raw: Record<string, unknown>;
};

export type EliticalWorklogCache = {
  version: number;
  lastSync: string;
  totalWorklogs: number;
  worklogs: NormalizedEliticalWorklog[];
};

type WorklogFetchResult = {
  worklogs: NormalizedEliticalWorklog[];
  requestedDockets: number;
  successfulRequests: number;
  failedRequests: number;
  reusedDockets: number;
};

async function loadRuntimeModules() {
  try {
    const [
      { EliticalAuthService },
      { EliticalClient },
      { EliticalProvider },
    ] = await Promise.all([
      import("./auth/index.js"),
      import("./client/index.js"),
      import("./provider/index.js"),
    ]);

    console.info("[EliticalSyncLive] runtime modules loaded", {
      auth: Boolean(EliticalAuthService),
      client: Boolean(EliticalClient),
      provider: Boolean(EliticalProvider),
    });

    return {
      EliticalAuthService,
      EliticalClient,
      EliticalProvider,
    };
  } catch (error) {
    console.error("[EliticalSyncLive] runtime module import failed", {
      name: error instanceof Error ? error.name : "",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "",
    });

    throw error;
  }
}

function loadEnv() {
  const envPath = process.env.ELITICAL_ENV_PATH || ".env";

  try {
    loadEnvFile(envPath);
    console.info("[EliticalSyncLive] environment file loaded", { envPath });
  } catch (error) {
    console.info("[EliticalSyncLive] environment file not loaded", {
      envPath,
      message: error instanceof Error ? error.message : String(error),
    });
    // Environment files are optional in deployed environments.
  }
}

function projectId(project: { id?: string; projectId?: string; cx?: string }) {
  return String(project.id || project.projectId || project.cx || "");
}

function docketId(docket: { id?: string; docketId?: string; dktId?: string; cx?: string }) {
  return String(docket.id || docket.docketId || docket.dktId || docket.cx || "");
}

function docketType(docket: { type?: string }) {
  return String(docket.type || "").toUpperCase();
}

function docketNumber(docket: Record<string, unknown>) {
  return String(docket.num || docket.docketNum || "");
}

function docketTitle(docket: Record<string, unknown>) {
  return String(docket.title || docket.docketName || docket.num || docket.id || "");
}

function isGraphDocketType(type: string) {
  return type === "EPIC" || type === "STORY" || type === "JOB" || type === "TASK";
}

function requiresDocketDetail(type: string) {
  return type === "STORY" || type === "JOB" || type === "TASK";
}

function timestampValue(docket: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = docket[key];

    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value);
    }
  }

  return "";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value ?? "");
}

function issueFingerprint(docket: Record<string, unknown>) {
  return stableStringify({
    id: docketId(docket),
    type: docketType(docket),
    num: docketNumber(docket),
    title: firstText(docket.title, docket.docketName),
    descr: firstText(docket.descr, docket.description),
    projectId: firstText(docket.projectId),
    sprintId: firstText(docket.sprintId),
    epicId: firstText(docket.epicId),
    storyId: firstText(docket.storyId),
    parentId: firstText(docket.parentId, docket.parentDocketId),
    stateId: firstText(docket.dktStateId, docket.stateId),
    stateName: firstText(docket.dktStateName, docket.docketState, docket.status),
    priority: firstText(docket.priority),
    category: firstText(docket.category),
    assigneeId: firstText(docket.assigneeId),
    storyPointEst: firstText(docket.storyPointEst, docket.storyPoints, docket.estimatedStoryPoints),
    updated: modifiedTimestamp(docket),
  });
}

function modifiedTimestamp(docket: Record<string, unknown>) {
  return timestampValue(docket, [
    "modifiedTime",
    "modifiedDate",
    "updatedTime",
    "updatedDate",
    "sortedTime",
    "createdTime",
    "createdDate",
  ]);
}

function createdTimestamp(docket: Record<string, unknown>) {
  return timestampValue(docket, ["createdTime", "createdDate"]);
}

function buildSyncIndex({
  projectId: targetProjectId,
  issues,
  syncedAt,
}: {
  projectId: string;
  issues: unknown[];
  syncedAt: string;
}): EliticalSyncIndex {
  const dockets: Record<string, DocketTimestampIndexEntry> = {};

  issues.forEach((issue) => {
    const record = issue as Record<string, unknown>;
    const id = docketId(record);

    if (!id) return;

    dockets[id] = {
      docketId: id,
      modifiedTimestamp: modifiedTimestamp(record),
      createdTimestamp: createdTimestamp(record),
      fingerprint: issueFingerprint(record),
    };
  });

  return {
    lastSuccessfulSync: syncedAt,
    projectId: targetProjectId,
    dockets,
  };
}

function previousHierarchyById(previousGraph?: Record<string, unknown> | null) {
  const byId = new Map<string, Record<string, unknown>>();

  ["epics", "stories", "jobs", "tasks"].forEach((key) => {
    const items = previousGraph?.[key];

    if (!Array.isArray(items)) return;

    items.forEach((item) => {
      if (!item || typeof item !== "object") return;

      const record = item as Record<string, unknown>;
      const id = docketId(record);

      if (id) byId.set(id, record);
    });
  });

  return byId;
}

function hasReusableHierarchy(issue: unknown, previousHierarchy: Map<string, Record<string, unknown>>) {
  const record = issue as Record<string, unknown>;

  if (docketType(record) === "EPIC") return true;

  const previous = previousHierarchy.get(docketId(record));

  if (!previous) return false;

  if (docketType(record) === "STORY") {
    return Boolean(previous.epicId || previous.parentId);
  }

  if (docketType(record) === "JOB") {
    return Boolean(previous.storyId || previous.parentId);
  }

  if (docketType(record) === "TASK") {
    return Boolean(previous.parentId || previous.storyId || previous.epicId);
  }

  return false;
}

function classifyIssues({
  issues,
  syncIndex,
}: {
  issues: unknown[];
  syncIndex: EliticalSyncIndex;
}) {
  const indexDockets = syncIndex.dockets || {};
  const created: unknown[] = [];
  const modified: unknown[] = [];
  const unchanged: unknown[] = [];

  issues.forEach((issue) => {
    const record = issue as Record<string, unknown>;
    const id = docketId(record);
    const previous = indexDockets[id];

    if (!previous) {
      created.push(issue);
      return;
    }

    if (
      previous.modifiedTimestamp !== modifiedTimestamp(record) ||
      (previous.fingerprint && previous.fingerprint !== issueFingerprint(record))
    ) {
      modified.push(issue);
      return;
    }

    unchanged.push(issue);
  });

  return {
    newIssues: created,
    modifiedIssues: modified,
    unchangedIssues: unchanged,
  };
}

function baselineStatus({
  syncIndex,
  targetProjectId,
  previousGraph,
}: {
  syncIndex: EliticalSyncIndex | null;
  targetProjectId: string;
  previousGraph?: Record<string, unknown> | null;
}) {
  const docketCount = Object.keys(syncIndex?.dockets || {}).length;
  const hierarchyCount = previousHierarchyById(previousGraph).size;

  if (!syncIndex) return { valid: false, reason: "no-baseline", docketCount, hierarchyCount };
  if (!syncIndex.projectId) return { valid: false, reason: "baseline-missing-project", docketCount, hierarchyCount };
  if (syncIndex.projectId !== targetProjectId) {
    return { valid: false, reason: "baseline-project-mismatch", docketCount, hierarchyCount };
  }
  if (!docketCount) return { valid: false, reason: "baseline-empty-docket-index", docketCount, hierarchyCount };
  if (!hierarchyCount) return { valid: false, reason: "baseline-missing-cached-hierarchy", docketCount, hierarchyCount };

  return { valid: true, reason: "valid-baseline", docketCount, hierarchyCount };
}

function mergeHierarchyFields<T extends Record<string, unknown>>(
  docket: T,
  detail: Record<string, unknown>
) {
  const merged: Record<string, unknown> = { ...docket };

  HIERARCHY_FIELDS.forEach((field) => {
    const value = detail[field];

    if (value !== undefined && value !== null && String(value).trim()) {
      merged[field] = value;
    }
  });

  return merged as T;
}

async function fetchDocketDetails({
  client,
  targets,
  progress,
}: {
  client: { getDocket: (id: string) => Promise<unknown> };
  targets: unknown[];
  progress: (next: EliticalLiveSyncProgress) => void;
}): Promise<DetailFetchResult> {
  let successfulDetailRequests = 0;
  let failedDetailRequests = 0;
  const details: Array<{ id: string; detail: Record<string, unknown> | null }> = [];

  for (let index = 0; index < targets.length; index += 1) {
    const issue = targets[index];
    const id = docketId(issue as Record<string, unknown>);
    let lastError: unknown = null;

    progress({
      phase: "fetching-details",
      message: `Fetching Docket Details (${index + 1} / ${targets.length})...`,
      current: index + 1,
      total: targets.length,
    });

    for (let attempt = 1; attempt <= DETAIL_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const detail = await client.getDocket(id);
        successfulDetailRequests += 1;
        details.push({ id, detail: detail as Record<string, unknown> });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      failedDetailRequests += 1;
      details.push({ id, detail: null });
    }
  }

  return {
    details,
    successfulDetailRequests,
    failedDetailRequests,
  };
}

function enrichIssuesFromDetails(
  issues: unknown[],
  details: Array<{ id: string; detail: Record<string, unknown> | null }>,
  previousHierarchy = new Map<string, Record<string, unknown>>()
) {
  const detailById = new Map(
    details
      .filter((entry) => entry.detail)
      .map((entry) => [entry.id, entry.detail as Record<string, unknown>])
  );

  return issues.map((issue) => {
    const record = issue as Record<string, unknown>;
    const id = docketId(record);
    const detail = detailById.get(id);
    const previous = previousHierarchy.get(id);

    if (detail) return mergeHierarchyFields(record, detail);
    if (previous) return mergeHierarchyFields(record, previous);

    return issue;
  });
}

function countsFor(output: {
  projects: unknown[];
  sprints: unknown[];
  epics: unknown[];
  stories: unknown[];
  jobs: unknown[];
  tasks?: unknown[];
  filteredOut?: unknown;
}) {
  return {
    projects: output.projects.length,
    sprints: output.sprints.length,
    epics: output.epics.length,
    stories: output.stories.length,
    jobs: output.jobs.length,
    tasks: output.tasks?.length || 0,
    filteredOut: output.filteredOut,
  };
}

function elapsedSince(startedAt: number) {
  return Date.now() - startedAt;
}

function firstText(...values: unknown[]) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function firstNumber(...values: unknown[]) {
  const match = values.find((value) => Number.isFinite(Number(value)));

  return match === undefined ? 0 : Number(match);
}

function isoDate(value: unknown) {
  if (value === undefined || value === null || value === "") return "";

  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }

  const parsed = new Date(String(value));

  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function cachedWorklogsByDocket(cache?: EliticalWorklogCache | null) {
  const byDocket = new Map<string, NormalizedEliticalWorklog[]>();

  if (!Array.isArray(cache?.worklogs)) return byDocket;

  cache.worklogs.forEach((worklog) => {
    if (!worklog?.docketId) return;

    const existing = byDocket.get(worklog.docketId) || [];

    existing.push(worklog);
    byDocket.set(worklog.docketId, existing);
  });

  return byDocket;
}

function normalizeWorklog(
  worklog: Record<string, unknown>,
  docket: Record<string, unknown>,
  fallbackProjectId: string,
  fallbackProjectName: string
): NormalizedEliticalWorklog {
  const id = firstText(worklog.id, worklog.worklogId, worklog.cx);
  const sourceDocketId = firstText(worklog.docketId, docketId(docket));
  const hour = firstNumber(worklog.hour, worklog.hours, worklog.loggedHours);
  const min = firstNumber(worklog.min, worklog.minutes, worklog.loggedMinutes);
  const durationMinutes = Math.round(hour * 60 + min);

  return {
    id: id || `${sourceDocketId}-${firstText(worklog.worklogDate, worklog.date)}-${firstText(worklog.comment, worklog.description)}`,
    docketId: sourceDocketId,
    projectId: firstText(worklog.projectId, docket.projectId, fallbackProjectId),
    projectName: firstText(worklog.projectName, fallbackProjectName),
    docketType: firstText(worklog.docketType, docketType(docket as { type?: string })),
    docketNumber: firstText(worklog.docketNum, docketNumber(docket)),
    docketTitle: firstText(worklog.docketName, docketTitle(docket)),
    employeeId: firstText(worklog.employeeId, worklog.empId),
    employeeName: firstText(worklog.employeeName),
    worklogDate: isoDate(firstText(worklog.worklogDate, worklog.date, worklog.createdDate)),
    durationMinutes,
    comment: firstText(worklog.comment, worklog.description, worklog.note),
    raw: worklog,
  };
}

async function fetchWorklogs({
  provider,
  issues,
  refreshTargets,
  cachedWorklogs,
  projectId: fallbackProjectId,
  projectName,
  syncedAt,
  progress,
}: {
  provider: { getWorklogs: (id: string) => Promise<unknown[]> };
  issues: unknown[];
  refreshTargets: unknown[];
  cachedWorklogs?: EliticalWorklogCache | null;
  projectId: string;
  projectName: string;
  syncedAt: string;
  progress: (next: EliticalLiveSyncProgress) => void;
}): Promise<WorklogFetchResult & { cache: EliticalWorklogCache }> {
  const issueById = new Map<string, Record<string, unknown>>();

  issues
    .map((issue) => issue as Record<string, unknown>)
    .forEach((issue) => {
      const id = docketId(issue);

      if (id) issueById.set(id, issue);
    });
  const refreshIds = new Set(
    refreshTargets
      .map((issue) => docketId(issue as Record<string, unknown>))
      .filter(Boolean)
  );
  const cachedByDocket = cachedWorklogsByDocket(cachedWorklogs);
  const nextWorklogs: NormalizedEliticalWorklog[] = [];
  let successfulRequests = 0;
  let failedRequests = 0;
  let reusedDockets = 0;

  for (const id of issueById.keys()) {
    if (!refreshIds.has(id)) {
      nextWorklogs.push(...(cachedByDocket.get(id) || []));
      reusedDockets += 1;
    }
  }

  const targets = refreshTargets
    .map((issue) => issue as Record<string, unknown>)
    .filter((issue) => issueById.has(docketId(issue)));

  for (let index = 0; index < targets.length; index += 1) {
    const issue = targets[index];
    const id = docketId(issue);

    progress({
      phase: "fetching-worklogs",
      message: `Fetching Worklogs (${index + 1} / ${targets.length})...`,
      current: index + 1,
      total: targets.length,
    });

    try {
      const worklogs = await provider.getWorklogs(id);

      successfulRequests += 1;
      nextWorklogs.push(
        ...worklogs.map((worklog) =>
          normalizeWorklog(
            worklog as Record<string, unknown>,
            issue,
            fallbackProjectId,
            projectName
          )
        )
      );
    } catch (error) {
      failedRequests += 1;
      nextWorklogs.push(...(cachedByDocket.get(id) || []));
      console.error("[EliticalSync] Worklog import failed", {
        docketId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const cache = {
    version: 1,
    lastSync: syncedAt,
    totalWorklogs: nextWorklogs.length,
    worklogs: nextWorklogs,
  };

  return {
    cache,
    worklogs: nextWorklogs,
    requestedDockets: targets.length,
    successfulRequests,
    failedRequests,
    reusedDockets,
  };
}

function attachWorklogsToIssues(
  issues: unknown[],
  worklogs: NormalizedEliticalWorklog[]
) {
  const byDocket = cachedWorklogsByDocket({
    version: 1,
    lastSync: "",
    totalWorklogs: worklogs.length,
    worklogs,
  });

  return issues.map((issue) => {
    const record = issue as Record<string, unknown>;

    return {
      ...record,
      worklogs: byDocket.get(docketId(record)) || [],
    };
  });
}

export async function importEliticalLiveToNormalized({
  writeOutput = false,
  onProgress,
  previousGraph = null,
  syncIndex = null,
  cachedWorklogs = null,
}: EliticalLiveSyncOptions = {}) {
  loadEnv();
  logRuntimeConfiguration("after-env");

  const startedAt = Date.now();
  const timings = {
    authenticationMs: 0,
    projectsMs: 0,
    sprintsMs: 0,
    issuesBoardMs: 0,
    comparisonMs: 0,
    detailRequestsMs: 0,
    normalizationMs: 0,
    worklogImportMs: 0,
  };
  const progress = (next: EliticalLiveSyncProgress) => onProgress?.(next);
  const { EliticalAuthService, EliticalClient, EliticalProvider } =
    await loadRuntimeModules();
  logRuntimeConfiguration("after-runtime-modules");
  const authService = new EliticalAuthService({
    baseUrl: process.env.ELITICAL_BASE_URL || undefined,
    dataDir: process.env.ELITICAL_DATA_DIR || undefined,
    storageStatePath: process.env.ELITICAL_STORAGE_STATE_PATH || undefined,
  });

  try {
    progress({ phase: "authenticating", message: "Authenticating..." });

    const authenticationStartedAt = Date.now();
    await authService.initialize();

    const session = await authService.restoreSession();

    if (!session) {
      await authService.login();
    }
    timings.authenticationMs = elapsedSince(authenticationStartedAt);

    const client = new EliticalClient(authService);
    const provider = new EliticalProvider(client);

    progress({ phase: "loading-project", message: "Loading Project..." });

    const projectsStartedAt = Date.now();
    const projects = await provider.getProjects();
    const targetProject = projects.find(
      (project) =>
        project.code === TARGET_PROJECT_CODE || project.name === TARGET_PROJECT_NAME
    );
    const targetProjectId = targetProject ? projectId(targetProject) : "";

    if (!targetProjectId) {
      throw new Error(`Elitical project ${TARGET_PROJECT_NAME} (${TARGET_PROJECT_CODE}) was not found.`);
    }
    timings.projectsMs = elapsedSince(projectsStartedAt);

    progress({ phase: "loading-sprints", message: "Loading Sprint..." });
    const sprintsStartedAt = Date.now();
    const sprints = await provider.getSprints(targetProjectId);
    timings.sprintsMs = elapsedSince(sprintsStartedAt);

    progress({ phase: "fetching-issues", message: "Fetching Issues..." });
    const issuesBoardStartedAt = Date.now();
    const issues = await provider.getIssues(targetProjectId);
    timings.issuesBoardMs = elapsedSince(issuesBoardStartedAt);

    const comparisonStartedAt = Date.now();
    const detailTargets = issues.filter((issue) => docketType(issue) !== "EPIC");
    const previousHierarchy = previousHierarchyById(previousGraph);
    const baseline = baselineStatus({
      syncIndex,
      targetProjectId,
      previousGraph,
    });
    let incrementalMode = baseline.valid;
    let incrementalFallback = baseline.valid ? "" : baseline.reason;
    let newIssues: unknown[] = [];
    let modifiedIssues: unknown[] = [];
    let unchangedIssues: unknown[] = [];
    let detailFetchResult: DetailFetchResult;

    if (baseline.valid) {
      const classified = classifyIssues({
        issues,
        syncIndex: syncIndex as EliticalSyncIndex,
      });

      newIssues = classified.newIssues;
      modifiedIssues = classified.modifiedIssues;
      unchangedIssues = classified.unchangedIssues;

      const unsafeReuse = unchangedIssues.some((issue) => {
        const type = docketType(issue as Record<string, unknown>);

        return isGraphDocketType(type) && requiresDocketDetail(type) &&
          !hasReusableHierarchy(issue, previousHierarchy);
      });

      if (unsafeReuse) {
        incrementalMode = false;
        incrementalFallback = "Cached hierarchy was incomplete for at least one unchanged docket.";
      }
    }
    timings.comparisonMs = elapsedSince(comparisonStartedAt);

    const detailRequestsStartedAt = Date.now();
    if (incrementalMode) {
      const incrementalDetailTargets = [...newIssues, ...modifiedIssues].filter(
        (issue) => requiresDocketDetail(docketType(issue as Record<string, unknown>))
      );

      detailFetchResult = await fetchDocketDetails({
        client,
        targets: incrementalDetailTargets,
        progress,
      });

      if (detailFetchResult.failedDetailRequests > 0) {
        incrementalMode = false;
        incrementalFallback = "At least one incremental detail request failed.";
      }
    }

    if (!incrementalMode) {
      detailFetchResult = await fetchDocketDetails({
        client,
        targets: detailTargets,
        progress,
      });
      newIssues = issues;
      modifiedIssues = [];
      unchangedIssues = [];
    }
    timings.detailRequestsMs = elapsedSince(detailRequestsStartedAt);

    const enrichedIssues = enrichIssuesFromDetails(
      issues,
      detailFetchResult!.details,
      incrementalMode ? previousHierarchy : new Map()
    );

    const syncedAt = new Date().toISOString();
    const worklogImportStartedAt = Date.now();
    const supportedWorklogIssues = enrichedIssues.filter((issue) =>
      isGraphDocketType(docketType(issue as Record<string, unknown>))
    );
    const cachedWorklogDockets = cachedWorklogsByDocket(cachedWorklogs);
    const canReuseCachedWorklogs =
      incrementalMode && cachedWorklogDockets.size > 0;
    const worklogRefreshTargets = canReuseCachedWorklogs
      ? [...newIssues, ...modifiedIssues].filter((issue) =>
          isGraphDocketType(docketType(issue as Record<string, unknown>))
        )
      : supportedWorklogIssues;
    const worklogFetchResult = await fetchWorklogs({
      provider,
      issues: supportedWorklogIssues,
      refreshTargets: worklogRefreshTargets,
      cachedWorklogs: canReuseCachedWorklogs ? cachedWorklogs : null,
      projectId: targetProjectId,
      projectName: targetProject?.name || TARGET_PROJECT_NAME,
      syncedAt,
      progress,
    });
    timings.worklogImportMs = elapsedSince(worklogImportStartedAt);

    progress({ phase: "normalizing", message: "Normalizing..." });

    const normalizationStartedAt = Date.now();
    const issuesWithWorklogs = attachWorklogsToIssues(
      enrichedIssues,
      worklogFetchResult.worklogs
    );
    const output = importEliticalLiveData({
      projects,
      sprints: sprints.map((sprint) => ({
        ...sprint,
        projectId: sprint.projectId || targetProjectId,
      })),
      dockets: issuesWithWorklogs.map((issue) => ({
        ...issue,
        projectId: (issue as Record<string, unknown>).projectId || targetProjectId,
      })),
      writeOutput,
    });
    timings.normalizationMs = elapsedSince(normalizationStartedAt);
    const counts = countsFor(output);
    const durationMs = Date.now() - startedAt;
    const nextSyncIndex = buildSyncIndex({
      projectId: targetProjectId,
      issues,
      syncedAt,
    });
    const skippedDetailRequests = incrementalMode
      ? unchangedIssues.filter((issue) =>
        requiresDocketDetail(docketType(issue as Record<string, unknown>))
      ).length
      : 0;
    const currentIssueIds = new Set(
      issues.map((issue) => docketId(issue as unknown as Record<string, unknown>)).filter(Boolean)
    );
    const removedDockets = incrementalMode
      ? Object.keys(syncIndex?.dockets || {}).filter((id) => !currentIssueIds.has(id)).length
      : 0;
    const incremental = {
      mode: incrementalMode ? "incremental" : "full",
      reason: incrementalMode ? baseline.reason : incrementalFallback,
      fallbackReason: incrementalMode ? "" : incrementalFallback,
      baselineDockets: baseline.docketCount,
      cachedHierarchyDockets: baseline.hierarchyCount,
      issuesBoardItems: issues.length,
      newDockets: newIssues.length,
      modifiedDockets: modifiedIssues.length,
      unchangedDockets: unchangedIssues.length,
      removedDockets,
      detailRequestsSent: detailFetchResult!.successfulDetailRequests + detailFetchResult!.failedDetailRequests,
      skippedDetailRequests,
      worklogRequestsSent: worklogFetchResult.requestedDockets,
      worklogRequestsReused: worklogFetchResult.reusedDockets,
      worklogRequestsFailed: worklogFetchResult.failedRequests,
      syncDurationSeconds: Math.round(durationMs / 1000),
    };

    console.log(`[inbound-sync] mode=${incremental.mode} reason=${incremental.reason}`);
    console.log(
      `[inbound-sync] dockets total=${incremental.issuesBoardItems} new=${incremental.newDockets} modified=${incremental.modifiedDockets} unchanged=${incremental.unchangedDockets} removed=${incremental.removedDockets}`
    );
    console.log(
      `[inbound-sync] details fetched=${incremental.detailRequestsSent} reused=${incremental.skippedDetailRequests}`
    );
    console.log(
      `[inbound-sync] worklogs fetched=${incremental.worklogRequestsSent} reused=${incremental.worklogRequestsReused}`
    );
    console.log(`[inbound-sync] duration=${incremental.syncDurationSeconds} s`);
    console.log("-------------------------------------");
    console.log("IssuesBoard items:", incremental.issuesBoardItems);
    console.log("New dockets:", incremental.newDockets);
    console.log("Modified dockets:", incremental.modifiedDockets);
    console.log("Unchanged dockets:", incremental.unchangedDockets);
    console.log("Detail requests sent:", incremental.detailRequestsSent);
    console.log("Skipped detail requests:", incremental.skippedDetailRequests);
    console.log("Worklog requests sent:", incremental.worklogRequestsSent);
    console.log("Worklog dockets reused:", incremental.worklogRequestsReused);
    console.log("Worklogs imported:", worklogFetchResult.worklogs.length);
    console.log("Sync duration:", `${incremental.syncDurationSeconds} s`);
    if (incremental.fallbackReason) {
      console.log("Incremental fallback:", incremental.fallbackReason);
    }
    console.log("-------------------------------------");

    progress({ phase: "complete", message: "Sync Complete" });

    return {
      normalized: output,
      counts,
      detailRequests: {
        total: detailTargets.length,
        successful: detailFetchResult!.successfulDetailRequests,
        failed: detailFetchResult!.failedDetailRequests,
        skipped: skippedDetailRequests,
      },
      incremental,
      syncIndex: nextSyncIndex,
      worklogs: worklogFetchResult.cache,
      worklogImport: {
        importedDockets: supportedWorklogIssues.length,
        importedWorklogs: worklogFetchResult.worklogs.length,
        requestedDockets: worklogFetchResult.requestedDockets,
        successfulRequests: worklogFetchResult.successfulRequests,
        failedRequests: worklogFetchResult.failedRequests,
        reusedDockets: worklogFetchResult.reusedDockets,
      },
      issues: {
        total: issues.length,
      },
      durationMs,
      timings,
      syncedAt,
    };
  } finally {
    await (authService as unknown as ClosableAuthService).close();
  }
}
