import http from "node:http";
import { CacheService } from "./services/CacheService.mjs";
import { LogBufferService } from "./services/LogBufferService.mjs";
import { LocalDataService } from "./services/LocalDataService.mjs";
import { LocalEventService } from "./services/LocalEventService.mjs";
import { LocalSyncQueueService } from "./services/LocalSyncQueueService.mjs";
import { initializeStorage } from "./services/StoragePathService.mjs";
import { SyncService, createEliticalSyncProvider } from "./services/SyncService.mjs";
import { WorklogService } from "./services/WorklogService.mjs";
import { validateDocketOperation } from "../src/utils/docketOperationValidation.js";
import {
  candidateItemFromIssue,
  canonicalSprintIdForPayload,
  chooseCreatedDocketCandidate,
  createdDocketCandidates,
} from "./services/CreateReconciliationService.mjs";
import {
  eliticalWorklogDateMillis,
  selectUniqueWorklogReconciliationMatch,
  worklogMatchesForReconciliation,
  worklogUpdateDatesConfirm,
} from "../src/services/elitical/worklogReconciliation.js";
import {
  docketStateApiId,
  docketStateApiName,
  normalizeDocketState,
} from "../src/utils/docketStates.js";
import {
  normalizeEliticalDescription,
  normalizeEliticalCreateDescriptionFields,
  validateEliticalDescription,
} from "../src/utils/eliticalDocketCreate.js";

const DEFAULT_PORT = 3797;
const PORT = Number(process.env.LOCAL_BACKEND_PORT || DEFAULT_PORT);
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const storageInitialization = await initializeStorage();
const cacheService = new CacheService();
const worklogService = new WorklogService();
const syncQueueService = new LocalSyncQueueService();
const events = new LocalEventService();
const logBuffer = new LogBufferService({ limit: 1000 });
const localData = new LocalDataService({ cacheService, worklogService, syncQueueService });
const syncService = new SyncService({ localData, events });
const ROOT_ID = "storyRoot";
const ORPHAN_SPRINT_ID = "virtual-orphan-sprint";
const CONFIRMED_DOCKET_UPDATE_FIELDS = new Set([
  "title",
  "description",
  "descr",
  "dktStateId",
  "dktStateName",
  "assigneeId",
  "sprintId",
  "sprintName",
  "hasNoSprint",
  "category",
  "priority",
  "epicId",
  "storyPointEst",
]);
const LOCAL_DOCKET_UPDATE_COMPANION_FIELDS = new Set([
  "docketState",
  "assignee",
  "sprint",
  "storyPoints",
  "parentId",
  "elitical",
  "worklog",
  "worklogs",
]);
const DOCKET_COLLECTION_BY_TYPE = {
  epic: "epics",
  story: "stories",
  task: "tasks",
  job: "jobs",
};
let sdkProviderPromise = null;
let sdkProviderLeaseCount = 0;

logBuffer.captureConsole(console);
syncService.registerProvider(createEliticalSyncProvider());

function logRequest(message) {
  console.log(`[local-backend] ${message}`);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
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

function normalizeDocketType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["epic", "story", "task", "job"].includes(normalized)) return normalized;

  if (normalized.includes("epic")) return "epic";
  if (normalized.includes("story")) return "story";
  if (normalized.includes("job")) return "job";
  if (normalized.includes("task")) return "task";

  return "";
}

function normalizeEliticalType(type) {
  return normalizeDocketType(type).toUpperCase();
}

function acceptsWorklog(type) {
  return ["story", "task", "job"].includes(normalizeDocketType(type));
}

function normalizeWorklogDate(value) {
  return eliticalWorklogDateMillis(value) || "";
}

function worklogDateKey(value) {
  const millis = normalizeWorklogDate(value);

  if (!millis) return "";

  const date = new Date(millis);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function worklogDatesMatch(first, second) {
  const firstMillis = normalizeWorklogDate(first);
  const secondMillis = normalizeWorklogDate(second);

  if (!firstMillis || !secondMillis) return false;
  if (Number(firstMillis) === Number(secondMillis)) return true;

  return worklogDateKey(firstMillis) === worklogDateKey(secondMillis);
}

function worklogDurationMinutes(value = {}) {
  const totalMinutes = firstNumber(value.timeMinutes, value.durationMinutes);

  if (totalMinutes) return totalMinutes;

  return firstNumber(value.hour) * 60 + firstNumber(value.min);
}

function positiveWorklogDurationMinutes(value = {}) {
  const explicitMinutes = firstNumber(value.timeMinutes, value.durationMinutes, value.loggedMinutes);

  if (explicitMinutes > 0) return explicitMinutes;

  const derivedMinutes = firstNumber(value.hour, value.hours, value.loggedHours, value.duration) * 60 +
    firstNumber(value.min, value.minutes);

  return derivedMinutes > 0 ? derivedMinutes : 0;
}

function worklogDurationFieldsFromMinutes(minutes) {
  const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));

  return {
    hour: Math.floor(totalMinutes / 60),
    min: totalMinutes % 60,
    timeMinutes: totalMinutes,
    durationMinutes: totalMinutes,
  };
}

function hasOwnField(object, field) {
  return Object.prototype.hasOwnProperty.call(object || {}, field);
}

function worklogUpdateRequestedFields(changes = {}) {
  const fields = new Set();

  if (hasOwnField(changes, "comment")) fields.add("comment");
  if (hasOwnField(changes, "worklogDate") || hasOwnField(changes, "date")) fields.add("worklogDate");
  if (
    hasOwnField(changes, "hour") ||
    hasOwnField(changes, "min") ||
    hasOwnField(changes, "timeMinutes") ||
    hasOwnField(changes, "durationMinutes") ||
    hasOwnField(changes, "minutes")
  ) {
    fields.add("duration");
  }

  return fields;
}

function confirmedWorklogUpdateResult(operation, outboundWorklog, updatedWorklog = {}) {
  const requestedFields = worklogUpdateRequestedFields(operation.changes || {});
  const acceptedChanges = {};
  const rejectedFields = [];
  const remoteDuration = positiveWorklogDurationMinutes(updatedWorklog);
  const outboundDuration = positiveWorklogDurationMinutes(outboundWorklog);
  const remoteBaseline = {
    ...(operation.remoteBaseline || {}),
    comment: firstString(updatedWorklog?.comment, updatedWorklog?.description, operation.remoteBaseline?.comment),
    worklogDate: normalizeWorklogDate(
      updatedWorklog?.worklogDate ||
      updatedWorklog?.date ||
      operation.remoteBaseline?.worklogDate
    ),
    hour: remoteDuration > 0
      ? Math.floor(remoteDuration / 60)
      : firstNumber(updatedWorklog?.hour, operation.remoteBaseline?.hour),
    min: remoteDuration > 0
      ? remoteDuration % 60
      : firstNumber(updatedWorklog?.min, operation.remoteBaseline?.min),
  };

  if (requestedFields.has("comment")) {
    if (firstString(updatedWorklog?.comment, updatedWorklog?.description) === firstString(outboundWorklog.comment, outboundWorklog.description)) {
      acceptedChanges.comment = operation.changes.comment;
      remoteBaseline.comment = firstString(outboundWorklog.comment, outboundWorklog.description);
    } else {
      rejectedFields.push("comment");
    }
  }

  if (requestedFields.has("worklogDate")) {
    if (worklogUpdateDatesConfirm(updatedWorklog?.worklogDate || updatedWorklog?.date, outboundWorklog.worklogDate || outboundWorklog.date)) {
      if (hasOwnField(operation.changes || {}, "worklogDate")) {
        acceptedChanges.worklogDate = operation.changes.worklogDate;
      }
      if (hasOwnField(operation.changes || {}, "date")) {
        acceptedChanges.date = operation.changes.date;
      }
      remoteBaseline.worklogDate = normalizeWorklogDate(updatedWorklog?.worklogDate || updatedWorklog?.date || outboundWorklog.worklogDate || outboundWorklog.date);
    } else {
      rejectedFields.push("worklogDate");
    }
  }

  if (requestedFields.has("duration")) {
    if (remoteDuration > 0 && remoteDuration === outboundDuration) {
      ["hour", "min", "timeMinutes", "durationMinutes", "minutes"].forEach((field) => {
        if (hasOwnField(operation.changes || {}, field)) acceptedChanges[field] = operation.changes[field];
      });
      remoteBaseline.hour = firstNumber(outboundWorklog.hour);
      remoteBaseline.min = firstNumber(outboundWorklog.min);
    } else {
      rejectedFields.push("duration");
    }
  }

  return {
    acceptedChanges,
    rejectedFields,
    remoteBaseline,
    fullyConfirmed: rejectedFields.length === 0,
  };
}

function confirmedUpdatedWorklog(operation, outboundWorklog, updatedWorklog, remoteDocketId, remoteWorklogId) {
  const outboundDuration = positiveWorklogDurationMinutes(outboundWorklog);
  const remoteDuration = positiveWorklogDurationMinutes(updatedWorklog);
  const durationChangeWasSent = [
    "hour",
    "min",
    "timeMinutes",
    "durationMinutes",
    "minutes",
  ].some((field) => Object.prototype.hasOwnProperty.call(operation.changes || {}, field));
  const preserveOutboundDuration = outboundDuration > 0 && (remoteDuration === 0 || durationChangeWasSent);
  const durationFields = preserveOutboundDuration
    ? worklogDurationFieldsFromMinutes(outboundDuration)
    : worklogDurationFieldsFromMinutes(remoteDuration || outboundDuration);
  const dateChangeWasSent =
    Object.prototype.hasOwnProperty.call(operation.changes || {}, "worklogDate") ||
    Object.prototype.hasOwnProperty.call(operation.changes || {}, "date");
  const commentChangeWasSent = Object.prototype.hasOwnProperty.call(operation.changes || {}, "comment");

  return {
    ...(operation.remoteBaseline || {}),
    ...(operation.payload || {}),
    ...(operation.changes || {}),
    ...(updatedWorklog || {}),
    ...(durationFields.timeMinutes > 0 ? durationFields : {}),
    id: firstString(updatedWorklog?.id, updatedWorklog?.worklogId, remoteWorklogId),
    docketId: firstString(updatedWorklog?.docketId, remoteDocketId),
    comment: commentChangeWasSent
      ? firstString(outboundWorklog.comment, outboundWorklog.description)
      : firstString(updatedWorklog?.comment, updatedWorklog?.description, outboundWorklog.comment, outboundWorklog.description),
    description: commentChangeWasSent
      ? firstString(outboundWorklog.comment, outboundWorklog.description)
      : firstString(updatedWorklog?.description, updatedWorklog?.comment, outboundWorklog.description, outboundWorklog.comment),
    worklogDate: dateChangeWasSent
      ? outboundWorklog.worklogDate || outboundWorklog.date
      : firstString(updatedWorklog?.worklogDate, updatedWorklog?.date)
      ? updatedWorklog.worklogDate || updatedWorklog.date
      : outboundWorklog.worklogDate || outboundWorklog.date,
  };
}

function normalizeWorklogForInput(input = {}) {
  if (!input || typeof input !== "object") {
    return {
      id: "",
      docketId: "",
      comment: "",
      worklogDate: "",
      hour: 0,
      min: 0,
    };
  }

  const totalMinutes = firstNumber(input.timeMinutes, input.durationMinutes);
  const hour = input.hour !== undefined ? firstNumber(input.hour) : Math.floor(totalMinutes / 60);
  const min = input.min !== undefined ? firstNumber(input.min) : totalMinutes % 60;

  return {
    id: firstString(input.id, input.worklogId),
    docketId: firstString(input.docketId),
    comment: firstString(input.comment, input.description),
    worklogDate: normalizeWorklogDate(input.worklogDate || input.date),
    hour,
    min,
  };
}

function isMeaningfulWorklogPayload(input = {}) {
  const worklog = normalizeWorklogForInput(input);

  return Number(worklog.hour) > 0 || Number(worklog.min) > 0;
}

function validateWorklogPayload(input = {}, { docketType = "" } = {}) {
  if (!isMeaningfulWorklogPayload(input)) return "";
  if (!acceptsWorklog(docketType)) return "Worklogs are supported only for Story, Task, and Job.";

  const worklog = normalizeWorklogForInput(input);

  if (!worklog.comment) return "Worklog comment is required.";
  if (!worklog.worklogDate) return "Worklog date is required.";
  if (Number(worklog.hour) < 0 || Number(worklog.min) < 0) return "Worklog time cannot be negative.";
  if (Number(worklog.min) > 59) return "Worklog minutes must be between 0 and 59.";
  if (Number(worklog.hour) === 0 && Number(worklog.min) === 0) return "Worklog time is required.";

  return "";
}

function itemCollections(graph) {
  return ["epics", "stories", "jobs", "tasks"].map((key) => [
    key,
    Array.isArray(graph?.[key]) ? graph[key] : [],
  ]);
}

function allGraphItems(graph) {
  return itemCollections(graph).flatMap(([, items]) => items);
}

