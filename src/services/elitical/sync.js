import { eliticalApiClient } from "./api.js";
import {
  clearStoredSession,
  consumeSessionFromUrl,
  getEliticalLoginUrl,
  getStoredSession,
  setStoredSession,
} from "./auth.js";
import { updateDocket } from "./docket.js";
import {
  getAssignedEpics,
  getAssignedJobs,
  getAssignedProject,
  getAssignedStories,
  getAssignedWorklogs,
  getCurrentEmployee,
  getCurrentSprint,
} from "./employee.js";
import { createWorklog, updateWorklog, deleteWorklog } from "./worklog.js";
import { ROOT_ID } from "../../utils/worklogModel";

let nextSyncManagerId = 1;
const PRODUCTION_READ_CONCURRENCY = 6;

function diagnosticError(error) {
  return {
    name: error?.name || "",
    message: error?.message || String(error),
    status: error?.status || "",
    code: error?.code || "",
    stack: error?.stack || "",
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length);

  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
}

function productionConfig() {
  const nodeProcess = globalThis.process;
  const nodeEnv = nodeProcess?.env || {};
  const viteEnv = import.meta?.env || {};

  return {
    baseUrl: nodeEnv.ELITICAL_BASE_URL || viteEnv.VITE_ELITICAL_BASE_URL || "",
    dataDir: nodeEnv.ELITICAL_DATA_DIR || viteEnv.VITE_ELITICAL_DATA_DIR || undefined,
    storageStatePath:
      nodeEnv.ELITICAL_STORAGE_STATE_PATH ||
      viteEnv.VITE_ELITICAL_STORAGE_STATE_PATH ||
      undefined,
  };
}

function runtimeImport(specifier) {
  return import(/* @vite-ignore */ specifier);
}

function canUseProductionRuntime() {
  return typeof window === "undefined";
}

async function createProductionEliticalProvider() {
  console.info("[EliticalSync] createProductionEliticalProvider() called");

  const [
    { EliticalAuthService },
    { EliticalClient },
    { EliticalProvider },
  ] = await Promise.all([
    runtimeImport("./auth/index.ts"),
    runtimeImport("./client/index.ts"),
    runtimeImport("./provider/index.ts"),
  ]);
  const authService = new EliticalAuthService(productionConfig());

  await authService.initialize();

  const client = new EliticalClient(authService);
  const provider = new EliticalProvider(client);

  console.info("[EliticalSync] createProductionEliticalProvider() completed");

  return provider;
}

async function resolveProvider(provider) {
  console.info("[EliticalSync] resolveProvider() called", {
    hasInjectedProvider: Boolean(provider),
    providerType: typeof provider,
  });

  if (!provider && !canUseProductionRuntime()) {
    console.info("[EliticalSync] resolveProvider() using browser API client path");
    return null;
  }

  if (!provider) {
    const resolvedProvider = await createProductionEliticalProvider();
    console.info("[EliticalSync] resolveProvider() returning production provider", {
      hasProvider: Boolean(resolvedProvider),
    });
    return resolvedProvider;
  }

  if (typeof provider === "function") {
    const resolvedProvider = await provider();
    console.info("[EliticalSync] resolveProvider() returning factory provider", {
      hasProvider: Boolean(resolvedProvider),
    });
    return resolvedProvider;
  }

  console.info("[EliticalSync] resolveProvider() returning injected provider", {
    hasProvider: Boolean(provider),
  });
  return provider;
}

export const SYNC_STATES = {
  SYNCED: "synced",
  MODIFIED: "modified",
  CONFLICT: "conflict",
  OFFLINE: "offline",
};

export const CONNECTION_STATES = {
  CONNECTED: "Connected",
  CONNECTING: "Connecting",
  SYNCING: "Syncing",
  OFFLINE: "Offline",
  AUTH_REQUIRED: "Authentication Required",
  ERROR: "Error",
  SESSION_EXPIRED: "Session Expired",
  SYNC_FAILED: "Sync Failed",
};