function findCachedDocket(graph, { remoteId = "", docketNumber = "" } = {}) {
  const targetRemoteId = firstString(remoteId);
  const targetNumber = firstString(docketNumber);

  return allGraphItems(graph).find((item) =>
    (!targetRemoteId || firstString(item.id, item.remoteId, item.sync?.remoteId) === targetRemoteId) &&
    (!targetNumber || firstString(item.num, item.docketNumber, item.docketNum) === targetNumber)
  );
}

function findCachedWorklog(worklogCache = {}, { remoteId = "", docketId = "" } = {}) {
  const worklogs = Array.isArray(worklogCache.worklogs) ? worklogCache.worklogs : [];
  const targetRemoteId = firstString(remoteId);
  const targetDocketId = firstString(docketId);

  return worklogs.find((worklog) =>
    (!targetRemoteId || firstString(worklog.id, worklog.worklogId, worklog.eliticalId, worklog.raw?.id) === targetRemoteId) &&
    (!targetDocketId || firstString(worklog.docketId, worklog.raw?.docketId) === targetDocketId)
  );
}

function recoveryPreviewPayload({
  parentOperation,
  dependentOperation,
  replacementDocket,
  replacementWorklog,
} = {}) {
  return {
    parent: {
      operationId: parentOperation.operationId,
      localId: parentOperation.localId,
      status: parentOperation.status,
      title: firstString(parentOperation.payload?.title),
      docketType: parentOperation.docketType,
    },
    dependent: {
      operationId: dependentOperation.operationId,
      localId: dependentOperation.localId,
      status: dependentOperation.status,
      docketId: firstString(dependentOperation.docketId, dependentOperation.payload?.docketId),
      dependsOn: dependentOperation.dependsOn,
      comment: firstString(dependentOperation.payload?.comment, dependentOperation.payload?.description),
      worklogDate: firstString(dependentOperation.payload?.worklogDate, dependentOperation.payload?.date),
      hour: firstNumber(dependentOperation.payload?.hour),
      min: firstNumber(dependentOperation.payload?.min),
    },
    replacementDocket: {
      id: replacementDocket.id,
      num: firstString(replacementDocket.num, replacementDocket.docketNumber, replacementDocket.docketNum),
      title: replacementDocket.title,
      type: replacementDocket.type,
    },
    replacementWorklog: {
      id: firstString(replacementWorklog.id, replacementWorklog.worklogId, replacementWorklog.eliticalId),
      docketId: replacementWorklog.docketId,
      worklogDate: firstString(replacementWorklog.worklogDate, replacementWorklog.date, replacementWorklog.raw?.worklogDate),
      hour: firstNumber(replacementWorklog.hour, replacementWorklog.raw?.hour),
      min: firstNumber(replacementWorklog.min, replacementWorklog.raw?.min),
      durationMinutes: firstNumber(
        replacementWorklog.durationMinutes,
        replacementWorklog.timeMinutes,
        replacementWorklog.raw?.durationMinutes,
        replacementWorklog.raw?.timeMinutes
      ),
      comment: firstString(replacementWorklog.comment, replacementWorklog.description),
    },
  };
}

async function validateDuplicateRecoveryRequest(input = {}) {
  const parentOperationId = firstString(input.parentOperationId);
  const dependentOperationId = firstString(input.dependentOperationId);
  const replacementRemoteDocketId = firstString(input.replacementRemoteDocketId);
  const replacementDocketNumber = firstString(input.replacementDocketNumber);
  const replacementRemoteWorklogId = firstString(input.replacementRemoteWorklogId);

  function fail(message, details = {}) {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = "DUPLICATE_RECOVERY_VALIDATION_FAILED";
    error.details = details;
    throw error;
  }

  if (!parentOperationId) fail("parentOperationId is required.");
  if (!dependentOperationId) fail("dependentOperationId is required.");
  if (!replacementRemoteDocketId) fail("replacementRemoteDocketId is required.");
  if (!replacementDocketNumber) fail("replacementDocketNumber is required.");
  if (!replacementRemoteWorklogId) fail("replacementRemoteWorklogId is required.");

  const [queue, graph, worklogCache] = await Promise.all([
    syncQueueService.load(),
    cacheService.loadGraph(),
    worklogService.loadImportedWorklogs(),
  ]);
  const parentOperation = (queue.operations || []).find((operation) => operation.operationId === parentOperationId);
  const dependentOperation = (queue.operations || []).find((operation) => operation.operationId === dependentOperationId);

  if (!parentOperation) fail("Parent operation was not found.");
  if (!dependentOperation) fail("Dependent operation was not found.");
  if (parentOperation.entityType !== "docket" || parentOperation.operation !== "create") {
    fail("Parent operation must be a Docket create.");
  }
  if (parentOperation.status !== "sync-failed") {
    fail("Parent operation must currently be sync-failed.", {
      status: parentOperation.status,
    });
  }
  if (dependentOperation.entityType !== "worklog" || dependentOperation.operation !== "create") {
    fail("Dependent operation must be a Worklog create.");
  }
  if (dependentOperation.status !== "dependency-blocked") {
    fail("Dependent operation must currently be dependency-blocked.", {
      status: dependentOperation.status,
    });
  }
  if (dependentOperation.dependsOn !== parentOperation.localId) {
    fail("Dependent operation does not depend on the selected parent operation.");
  }
  if (firstString(dependentOperation.docketId, dependentOperation.payload?.docketId) !== parentOperation.localId) {
    fail("Dependent Worklog does not reference the selected parent Docket.");
  }

  const replacementDocket = findCachedDocket(graph, {
    remoteId: replacementRemoteDocketId,
    docketNumber: replacementDocketNumber,
  });

  if (!replacementDocket) {
    fail("Replacement Docket was not found in the local cache.", {
      replacementRemoteDocketId,
      replacementDocketNumber,
    });
  }

  const replacementWorklog = findCachedWorklog(worklogCache, {
    remoteId: replacementRemoteWorklogId,
    docketId: replacementRemoteDocketId,
  });

  if (!replacementWorklog) {
    fail("Replacement Worklog was not found in the local cache.", {
      replacementRemoteWorklogId,
      replacementRemoteDocketId,
    });
  }

  return {
    parentOperationId,
    dependentOperationId,
    replacementRemoteDocketId,
    replacementDocketNumber,
    replacementRemoteWorklogId,
    parentOperation,
    dependentOperation,
    replacementDocket,
    replacementWorklog,
  };
}

function isSyntheticMutationId(id) {
  const value = firstString(id);

  return (
    !value ||
    value === ORPHAN_SPRINT_ID ||
    value.startsWith("reference-") ||
    value.startsWith("ghost-") ||
    value.startsWith("virtual-")
  );
}

function errorChain(error) {
  const errors = [];
  let current = error;
  const seen = new Set();

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    errors.push(current);
    current = current.cause;
  }

  return errors;
}

function isAmbiguousMutationError(error) {
  const chain = errorChain(error);
  const text = chain
    .map((entry) => `${entry.name || ""} ${entry.code || ""} ${entry.message || ""}`)
    .join(" ")
    .toLowerCase();
  const statusEntry = chain.find((entry) => Number(entry.status || entry.statusCode));
  const status = Number(statusEntry?.status || statusEntry?.statusCode || 0);

  if (status >= 400 && status < 500) return false;

  return (
    text.includes("aborterror") ||
    text.includes("signal is aborted") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("target page, context or browser has been closed") ||
    text.includes("page closed") ||
    text.includes("context closed") ||
    text.includes("browser closed") ||
    text.includes("networkerror") ||
    text.includes("network error") ||
    text.includes("socket hang up") ||
    text.includes("econnreset") ||
    text.includes("response lost")
  );
}

function updateFieldsOnly(updates = {}) {
  const supported = {};
  const unsupportedFields = Object.keys(updates || {}).filter(
    (field) =>
      field !== "id" &&
      !CONFIRMED_DOCKET_UPDATE_FIELDS.has(field) &&
      !LOCAL_DOCKET_UPDATE_COMPANION_FIELDS.has(field)
  );

  if (Object.prototype.hasOwnProperty.call(updates, "title")) {
    supported.title = firstString(updates.title);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "description")) {
    supported.description = firstString(updates.description);
  } else if (Object.prototype.hasOwnProperty.call(updates, "descr")) {
    supported.descr = firstString(updates.descr);
  }

  [
    "dktStateId",
    "assigneeId",
    "sprintId",
    "sprintName",
    "category",
    "priority",
    "epicId",
  ].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      supported[field] = firstString(updates[field]);
    }
  });

  if (Object.prototype.hasOwnProperty.call(updates, "hasNoSprint")) {
    supported.hasNoSprint = Boolean(updates.hasNoSprint);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "storyPointEst")) {
    supported.storyPointEst = firstNumber(updates.storyPointEst);
  }

  LOCAL_DOCKET_UPDATE_COMPANION_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      supported[field] = updates[field];
    }
  });

  return {
    supported,
    unsupportedFields,
    supportedFields: Object.keys(supported).filter((field) => CONFIRMED_DOCKET_UPDATE_FIELDS.has(field)),
  };
}

async function sdkProvider() {
  if (!sdkProviderPromise) {
    sdkProviderPromise = (async () => {
      const [
        { EliticalAuthService },
        { EliticalClient },
        { EliticalProvider },
      ] = await Promise.all([
        import("./../src/services/elitical/auth/index.js"),
        import("./../src/services/elitical/client/index.js"),
        import("./../src/services/elitical/provider/index.js"),
      ]);
      const authService = new EliticalAuthService({
        baseUrl: process.env.ELITICAL_BASE_URL || undefined,
        dataDir: process.env.ELITICAL_DATA_DIR || undefined,
        storageStatePath: process.env.ELITICAL_STORAGE_STATE_PATH || undefined,
      });

      await authService.initialize();

      const session = await authService.restoreSession();

      if (!session) {
        await authService.login();
      }

      return new EliticalProvider(new EliticalClient(authService));
    })().catch((error) => {
      sdkProviderPromise = null;
      throw error;
    });
  }

  return sdkProviderPromise;
}

async function closeSdkProvider({ force = false } = {}) {
  if (!force && sdkProviderLeaseCount > 0) return;

  const providerPromise = sdkProviderPromise;
  sdkProviderPromise = null;

  if (!providerPromise) return;

  try {
    const provider = await providerPromise;
    await provider?.close?.();
  } catch (error) {
    console.warn("[local-backend] SDK provider cleanup failed", {
      message: error?.message || String(error),
    });
  }
}