export const ELITICAL_FIELDS = [
  "title",
  "description",
  "type",
  "parentId",
  "category",
  "priority",
  "assignee",
  "status",
  "docketState",
  "sprint",
  "storyPoints",
  "timeMinutes",
  "plannedStartDate",
  "plannedEndDate",
  "actualStartDate",
  "actualEndDate",
  "dueDate",
  "estimatedHours",
  "loggedHours",
  "remainingHours",
  "labels",
  "worklogs",
  "comments",
  "createdAt",
  "updatedAt",
];

export const GITHUB_FIELDS = [
  "personalNotes",
  "position",
  "favorite",
  "customTags",
  "aiSummary",
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeListPayload(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function officialId(item) {
  return String(item?.eliticalId || item?.officialId || item?.id || "");
}

function copyFields(source, fields) {
  return fields.reduce((acc, field) => {
    if (source && source[field] !== undefined) acc[field] = source[field];
    return acc;
  }, {});
}

function officialToWorkItem(docket) {
  const id = officialId(docket);
  const type = String(docket.type || docket.docketType || "task").toLowerCase();

  return {
    id,
    eliticalId: id,
    title: docket.title || docket.name || "Untitled",
    description: docket.description || "",
    type,
    parentId: docket.parentId || docket.parentDocketId || ROOT_ID,
    category: docket.category || "feature",
    priority: docket.priority || "info",
    docketState: docket.docketState || docket.status || "concept",
    status: docket.status || docket.docketState || "concept",
    sprint: docket.sprint || docket.sprintName || "",
    storyPoints: Number(docket.storyPoints || 0),
    estimatedHours: Number(docket.estimatedHours || 0),
    loggedHours: Number(docket.loggedHours || 0),
    remainingHours: Number(docket.remainingHours || 0),
    dueDate: docket.dueDate || "",
    worklogs: asArray(docket.worklogs),
    comments: asArray(docket.comments),
    createdAt: docket.createdAt || "",
    updatedAt: docket.updatedAt || docket.modifiedAt || "",
  };
}

function firstString(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function firstNumber(...values) {
  const match = values.find((value) => Number.isFinite(Number(value)));

  return match === undefined ? 0 : Number(match);
}

function slug(value, fallback) {
  return firstString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function normalizeExtensionType(type, fallback = "task") {
  const normalized = String(type || "").toLowerCase();

  if (normalized.includes("epic")) return "epic";
  if (normalized.includes("story")) return "story";
  if (normalized.includes("job")) return "job";
  if (normalized.includes("task")) return "task";

  return fallback;
}

function entityName(entity, fallback) {
  return firstString(
    entity?.name,
    entity?.displayName,
    entity?.fullName,
    entity?.title,
    entity?.projectName,
    entity?.sprintName,
    entity?.id,
    fallback
  );
}

function extensionWorklogEntry(worklog) {
  const minutes = firstNumber(
    worklog?.timeMinutes,
    worklog?.minutes,
    worklog?.loggedMinutes
  );
  const hours = firstNumber(worklog?.hours, worklog?.loggedHours, worklog?.duration);

  return {
    date: firstString(worklog?.date, worklog?.worklogDate, worklog?.createdDate),
    description: firstString(worklog?.description, worklog?.comment, worklog?.note),
    timeMinutes: minutes || Math.round(hours * 60),
  };
}

function extensionDocketToWorkItem(docket, fallbackType) {
  const type = normalizeExtensionType(docket?.type || docket?.docketType, fallbackType);
  const id = firstString(docket?.id, docket?.docketId, docket?.cx);

  return {
    id,
    eliticalId: id,
    title: firstString(docket?.title, docket?.name, docket?.docketTitle, `${type} ${id}`),
    description: firstString(docket?.description, docket?.descr),
    type,
    parentId: firstString(docket?.parentId, docket?.parentDocketId),
    category: firstString(docket?.category, "feature"),
    priority: firstString(docket?.priority, "info"),
    docketState: firstString(docket?.docketState, docket?.status, "concept"),
    status: firstString(docket?.status, docket?.docketState, "concept"),
    sprint: firstString(docket?.sprintName, docket?.sprint, docket?.sprintId),
    storyPoints: firstNumber(docket?.storyPoints, docket?.estimatedStoryPoints),
    plannedStartDate: firstString(docket?.plannedStartDate),
    plannedEndDate: firstString(docket?.plannedEndDate),
    dueDate: firstString(docket?.dueDate),
    estimatedHours: firstNumber(docket?.estimatedHours),
    loggedHours: firstNumber(docket?.loggedHours),
    remainingHours: firstNumber(docket?.remainingHours),
    worklogs: asArray(docket?.worklogs).map(extensionWorklogEntry),
    updatedAt: firstString(docket?.updatedAt, docket?.updatedTime),
  };
}

function ensureValidExtensionHierarchy(workItems, payload) {
  const project = payload?.project || {};
  const sprint = payload?.sprint || {};
  const employee = payload?.employee || {};
  const items = workItems.filter((item) => item.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const projectId = firstString(project.id, project.projectId, employee.id, "elitical");
  const projectEpicId = `elitical-project-${slug(projectId, "project")}`;
  const sprintStoryId = `elitical-sprint-${slug(
    firstString(sprint.id, sprint.sprintId, projectId),
    "sprint"
  )}`;

  if (!items.some((item) => item.type === "epic")) {
    const projectEpic = {
      id: projectEpicId,
      eliticalId: projectEpicId,
      title: entityName(project, "Elitical Project"),
      description: "",
      type: "epic",
      parentId: ROOT_ID,
      category: "feature",
      priority: "info",
      docketState: "concept",
      status: "concept",
      sprint: entityName(sprint, ""),
      storyPoints: 0,
    };

    items.unshift(projectEpic);
    byId.set(projectEpic.id, projectEpic);
  }

  const firstEpicId = items.find((item) => item.type === "epic")?.id || projectEpicId;

  items
    .filter((item) => item.type === "epic")
    .forEach((item) => {
      item.parentId = ROOT_ID;
    });

  if (!items.some((item) => item.type === "story")) {
    const sprintStory = {
      id: sprintStoryId,
      eliticalId: sprintStoryId,
      title: entityName(sprint, "Elitical Worklogs"),
      description: "",
      type: "story",
      parentId: firstEpicId,
      category: "feature",
      priority: "info",
      docketState: "concept",
      status: "concept",
      sprint: entityName(sprint, ""),
      storyPoints: 0,
    };

    items.push(sprintStory);
    byId.set(sprintStory.id, sprintStory);
  }

  const firstStoryId = items.find((item) => item.type === "story")?.id || sprintStoryId;
  const validEpicIds = new Set(items.filter((item) => item.type === "epic").map((item) => item.id));
  const validStoryIds = new Set(items.filter((item) => item.type === "story").map((item) => item.id));

  items
    .filter((item) => item.type === "story" || item.type === "task")
    .forEach((item) => {
      if (!validEpicIds.has(item.parentId)) item.parentId = firstEpicId;
    });

  items
    .filter((item) => item.type === "job")
    .forEach((item) => {
      if (!validStoryIds.has(item.parentId)) item.parentId = firstStoryId;
    });

  return items;
}

function extensionPayloadToOfficialData(payload) {
  const worklogs = asArray(payload?.worklogs).map((worklog) => ({
    ...worklog,
    ...extensionWorklogEntry(worklog),
  }));
  const worklogsByDocketId = worklogs.reduce((acc, worklog) => {
    const docketId = firstString(worklog.docketId, worklog.workItemId);
    if (!docketId) return acc;
    if (!acc.has(docketId)) acc.set(docketId, []);
    acc.get(docketId).push(worklog);
    return acc;
  }, new Map());
  const dockets = [
    ...asArray(payload?.epics).map((item) => extensionDocketToWorkItem(item, "epic")),
    ...asArray(payload?.stories).map((item) => extensionDocketToWorkItem(item, "story")),
    ...asArray(payload?.jobs).map((item) => extensionDocketToWorkItem(item, "job")),
  ].map((item) => ({
    ...item,
    worklogs: worklogsByDocketId.get(item.id) || item.worklogs || [],
  }));
  const docketIds = new Set(dockets.map((item) => item.id));
  const orphanWorklogItems = worklogs
    .filter((worklog) => !firstString(worklog.docketId) || !docketIds.has(String(worklog.docketId)))
    .map((worklog, index) => {
      const id = `elitical-worklog-${slug(
        firstString(worklog.id, worklog.date, index),
        `log-${index}`
      )}`;

      return {
        id,
        eliticalId: id,
        title: firstString(worklog.comment, worklog.description, `Worklog ${index + 1}`),
        description: firstString(worklog.comment, worklog.description),
        type: "job",
        parentId: "",
        category: "feature",
        priority: "info",
        docketState: "concept",
        status: "concept",
        sprint: entityName(payload?.sprint, ""),
        storyPoints: 0,
        worklogs: [extensionWorklogEntry(worklog)],
        dueDate: firstString(worklog.date),
        updatedAt: firstString(worklog.date),
      };
    });
  const workItems = ensureValidExtensionHierarchy(
    [...dockets, ...orphanWorklogItems],
    payload
  );

  return {
    projectId: firstString(payload?.project?.id, payload?.project?.projectId),
    sprintId: firstString(payload?.sprint?.id, payload?.sprint?.sprintId),
    employee: payload?.employee || null,
    project: payload?.project || null,
    sprint: payload?.sprint || null,
    downloadedAt: payload?.syncedAt || payload?.receivedAt || new Date().toISOString(),
    sprints: payload?.sprint ? [payload.sprint] : [],
    employees: payload?.employee ? [payload.employee] : [],
    dockets,
    workItems,
    worklogs,
    source: payload?.source || "elitical-extension",
  };
}

async function fetchJsonWithFallback(urls) {
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to read Elitical extension data.");
}

export async function downloadExtensionData({
  urls = [
    "/api/elitical/extension-sync",
    "http://localhost:8888/api/elitical/extension-sync",
  ],
} = {}) {
  const payload = await fetchJsonWithFallback(urls);

  if (!payload || payload.status === "empty") {
    throw new Error("No Elitical extension data is available yet. Click Sync Now in the extension first.");
  }

  if (payload.source !== "elitical-worklog-extension") {
    throw new Error("Latest Elitical payload did not come from the browser extension.");
  }

  return extensionPayloadToOfficialData(payload);
}

export async function downloadOfficialData({
  client = eliticalApiClient,
  provider = null,
} = {}) {
  console.info("[EliticalSync] downloadOfficialData() entered");

  try {
    const productionProvider = await resolveProvider(provider);
    console.info("[EliticalSync] downloadOfficialData() provider resolved", {
      hasProvider: Boolean(productionProvider),
    });

  if (productionProvider) {
    console.info("[EliticalSync] downloadOfficialData() calling provider.getProjects()");
    const projects = await productionProvider.getProjects();
    console.info("[EliticalSync] provider.getProjects() resolved", {
      count: projects.length,
    });
    const project = projects[0] || null;
    const projectId = firstString(project?.id, project?.projectId, project?.cx);
    console.info("[EliticalSync] downloadOfficialData() selected project", {
      projectId,
    });
    const sprints = projectId ? await productionProvider.getSprints(projectId) : [];
    console.info("[EliticalSync] provider.getSprints() resolved", {
      count: sprints.length,
    });
    const sprint = sprints[0] || null;
    const sprintId = firstString(sprint?.id, sprint?.sprintId, sprint?.cx);
    const issues = projectId ? await productionProvider.getIssues(projectId) : [];
    console.info("[EliticalSync] provider.getIssues() resolved", {
      count: issues.length,
    });
    const docketDetails = await mapWithConcurrency(
      issues,
      PRODUCTION_READ_CONCURRENCY,
      async (issue) => {
      const docketId = officialId(issue);
      console.info("[EliticalSync] downloadOfficialData() loading docket", {
        docketId,
      });
      return docketId ? await productionProvider.getDocket(docketId) : issue;
      }
    );
    console.info("[EliticalSync] provider.getDocket() loop resolved", {
      count: docketDetails.length,
    });

    const worklogGroups = await mapWithConcurrency(
      docketDetails,
      PRODUCTION_READ_CONCURRENCY,
      async (docket) => {
        const docketId = officialId(docket);

      console.info("[EliticalSync] downloadOfficialData() loading worklogs", {
        docketId,
      });
      return {
        docketId,
        worklogs: docketId
          ? await productionProvider.getWorklogs(docketId).catch((error) => {
              if (error?.status === 401 || error?.status === 403) return [];
              throw error;
            })
          : [],
      };
      }
    );
    console.info("[EliticalSync] provider.getWorklogs() loop resolved", {
      count: worklogGroups.length,
    });
    const worklogsByDocketId = worklogGroups.reduce((acc, group) => {
      if (group.docketId) acc.set(group.docketId, group.worklogs);
      return acc;
    }, new Map());
    const dockets = docketDetails.map((docket) => ({
      ...docket,
      worklogs: worklogsByDocketId.get(officialId(docket)) || docket.worklogs || [],
    }));
    const worklogs = worklogGroups.flatMap((group) => group.worklogs);

    const officialData = {
      projectId,
      sprintId,
      employee: null,
      project,
      sprint,
      downloadedAt: new Date().toISOString(),
      sprints,
      employees: [],
      dockets,
      workItems: dockets.map(officialToWorkItem),
      worklogs,
      source: "elitical-client",
    };

    console.info("[EliticalSync] downloadOfficialData() returning production official data", {
      source: officialData.source,
      projectId,
      sprintId,
      docketCount: dockets.length,
      worklogCount: worklogs.length,
    });

    return officialData;
  }

  const [
    employee,
    project,
    sprint,
    epicsPayload,
    storiesPayload,
    jobsPayload,
    worklogsPayload,
  ] = await Promise.all([
    getCurrentEmployee(client),
    getAssignedProject(client),
    getCurrentSprint(client),
    getAssignedEpics(client),
    getAssignedStories(client),
    getAssignedJobs(client),
    getAssignedWorklogs(client),
  ]);
  const worklogs = normalizeListPayload(worklogsPayload, "worklogs");
  const worklogsByDocketId = worklogs.reduce((acc, worklog) => {
    const docketId = String(worklog.docketId || worklog.workItemId || "");
    if (!docketId) return acc;
    if (!acc.has(docketId)) acc.set(docketId, []);
    acc.get(docketId).push(worklog);
    return acc;
  }, new Map());
  const dockets = [
    ...normalizeListPayload(epicsPayload, "epics"),
    ...normalizeListPayload(storiesPayload, "stories"),
    ...normalizeListPayload(jobsPayload, "jobs"),
  ].map((docket) => ({
    ...docket,
    worklogs: worklogsByDocketId.get(officialId(docket)) || docket.worklogs || [],
  }));
  const projectId = String(project?.id || project?.projectId || "");
  const sprintId = String(sprint?.id || sprint?.sprintId || "");

  const officialData = {
    projectId,
    sprintId,
    employee,
    project,
    sprint,
    downloadedAt: new Date().toISOString(),
    sprints: sprint ? [sprint] : [],
    employees: employee ? [employee] : [],
    dockets,
    workItems: dockets.map(officialToWorkItem),
    worklogs,
  };

  console.info("[EliticalSync] downloadOfficialData() returning legacy official data", {
    docketCount: dockets.length,
    worklogCount: worklogs.length,
  });

  return officialData;
  } catch (error) {
    console.error("[EliticalSync] downloadOfficialData() threw", diagnosticError(error));
    throw error;
  }
}

export function mergeWithGitHub({
  officialData,
  githubSnapshot,
} = {}) {
  const officialItems = asArray(officialData?.workItems);
  const personalItems = asArray(githubSnapshot?.workItems);
  const personalByOfficialId = new Map(
    personalItems.map((item) => [officialId(item), item])
  );
  const seenIds = new Set();
  const mergedOfficialItems = officialItems.map((officialItem) => {
    const id = officialId(officialItem);
    const personalItem = personalByOfficialId.get(id);

    seenIds.add(id);

    return {
      ...(personalItem || {}),
      ...copyFields(officialItem, ELITICAL_FIELDS),
      ...copyFields(personalItem, GITHUB_FIELDS),
      id: personalItem?.id || id,
      eliticalId: id,
      syncState: SYNC_STATES.SYNCED,
    };
  });
  const personalOnlyItems = personalItems
    .filter((item) => !seenIds.has(officialId(item)))
    .map((item) => ({
      ...item,
      syncState: SYNC_STATES.OFFLINE,
    }));

  return {
    ...(githubSnapshot || {}),
    workItems: [
      ...mergedOfficialItems,
      ...personalOnlyItems,
    ],
    elitical: {
      projectId: officialData?.projectId || "",
      rootDocketId: officialData?.rootDocketId || "",
      lastSyncedAt: officialData?.downloadedAt || new Date().toISOString(),
    },
  };
}

export function calculateSyncState({
  item,
  officialItem,
  pendingChanges = [],
  conflictIds = [],
  offline = false,
} = {}) {
  if (offline) return SYNC_STATES.OFFLINE;

  const id = officialId(item || officialItem);

  if (conflictIds.includes(id)) return SYNC_STATES.CONFLICT;
  if (pendingChanges.some((change) => officialId(change) === id)) {
    return SYNC_STATES.MODIFIED;
  }

  return SYNC_STATES.SYNCED;
}

export async function uploadPendingChanges({
  pendingChanges = [],
  client = eliticalApiClient,
} = {}) {
  const results = [];

  for (const change of pendingChanges) {
    if (change.type === "createWorklog") {
      results.push(await createWorklog(change.docketId, change.payload, client));
    } else if (change.type === "updateWorklog") {
      results.push(await updateWorklog(change.worklogId, change.payload, client));
    } else if (change.type === "deleteWorklog") {
      results.push(await deleteWorklog(change.worklogId, client));
    } else if (change.type === "updateDocket") {
      results.push(await updateDocket(change.docketId, change.payload, client));
    }
  }

  return results;
}

function normalizeConnectionPayload({
  session,
  employee,
  project,
  sprint,
}) {
  return {
    session,
    employee: {
      id: String(employee?.id || employee?.employeeId || session?.employeeId || ""),
      name: String(employee?.name || employee?.displayName || employee?.fullName || ""),
      email: String(employee?.email || ""),
    },
    project: {
      id: String(project?.id || project?.projectId || session?.projectId || ""),
      name: String(project?.name || project?.title || ""),
    },
    sprint: {
      id: String(sprint?.id || sprint?.sprintId || ""),
      name: String(sprint?.name || sprint?.title || ""),
    },
    lastSyncedAt: new Date().toISOString(),
  };
}

export async function loadConnectionContext({
  session = getStoredSession(),
  client = eliticalApiClient,
  provider = null,
} = {}) {
  console.info("[EliticalSync] loadConnectionContext() entered");

  try {
    const productionProvider = await resolveProvider(provider);
    console.info("[EliticalSync] loadConnectionContext() provider resolved", {
      hasProvider: Boolean(productionProvider),
    });

  if (productionProvider) {
    const projects = await productionProvider.getProjects();
    console.info("[EliticalSync] loadConnectionContext() provider.getProjects() resolved", {
      count: projects.length,
    });
    const project = projects[0] || null;
    const projectId = firstString(project?.id, project?.projectId, project?.cx);
    const sprints = projectId ? await productionProvider.getSprints(projectId) : [];
    console.info("[EliticalSync] loadConnectionContext() provider.getSprints() resolved", {
      count: sprints.length,
    });
    const sprint = sprints[0] || null;

    const result = {
      status: CONNECTION_STATES.CONNECTED,
      context: normalizeConnectionPayload({
        session: {
          projectId,
          source: "elitical-client",
        },
        employee: null,
        project,
        sprint,
      }),
    };

    console.info("[EliticalSync] loadConnectionContext() returning production context", {
      status: result.status,
      projectId,
    });

    return result;
  }

  if (
    !session?.token &&
    !session?.authorization &&
    !session?.sJwtToken &&
    !session?.sessionId
  ) {
    const result = {
      status: CONNECTION_STATES.AUTH_REQUIRED,
      context: null,
    };

    console.info("[EliticalSync] loadConnectionContext() returning auth required");

    return result;
  }

  const [employee, project, sprint] = await Promise.all([
    getCurrentEmployee(client),
    getAssignedProject(client),
    getCurrentSprint(client),
  ]);

  const result = {
    status: CONNECTION_STATES.CONNECTED,
    context: normalizeConnectionPayload({
      session,
      employee,
      project,
      sprint,
    }),
  };

  console.info("[EliticalSync] loadConnectionContext() returning legacy context", {
    status: result.status,
  });

  return result;
  } catch (error) {
    console.error("[EliticalSync] loadConnectionContext() threw", diagnosticError(error));
    throw error;
  }
}

export function connectionFromOfficialData(officialData) {
  return {
    status: CONNECTION_STATES.CONNECTED,
    context: normalizeConnectionPayload({
      session: {
        employeeId: officialData?.employee?.id,
        projectId: officialData?.projectId,
        source: officialData?.source || "elitical-extension",
      },
      employee: officialData?.employee,
      project: officialData?.project,
      sprint: officialData?.sprint,
    }),
  };
}

export function restoreSession() {
  return consumeSessionFromUrl() || getStoredSession();
}

export function connectElitical({
  session = restoreSession(),
  returnUrl,
} = {}) {
  if (
    session?.token ||
    session?.authorization ||
    session?.sJwtToken ||
    session?.sessionId
  ) {
    setStoredSession(session);
    return {
      status: CONNECTION_STATES.CONNECTING,
      session,
      redirected: false,
    };
  }

  window.location.assign(getEliticalLoginUrl(returnUrl));

  return {
    status: CONNECTION_STATES.AUTH_REQUIRED,
    session: null,
    redirected: true,
  };
}

export function disconnectElitical() {
  clearStoredSession();

  return {
    status: CONNECTION_STATES.AUTH_REQUIRED,
    context: null,
  };
}

export function createSyncManager({
  client = eliticalApiClient,
  provider = null,
} = {}) {
  const syncManagerInstanceId = nextSyncManagerId++;

  console.info("[EliticalSync] createSyncManager() constructed", {
    syncManagerInstanceId,
    hasInjectedProvider: Boolean(provider),
  });

  return {
    syncManagerInstanceId,
    restoreSession,
    connectElitical,
    disconnectElitical,
    loadConnectionContext: (options) => {
      console.info("[EliticalSync] SyncManager.loadConnectionContext() called", {
        syncManagerInstanceId,
      });

      return loadConnectionContext({ ...options, client, provider });
    },
    downloadOfficialData: (options) => {
      console.info("[EliticalSync] SyncManager.downloadOfficialData() called", {
        syncManagerInstanceId,
      });

      return downloadOfficialData({ ...options, client, provider });
    },
    downloadExtensionData,
    connectionFromOfficialData,
    mergeWithGitHub,
    calculateSyncState,
    uploadPendingChanges: (options) => uploadPendingChanges({ ...options, client }),
  };
}

export const eliticalSyncManager = createSyncManager();