async function acquireSdkProvider() {
  sdkProviderLeaseCount += 1;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    sdkProviderLeaseCount = Math.max(0, sdkProviderLeaseCount - 1);
    await closeSdkProvider();
  };

  try {
    const provider = await sdkProvider();

    return {
      provider,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

function issueId(issue) {
  return firstString(issue?.id, issue?.eliticalId, issue?.docketId, issue?.dktId, issue?.cx);
}

function sprintTitle(graph, sprintId, fallback = "") {
  const sprint = (graph.appState?.sprints || graph.sprints || []).find(
    (entry) => entry?.id === sprintId
  );

  return firstString(sprint?.title, sprint?.name, fallback);
}

function stateName(graph, stateId, fallback = "") {
  const state = (graph.states || []).find((entry) => entry?.id === stateId);

  return firstString(state?.name, state?.title, fallback);
}

function resolveDocketCreateStateFields(payload = {}) {
  const docketState = normalizeDocketState(
    firstString(payload.docketState, payload.dktStateName, payload.stateName)
  );
  const dktStateId = firstString(payload.dktStateId, payload.stateId, docketStateApiId(docketState));
  const dktStateName = firstString(payload.dktStateName, payload.stateName, docketStateApiName(docketState));

  return {
    ...payload,
    docketState,
    dktStateId,
    dktStateName,
  };
}

function normalizeDocketCreatePayload(payload = {}) {
  return resolveDocketCreateStateFields(
    normalizeEliticalCreateDescriptionFields(payload)
  );
}

function parentFor(graph, parentId) {
  return (graph.appState?.workItems || []).find((item) => item?.id === parentId) || null;
}

function buildCreatedDocketRecords({ graph, issue, payload }) {
  const type = normalizeDocketType(payload.type || issue?.type);
  const id = issueId(issue);
  const parent = parentFor(graph, payload.parentId);
  const projectId = firstString(
    issue?.projectId,
    payload.projectId,
    parent?.elitical?.projectId,
    graph.projects?.[0]?.id,
    graph.targetProject?.id
  );
  const sprintId = firstString(issue?.sprintId, payload.sprintId);
  const parentId = type === "epic" ? ROOT_ID : firstString(payload.parentId, issue?.parentId);
  const parentEpicId =
    type === "epic"
      ? ""
      : type === "story" || type === "task"
      ? parentId
      : firstString(parent?.elitical?.epicId, parent?.parentId, issue?.epicId, payload.epicId);
  const parentStoryId =
    type === "job"
      ? parentId
      : type === "story"
      ? id
      : "";
  const stateId = firstString(issue?.stateId, issue?.dktStateId, payload.dktStateId);
  const docketState = normalizeDocketState(firstString(
    issue?.docketState,
    issue?.dktState,
    issue?.dktStateName,
    issue?.status,
    payload.docketState,
    stateName(graph, stateId),
    "concept"
  ));
  const createdAt = firstString(issue?.createdAt, issue?.createdTime, new Date().toISOString());
  const updatedAt = firstString(issue?.updatedAt, issue?.updatedTime, createdAt);
  const title = firstString(issue?.title, issue?.name, issue?.docketTitle, payload.title, id);
  const description = firstString(issue?.description, issue?.descr, payload.description, payload.descr);
  const sprint = sprintTitle(graph, sprintId, firstString(issue?.sprint, issue?.sprintName, payload.sprint));
  const storyPoints = type === "story"
    ? firstNumber(issue?.storyPoints, issue?.estimatedStoryPoints, payload.storyPoints, payload.storyPointEst)
    : 0;
  const assigneeName = firstString(issue?.assigneeName, issue?.assignee, payload.assignee);
  const createdBy = firstString(issue?.createdBy, assigneeName);
  const updatedBy = firstString(issue?.updatedBy, assigneeName);
  const num = firstString(issue?.num, issue?.number, issue?.docketNumber);
  const rawRecord = {
    ...issue,
    id,
    num,
    type: normalizeEliticalType(type),
    title,
    description,
    projectId,
    sprintId,
    epicId: parentEpicId,
    epicName: firstString(issue?.epicName, parent?.type === "epic" ? parent.title : ""),
    epicNum: firstString(issue?.epicNum, parent?.type === "epic" ? parent.elitical?.num : ""),
    storyId: parentStoryId,
    storyName: firstString(issue?.storyName, parent?.type === "story" ? parent.title : ""),
    storyNum: firstString(issue?.storyNum, parent?.type === "story" ? parent.elitical?.num : ""),
    parentId,
    stateId,
    stateName: docketStateApiName(docketState),
    dktStateName: docketStateApiName(docketState),
    docketState,
    category: firstString(issue?.category, payload.category, "feature"),
    priority: firstString(issue?.priority, payload.priority, "info"),
    assigneeId: firstString(issue?.assigneeId, payload.assigneeId),
    assigneeName,
    reporterId: firstString(issue?.reporterId, payload.reporterId),
    reporterName: firstString(issue?.reporterName),
    storyPoints,
    createdBy,
    createdAt,
    updatedBy,
    updatedAt,
    worklogs: Array.isArray(issue?.worklogs) ? issue.worklogs : [],
  };
  const appItem = {
    id,
    sourceId: id,
    title,
    description,
    category: rawRecord.category,
    priority: rawRecord.priority,
    sprint,
    docketState,
    assignee: assigneeName,
    createdBy,
    createdAt,
    updatedBy,
    updatedAt,
    elitical: {
      num,
      projectId,
      sprintId,
      epicId: parentEpicId,
      storyId: parentStoryId,
      stateId,
      assigneeId: rawRecord.assigneeId,
      reporterId: rawRecord.reporterId,
    },
    type,
    parentId,
    ...(type === "story" ? { storyPoints } : {}),
    ...(["task", "job"].includes(type) ? { worklogs: [] } : {}),
  };

  return {
    type,
    id,
    rawRecord,
    appItem,
  };
}

function withSyncMetadata(record, sync) {
  return {
    ...record,
    sync: {
      status: sync.status,
      remoteId: sync.remoteId || "",
      localId: sync.localId || "",
      lastError: sync.lastError || "",
      pendingChanges: sync.pendingChanges || {},
      operationId: sync.operationId || "",
    },
    elitical: record.elitical
      ? {
          ...record.elitical,
          remoteId: sync.remoteId || record.elitical.remoteId || "",
        }
      : record.elitical,
  };
}

function writeGraphEventPayload(nextGraph, cacheWrite, queueSummary, status = "updated") {
  return {
    status,
    normalized: nextGraph,
    cache: {
      changed: cacheWrite.changed,
      metadata: cacheWrite.metadata,
    },
    metadata: cacheWrite.metadata,
    syncQueue: queueSummary,
  };
}

async function saveLocalGraph(nextGraph, { status = "updated" } = {}) {
  const cacheWrite = await cacheService.saveGraph(nextGraph, {
    syncedAt: new Date().toISOString(),
  });
  const queueSummary = await syncQueueService.summary();
  const eventPayload = writeGraphEventPayload(nextGraph, cacheWrite, queueSummary, status);

  events.cache("cache-updated", eventPayload);

  return {
    graph: nextGraph,
    cacheWrite,
    queueSummary,
    eventPayload,
  };
}

async function createLocalDocket(payload) {
  const graph = await cacheService.loadGraph();

  if (!graph?.appState?.workItems) {
    const error = new Error("No local graph cache is available.");
    error.statusCode = 404;
    throw error;
  }

  const createPayload = normalizeDocketCreatePayload(payload);
  const localId = syncQueueService.localDocketId();
  const issue = {
    ...createPayload,
    id: localId,
    type: normalizeEliticalType(createPayload.type),
  };
  const validationError = validateDocketOperation({
    operation: "create",
    payload: {
      ...createPayload,
      id: localId,
    },
    workItems: graph.appState.workItems,
    sprints: graph.appState.sprints,
  });

  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  const requestedWorklog = createPayload.worklog || null;
  const meaningfulWorklog = isMeaningfulWorklogPayload(requestedWorklog);
  const worklogValidationError = meaningfulWorklog
    ? validateWorklogPayload(requestedWorklog, { docketType: createPayload.type })
    : "";

  if (worklogValidationError) {
    const error = new Error(worklogValidationError);
    error.statusCode = 400;
    throw error;
  }

  const records = buildCreatedDocketRecords({
    graph,
    issue,
    payload: {
      ...createPayload,
      id: localId,
    },
  });
	  const sync = {
	    status: "pending-create",
	    remoteId: "",
	    localId,
	    pendingChanges: {
	      ...createPayload,
	      title: records.appItem.title,
	      description: records.appItem.description || "",
	      descr: records.appItem.description || "",
	    },
	  };
  const appItem = withSyncMetadata(records.appItem, sync);
  const rawRecord = withSyncMetadata(records.rawRecord, sync);
  const localWorklog = meaningfulWorklog
    ? {
        ...normalizeWorklogForInput(requestedWorklog),
        id: syncQueueService.localWorklogId(),
        localId: "",
        remoteId: "",
        docketId: localId,
        date: normalizeWorklogForInput(requestedWorklog).worklogDate,
        description: normalizeWorklogForInput(requestedWorklog).comment,
        timeMinutes:
          normalizeWorklogForInput(requestedWorklog).hour * 60 +
          normalizeWorklogForInput(requestedWorklog).min,
        status: "pending-create",
        sync: {
          status: "pending-create",
          remoteId: "",
          localId: "",
          pendingChanges: normalizeWorklogForInput(requestedWorklog),
          lastError: "",
        },
      }
    : null;
  if (localWorklog) {
    localWorklog.localId = localWorklog.id;
    appItem.worklogs = [localWorklog, ...(Array.isArray(appItem.worklogs) ? appItem.worklogs : [])];
    rawRecord.worklogs = [localWorklog, ...(Array.isArray(rawRecord.worklogs) ? rawRecord.worklogs : [])];
  }
  const collectionName = DOCKET_COLLECTION_BY_TYPE[records.type];
  const nextGraph = {
    ...graph,
    generatedAt: new Date().toISOString(),
    [collectionName]: [
      ...(graph[collectionName] || []).filter((item) => item.id !== localId),
      rawRecord,
    ],
    appState: {
      ...graph.appState,
      workItems: [
        ...(graph.appState.workItems || []).filter((item) => item.id !== localId),
        appItem,
      ],
    },
  };

	  await syncQueueService.enqueueCreate({
	    item: appItem,
	    payload: {
	      ...createPayload,
	      worklog: undefined,
	      id: localId,
	    },
	  });

  if (localWorklog) {
    await syncQueueService.enqueueWorklogCreate({
      worklog: localWorklog,
      dependsOn: localId,
    });
  }

  const saved = await saveLocalGraph(nextGraph, { status: "local-created" });

  return {
	    status: "local-created",
	    message: `Created ${normalizeDocketType(createPayload?.type) || "docket"} locally. Sync to Elitical is pending.`,
    docket: rawRecord,
    item: appItem,
    normalized: saved.graph,
    cache: {
      changed: saved.cacheWrite.changed,
      metadata: saved.cacheWrite.metadata,
    },
    metadata: saved.cacheWrite.metadata,
    syncQueue: saved.queueSummary,
  };
}

function updatedRawRecord(raw, changes, pendingChanges = changes, remoteBaseline = null) {
  const baseline = remoteBaseline || {
    title: raw.sync?.remoteBaseline?.title || raw.title || "",
    description: firstString(raw.sync?.remoteBaseline?.description, raw.description, raw.descr),
  };
  const hasPendingChanges = Object.keys(pendingChanges || {}).length > 0;
  const next = {
    ...raw,
    ...changes,
    descr: changes.description !== undefined ? changes.description : raw.descr,
    sync: {
      ...(raw.sync || {}),
      status: raw.sync?.status === "pending-create"
        ? "pending-create"
        : hasPendingChanges
        ? "pending-update"
        : "synced",
      remoteId: firstString(raw.sync?.remoteId, raw.elitical?.remoteId, raw.id),
      pendingChanges: hasPendingChanges ? pendingChanges : {},
      remoteBaseline: baseline,
      lastError: "",
    },
  };

  return next;
}

function remoteBaselineForItem(item = {}) {
  const baseline = item.sync?.remoteBaseline || {};
  const elitical = item.elitical || {};

  return {
    ...baseline,
    title: firstString(baseline.title ?? item.title),
    description: firstString(baseline.description ?? item.description ?? item.descr),
    dktStateId: firstString(baseline.dktStateId ?? baseline.stateId ?? elitical.stateId ?? item.dktStateId),
    dktStateName: docketStateApiName(
      normalizeDocketState(baseline.dktStateName ?? baseline.docketState ?? item.dktStateName ?? item.docketState)
    ),
    assigneeId: firstString(baseline.assigneeId ?? elitical.assigneeId ?? item.assigneeId),
    sprintId: firstString(baseline.sprintId ?? elitical.sprintId ?? item.sprintId),
    sprintName: firstString(baseline.sprintName ?? item.sprintName ?? item.sprint),
    category: firstString(baseline.category ?? item.category),
    priority: firstString(baseline.priority ?? item.priority),
    epicId: firstString(baseline.epicId ?? item.epicId ?? item.parentId),
    storyPointEst: firstNumber(baseline.storyPointEst ?? item.storyPointEst ?? item.storyPoints),
  };
}

function supportedChangesAgainstBaseline(changes = {}, baseline = {}) {
  const next = {};

  if (
    Object.prototype.hasOwnProperty.call(changes, "title") &&
    firstString(changes.title) !== firstString(baseline.title)
  ) {
    next.title = firstString(changes.title);
  }

  if (
    Object.prototype.hasOwnProperty.call(changes, "description") &&
    firstString(changes.description) !== firstString(baseline.description)
  ) {
    next.description = firstString(changes.description);
  }

  if (
    Object.prototype.hasOwnProperty.call(changes, "descr") &&
    !Object.prototype.hasOwnProperty.call(next, "description") &&
    firstString(changes.descr) !== firstString(baseline.description)
  ) {
    next.description = firstString(changes.descr);
  }

  [
    "dktStateId",
    "dktStateName",
    "assigneeId",
    "sprintId",
    "sprintName",
    "category",
    "priority",
    "epicId",
  ].forEach((field) => {
    if (
      Object.prototype.hasOwnProperty.call(changes, field) &&
      firstString(changes[field]) !== firstString(baseline[field])
    ) {
      next[field] = firstString(changes[field]);
    }
  });

  if (
    Object.prototype.hasOwnProperty.call(changes, "dktStateName") &&
    docketStateApiName(normalizeDocketState(changes.dktStateName)) !==
      docketStateApiName(normalizeDocketState(baseline.dktStateName))
  ) {
    next.dktStateName = docketStateApiName(normalizeDocketState(changes.dktStateName));
  }

  if (Object.prototype.hasOwnProperty.call(changes, "hasNoSprint")) {
    next.hasNoSprint = Boolean(changes.hasNoSprint);
  }

  if (
    Object.prototype.hasOwnProperty.call(changes, "storyPointEst") &&
    firstNumber(changes.storyPointEst) !== firstNumber(baseline.storyPointEst)
  ) {
    next.storyPointEst = firstNumber(changes.storyPointEst);
  } else if (
    Object.prototype.hasOwnProperty.call(changes, "storyPoints") &&
    firstNumber(changes.storyPoints) !== firstNumber(baseline.storyPointEst)
  ) {
    next.storyPointEst = firstNumber(changes.storyPoints);
  }

  return next;
}

function updatedAppItem(item, changes, pendingChanges = changes) {
  const remoteBaseline = item.sync?.remoteBaseline || remoteBaselineForItem(item);
  const hasPendingChanges = Object.keys(pendingChanges || {}).length > 0;
  const next = {
    ...item,
    ...changes,
    sync: {
      ...(item.sync || {}),
      status: item.sync?.status === "pending-create"
        ? "pending-create"
        : hasPendingChanges
        ? "pending-update"
        : "synced",
      remoteId: firstString(item.sync?.remoteId, item.elitical?.remoteId, item.id),
      pendingChanges: {
        ...(hasPendingChanges ? pendingChanges : {}),
      },
      remoteBaseline,
      lastError: "",
    },
  };

  return withSyncMetadata(next, next.sync);
}

function worklogRemoteBaseline(worklog = {}) {
  return {
    comment: firstString(worklog.sync?.remoteBaseline?.comment, worklog.comment, worklog.description),
    worklogDate: normalizeWorklogDate(
      worklog.sync?.remoteBaseline?.worklogDate ||
      worklog.worklogDate ||
      worklog.date
    ),
    hour: firstNumber(worklog.sync?.remoteBaseline?.hour, worklog.hour),
    min: firstNumber(worklog.sync?.remoteBaseline?.min, worklog.min),
  };
}

function worklogRecordForSave(docketId, input = {}, existing = null) {
  const normalized = normalizeWorklogForInput(input);
  const id = firstString(existing?.id, input.id) || syncQueueService.localWorklogId();
  const isLocal = syncQueueService.isLocalWorklogId(id);
  const remoteBaseline = existing ? worklogRemoteBaseline(existing) : null;
  const status = isLocal ? "pending-create" : "pending-update";

  return {
    ...(existing || {}),
    ...normalized,
    id,
    localId: isLocal ? id : firstString(existing?.sync?.localId),
    remoteId: isLocal ? "" : firstString(existing?.sync?.remoteId, existing?.remoteId, existing?.id),
    docketId,
    date: normalized.worklogDate,
    description: normalized.comment,
    timeMinutes: normalized.hour * 60 + normalized.min,
    status,
    sync: {
      ...(existing?.sync || {}),
      status,
      remoteId: isLocal ? "" : firstString(existing?.sync?.remoteId, existing?.remoteId, existing?.id),
      localId: isLocal ? id : firstString(existing?.sync?.localId),
      pendingChanges: normalized,
      remoteBaseline,
      lastError: "",
    },
  };
}

function mergeWorklogIntoGraph(graph, docketId, worklog) {
  const rewrite = (item) => {
    if (!item || item.id !== docketId) return item;

    const currentWorklogs = Array.isArray(item.worklogs) ? item.worklogs : [];
    const nextWorklogs = [
      worklog,
      ...currentWorklogs.filter((entry) => firstString(entry?.id, entry?.worklogId) !== worklog.id),
    ];

    return {
      ...item,
      worklogs: nextWorklogs,
    };
  };
  const nextGraph = {
    ...graph,
    appState: {
      ...(graph.appState || {}),
      workItems: (graph.appState?.workItems || []).map(rewrite),
    },
  };

  itemCollections(graph).forEach(([key, items]) => {
    nextGraph[key] = items.map(rewrite);
  });

  return nextGraph;
}

function markGraphWorklogSynced(graph, localWorklogId, remoteWorklogId, changes = {}, syncResult = {}) {
  const rewrite = (item) => {
    if (!item || !Array.isArray(item.worklogs)) return item;

    const rewrittenWorklogs = item.worklogs.map((entry) => {
      const entryId = firstString(entry?.id, entry?.worklogId);

      if (entryId !== localWorklogId && entryId !== remoteWorklogId) return entry;

      const next = {
        ...entry,
        ...changes,
        id: remoteWorklogId || entryId,
        remoteId: remoteWorklogId || entry.remoteId || entryId,
        status: syncResult.pendingChanges && Object.keys(syncResult.pendingChanges).length
          ? "pending-update"
          : "synced",
        sync: {
          ...(entry.sync || {}),
          status: syncResult.pendingChanges && Object.keys(syncResult.pendingChanges).length
            ? "pending-update"
            : "synced",
          remoteId: remoteWorklogId || entry.sync?.remoteId || entryId,
          localId: localWorklogId || entry.sync?.localId || "",
          pendingChanges: syncResult.pendingChanges || {},
          lastError: syncResult.error?.message || "",
          remoteBaseline: syncResult.remoteBaseline || {
            comment: firstString(changes.comment, entry.comment, entry.description),
            worklogDate: normalizeWorklogDate(changes.worklogDate || entry.worklogDate || entry.date),
            hour: firstNumber(changes.hour, entry.hour),
            min: firstNumber(changes.min, entry.min),
          },
          lastSyncedAt: syncResult.pendingChanges && Object.keys(syncResult.pendingChanges).length
            ? entry.sync?.lastSyncedAt || ""
            : new Date().toISOString(),
        },
      };

      next.description = firstString(next.description, next.comment);
      next.date = normalizeWorklogDate(next.worklogDate || next.date);
      next.timeMinutes = firstNumber(next.hour) * 60 + firstNumber(next.min);

      return next;
    });
    const seen = new Set();
    const worklogs = rewrittenWorklogs.filter((entry) => {
      const key = firstString(entry?.id, entry?.worklogId);

      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      ...item,
      worklogs,
    };
  };
  const nextGraph = {
    ...graph,
    appState: {
      ...(graph.appState || {}),
      workItems: (graph.appState?.workItems || []).map(rewrite),
    },
  };

  itemCollections(graph).forEach(([key, items]) => {
    nextGraph[key] = items.map(rewrite);
  });

  return nextGraph;
}

function normalizedWorklogCacheEntry(worklog = {}, operation = {}, remoteDocketId = "") {
  const payload = {
    ...(operation.payload || {}),
    ...worklog,
    docketId: firstString(worklog.docketId, remoteDocketId, operation.docketId),
  };
  const worklogDate = normalizeWorklogDate(payload.worklogDate || payload.date);
  const totalMinutes = positiveWorklogDurationMinutes(payload);
  const hour = totalMinutes > 0 ? Math.floor(totalMinutes / 60) : firstNumber(payload.hour);
  const min = totalMinutes > 0 ? totalMinutes % 60 : firstNumber(payload.min);

  return {
    id: firstString(payload.id, payload.worklogId),
    docketId: firstString(payload.docketId),
    projectId: firstString(payload.projectId),
    projectName: firstString(payload.projectName),
    docketType: firstString(payload.docketType),
    docketNumber: firstString(payload.docketNum, payload.docketNumber),
    docketTitle: firstString(payload.docketName, payload.docketTitle),
    employeeId: firstString(payload.employeeId),
    employeeName: firstString(payload.employeeName),
    worklogDate: worklogDate ? new Date(worklogDate).toISOString() : "",
    durationMinutes: totalMinutes || hour * 60 + min,
    comment: firstString(payload.comment, payload.description),
    raw: {
      ...payload,
      worklogDate,
      hour,
      min,
      date: String(worklogDate || ""),
      description: firstString(payload.comment, payload.description),
      timeMinutes: totalMinutes || hour * 60 + min,
      eliticalId: firstString(payload.id, payload.worklogId),
    },
  };
}

async function mergeSyncedWorklogIntoCache(worklog, operation, remoteDocketId) {
  const entry = normalizedWorklogCacheEntry(worklog, operation, remoteDocketId);

  if (!entry.id) return null;

  const cache = await localData.loadWorklogs();
  const existing = Array.isArray(cache?.worklogs) ? cache.worklogs : [];
  const nextWorklogs = [
    entry,
    ...existing.filter((candidate) => {
      const candidateId = firstString(candidate?.id, candidate?.worklogId);

      if (candidateId && candidateId === entry.id) return false;
      if (candidateId && candidateId === operation.localId) return false;
      return true;
    }),
  ];

  await worklogService.saveImportedWorklogs({
    ...cache,
    worklogs: nextWorklogs,
    totalWorklogs: nextWorklogs.length,
  });

  return entry;
}

async function queueLocalWorklogSave(graph, docketId, item, worklogInput) {
  if (!isMeaningfulWorklogPayload(worklogInput)) return { graph, worklog: null };

  const validationError = validateWorklogPayload(worklogInput, { docketType: item.type });

  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  const requestedId = firstString(worklogInput.id, worklogInput.worklogId);
  const existing = (Array.isArray(item.worklogs) ? item.worklogs : []).find(
    (entry) => firstString(entry?.id, entry?.worklogId) === requestedId
  );
  const worklog = worklogRecordForSave(docketId, worklogInput, existing);
  const nextGraph = mergeWorklogIntoGraph(graph, docketId, worklog);

  if (syncQueueService.isLocalWorklogId(worklog.id)) {
    await syncQueueService.enqueueWorklogCreate({
      worklog,
      dependsOn: syncQueueService.isLocalId(docketId) ? docketId : "",
    });
  } else {
    await syncQueueService.enqueueWorklogUpdate({
      worklog,
      changes: normalizeWorklogForInput(worklogInput),
      baselineWorklog: existing,
    });
  }

  return { graph: nextGraph, worklog };
}

async function updateLocalDocket(docketId, updates) {
  let graph = await cacheService.loadGraph();

  if (!graph?.appState?.workItems) {
    const error = new Error("No local graph cache is available.");
    error.statusCode = 404;
    throw error;
  }

  if (isSyntheticMutationId(docketId)) {
    const error = new Error("Refusing to update a synthetic, reference, ghost, virtual, or empty docket ID.");
    error.statusCode = 400;
    error.code = "INVALID_DOCKET_ID";
    throw error;
  }

  const item = graph.appState.workItems.find((entry) => entry.id === docketId);

  if (!item) {
    const error = new Error("Docket was not found in the local cache.");
    error.statusCode = 404;
    throw error;
  }

  let savedWorklog = null;

  if (updates.worklog) {
    const result = await queueLocalWorklogSave(graph, docketId, item, updates.worklog);

    graph = result.graph;
    savedWorklog = result.worklog;
  }

  const changes = {};

  if (updates.title !== undefined) changes.title = firstString(updates.title);
  if (updates.description !== undefined) changes.description = firstString(updates.description);
  if (updates.descr !== undefined && changes.description === undefined) {
    changes.description = firstString(updates.descr);
  }
  [
    "dktStateId",
    "dktStateName",
    "assigneeId",
    "sprintId",
    "sprintName",
    "category",
    "priority",
    "epicId",
  ].forEach((field) => {
    if (updates[field] !== undefined) changes[field] = firstString(updates[field]);
  });
  if (updates.hasNoSprint !== undefined) changes.hasNoSprint = Boolean(updates.hasNoSprint);
  if (updates.storyPointEst !== undefined) changes.storyPointEst = firstNumber(updates.storyPointEst);
  LOCAL_DOCKET_UPDATE_COMPANION_FIELDS.forEach((field) => {
    if (field === "worklog" || field === "worklogs") return;
    if (updates[field] !== undefined) changes[field] = updates[field];
  });

  const remoteBaseline = remoteBaselineForItem(item);
  const submittedPendingChanges = supportedChangesAgainstBaseline(changes, remoteBaseline);

  const validationError = validateDocketOperation({
    operation: "update",
    docket: item,
    changes: submittedPendingChanges,
    workItems: graph.appState.workItems,
    sprints: graph.appState.sprints,
  });

  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  const queue = Object.keys(changes).length
    ? await syncQueueService.enqueueUpdate({
        item: updatedAppItem(item, changes, submittedPendingChanges),
        changes,
        baselineItem: item,
      })
    : await syncQueueService.load();
  const remainingUpdate = (queue.operations || []).find(
    (operation) =>
      operation.entityType === "docket" &&
      operation.operation === "update" &&
      operation.localId === item.id &&
      ["pending-update", "sync-failed"].includes(operation.status)
  );
  const pendingChanges = remainingUpdate?.changes || {};
  const currentItem = graph.appState.workItems.find((entry) => entry.id === docketId) || item;
  const nextItem = Object.keys(changes).length
    ? updatedAppItem(currentItem, changes, pendingChanges)
    : currentItem;
  const updateRaw = (raw) =>
    raw.id === docketId ? updatedRawRecord(raw, changes, pendingChanges, remoteBaseline) : raw;
  const nextGraph = {
    ...graph,
    generatedAt: new Date().toISOString(),
    appState: {
      ...graph.appState,
      workItems: graph.appState.workItems.map((entry) =>
        entry.id === docketId ? nextItem : entry
      ),
    },
  };

  itemCollections(nextGraph).forEach(([key, items]) => {
    nextGraph[key] = items.map(updateRaw);
  });

  const saved = await saveLocalGraph(nextGraph, { status: "local-updated" });

  return {
    status: "local-updated",
    message: Object.keys(pendingChanges).length
      ? "Saved locally. Sync to Elitical is pending."
      : "Saved locally. No pending Elitical update remains.",
    docket: nextItem,
    item: nextItem,
    normalized: saved.graph,
    cache: {
      changed: saved.cacheWrite.changed,
      metadata: saved.cacheWrite.metadata,
    },
    metadata: saved.cacheWrite.metadata,
    syncQueue: saved.queueSummary,
    worklog: savedWorklog,
  };
}

function remoteIdForLocalId(graph, localToRemote, id) {
  const value = firstString(id);

  if (!value) return "";
  if (localToRemote[value]) return localToRemote[value];

  const item = (graph.appState?.workItems || []).find((entry) => entry.id === value);

  return firstString(item?.sync?.remoteId, item?.elitical?.remoteId, item?.id);
}

function remoteDocketIdForWorklog(graph, localToRemote, operation) {
  const payloadDocketId = firstString(operation.payload?.docketId, operation.docketId);
  const dependencyId = firstString(operation.dependsOn);
  const resolved = firstString(
    dependencyId ? localToRemote[dependencyId] : "",
    payloadDocketId ? localToRemote[payloadDocketId] : "",
    remoteIdForLocalId(graph, localToRemote, payloadDocketId)
  );

  if (
    !resolved ||
    syncQueueService.isLocalId(resolved) ||
    isSyntheticMutationId(resolved)
  ) {
    return "";
  }

  return resolved;
}

function worklogPayloadForRemote(operation, docketId) {
  const basePayload = operation.operation === "update"
    ? {
        ...(operation.remoteBaseline || {}),
        ...(operation.payload || {}),
        ...(operation.changes || {}),
      }
    : {
        ...(operation.payload || {}),
        ...(operation.changes || {}),
      };
  const remoteWorklogId = firstString(operation.remoteId, basePayload.id);

  return {
    ...basePayload,
    id: remoteWorklogId,
    docketId,
  };
}

function worklogMatchesOperation(worklog = {}, operation = {}) {
  return worklogMatchesForReconciliation(worklog, {
    ...(operation.payload || {}),
    docketId: firstString(operation.payload?.docketId, operation.docketId),
  });
}

async function reconcileWorklogCreate(provider, operation, remoteDocketId) {
  const worklogs = await provider.getWorklogs(remoteDocketId);
  const expected = {
    ...(operation.payload || {}),
    docketId: remoteDocketId,
  };

  return selectUniqueWorklogReconciliationMatch(
    worklogs.map((worklog) => ({
      ...worklog,
      docketId: firstString(worklog?.docketId, remoteDocketId),
    })),
    expected
  );
}

function localDocketRecordForOperation(graph, operation = {}) {
  const localId = firstString(operation.localId, operation.payload?.id);
  const remoteId = firstString(operation.remoteId);
  const matchesId = (item = {}) =>
    [item.id, item.sourceId, item.sourceItemId, item.sourceDocketId, item.elitical?.remoteId, item.sync?.remoteId]
      .some((candidate) => {
        const value = firstString(candidate);
        return value && (value === localId || value === remoteId);
      });

  return (
    (graph.appState?.workItems || []).find(matchesId) ||
    itemCollections(graph)
      .flatMap(([, items]) => items)
      .find(matchesId) ||
    null
  );
}

function payloadForRemoteCreate(graph, operation, localToRemote) {
  const payload = normalizeDocketCreatePayload({
    ...(operation.payload || {}),
  });
  const localRecord = localDocketRecordForOperation(graph, operation);
  const description = normalizeEliticalDescription(firstString(
    localRecord?.description,
    localRecord?.descr,
    payload.description,
    payload.descr
  ));
  const parentId = firstString(payload.parentId);
  const epicId = firstString(payload.epicId);
  const storyId = firstString(payload.storyId);
  const sprintId = firstString(payload.sprintId);
  const descriptionError = validateEliticalDescription(description);

  if (descriptionError) {
    throw new Error(descriptionError);
  }
  payload.description = description;
  payload.descr = description;
  if (parentId) payload.parentId = remoteIdForLocalId(graph, localToRemote, parentId) || parentId;
  if (epicId) payload.epicId = remoteIdForLocalId(graph, localToRemote, epicId) || epicId;
  if (storyId) payload.storyId = remoteIdForLocalId(graph, localToRemote, storyId) || storyId;
  if (sprintId === ORPHAN_SPRINT_ID) payload.sprintId = "";
  delete payload.id;

  return payload;
}

function changesForRemoteUpdate(graph, operation, localToRemote) {
  const changes = {
    ...(operation.changes || {}),
    type: normalizeEliticalType(operation.docketType),
  };

  if (changes.epicId) {
    const epicId = firstString(changes.epicId);
    const remoteEpicId = remoteIdForLocalId(graph, localToRemote, epicId) || epicId;

    if (isSyntheticMutationId(remoteEpicId) || syncQueueService.isLocalId(remoteEpicId)) {
      throw new Error("Story Epic parent has not been synced to a real Elitical ID yet.");
    }

    changes.epicId = remoteEpicId;
  }

  if (changes.sprintId) {
    const sprintId = firstString(changes.sprintId);

    if (sprintId === ORPHAN_SPRINT_ID || isSyntheticMutationId(sprintId)) {
      throw new Error("Moving a docket to no sprint / Orphan Sprint is not yet confirmed for Elitical sync.");
    }
  }

  return changes;
}

function remoteIdFromCreated(createdDocket) {
  return firstString(createdDocket?.id, createdDocket?.eliticalId, createdDocket?.docketId);
}

function removeAcceptedPendingChanges(pendingChanges = {}, acceptedChanges = {}) {
  const next = {
    ...(pendingChanges || {}),
  };

  Object.keys(acceptedChanges || {}).forEach((field) => {
    delete next[field];
  });

  return next;
}

function syncedRemoteBaseline(record = {}, acceptedChanges = {}) {
  return {
    ...(record.sync?.remoteBaseline || {}),
    title:
      acceptedChanges.title !== undefined
        ? acceptedChanges.title
        : record.title || record.sync?.remoteBaseline?.title || "",
    description:
      acceptedChanges.description !== undefined
        ? acceptedChanges.description
        : firstString(record.description, record.descr, record.sync?.remoteBaseline?.description),
    dktStateId:
      acceptedChanges.dktStateId !== undefined
        ? acceptedChanges.dktStateId
        : firstString(record.sync?.remoteBaseline?.dktStateId, record.elitical?.stateId, record.dktStateId),
    dktStateName:
      acceptedChanges.dktStateName !== undefined
        ? docketStateApiName(normalizeDocketState(acceptedChanges.dktStateName))
        : docketStateApiName(
            normalizeDocketState(record.sync?.remoteBaseline?.dktStateName || record.docketState || record.dktStateName)
          ),
    assigneeId:
      acceptedChanges.assigneeId !== undefined
        ? acceptedChanges.assigneeId
        : firstString(record.sync?.remoteBaseline?.assigneeId, record.elitical?.assigneeId, record.assigneeId),
    sprintId:
      acceptedChanges.sprintId !== undefined
        ? acceptedChanges.sprintId
        : firstString(record.sync?.remoteBaseline?.sprintId, record.elitical?.sprintId, record.sprintId),
    sprintName:
      acceptedChanges.sprintName !== undefined
        ? acceptedChanges.sprintName
        : firstString(record.sync?.remoteBaseline?.sprintName, record.sprintName, record.sprint),
    category:
      acceptedChanges.category !== undefined
        ? acceptedChanges.category
        : firstString(record.sync?.remoteBaseline?.category, record.category),
    priority:
      acceptedChanges.priority !== undefined
        ? acceptedChanges.priority
        : firstString(record.sync?.remoteBaseline?.priority, record.priority),
    epicId:
      acceptedChanges.epicId !== undefined
        ? acceptedChanges.epicId
        : firstString(record.sync?.remoteBaseline?.epicId, record.epicId, record.parentId),
    storyPointEst:
      acceptedChanges.storyPointEst !== undefined
        ? acceptedChanges.storyPointEst
        : firstNumber(record.sync?.remoteBaseline?.storyPointEst, record.storyPointEst, record.storyPoints),
  };
}

function markGraphDocketSynced(graph, docketId, { remoteId, localId = "", changes = {} } = {}) {
  const canonicalId = firstString(docketId, remoteId);
  const acceptedChanges = {
    ...changes,
  };

  if (acceptedChanges.descr !== undefined && acceptedChanges.description === undefined) {
    acceptedChanges.description = acceptedChanges.descr;
    delete acceptedChanges.descr;
  }
  Object.keys(acceptedChanges).forEach((field) => {
    if (acceptedChanges[field] === undefined) delete acceptedChanges[field];
  });

  const rewrite = (record) => {
    if (!record || record.id !== canonicalId) return record;

    const pendingChanges = removeAcceptedPendingChanges(record.sync?.pendingChanges, acceptedChanges);
    const sync = {
      ...(record.sync || {}),
      status: Object.keys(pendingChanges).length ? record.sync?.status || "pending-update" : "synced",
      remoteId: firstString(remoteId, record.sync?.remoteId, record.elitical?.remoteId, record.id),
      localId: firstString(localId, record.sync?.localId),
      lastError: "",
      pendingChanges,
      remoteBaseline: syncedRemoteBaseline(record, acceptedChanges),
      lastSyncedAt: new Date().toISOString(),
    };
    const next = {
      ...record,
      ...acceptedChanges,
      ...(acceptedChanges.description !== undefined ? { descr: acceptedChanges.description } : {}),
      sync,
    };

    if (next.elitical) {
      next.elitical = {
        ...next.elitical,
        remoteId: sync.remoteId,
      };
    }

    return withSyncMetadata(next, sync);
  };
  const nextGraph = {
    ...graph,
    appState: {
      ...(graph.appState || {}),
      workItems: (graph.appState?.workItems || []).map(rewrite),
    },
  };

  itemCollections(graph).forEach(([key, items]) => {
    nextGraph[key] = items.map(rewrite);
  });

  return nextGraph;
}

function acceptedUpdateChanges(operation, updateResult) {
  const mutationResult = updateResult?.__eliticalUpdateResult || {};
  const acceptedFields = Array.isArray(mutationResult.acceptedFields)
    ? mutationResult.acceptedFields.map((field) => firstString(field?.field)).filter(Boolean)
    : Object.keys(operation.changes || {});
  const changes = {};

  acceptedFields.forEach((field) => {
    if (field === "type") return;

    if (field === "description") {
      changes.description = firstString(
        operation.changes?.description,
        operation.changes?.descr,
        updateResult?.description,
        updateResult?.descr
      );
    } else if (field === "dktStateId") {
      changes.dktStateId = firstString(operation.changes?.dktStateId, updateResult?.dktStateId);
      if (operation.changes?.dktStateName !== undefined || updateResult?.dktStateName !== undefined) {
        changes.dktStateName = docketStateApiName(
          normalizeDocketState(firstString(operation.changes?.dktStateName, updateResult?.dktStateName))
        );
      }
    } else if (field === "sprintId") {
      changes.sprintId = firstString(operation.changes?.sprintId, updateResult?.sprintId);
      if (operation.changes?.sprintName !== undefined || updateResult?.sprintName !== undefined) {
        changes.sprintName = firstString(operation.changes?.sprintName, updateResult?.sprintName);
      }
      if (operation.changes?.hasNoSprint !== undefined || updateResult?.hasNoSprint !== undefined) {
        changes.hasNoSprint = Boolean(operation.changes?.hasNoSprint ?? updateResult?.hasNoSprint);
      }
    } else if (Object.prototype.hasOwnProperty.call(operation.changes || {}, field)) {
      changes[field] = operation.changes[field];
    }
  });

  return changes;
}

async function reconcileCreatedRemoteId(payload, createdDocket, { provider, graph } = {}) {
  if (!isEmptyCreateAccepted(createdDocket)) {
    return {
      remoteId: remoteIdFromCreated(createdDocket),
      reconciliation: {
        started: false,
        found: Boolean(remoteIdFromCreated(createdDocket)),
        source: "create-response",
      },
    };
  }

  const reconciliation = await reconcileEmptyCreateResponse(payload, createdDocket, {
    provider,
    graph,
  });

  return {
    remoteId: firstString(reconciliation?.item?.id, reconciliation?.docket?.id),
    reconciliation: reconciliation?.reconciliation || null,
    item: reconciliation?.item || null,
    docket: reconciliation?.docket || null,
  };
}

function outboundProgressMeta(operation, index, total) {
  return {
    direction: "outbound",
    state: "running",
    entityType: operation.entityType || "docket",
    operationType: operation.operation || "",
    docketType: operation.docketType || "",
    current: index + 1,
    total,
    unit: "operations",
    operationId: operation.operationId,
  };
}

async function syncPendingToElitical() {
  const queue = await syncQueueService.load();
  const operations = syncQueueService.orderedPendingOperations(queue);

  if (!operations.length) {
    const cache = await localData.loadGraphCache();

    return {
      status: "synced",
      message: "Everything is synced.",
      normalized: cache?.normalized || (await cacheService.loadGraph()) || { appState: { workItems: [], sprints: [] } },
      cache: {
        changed: false,
        metadata: cache?.metadata || await cacheService.readMetadata(),
      },
      metadata: cache?.metadata || await cacheService.readMetadata(),
      syncQueue: await syncQueueService.summary(),
      syncSummary: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failures: [],
      },
    };
  }

  let graph = await cacheService.loadGraph();

  if (!graph?.appState?.workItems) {
    const error = new Error("No local graph cache is available.");
    error.statusCode = 404;
    throw error;
  }

  const localToRemote = {
    ...(queue.localToRemote || {}),
  };
  const failures = [];
  const successes = [];
  const reconciliations = [];
  const blocked = [];
  const sdkLease = await acquireSdkProvider();

  try {
    const provider = sdkLease.provider;

    events.progress({
      direction: "outbound",
      state: "running",
      phase: "starting",
      message: "Syncing pending local changes to Elitical...",
      current: 0,
      total: operations.length,
      unit: "operations",
    });

    for (const [operationIndex, operation] of operations.entries()) {
      try {
      if (operation.entityType === "docket" && operation.operation === "create") {
        const remotePayload = payloadForRemoteCreate(graph, operation, localToRemote);
        const parentId = firstString(remotePayload.parentId);
        const originalParentId = firstString(operation.payload?.parentId);
        const operationClassification = syncQueueService.classifyOperation(operation);
        const createWasAlreadyAccepted = operationClassification.reconciliationActionable;

        if (originalParentId && syncQueueService.isLocalId(originalParentId) && !localToRemote[originalParentId]) {
          throw new Error("Parent docket has not been synced yet.");
        }

        if (parentId === ORPHAN_SPRINT_ID || isSyntheticMutationId(parentId)) {
          throw new Error("Create payload contains a synthetic parent ID.");
        }

        events.progress({
          ...outboundProgressMeta(operation, operationIndex, operations.length),
          phase: createWasAlreadyAccepted ? "reconciliation" : "mutation",
          message: createWasAlreadyAccepted
            ? `Recovering accepted ${operation.docketType} create in Elitical...`
            : `Creating ${operation.docketType} in Elitical...`,
        });

        let createdDocket = createWasAlreadyAccepted
          ? {
              __eliticalCreateAccepted: true,
              __emptyCreateResponse: true,
              __recoveryOnly: true,
            }
          : null;
        let createAmbiguousError = null;

        if (!createWasAlreadyAccepted) {
          try {
            createdDocket = await createEliticalDocket(remotePayload, provider);
          } catch (error) {
            if (!isAmbiguousMutationError(error)) throw error;

            createAmbiguousError = error;
            createdDocket = {
              __eliticalCreateAccepted: true,
              __emptyCreateResponse: true,
              __ambiguousMutation: true,
              __createError: error?.message || String(error || "Ambiguous create outcome."),
            };
          }
        }
        const createReconciliation = await reconcileCreatedRemoteId(remotePayload, createdDocket, {
          provider,
          graph,
        });
        const remoteId = createReconciliation.remoteId;

        if (!remoteId) {
          const error = new Error("Created docket was accepted but the remote Elitical ID could not be reconciled.");

          await syncQueueService.markOperationUnconfirmed(operation.operationId, error);
          failures.push({
            operationId: operation.operationId,
            localId: operation.localId,
            docketType: operation.docketType,
            operation: operation.operation,
            message: error.message,
            acceptedMutation: true,
            ambiguousMutation: Boolean(createAmbiguousError),
            retryMutation: false,
          });
          reconciliations.push({
            operationId: operation.operationId,
            operation: operation.operation,
            localId: operation.localId,
            remoteId: "",
            reconciliation: createReconciliation.reconciliation,
            acceptedMutation: true,
            ambiguousMutation: Boolean(createAmbiguousError),
            retryMutation: false,
            recoveryOnly: createWasAlreadyAccepted,
          });
          continue;
        }

        graph = await syncQueueService.replaceLocalId(graph, operation.localId, remoteId);
        graph = markGraphDocketSynced(graph, remoteId, {
          remoteId,
          localId: operation.localId,
          changes: {
            title: operation.payload?.title,
            description: firstString(operation.payload?.description, operation.payload?.descr),
          },
        });
        localToRemote[operation.localId] = remoteId;
        await syncQueueService.markOperationSynced(operation.operationId, {
          localId: operation.localId,
          remoteId,
        });
        successes.push(operation);
        reconciliations.push({
          operationId: operation.operationId,
          operation: operation.operation,
          localId: operation.localId,
          remoteId,
          reconciliation: createReconciliation.reconciliation,
          recoveryOnly: createWasAlreadyAccepted,
        });
        continue;
      }

      if (operation.operation === "update") {
        if (operation.entityType === "worklog") {
          const remoteWorklogId = firstString(operation.remoteId, operation.payload?.id);
          const remoteDocketId = remoteDocketIdForWorklog(graph, localToRemote, operation);

          if (!remoteWorklogId || syncQueueService.isLocalWorklogId(remoteWorklogId)) {
            throw new Error("Worklog update does not have a real remote Elitical worklog ID.");
          }

          if (!remoteDocketId) {
            throw new Error("Worklog update does not have a real remote Elitical docket ID.");
          }

          events.progress({
            ...outboundProgressMeta(operation, operationIndex, operations.length),
            phase: "mutation",
            message: "Updating Worklog in Elitical...",
          });

          const outboundWorklog = {
            ...worklogPayloadForRemote(operation, remoteDocketId),
            id: remoteWorklogId,
          };
          const updatedWorklog = await provider.updateWorklog(outboundWorklog);
          const confirmation = confirmedWorklogUpdateResult(
            operation,
            outboundWorklog,
            updatedWorklog
          );
          const confirmedWorklog = confirmedUpdatedWorklog(
            operation,
            outboundWorklog,
            updatedWorklog,
            remoteDocketId,
            remoteWorklogId
          );
          const remainingChanges = {
            ...(operation.changes || {}),
          };

          Object.keys(confirmation.acceptedChanges || {}).forEach((field) => {
            delete remainingChanges[field];
          });
          const confirmationError = confirmation.fullyConfirmed
            ? null
            : new Error(`Elitical Worklog update was not confirmed for: ${confirmation.rejectedFields.join(", ")}.`);

          await syncQueueService.markUpdateFieldsSynced(operation.operationId, {
            localId: operation.localId,
            remoteId: remoteWorklogId,
            acceptedChanges: confirmation.acceptedChanges,
            remoteBaseline: confirmation.remoteBaseline,
            error: confirmationError,
          });
          await mergeSyncedWorklogIntoCache(
            confirmedWorklog,
            operation,
            remoteDocketId
          );
          graph = markGraphWorklogSynced(graph, operation.localId, remoteWorklogId, confirmedWorklog, {
            pendingChanges: remainingChanges,
            remoteBaseline: confirmation.remoteBaseline,
            error: confirmationError,
          });
          if (confirmation.fullyConfirmed) {
            successes.push(operation);
          } else {
            failures.push({
              operationId: operation.operationId,
              localId: operation.localId,
              entityType: "worklog",
              operation: operation.operation,
              message: confirmationError.message,
              partialSuccess: Object.keys(confirmation.acceptedChanges || {}),
              pendingFields: Object.keys(remainingChanges),
              retryMutation: true,
            });
          }
          reconciliations.push({
            operationId: operation.operationId,
            operation: operation.operation,
            entityType: "worklog",
            localId: operation.localId,
            remoteId: firstString(updatedWorklog?.id, remoteWorklogId),
            acceptedFields: Object.keys(confirmation.acceptedChanges || {}),
            pendingFields: Object.keys(remainingChanges),
          });
          continue;
        }

        const remoteId = firstString(
          operation.remoteId,
          localToRemote[operation.localId],
          remoteIdForLocalId(graph, localToRemote, operation.localId)
        );

        if (isSyntheticMutationId(remoteId) || syncQueueService.isLocalId(remoteId)) {
          throw new Error("Update operation does not have a real remote Elitical ID.");
        }

        events.progress({
          ...outboundProgressMeta(operation, operationIndex, operations.length),
          phase: "mutation",
          message: `Updating ${operation.docketType} in Elitical...`,
        });

        const remoteChanges = changesForRemoteUpdate(graph, operation, localToRemote);
        const updateResult = await provider.updateDocket(remoteId, remoteChanges);
        const acceptedChanges = acceptedUpdateChanges(
          {
            ...operation,
            changes: remoteChanges,
          },
          updateResult
        );
        const mutationResult = updateResult?.__eliticalUpdateResult || {};
        const failedFields = Array.isArray(mutationResult.failedFields)
          ? mutationResult.failedFields
          : [];

        graph = markGraphDocketSynced(graph, operation.localId, {
          remoteId,
          localId: operation.localId,
          changes: acceptedChanges,
        });
        await syncQueueService.markUpdateFieldsSynced(operation.operationId, {
          localId: operation.localId,
          remoteId,
          acceptedChanges,
          error: failedFields.length
            ? new Error(`Some update fields failed: ${failedFields.map((field) => firstString(field?.field)).filter(Boolean).join(", ")}`)
            : null,
        });
        if (Object.keys(acceptedChanges).length) successes.push(operation);
        if (failedFields.length) {
          failures.push({
            operationId: operation.operationId,
            localId: operation.localId,
            docketType: operation.docketType,
            operation: operation.operation,
            message: `Some update fields failed: ${failedFields.map((field) => firstString(field?.field)).filter(Boolean).join(", ")}`,
            partialSuccess: Object.keys(acceptedChanges),
          });
        }
        reconciliations.push({
          operationId: operation.operationId,
          operation: operation.operation,
          localId: operation.localId,
          remoteId,
          reconciliation: updateResult?.__eliticalUpdateResult?.reconciliation || null,
          acceptedFields: Object.keys(acceptedChanges),
        });
      }

      if (operation.entityType === "worklog" && operation.operation === "create") {
        const remoteDocketId = remoteDocketIdForWorklog(graph, localToRemote, operation);

        if (!remoteDocketId) {
          const error = new Error("Worklog is waiting for its docket to sync to a real Elitical ID.");

          await syncQueueService.markOperationDependencyBlocked(operation.operationId, error);
          blocked.push({
            operationId: operation.operationId,
            localId: operation.localId,
            entityType: "worklog",
            operation: operation.operation,
            dependsOn: firstString(operation.dependsOn),
            docketId: firstString(operation.docketId, operation.payload?.docketId),
            message: error.message,
          });
          continue;
        }

        const operationClassification = syncQueueService.classifyOperation(operation);
        const createWasAlreadyAccepted = operationClassification.reconciliationActionable;

        events.progress({
          ...outboundProgressMeta(operation, operationIndex, operations.length),
          phase: createWasAlreadyAccepted ? "reconciliation" : "mutation",
          message: createWasAlreadyAccepted
            ? "Recovering accepted Worklog create in Elitical..."
            : "Creating Worklog in Elitical...",
        });

        let createdWorklog = null;
        let worklogCreateAmbiguousError = null;

        if (createWasAlreadyAccepted) {
          createdWorklog = await reconcileWorklogCreate(provider, operation, remoteDocketId);
        } else {
          try {
            createdWorklog = await provider.createWorklog(worklogPayloadForRemote(operation, remoteDocketId));
          } catch (error) {
            if (!isAmbiguousMutationError(error)) throw error;

            worklogCreateAmbiguousError = error;
          }
        }
        let remoteWorklogId = firstString(createdWorklog?.id, createdWorklog?.worklogId);

        if (!remoteWorklogId && (!createWasAlreadyAccepted || worklogCreateAmbiguousError)) {
          events.progress({
            ...outboundProgressMeta(operation, operationIndex, operations.length),
            phase: "reconciliation",
            message: "Reconciling accepted Worklog create in Elitical...",
          });
          createdWorklog = await reconcileWorklogCreate(provider, operation, remoteDocketId);
          remoteWorklogId = firstString(createdWorklog?.id, createdWorklog?.worklogId);
        }

        if (!remoteWorklogId) {
          const error = new Error("Created worklog was accepted but the remote Elitical worklog ID could not be reconciled.");

          await syncQueueService.markOperationUnconfirmed(operation.operationId, error);
          blocked.push({
            operationId: operation.operationId,
            localId: operation.localId,
            entityType: "worklog",
            operation: operation.operation,
            actionability: "reconciliation-actionable",
            message: error.message,
            acceptedMutation: true,
            ambiguousMutation: Boolean(worklogCreateAmbiguousError),
            retryMutation: false,
          });
          continue;
        }

        await syncQueueService.markOperationSynced(operation.operationId, {
          localId: operation.localId,
          remoteId: remoteWorklogId,
        });
        await mergeSyncedWorklogIntoCache(
          {
            ...(createdWorklog || {}),
            id: remoteWorklogId,
            docketId: remoteDocketId,
          },
          operation,
          remoteDocketId
        );
        graph = markGraphWorklogSynced(graph, operation.localId, remoteWorklogId, {
          ...(operation.payload || {}),
          id: remoteWorklogId,
          docketId: remoteDocketId,
        });
        successes.push(operation);
        reconciliations.push({
          operationId: operation.operationId,
          operation: operation.operation,
          entityType: "worklog",
          localId: operation.localId,
          remoteId: remoteWorklogId,
        });
      }
      } catch (error) {
        await syncQueueService.markOperationFailed(operation.operationId, error);
        failures.push({
          operationId: operation.operationId,
          localId: operation.localId,
          docketType: operation.docketType,
          operation: operation.operation,
          message: error?.message || "Sync failed.",
        });
      }
    }

    const saved = await saveLocalGraph(graph, { status: "queue-processed" });
    events.progress({
      direction: "outbound",
      state: "running",
      phase: "saving-cache",
      message: "Saving local cache...",
      current: operations.length,
      total: operations.length,
      unit: "operations",
    });
    const finalQueue = await syncQueueService.load();
    const normalized = syncQueueService.applyPendingToGraph(saved.graph, finalQueue);
    const queueSummary = await syncQueueService.summary();
    const unconfirmed = failures.filter((failure) => failure.acceptedMutation && failure.retryMutation === false);
    const hardFailures = failures.filter((failure) => !failure.acceptedMutation);
    const result = {
      status: hardFailures.length
        ? "sync-completed-with-failures"
        : unconfirmed.length
        ? "sync-completed-with-unconfirmed"
        : blocked.length
        ? "sync-completed-with-blocked"
        : "synced",
      message: hardFailures.length
        ? `Sync completed with ${hardFailures.length} failure${hardFailures.length === 1 ? "" : "s"}.`
        : unconfirmed.length
        ? `Sync completed with ${unconfirmed.length} unconfirmed item${unconfirmed.length === 1 ? "" : "s"}.`
        : blocked.length
        ? `Sync completed with ${blocked.length} blocked item${blocked.length === 1 ? "" : "s"}.`
        : "Synced successfully.",
      normalized,
      counts: {
        attempted: operations.length,
        succeeded: successes.length,
        failed: hardFailures.length,
        unconfirmed: unconfirmed.length,
        blocked: blocked.length,
        targetedReconciliations: reconciliations.length,
        fullImportRuns: 0,
        worklogRequests: 0,
        detailRequests: 0,
      },
      durationMs: 0,
      syncedAt: new Date().toISOString(),
      cache: {
        changed: saved.cacheWrite.changed,
        metadata: saved.cacheWrite.metadata,
      },
      metadata: saved.cacheWrite.metadata,
      syncQueue: queueSummary,
      syncSummary: {
        attempted: operations.length,
        succeeded: successes.length,
        failed: hardFailures.length,
        unconfirmed: unconfirmed.length,
        blocked: blocked.length,
        failures,
        hardFailures,
        blocked,
        reconciliations,
        fullSyncRun: false,
        detailRequests: 0,
        worklogRequests: 0,
      },
    };

    events.cache(hardFailures.length ? "sync-failed" : "cache-updated", result);
    events.progress({
      direction: "outbound",
      state: hardFailures.length ? "failed" : "synced",
      phase: hardFailures.length ? "failed" : "complete",
      message: result.message,
      current: operations.length,
      total: operations.length,
      unit: "operations",
    });

    return result;
  } finally {
    await sdkLease.release();
  }
}

function isEmptyCreateAccepted(issue) {
  return Boolean(issue?.__eliticalCreateAccepted && issue?.__emptyCreateResponse);
}

function docketTypeLabel(value) {
  const type = normalizeDocketType(value);

  return type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : "Docket";
}

async function reconcileEmptyCreateResponse(payload, acceptedCreate, { provider = null, graph = null } = {}) {
  console.info("[local-backend] create reconciliation started", {
    type: normalizeDocketType(payload?.type),
    title: firstString(payload?.title),
    parentId: firstString(payload?.parentId),
    projectId: firstString(payload?.projectId),
    sprintId: canonicalSprintIdForPayload(payload),
    assigneeId: firstString(payload?.assigneeId),
    createHttpStatus: acceptedCreate?.__createStatus || 0,
    createEndpoint: acceptedCreate?.__createEndpoint || "",
    emptyResponse: true,
    postConsideredSuccessful: true,
    retryPost: false,
    reconciliationMode: "targeted-issues-board",
  });

  const currentGraph = graph || await cacheService.loadGraph() || { appState: { workItems: [], sprints: [] } };
  const sdkLease = provider ? null : await acquireSdkProvider();
  const resolvedProvider = provider || sdkLease.provider;
  let remoteIssues = [];

  try {
    remoteIssues = await resolvedProvider.getIssues(firstString(payload?.projectId));
  } catch (error) {
    console.warn("[local-backend] targeted create reconciliation failed", {
      message: error?.message || "Unable to load targeted IssuesBoard list after create.",
      statusCode: error?.statusCode || error?.status || 0,
      code: error?.code || "",
      postWasRetried: false,
      fullSyncRun: false,
    });

    return {
      status: "create-submitted-unconfirmed",
      message:
        `${docketTypeLabel(payload?.type)} was submitted successfully, but the new docket could not yet be confirmed locally. Refresh or sync to update the view.`,
      normalized: currentGraph,
      cache: {
        changed: false,
        metadata: await cacheService.readMetadata(),
      },
      metadata: await cacheService.readMetadata(),
      reconciliation: {
        started: true,
        found: false,
        candidateCount: 0,
        mode: "targeted-issues-board",
        fullSyncRun: false,
        refreshError: {
          message: error?.message || "Unable to load targeted IssuesBoard list after create.",
          statusCode: error?.statusCode || error?.status || 0,
          code: error?.code || "",
        },
      },
    };
  } finally {
    await sdkLease?.release();
  }

  const candidateGraph = {
    ...currentGraph,
    appState: {
      ...(currentGraph.appState || {}),
      workItems: remoteIssues.map(candidateItemFromIssue),
    },
  };
  const candidates = createdDocketCandidates(candidateGraph, payload);
  const best = chooseCreatedDocketCandidate(candidates);

  console.info("[local-backend] create reconciliation candidates", {
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 10).map((candidate) => candidate.diagnostics),
    matchedDocketId: best ? best.item.id : "",
    matchedDocketNum: best ? firstString(best.item?.elitical?.num) : "",
    matchedSprintId: best ? firstString(best.item?.elitical?.sprintId, best.item?.sprintId) : "",
    matchedParentId: best ? firstString(best.item?.parentId) : "",
    matchedEpicId: best ? firstString(best.item?.elitical?.epicId) : "",
    reconciliationMode: "targeted-issues-board",
    fullSyncRun: false,
  });

  if (!best) {
    return {
      status: "create-submitted-unconfirmed",
      message:
        `${docketTypeLabel(payload?.type)} was submitted successfully, but the new docket could not yet be confirmed locally. Refresh or sync to update the view.`,
      normalized: currentGraph,
      cache: {
        changed: false,
        metadata: await cacheService.readMetadata(),
      },
      metadata: await cacheService.readMetadata(),
      reconciliation: {
        started: true,
        found: false,
        mode: "targeted-issues-board",
        fullSyncRun: false,
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 10).map((candidate) => candidate.diagnostics),
      },
    };
  }

  const records = buildCreatedDocketRecords({
    graph: currentGraph,
    issue: best.item,
    payload,
  });

  return {
    status: "created-reconciled",
    message: `Created ${normalizeDocketType(payload?.type) || "docket"}`,
    docket: records.rawRecord,
    item: best.item,
    normalized: currentGraph,
    cache: {
      changed: false,
      metadata: await cacheService.readMetadata(),
    },
    metadata: await cacheService.readMetadata(),
    reconciliation: {
      started: true,
      found: true,
      mode: "targeted-issues-board",
      fullSyncRun: false,
      candidateCount: candidates.length,
      matchedDocketId: best.item.id,
      matchedDocketNum: firstString(best.item?.elitical?.num),
      matchedSprintId: firstString(best.item?.elitical?.sprintId, best.item?.sprintId),
      matchedParentId: firstString(best.item?.parentId),
      matchedEpicId: firstString(best.item?.elitical?.epicId),
      candidates: candidates.slice(0, 10).map((candidate) => candidate.diagnostics),
    },
  };
}

function validateCreateDocketPayload(graph, payload) {
  const type = normalizeDocketType(payload?.type);
  const title = firstString(payload?.title);
  const parentId = firstString(payload?.parentId);
  const parent = parentFor(graph, parentId);

  if (!type) return "Docket type must be Epic, Story, Task, or Job.";
  if (!title) return "Title is required.";
  if (type === "epic") return "";
  if (!parent) return "A valid parent is required.";
  if ((type === "story" || type === "task") && parent.type !== "epic") {
    return `${type === "story" ? "Story" : "Task"} must have an Epic parent.`;
  }
  if (type === "job" && parent.type !== "story") {
    return "Job must have a Story parent.";
  }

  return "";
}

async function createEliticalDocket(payload, provider = null) {
  const sdkLease = provider ? null : await acquireSdkProvider();
  const resolvedProvider = provider || sdkLease.provider;
  const methodByType = {
    epic: "createEpic",
    story: "createStory",
    task: "createTask",
    job: "createJob",
  };
  const type = normalizeDocketType(payload.type);
  const method = methodByType[type];

  if (!method) {
    const error = new Error("Unsupported docket type.");
    error.statusCode = 400;
    throw error;
  }

  try {
    return await resolvedProvider[method]({
      ...payload,
      type: undefined,
    });
  } finally {
    await sdkLease?.release();
  }
}

async function appendCreatedDocketToCache(payload, createdDocket) {
  const graph = await cacheService.loadGraph();

  if (!graph?.appState?.workItems) {
    const error = new Error("No local graph cache is available.");
    error.statusCode = 404;
    throw error;
  }

  const records = buildCreatedDocketRecords({
    graph,
    issue: createdDocket,
    payload,
  });
  const collectionName = DOCKET_COLLECTION_BY_TYPE[records.type];
  const nextGraph = {
    ...graph,
    generatedAt: new Date().toISOString(),
    [collectionName]: [
      ...(graph[collectionName] || []).filter((item) => item.id !== records.id),
      records.rawRecord,
    ],
    appState: {
      ...graph.appState,
      workItems: [
        ...(graph.appState.workItems || []).filter((item) => item.id !== records.id),
        records.appItem,
      ],
    },
  };
  const cacheWrite = await cacheService.saveGraph(nextGraph, {
    syncedAt: new Date().toISOString(),
  });

  events.cache("cache-updated", {
    status: "updated",
    normalized: nextGraph,
    cache: {
      changed: cacheWrite.changed,
      metadata: cacheWrite.metadata,
    },
    metadata: cacheWrite.metadata,
  });

  return {
    graph: nextGraph,
    cacheWrite,
    item: records.appItem,
    docket: records.rawRecord,
  };
}

function fieldLabel(field) {
  if (field === "description") return "Description";
  if (field === "title") return "Title";

  return field;
}

function updateMessage({ acceptedFieldNames, failedFieldNames, reconciliationSucceeded }) {
  const acceptedLabels = acceptedFieldNames.map(fieldLabel);
  const failedLabels = failedFieldNames.map(fieldLabel);

  if (!reconciliationSucceeded) {
    if (acceptedLabels.length === 1) {
      return `${acceptedLabels[0]} was updated successfully in Elitical, but the latest docket data could not yet be refreshed locally. Refresh or sync to update the view.`;
    }

    return "Changes were updated successfully in Elitical, but the latest docket data could not yet be refreshed locally. Refresh or sync to update the view.";
  }

  if (acceptedLabels.length && failedLabels.length) {
    return `${acceptedLabels.join(" and ")} updated successfully in Elitical, but ${failedLabels.join(" and ")} failed. Latest Elitical data was refreshed locally.`;
  }

  return acceptedLabels.length === 1
    ? `${acceptedLabels[0]} saved to Elitical`
    : "Changes saved to Elitical";
}

async function reconcileUpdatedDocket({ docketId, updates, updateResult, unsupportedFields }) {
  const mutationResult = updateResult?.__eliticalUpdateResult || {};
  const acceptedFields = Array.isArray(mutationResult.acceptedFields)
    ? mutationResult.acceptedFields
    : [];
  const failedFields = Array.isArray(mutationResult.failedFields)
    ? mutationResult.failedFields
    : [];
  const acceptedFieldNames = acceptedFields
    .map((result) => firstString(result?.field))
    .filter(Boolean);
  const failedFieldNames = failedFields
    .map((result) => firstString(result?.field))
    .filter(Boolean);

  console.info("[local-backend] update reconciliation started", {
    canonicalDocketId: docketId,
    requestedUpdateFields: Object.keys(updates || {}),
    acceptedFieldNames,
    failedFieldNames,
    unsupportedFields,
    retryMutation: false,
  });

  let syncResult;

  try {
    syncResult = await syncService.run({ providerId: "elitical" });
  } catch (error) {
    const currentCache = await localData.loadGraphCache();

    console.warn("[local-backend] update reconciliation refresh failed", {
      canonicalDocketId: docketId,
      message: error?.message || "Unable to refresh after update.",
      statusCode: error?.statusCode || error?.status || 0,
      code: error?.code || "",
      retryMutation: false,
      usingCurrentCache: Boolean(currentCache?.normalized),
    });

    syncResult = {
      status: "refresh-failed",
      normalized: currentCache?.normalized,
      cache: {
        changed: false,
        metadata: currentCache?.metadata || null,
      },
      refreshError: {
        message: error?.message || "Unable to refresh after update.",
        statusCode: error?.statusCode || error?.status || 0,
        code: error?.code || "",
      },
    };
  }

  const finalItem = (syncResult.normalized?.appState?.workItems || []).find(
    (item) => item?.id === docketId
  ) || null;
  const reconciliationSucceeded = Boolean(syncResult.normalized && !syncResult.refreshError);

  console.info("[local-backend] update reconciliation complete", {
    canonicalDocketId: docketId,
    finalCanonicalDocketId: firstString(finalItem?.id, docketId),
    finalTitle: firstString(finalItem?.title, updateResult?.title),
    finalDescription: firstString(
      finalItem?.description,
      updateResult?.description,
      updateResult?.descr
    ),
    reconciliationSucceeded,
    acceptedFieldNames,
    failedFieldNames,
  });

  return {
    status:
      acceptedFieldNames.length && failedFieldNames.length
        ? "partial-update-reconciled"
        : reconciliationSucceeded
        ? "updated-reconciled"
        : "updated-refresh-failed",
    message: updateMessage({
      acceptedFieldNames,
      failedFieldNames,
      reconciliationSucceeded,
    }),
    docket: updateResult,
    item: finalItem,
    normalized:
      syncResult.normalized ||
      (await cacheService.loadGraph()) ||
      { appState: { workItems: [], sprints: [] } },
    cache: syncResult.cache,
    metadata: syncResult.cache?.metadata,
    update: {
      canonicalDocketId: docketId,
      requestedFields: Object.keys(updates || {}),
      acceptedFields,
      failedFields,
      unsupportedFields,
      retryMutation: false,
    },
    reconciliation: {
      started: true,
      succeeded: reconciliationSucceeded,
      refreshError: syncResult.refreshError || null,
      finalCanonicalDocketId: firstString(finalItem?.id, docketId),
      finalTitle: firstString(finalItem?.title, updateResult?.title),
      finalDescription: firstString(
        finalItem?.description,
        updateResult?.description,
        updateResult?.descr
      ),
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();

  if (!rawBody) return {};

  return JSON.parse(rawBody);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requestLabel = `${req.method} ${url.pathname}`;

  logRequest(`${requestLabel} started`);
  res.on("finish", () => {
    logRequest(`${requestLabel} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const syncStatus = syncService.status();

    sendJson(res, 200, {
      status: "ok",
      service: "elitical-worklog-local-backend",
      storage: {
        root: storageInitialization.paths.root,
        status: storageInitialization.status,
        rebuildRequired: storageInitialization.rebuildRequired,
        resetDetected: storageInitialization.resetDetected,
        migrated: storageInitialization.migrated,
      },
      syncInProgress: syncStatus.syncInProgress,
      lastProgress: syncStatus.lastProgress,
      providers: syncStatus.providers,
      cacheExists: await localData.exists(),
      syncQueue: await syncQueueService.summary(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, {
      status: "ok",
      ...logBuffer.snapshot({
        sinceId: url.searchParams.get("sinceId") || 0,
        limit: url.searchParams.get("limit") || 1000,
      }),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local/sync/recovery/resolve-duplicate") {
    try {
      const body = await readJsonBody(req);
      const validation = await validateDuplicateRecoveryRequest(body);
      const preview = recoveryPreviewPayload(validation);

      if (body.previewOnly) {
        sendJson(res, 200, {
          status: "preview",
          preview,
          syncQueue: await syncQueueService.summary(),
        });
        return;
      }

      const result = await syncQueueService.resolveDuplicateCreateWithDependent({
        parentOperationId: validation.parentOperationId,
        dependentOperationId: validation.dependentOperationId,
        replacementRemoteDocketId: validation.replacementRemoteDocketId,
        replacementDocketNumber: validation.replacementDocketNumber,
        replacementRemoteWorklogId: validation.replacementRemoteWorklogId,
      });
      const graph = await cacheService.loadGraph();

      sendJson(res, 200, {
        status: "superseded",
        preview,
        parentOperation: result.parentOperation,
        dependentOperation: result.dependentOperation,
        normalized: graph ? syncQueueService.applyPendingToGraph(graph, await syncQueueService.load()) : null,
        metadata: await cacheService.readMetadata(),
        syncQueue: result.syncQueue,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || "Unable to resolve duplicate sync operations.",
        code: error.code || "",
        details: error.details || null,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/elitical/sync-live/events") {
    events.stream("progress", req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sync/events") {
    events.stream("progress", req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/elitical/sync-live") {
    try {
      sendJson(res, 200, await syncService.run({ providerId: "elitical" }));
    } catch (error) {
      const payload = error.payload || {
        error: error.message || "Sync failed.",
      };

      console.error("[local-backend] /api/elitical/sync-live failed", payload);
      sendJson(res, error.statusCode || 500, payload);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sync") {
    try {
      const body = await readJsonBody(req);
      const providerId = body.provider || url.searchParams.get("provider") || "elitical";

      if (body.direction === "to-elitical" || body.action === "sync_pending") {
        sendJson(res, 200, await syncPendingToElitical());
      } else {
        sendJson(res, 200, await syncService.run({ providerId }));
      }
    } catch (error) {
      const payload = error.payload || {
        error: error.message || "Sync failed.",
      };

      console.error("[local-backend] /api/sync failed", payload);
      sendJson(res, error.statusCode || 500, payload);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/elitical/lookups") {
    try {
      const projectId = url.searchParams.get("projectId") || "";

      if (!projectId) {
        sendJson(res, 400, {
          error: "projectId is required.",
        });
        return;
      }

      sendJson(res, 200, await syncService.provider("elitical").lookups(projectId));
    } catch (error) {
      sendJson(res, error.statusCode || error.status || 500, {
        error: error.message || "Unable to load Elitical lookup values.",
        code: error.code || "",
        endpoint: error.endpoint || "",
        payload: error.payload || null,
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/elitical/dockets") {
    try {
      const payload = await readJsonBody(req);

      sendJson(res, 201, await createLocalDocket(payload));
    } catch (error) {
      sendJson(res, error.statusCode || error.status || 500, {
        error: error.message || "Unable to create Elitical docket.",
        code: error.code || "",
        endpoint: error.endpoint || "",
        payload: error.payload || null,
      });
    }
    return;
  }

  const docketUpdateMatch = url.pathname.match(/^\/api\/elitical\/dockets\/([^/]+)$/);

  if (req.method === "PUT" && docketUpdateMatch) {
    try {
      const docketId = decodeURIComponent(docketUpdateMatch[1]);
      const updates = await readJsonBody(req);
      const { supported, supportedFields, unsupportedFields } = updateFieldsOnly(updates);

      if (!supportedFields.length && !Object.keys(supported).length) {
        sendJson(res, 400, {
          error: "No supported local-first docket update fields were provided.",
          code: "UNSUPPORTED_UPDATE_FIELDS",
          supportedFields: Array.from(CONFIRMED_DOCKET_UPDATE_FIELDS).filter((field) => field !== "descr"),
          unsupportedFields,
        });
        return;
      }

      console.info("[local-backend] docket update requested", {
        canonicalDocketId: docketId,
        supportedFields,
        unsupportedFields,
        endpoint: "/api/elitical/dockets/:id",
        method: "PUT",
        mode: "local-first",
      });

      sendJson(res, 200, await updateLocalDocket(docketId, supported));
    } catch (error) {
      sendJson(res, error.statusCode || error.status || 500, {
        error: error.message || "Unable to update Elitical docket.",
        code: error.code || "",
        endpoint: error.endpoint || "",
        payload: error.payload || null,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache/events") {
    events.stream("cache", req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache") {
    const skipBackgroundSync = url.searchParams.get("skipBackgroundSync") === "1";
    const cache = await localData.loadGraphCache();

    if (!cache) {
      if (storageInitialization.resetDetected && !skipBackgroundSync) {
        try {
          const rebuilt = await syncService.run({ providerId: "elitical" });
          sendJson(res, 200, {
            ...rebuilt,
            bootstrap: {
              status: "rebuilt-from-elitical",
              storageRoot: storageInitialization.paths.root,
            },
          });
        } catch (error) {
          const payload = error.payload || {
            error: error.message || "Unable to rebuild local cache.",
          };

          sendJson(res, error.statusCode || 500, {
            ...payload,
            bootstrap: {
              status: "rebuild-failed",
              storageRoot: storageInitialization.paths.root,
            },
          });
        }
        return;
      }

      sendJson(res, 404, {
        error: "No local cache",
        message: "No local cache is available yet.",
        storage: {
          root: storageInitialization.paths.root,
          rebuildRequired: storageInitialization.rebuildRequired,
          resetDetected: storageInitialization.resetDetected,
        },
      });
      return;
    }

    sendJson(res, 200, cache);
    if (!skipBackgroundSync) syncService.startBackground({ providerId: "elitical" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache/metadata") {
    const metadata = await localData.loadMetadata();

    if (!metadata) {
      sendJson(res, 404, {
        error: "No local cache metadata",
      });
      return;
    }

    sendJson(res, 200, {
      status: "hit",
      metadata,
      syncQueue: await syncQueueService.summary(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cache/clear") {
    await localData.clear();
    events.cache("cache-cleared");
    sendJson(res, 200, {
      status: "cleared",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/worklogs") {
    sendJson(res, 200, await localData.loadWorklogs());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/worklogs/metadata") {
    sendJson(res, 200, await localData.loadWorklogMetadata());
    return;
  }

  const worklogMatch = url.pathname.match(/^\/api\/worklogs\/([^/]+)(?:\/([^/]+))?$/);

  if (worklogMatch) {
    const docketId = decodeURIComponent(worklogMatch[1]);
    const action = worklogMatch[2] || "";

    try {
      if (req.method === "GET" && !action) {
        sendJson(res, 200, await localData.getWorklogState(docketId));
        return;
      }

      if (req.method === "PUT" && action === "draft") {
        const draft = await localData.saveWorklogDraft(docketId, await readJsonBody(req));
        sendJson(res, 200, {
          status: "saved",
          draft,
        });
        return;
      }

      if (req.method === "DELETE" && action === "draft") {
        await localData.clearWorklogDraft(docketId);
        sendJson(res, 200, {
          status: "cleared",
        });
        return;
      }

      if (req.method === "POST" && action === "submit") {
        const payload = await readJsonBody(req);
        const result = await updateLocalDocket(docketId, {
          worklog: {
            comment: firstString(payload.comment, payload.description),
            worklogDate: firstString(payload.worklogDate, payload.date),
            timeMinutes: firstNumber(payload.timeMinutes, payload.durationMinutes),
            hour: payload.hour,
            min: payload.min,
          },
        });

        await localData.clearWorklogDraft(docketId).catch(() => {});
        sendJson(res, 202, result);
        return;
      }
    } catch (error) {
      sendJson(res, error?.status || 500, {
        error: error?.message || "Worklog request failed.",
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/worklogs/upload-pending") {
    sendJson(res, 200, await localData.uploadPendingWorklogs());
    return;
  }

  sendJson(res, 404, {
    error: "Not Found",
  });
});

server.listen(PORT, "127.0.0.1", () => {
  logRequest(`Storage root: ${storageInitialization.paths.root}`);
  logRequest(`Cache directory: ${process.env.ELITICAL_CACHE_DIR || storageInitialization.paths.dataDir}`);
  logRequest(`Sync directory: ${process.env.ELITICAL_SYNC_DIR || storageInitialization.paths.syncDir}`);
  logRequest(`Auth directory: ${process.env.ELITICAL_DATA_DIR || storageInitialization.paths.authDir}`);
  logRequest(`Environment path: ${process.env.ELITICAL_ENV_PATH || ".env"}`);
  console.log(`Local backend ready: http://127.0.0.1:${PORT}`);
});

server.on("error", (error) => {
  console.error(`[local-backend] Server error: ${error.message}`);
});

async function shutdown(signal) {
  console.log(`[local-backend] ${signal} received. Shutting down...`);
  syncService.stopSchedule();

  try {
    await Promise.all([
      closeSdkProvider({ force: true }),
      syncService.closeProviders(),
    ]);
  } finally {
    server.close(() => {
      process.exit(0);
    });
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(`[local-backend] Shutdown failed: ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(`[local-backend] Shutdown failed: ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
});

process.on("uncaughtException", (error) => {
  console.error(`[local-backend] Uncaught exception: ${error?.stack || error?.message || error}`);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[local-backend] Unhandled rejection: ${reason?.stack || reason?.message || reason}`);
});
