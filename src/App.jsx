import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import GraphView from "./views/GraphView";
import PlanningView from "./views/PlanningView";
import {
  CATEGORIES,
  DOCKET_STATES,
  PRIORITIES,
  ROOT_ID,
  buildWorklogSnapshot,
  calculateStoryPoints,
  deleteWorkItem,
  generateSprintId,
  normalizeWorklogSnapshot,
  stableSnapshotString,
  updateWorkItem,
} from "./utils/worklogModel";
import { loadLegacyStoryViewState } from "./utils/storage";
import {
  saveCache,
} from "./utils/cache";
import {
  loadWorklogSnapshot,
  saveWorklogSnapshot,
} from "./services/worklogApi";
import { syncLiveEliticalData } from "./services/elitical/syncLiveClient";
import { syncPendingToElitical } from "./services/syncClient";
import {
  loadLocalGraphCache,
  loadLocalWorklogsCache,
  subscribeToLocalCacheEvents,
} from "./services/localCacheClient";
import {
  loadPublishedData,
  loadPublishedWorklogs,
} from "./services/publishedDataClient";
import {
  clearJobWorklogDraft,
  loadJobWorklogState,
  saveJobWorklogDraft,
  submitJobWorklog,
} from "./services/worklogEngineClient";
import {
  createEliticalDocket,
  updateEliticalDocket,
} from "./services/eliticalEditClient";
import {
  ORPHAN_SPRINT_TITLE,
  isOrphanSprintId,
  isReferenceNode,
  projectionScopeIdForItem,
  scopesWithOrphanSprint,
} from "./utils/hierarchyProjection";
import { childCreateTypesForCanonicalType } from "./utils/nodeCapabilities";
import "./App.css";

const MAIN_ROOT_ID = "mainRoot";
const APP_VIEWS = [
  { id: "main", label: "Tree View" },
  { id: "sprint", label: "Sprint View" },
  { id: "epic", label: "Epic View" },
  { id: "story", label: "Story View" },
  { id: "job", label: "Job View" },
  { id: "task", label: "Task View" },
  { id: "day", label: "Day View" },
  { id: "backlog", label: "Backlog View" },
  { id: "worklog", label: "Worklog View" },
  { id: "dashboard", label: "Dashboard" },
];
const PLANNING_VIEW_IDS = new Set(["backlog", "worklog"]);
const CONTEXT_VIEW_IDS = new Set(["sprint", "epic", "story", "job", "task", "day"]);
const WORKLOG_DEPENDENT_VIEW_IDS = new Set(["day", "worklog", "dashboard"]);
const DOCKET_CONTEXT_TYPES = new Set(["epic", "story", "job", "task"]);
const BROWSER_REFRESH_STATE_KEY = "elitical-worklog.browser-refresh-state.v1";

function isBrowserReloadNavigation() {
  if (typeof window === "undefined" || typeof window.performance === "undefined") {
    return false;
  }

  const [navigation] =
    typeof window.performance.getEntriesByType === "function"
      ? window.performance.getEntriesByType("navigation")
      : [];

  if (navigation?.type) return navigation.type === "reload";

  return window.performance.navigation?.type === 1;
}

function readBrowserRefreshState() {
  if (typeof window === "undefined") return null;

  try {
    return JSON.parse(
      window.sessionStorage.getItem(BROWSER_REFRESH_STATE_KEY) || "null"
    );
  } catch {
    return null;
  }
}

function saveBrowserRefreshState(state) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      BROWSER_REFRESH_STATE_KEY,
      JSON.stringify(state)
    );
  } catch {
    // Ignore storage failures; refresh should still load from the backend cache.
  }
}

function normalizeSyncQueueSummary(summary = {}) {
  const actionableCount = Number(
    summary.actionableCount ?? summary.pendingCount ?? 0
  );
  const mutationActionableCount = Number(
    summary.mutationActionableCount ?? summary.retryablePendingCount ?? 0
  );
  const reconciliationActionableCount = Number(
    summary.reconciliationActionableCount ?? summary.unconfirmedCount ?? 0
  );

  return {
    ...summary,
    actionableCount,
    pendingCount: actionableCount,
    mutationActionableCount,
    reconciliationActionableCount,
    retryablePendingCount: Number(
      summary.retryablePendingCount ?? mutationActionableCount
    ),
    unconfirmedCount: Number(
      summary.unconfirmedCount ?? reconciliationActionableCount
    ),
    failedCount: Number(summary.failedCount ?? 0),
    blockedCount: Number(summary.blockedCount ?? 0),
    operations: Array.isArray(summary.operations) ? summary.operations : [],
  };
}

function isHostedViewerRuntime() {
  if (typeof window !== "undefined" && window.eliticalDesktop?.isDesktop) return false;
  if (import.meta.env.VITE_APP_MODE === "desktop") return false;
  if (import.meta.env.VITE_APP_MODE === "viewer") return true;
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return false;

  return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function formatType(type) {
  if (type === "main-root") return "Main";
  if (type === "story-root") return "Sprint";
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function makeCreateDraft(type, sprint, docketState) {
  return {
    title: "",
    description: "",
    worklogDescription: "",
    worklogDate: "",
    category: "feature",
    priority: "info",
    sprint,
    docketState,
    storyPoints: 0,
    time: "00:00",
    type,
  };
}

function makeSprintDraft(sprint, rootTitle, rootDocketState) {
  return {
    code: sprint?.code || "",
    title: sprint?.title || rootTitle || "New Sprint",
    sprintStartDate: sprint?.sprintStartDate
      ? formatDateInput(sprint.sprintStartDate)
      : "",
    sprintEndDate: sprint?.sprintEndDate
      ? formatDateInput(sprint.sprintEndDate)
      : "",
    sprintState: sprint?.sprintState || "",
    state: sprint?.state || "",
    createdBy: sprint?.createdBy || "",
    createdAt: sprint?.createdAt ? formatDateTimeLocalInput(sprint.createdAt) : "",
    updatedBy: sprint?.updatedBy || "",
    updatedAt: sprint?.updatedAt ? formatDateTimeLocalInput(sprint.updatedAt) : "",
    docketState: sprint?.docketState || rootDocketState || "concept",
  };
}

function makeEditDraft(item, fallbackSprint) {
  const primaryWorklog = Array.isArray(item.worklogs)
    ? item.worklogs[0]
    : null;
  const persistedSprintId = persistedDocketSprintId(item);
  const worklogDurationMinutes = durationMinutesForWorklogDraft(primaryWorklog, item);

  return {
    title: item.title || "",
    description: item.description || "",
    worklogId: primaryWorklog?.id || primaryWorklog?.worklogId || "",
    worklogDescription: primaryWorklog?.description || primaryWorklog?.comment || "",
    worklogDate: primaryWorklog ? formatDateInput(primaryWorklog.date || primaryWorklog.worklogDate) : "",
    category: item.category || "feature",
    priority: item.priority || "info",
    sprint: item.sprint || fallbackSprint,
    sprintId: persistedSprintId,
    sprintName: item.sprint || fallbackSprint,
    docketState: item.docketState || "concept",
    stateId: item.elitical?.stateId || item.dktStateId || "",
    stateName: item.docketState || item.dktStateName || "concept",
    assigneeId: item.elitical?.assigneeId || item.assigneeId || "",
    assigneeName: item.elitical?.assigneeName || item.assignee || "",
    parentId: item.parentId || "",
    epicId: item.elitical?.epicId || item.epicId || item.parentId || "",
    storyPoints: item.storyPoints || 0,
    time: formatTimeInput(worklogDurationMinutes),
  };
}

function positiveNumber(...values) {
  const match = values.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);

  return match === undefined ? 0 : Number(match);
}

function durationFromHourMinute(source = {}) {
  const hours = Number(source.hour ?? source.hours ?? source.loggedHours ?? source.duration ?? 0);
  const minutes = Number(source.min ?? source.minutes ?? 0);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;

  const totalMinutes = Math.round(hours) * 60 + Math.min(59, Math.max(0, Math.round(minutes)));

  return totalMinutes > 0 ? totalMinutes : 0;
}

function durationMinutesForWorklogDraft(worklog, item = {}) {
  if (!worklog) return positiveNumber(item.timeMinutes, item.durationMinutes);

  return (
    positiveNumber(worklog.timeMinutes, worklog.durationMinutes) ||
    durationFromHourMinute(worklog) ||
    positiveNumber(item.timeMinutes, item.durationMinutes) ||
    durationFromHourMinute(worklog.sync?.remoteBaseline)
  );
}

function lookupId(value) {
  return String(value?.id || value?.eliticalId || value?.code || value?.name || value?.title || "").trim();
}

function lookupName(value) {
  return String(value?.name || value?.title || value?.label || value?.code || value?.id || "").trim();
}

function isSyntheticOptionId(id) {
  const value = String(id || "").trim();

  return (
    !value ||
    value === ROOT_ID ||
    isOrphanSprintId(value) ||
    value.startsWith("reference-") ||
    value.startsWith("ghost-") ||
    value.startsWith("virtual-") ||
    value.startsWith("local-docket-")
  );
}

function normalizeLookupOptions(values = []) {
  const seen = new Set();

  return values
    .map((value) => ({
      ...value,
      id: lookupId(value),
      name: lookupName(value),
    }))
    .filter((value) => {
      if (!value.id || seen.has(value.id)) return false;

      seen.add(value.id);
      return true;
    });
}

function sortLookupOptions(options = []) {
  return [...options].sort((a, b) =>
    String(a.name || a.title || a.id || "").localeCompare(
      String(b.name || b.title || b.id || "")
    )
  );
}

function remoteIdForOptionItem(item) {
  return String(item?.sync?.remoteId || item?.elitical?.remoteId || item?.remoteId || item?.id || "").trim();
}

function buildLocalStateOptions(item, workItems = []) {
  const sameProject = (entry) =>
    !item?.elitical?.projectId ||
    !entry?.elitical?.projectId ||
    entry.elitical.projectId === item.elitical.projectId;

  return sortLookupOptions(
    normalizeLookupOptions(
      workItems
        .filter((entry) => sameProject(entry) && entry?.elitical?.stateId)
        .map((entry) => ({
          id: entry.elitical.stateId,
          name: entry.docketState || entry.elitical.stateName || entry.dktStateName || entry.elitical.stateId,
        }))
    )
  );
}

function buildLocalAssigneeOptions(item, workItems = []) {
  const sameProject = (entry) =>
    !item?.elitical?.projectId ||
    !entry?.elitical?.projectId ||
    entry.elitical.projectId === item.elitical.projectId;

  return sortLookupOptions(
    normalizeLookupOptions(
      workItems
        .filter((entry) => sameProject(entry) && entry?.elitical?.assigneeId)
        .map((entry) => ({
          id: entry.elitical.assigneeId,
          name: entry.elitical.assigneeName || entry.assignee || entry.elitical.assigneeId,
        }))
    )
  );
}

function buildLocalSprintOptions(sprints = []) {
  return sortLookupOptions(
    normalizeLookupOptions(
      sprints
        .filter((sprint) => sprint.id && !isSyntheticOptionId(sprint.id))
        .map((sprint) => ({
          id: sprint.id,
          name: sprint.title || sprint.name || sprint.id,
        }))
    )
  );
}

function buildLocalEpicOptions(item, workItems = []) {
  const sameProject = (entry) =>
    !item?.elitical?.projectId ||
    !entry?.elitical?.projectId ||
    entry.elitical.projectId === item.elitical.projectId;

  return sortLookupOptions(
    normalizeLookupOptions(
      workItems
        .filter((entry) => entry.type === "epic" && sameProject(entry))
        .map((entry) => ({
          id: entry.id,
          remoteId: remoteIdForOptionItem(entry),
          name: entry.title || entry.id,
        }))
        .filter((entry) => !isSyntheticOptionId(entry.id) && !isSyntheticOptionId(entry.remoteId))
    )
  );
}

function fallbackLookupOptions(values = []) {
  return values.map((value) => ({
    id: value,
    name: formatLabel(value),
  }));
}

function optionLabel(options, id, fallback = "") {
  if (!id) return fallback;

  return options.find((option) => option.id === id)?.name || fallback || id;
}

function nativeEnumValue(value) {
  return String(value || "").trim().toUpperCase();
}

function sprintNameForId(sprints = [], sprintId = "") {
  return sprints.find((sprint) => sprint.id === sprintId)?.title ||
    sprints.find((sprint) => sprint.id === sprintId)?.name ||
    "";
}

function supportedUpdatePayloadForItem(item, updates = {}, { workItems = [], sprints = [] } = {}) {
  const sdkUpdates = {};
  const nextStateId = updates.dktStateId ?? updates.stateId;
  const nextStateName = updates.dktStateName ?? updates.stateName ?? updates.docketState;

  if (
    Object.prototype.hasOwnProperty.call(updates, "title") &&
    String(updates.title || "").trim() !== String(item.title || "").trim()
  ) {
    sdkUpdates.title = String(updates.title || "").trim();
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "description") &&
    String(updates.description || "").trim() !== String(item.description || "").trim()
  ) {
    sdkUpdates.description = String(updates.description || "").trim();
  }

  if (
    (
      Object.prototype.hasOwnProperty.call(updates, "dktStateId") ||
      Object.prototype.hasOwnProperty.call(updates, "stateId")
    ) &&
    String(nextStateId || "").trim() &&
    String(nextStateId || "").trim() !== String(item.elitical?.stateId || item.dktStateId || "").trim()
  ) {
    sdkUpdates.dktStateId = String(nextStateId || "").trim();
    sdkUpdates.dktStateName = String(nextStateName || "").trim();
    sdkUpdates.docketState = String(updates.docketState || nextStateName || "").trim();
    sdkUpdates.elitical = {
      ...(updates.elitical || item.elitical || {}),
      stateId: sdkUpdates.dktStateId,
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "assigneeId") &&
    String(updates.assigneeId || "").trim() !== String(item.elitical?.assigneeId || item.assigneeId || "").trim()
  ) {
    sdkUpdates.assigneeId = String(updates.assigneeId || "").trim();
    sdkUpdates.assignee = String(updates.assignee || updates.assigneeName || item.assignee || "").trim();
    sdkUpdates.elitical = {
      ...(sdkUpdates.elitical || updates.elitical || item.elitical || {}),
      assigneeId: sdkUpdates.assigneeId,
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "sprintId") &&
    String(updates.sprintId || "").trim() &&
    String(updates.sprintId || "").trim() !== String(item.elitical?.sprintId || item.sprintId || "").trim() &&
    !isOrphanSprintId(updates.sprintId)
  ) {
    sdkUpdates.sprintId = String(updates.sprintId || "").trim();
    sdkUpdates.sprintName = String(updates.sprintName || sprintNameForId(sprints, updates.sprintId)).trim();
    sdkUpdates.hasNoSprint = false;
    sdkUpdates.sprint = sdkUpdates.sprintName;
    sdkUpdates.elitical = {
      ...(sdkUpdates.elitical || updates.elitical || item.elitical || {}),
      sprintId: sdkUpdates.sprintId,
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "category") &&
    nativeEnumValue(updates.category) !== nativeEnumValue(item.category)
  ) {
    sdkUpdates.category = nativeEnumValue(updates.category);
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "priority") &&
    nativeEnumValue(updates.priority) !== nativeEnumValue(item.priority)
  ) {
    sdkUpdates.priority = nativeEnumValue(updates.priority);
  }

  if (
    item.type === "story" &&
    Object.prototype.hasOwnProperty.call(updates, "parentId") &&
    updates.parentId !== item.parentId &&
    !isReferenceNode(workItems.find((entry) => entry.id === updates.parentId)) &&
    !String(updates.parentId || "").startsWith("local-docket-") &&
    !isSyntheticOptionId(updates.epicId || updates.parentId)
  ) {
    sdkUpdates.parentId = updates.parentId;
    sdkUpdates.epicId = updates.epicId || updates.parentId;
  }

  if (
    item.type === "story" &&
    Object.prototype.hasOwnProperty.call(updates, "storyPoints") &&
    Number(updates.storyPoints || 0) !== Number(item.storyPoints || 0)
  ) {
    sdkUpdates.storyPoints = Number(updates.storyPoints || 0);
    sdkUpdates.storyPointEst = Number(updates.storyPoints || 0);
  }

  return sdkUpdates;
}

function optionIdForValue(options, value, fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) return fallback;

  const matched = options.find((option) =>
    [option.id, option.code, option.name, option.title]
      .some((candidate) => String(candidate || "").trim().toLowerCase() === normalized)
  );

  return matched?.id || fallback || value;
}

function mergeOption(options, id, name) {
  if (!id || options.some((option) => option.id === id)) return options;

  return [
    ...options,
    {
      id,
      name: name || id,
    },
  ];
}

function localDocketStateValue(label, current) {
  const normalized = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  return DOCKET_STATES.includes(normalized) ? normalized : current || "concept";
}

function createTypesForParent(parentId, workItems) {
  const parent = workItems.find((item) => item.id === parentId);

  return childCreateTypesForCanonicalType(parent?.type);
}

function projectIdForCreate(parentId, workItems, sprints) {
  const parent = workItems.find((item) => item.id === parentId);

  if (parent?.elitical?.projectId) return parent.elitical.projectId;

  const sprint = sprints.find((entry) => entry.id === parentId);

  return (
    sprint?.projectId ||
    sprints.find((entry) => entry.projectId)?.projectId ||
    workItems.find((item) => item.elitical?.projectId)?.elitical?.projectId ||
    ""
  );
}

function sprintIdForCreate(parentId, sprintId, workItems, sprints) {
  if (sprintId) return sprintId;
  if (sprints.some((entry) => entry.id === parentId && parentId !== ROOT_ID)) return parentId;

  const parent = workItems.find((item) => item.id === parentId);

  return parent?.elitical?.sprintId || parent?.sprintId || "";
}

function nativeStorySprintForCreate(parentId, sprintId, workItems, sprints) {
  const selectedSprintId = sprintIdForCreate(parentId, sprintId, workItems, sprints);
  const selectedSprint = sprints.find((entry) => entry.id === selectedSprintId);
  const activeSprint = sprints.find(
    (entry) =>
      entry.id &&
      entry.id !== ROOT_ID &&
      String(entry.sprintState || "").toUpperCase() === "IN_PROGRESS"
  );
  const fallbackSprint = sprints.find((entry) => entry.id && entry.id !== ROOT_ID);
  const sprint = selectedSprint || activeSprint || fallbackSprint || null;

  return {
    sprintId: sprint?.id || selectedSprintId || "",
    sprintName: sprint?.title || sprint?.name || "",
  };
}

function nativeStoryAssigneeIdForCreate(parentId, payload, workItems) {
  const parent = workItems.find((item) => item.id === parentId);
  const assignedItem = workItems.find((item) => item.elitical?.assigneeId);

  return (
    payload.assigneeId ||
    parent?.elitical?.assigneeId ||
    assignedItem?.elitical?.assigneeId ||
    ""
  );
}

function nativeStoryProjectNameForCreate(parentId, workItems, sprints, fallback) {
  const parent = workItems.find((item) => item.id === parentId);
  const projectSprint = sprints.find((entry) => entry.projectName || entry.name || entry.title);

  return (
    parent?.elitical?.projectName ||
    projectSprint?.projectName ||
    projectSprint?.name ||
    fallback ||
    ""
  );
}

function canonicalDocketIdForUpdate(item) {
  if (!item || item.isVirtual || isOrphanSprintId(item.id)) return "";

  const id = isReferenceNode(item)
    ? item.sourceItemId || item.sourceDocketId || item.sourceId
    : item.id;
  const value = String(id || "").trim();

  if (
    !value ||
    value === "virtual-orphan-sprint" ||
    value.startsWith("reference-") ||
    value.startsWith("ghost-") ||
    value.startsWith("virtual-")
  ) {
    return "";
  }

  return value;
}

function resolveCanonicalWorkItem(id, workItems = []) {
  const value = String(id || "").trim();

  if (!value) return null;

  return workItems.find((item) => item.id === value) ||
    workItems.find((item) =>
      [item.sourceItemId, item.sourceDocketId, item.sourceId, item.elitical?.remoteId, item.sync?.remoteId]
        .some((candidate) => String(candidate || "").trim() === value)
    ) ||
    null;
}

function parentPayloadForCreate(type, parentId, workItems) {
  const parent = workItems.find((item) => item.id === parentId);

  if (type === "epic") return {};
  if ((type === "story" || type === "task") && parent?.type === "epic") {
    return {
      parentId,
      epicId: parentId,
    };
  }
  if (type === "job" && parent?.type === "story") {
    return {
      parentId,
      storyId: parentId,
      epicId: parent.elitical?.epicId || parent.parentId || "",
    };
  }

  return {
    parentId,
  };
}

function validateCreatePayload(payload, workItems, sprints) {
  const type = String(payload.type || "").trim();
  const title = String(payload.title || "").trim();
  const parentId = String(payload.parentId || "").trim();
  const validTypes =
    payload.isOrphanSprint && parentId === ROOT_ID
      ? ["epic"]
      : createTypesForParent(parentId, workItems, sprints);

  if (!["epic", "story", "task", "job"].includes(type)) {
    return "Choose a docket type.";
  }
  if (!validTypes.includes(type)) {
    return "Choose a valid parent for this docket type.";
  }
  if (!title) return "Title is required.";
  if (type !== "epic" && !workItems.some((item) => item.id === parentId)) {
    return "A valid parent is required.";
  }

  return "";
}

function parseTimeInput(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number(part));

  if (
    parts.length !== 2 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return 0;
  }

  const [hours, minutes] = parts;
  const totalMinutes = Math.round(hours) * 60 + Math.min(59, Math.round(minutes));
  return Math.round(totalMinutes / 15) * 15;
}

function formatTimeInput(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;

  return [
    String(hours).padStart(2, "0"),
    String(remainingMinutes).padStart(2, "0"),
  ].join(":");
}

function formatDateInput(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateInputToIso(value, fallback) {
  const fallbackDate = new Date(fallback || Date.now());
  const [year, month, day] = String(value || "")
    .split("-")
    .map((part) => Number(part));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return Number.isNaN(fallbackDate.getTime())
      ? new Date().toISOString()
      : fallbackDate.toISOString();
  }

  const date = Number.isNaN(fallbackDate.getTime())
    ? new Date()
    : fallbackDate;
  date.setFullYear(year, month - 1, day);

  return date.toISOString();
}

function formatDateTimeLocalInput(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return [
    formatDateInput(date),
    [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
    ].join(":"),
  ].join("T");
}

function dateTimeInputToIso(value) {
  if (!value) return "";

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function optionalDateInputToIso(value) {
  if (!value) return "";

  return dateInputToIso(value, value);
}

function formatWorkTime(minutes) {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const officeDayMinutes = 8 * 60;

  if (safeMinutes <= officeDayMinutes) {
    return formatTimeInput(safeMinutes);
  }

  const days = Math.floor(safeMinutes / officeDayMinutes);
  const remainder = safeMinutes % officeDayMinutes;
  const hours = Math.floor(remainder / 60);
  const remainingMinutes = remainder % 60;

  return [
    String(days).padStart(2, "0"),
    String(hours).padStart(2, "0"),
    String(remainingMinutes).padStart(2, "0"),
  ].join(":");
}

function acceptsTime(type) {
  return type === "story" || type === "task" || type === "job";
}

function worklogDraftFromFields(draft = {}) {
  const totalMinutes = parseTimeInput(draft.time);
  const hour = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;

  return {
    id: draft.worklogId || "",
    comment: String(draft.worklogDescription || "").trim(),
    worklogDate: draft.worklogDate || "",
    hour,
    min,
  };
}

function isMeaningfulWorklogDraft(draft = {}) {
  const worklog = worklogDraftFromFields(draft);

  return Boolean(
    worklog.comment ||
    worklog.worklogDate ||
    Number(worklog.hour) > 0 ||
    Number(worklog.min) > 0
  );
}

function validateWorklogDraft(draft = {}) {
  if (!isMeaningfulWorklogDraft(draft)) return "";

  const worklog = worklogDraftFromFields(draft);

  if (!worklog.comment) return "Worklog comment is required.";
  if (!worklog.worklogDate) return "Worklog date is required.";
  if (Number(worklog.hour) < 0 || Number(worklog.min) < 0) {
    return "Worklog time cannot be negative.";
  }
  if (Number(worklog.min) > 59) return "Worklog minutes must be between 0 and 59.";
  if (Number(worklog.hour) === 0 && Number(worklog.min) === 0) {
    return "Worklog time is required.";
  }

  return "";
}

function parentLabel(parentId, workItems) {
  if (parentId === ROOT_ID) return "Sprint";
  const parent = workItems.find((item) => item.id === parentId);
  return parent ? parent.title : parentId;
}

function parentFieldLabel(parentId, workItems) {
  if (parentId === ROOT_ID) return "Sprint";
  const parent = workItems.find((item) => item.id === parentId);
  return parent ? formatType(parent.type) : "Parent";
}

function inheritedSprint(parentId, workItems, rootTitle) {
  let currentParentId = parentId;

  while (currentParentId && currentParentId !== ROOT_ID) {
    const parent = workItems.find((item) => item.id === currentParentId);

    if (!parent) break;
    if (parent.sprint) return parent.sprint;

    currentParentId = parent.parentId;
  }

  return rootTitle;
}

function inheritedDocketState(parentId, workItems, rootDocketState) {
  if (parentId === ROOT_ID) return rootDocketState || "concept";

  const parent = workItems.find((item) => item.id === parentId);
  return parent?.docketState || rootDocketState || "concept";
}

function openChildNames(parentId, workItems) {
  return workItems
    .filter(
      (item) =>
        item.parentId === parentId &&
        (item.docketState || "concept") !== "artifact"
    )
    .map((item) => item.title);
}

function artifactBlockedError(parentId, workItems) {
  const names = openChildNames(parentId, workItems);

  if (names.length === 0) return "";

  return `Close these child boxes first: ${names.join(", ")}.`;
}

function normalizeArtifactRollup(items, rootDocketState) {
  const childIdsByParent = items.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item.id);
    return acc;
  }, new Map());
  const itemById = new Map(items.map((item) => [item.id, item]));
  const nextStateById = new Map();

  function stateFor(id) {
    if (nextStateById.has(id)) return nextStateById.get(id);

    const item = itemById.get(id);
    const childIds = childIdsByParent.get(id) || [];
    let nextState = item?.docketState || "concept";

    if (childIds.length > 0) {
      const allChildrenArtifact = childIds.every(
        (childId) => stateFor(childId) === "artifact"
      );

      if (allChildrenArtifact) {
        nextState = "artifact";
      } else if (nextState === "artifact") {
        nextState = "concept";
      }
    }

    nextStateById.set(id, nextState);
    return nextState;
  }

  const nextItems = items.map((item) => {
    const nextState = stateFor(item.id);
    return item.docketState === nextState
      ? item
      : {
          ...item,
          docketState: nextState,
        };
  });
  const rootChildIds = childIdsByParent.get(ROOT_ID) || [];
  const nextRootDocketState =
    rootChildIds.length > 0 &&
    rootChildIds.every((id) => stateFor(id) === "artifact")
      ? "artifact"
      : rootDocketState === "artifact"
      ? "concept"
      : rootDocketState || "concept";

  return {
    workItems: nextItems,
    rootDocketState: nextRootDocketState,
  };
}

function normalizeStoryStateArtifactRollup(state) {
  const normalized = normalizeArtifactRollup(
    state.workItems,
    state.rootDocketState || "concept"
  );

  return {
    ...state,
    rootDocketState: normalized.rootDocketState,
    workItems: normalized.workItems,
  };
}

function snapshotFromState(state) {
  const result = buildWorklogSnapshot(
    normalizeStoryStateArtifactRollup(state)
  );

  if (!result.valid) {
    throw new Error(result.error);
  }

  return result.snapshot;
}

function normalizeLoadedSnapshot(snapshot) {
  const result = normalizeWorklogSnapshot(snapshot);

  if (!result.valid) {
    throw new Error(result.error);
  }

  return {
    state: normalizeStoryStateArtifactRollup(result.state),
    snapshot: snapshotFromState(result.state),
  };
}

function snapshotEquals(first, second) {
  if (!first || !second) return false;
  return stableSnapshotString(first) === stableSnapshotString(second);
}

function descendantsIncluding(items, rootId) {
  if (!rootId) return items;

  const childrenByParent = items.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item);
    return acc;
  }, new Map());
  const visible = [];
  const pending = [rootId];

  while (pending.length) {
    const id = pending.shift();
    const item = items.find((entry) => entry.id === id);

    if (!item) continue;

    visible.push(item);
    pending.push(...(childrenByParent.get(id) || []).map((child) => child.id));
  }

  return visible;
}

function ancestorsForMatches(items, predicate) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const visibleIds = new Set();

  items.forEach((item) => {
    if (!predicate(item)) return;

    visibleIds.add(item.id);

    let parentId = item.parentId;

    while (parentId && parentId !== ROOT_ID) {
      visibleIds.add(parentId);
      parentId = itemById.get(parentId)?.parentId;
    }
  });

  return items.filter((item) => visibleIds.has(item.id));
}

function displaySprintIdForItem(item) {
  return projectionScopeIdForItem(item);
}

function sprintSortTime(sprint) {
  return Math.max(
    new Date(sprint?.sprintStartDate || 0).getTime() || 0,
    new Date(sprint?.createdAt || 0).getTime() || 0,
    new Date(sprint?.updatedAt || 0).getTime() || 0
  );
}

function defaultSprintId(sprints = []) {
  const realSprints = sprints.filter((sprint) => sprint.id !== ROOT_ID);
  const inProgress = realSprints
    .filter((sprint) =>
      String(sprint.sprintState || sprint.state || "")
        .toLowerCase()
        .includes("progress")
    )
    .sort((first, second) => sprintSortTime(second) - sprintSortTime(first));

  return inProgress[0]?.id || realSprints[0]?.id || "";
}

function updatedSortTime(item) {
  return Math.max(
    new Date(item?.updatedAt || 0).getTime() || 0,
    new Date(item?.createdAt || 0).getTime() || 0
  );
}

function defaultDocketContextId(workItems = [], type) {
  const matches = workItems
    .filter((item) => item.type === type)
    .sort((first, second) => updatedSortTime(second) - updatedSortTime(first));
  const scopedMatch = matches.find((item) =>
    displaySprintIdForItem(item)
  );

  return scopedMatch?.id || matches[0]?.id || "";
}

function contextOptionLabel(option, viewMode) {
  if (!option) return "";
  if (viewMode === "sprint") return option.title || option.id;

  const prefix = option.elitical?.num || option.id;
  return `${prefix} ${option.title || ""}`.trim();
}

function contextOptionMeta(option, viewMode) {
  if (!option) return "";
  if (viewMode === "sprint") {
    if (isOrphanSprintId(option.id)) return "No Sprint";

    return option.sprintState || option.state || option.code || "";
  }

  return [formatType(option.type), option.sprint].filter(Boolean).join(" · ");
}

function contextViewLabel(viewMode) {
  if (viewMode === "sprint") return "Sprint";
  if (viewMode === "epic") return "Epic";
  if (viewMode === "story") return "Story";
  if (viewMode === "job") return "Job";
  if (viewMode === "task") return "Task";
  if (viewMode === "day") return "Date";
  return "Context";
}

function defaultContextSelection({ viewMode, sprints, workItems }) {
  if (viewMode === "sprint") return defaultSprintId(sprints);
  if (viewMode === "day") return formatDateInput(new Date());
  if (DOCKET_CONTEXT_TYPES.has(viewMode)) {
    return defaultDocketContextId(workItems, viewMode);
  }

  return "";
}

function contextOptionsForView({ viewMode, sprints, workItems }) {
  if (viewMode === "sprint") {
    return sprints.filter((sprint) => sprint.id !== ROOT_ID);
  }

  if (viewMode === "day") return [];

  if (DOCKET_CONTEXT_TYPES.has(viewMode)) {
    return workItems.filter((item) => item.type === viewMode);
  }

  return [];
}

function worklogDateToInput(value) {
  if (!value) return "";

  if (typeof value === "number") return formatDateInput(new Date(value));

  const text = String(value || "").trim();

  if (!text) return "";

  if (/^\d+$/.test(text)) return formatDateInput(new Date(Number(text)));

  return formatDateInput(text);
}

function isRealImportedWorklog(entry) {
  return Boolean(String(entry?.id || "").trim());
}

function worklogMinutes(entry) {
  const minutes = Number(entry?.timeMinutes ?? entry?.durationMinutes ?? 0);

  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

function worklogsForDay(item, selectedDate) {
  if (!selectedDate || !Array.isArray(item?.worklogs)) return [];

  return item.worklogs.filter(
    (entry) =>
      isRealImportedWorklog(entry) &&
      worklogDateToInput(entry.worklogDate || entry.date) === selectedDate
  );
}

function aggregateDayWorklogs(item, selectedDate) {
  const worklogs = worklogsForDay(item, selectedDate);
  const totalMinutes = worklogs.reduce(
    (total, entry) => total + worklogMinutes(entry),
    0
  );
  const comments = worklogs
    .map((entry) => String(entry.comment || entry.description || "").trim())
    .filter(Boolean);

  return {
    worklogs,
    totalMinutes,
    count: worklogs.length,
    comments,
  };
}

function normalizedImportedWorklog(entry = {}) {
  const durationMinutes = Number(entry.durationMinutes ?? entry.timeMinutes ?? 0);

  return {
    ...entry,
    id: String(entry.id || entry.worklogId || ""),
    date: entry.worklogDate || entry.date || "",
    worklogDate: entry.worklogDate || entry.date || "",
    description: String(entry.comment || entry.description || ""),
    comment: String(entry.comment || entry.description || ""),
    employeeId: String(entry.employeeId || ""),
    employeeName: String(entry.employeeName || ""),
    timeMinutes: Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : 0,
    durationMinutes: Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : 0,
  };
}

function applyImportedWorklogs(workItems = [], importedWorklogs = []) {
  if (!Array.isArray(importedWorklogs) || importedWorklogs.length === 0) {
    return workItems;
  }

  const byDocket = new Map();

  importedWorklogs.forEach((entry) => {
    const docketId = String(entry?.docketId || "").trim();

    if (!docketId) return;
    if (!byDocket.has(docketId)) byDocket.set(docketId, []);
    byDocket.get(docketId).push(normalizedImportedWorklog(entry));
  });

  return workItems.map((item) => {
    if (!["story", "job", "task"].includes(item.type)) return item;

    return {
      ...item,
      worklogs: byDocket.get(item.id) || [],
    };
  });
}

function addDescendants(itemId, childrenByParent, selectedIds) {
  const pending = [itemId];

  while (pending.length) {
    const currentId = pending.shift();

    (childrenByParent.get(currentId) || []).forEach((child) => {
      if (selectedIds.has(child.id)) return;

      selectedIds.add(child.id);
      pending.push(child.id);
    });
  }
}

function buildContextGraph({
  workItems,
  sprints = [],
  viewMode,
  selectedId,
}) {
  if (!CONTEXT_VIEW_IDS.has(viewMode) || !selectedId) {
    return {
      workItems,
      rootId: null,
      sprints: [],
    };
  }

  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]));
  const selectedIds = new Set();
  const selectedSprintIds = new Set();
  const dayAggregates = new Map();
  const childrenByParent = workItems.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item);
    return acc;
  }, new Map());

  if (viewMode === "sprint") {
    workItems.forEach((item) => {
      if (displaySprintIdForItem(item) !== selectedId) return;

      selectedIds.add(item.id);
      selectedSprintIds.add(selectedId);
    });
  } else if (viewMode === "day") {
    workItems.forEach((item) => {
      const aggregate = aggregateDayWorklogs(item, selectedId);

      if (aggregate.count === 0) return;

      selectedIds.add(item.id);
      dayAggregates.set(item.id, aggregate);

      const sprintId = displaySprintIdForItem(item);
      if (sprintById.has(sprintId)) selectedSprintIds.add(sprintId);
    });
  } else if (viewMode === "epic") {
    if (itemById.has(selectedId)) {
      selectedIds.add(selectedId);
      addDescendants(selectedId, childrenByParent, selectedIds);
    }
  } else if (viewMode === "story") {
    const selected = itemById.get(selectedId);

    if (selected) {
      selectedIds.add(selected.id);
      addDescendants(selected.id, childrenByParent, selectedIds);
    }
  } else if (viewMode === "job" || viewMode === "task") {
    const selected = itemById.get(selectedId);

    if (selected) {
      selectedIds.add(selected.id);
    }
  }

  selectedIds.forEach((id) => {
    const sprintId = displaySprintIdForItem(itemById.get(id));
    if (sprintById.has(sprintId)) selectedSprintIds.add(sprintId);
  });

  const contextWorkItems = workItems
    .filter((item) => selectedIds.has(item.id))
    .map((item) => {
      const aggregate = dayAggregates.get(item.id);
      const dayItem =
        viewMode === "day" && aggregate
          ? {
              ...item,
              worklogs: aggregate.worklogs.map((entry) => ({
                ...entry,
                date: entry.date || entry.worklogDate,
                timeMinutes: worklogMinutes(entry),
                description: entry.description || entry.comment || "",
              })),
              timeMinutes: aggregate.totalMinutes,
              dayWorklogCount: aggregate.count,
              dayWorklogComments: aggregate.comments,
            }
          : item;

      return selectedIds.has(dayItem.id)
        ? {
            ...dayItem,
            isContextPrimary: true,
          }
        : dayItem;
    });

  return {
    workItems: contextWorkItems,
    rootId: null,
    sprints: sprints.filter((sprint) => selectedSprintIds.has(sprint.id)),
  };
}

function dayViewSummary({ workItems, graphWorkItems, selectedDate, rootTitle }) {
  const dayWorklogs = workItems.flatMap((item) =>
    worklogsForDay(item, selectedDate).map((entry) => ({
      item,
      entry,
    }))
  );
  const selectedDocketIds = new Set(dayWorklogs.map(({ item }) => item.id));
  const graphByType = graphWorkItems.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  const sprintNames = new Set(
    graphWorkItems.map((item) => item.sprint).filter(Boolean)
  );
  const totalMinutes = dayWorklogs.reduce(
    (total, { entry }) => total + worklogMinutes(entry),
    0
  );

  return {
    selectedDate,
    worklogs: dayWorklogs.length,
    totalMinutes,
    projects: rootTitle ? 1 : 0,
    sprints: sprintNames.size,
    epics: graphByType.epic || 0,
    stories: graphByType.story || 0,
    jobs: graphByType.job || 0,
    tasks: graphByType.task || 0,
    dockets: selectedDocketIds.size,
  };
}

function mergeByStableIdentity(currentItems = [], nextItems = []) {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));

  return nextItems.map((item) => {
    const current = currentById.get(item.id);

    return current && stableSnapshotString(current) === stableSnapshotString(item)
      ? current
      : item;
  });
}

function mergeGraphState(currentState, nextState) {
  if (!currentState) return nextState;

  return {
    ...nextState,
    sprints: mergeByStableIdentity(currentState.sprints, nextState.sprints),
    workItems: mergeByStableIdentity(currentState.workItems, nextState.workItems),
  };
}

function descendantCount(items, id) {
  return descendantsIncluding(items, id).length - 1;
}

function formatLabel(value) {
  const text = String(value || "")
    .replace(/[-_]/g, " ")
    .trim();

  if (!text) return "-";

  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDocketState(state) {
  return formatLabel(state);
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeSync(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Not synced";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (elapsedSeconds < 60) return "Just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} min ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return formatDateLabel(value);
}

function formatDateLabel(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function itemMatchesQuery(item, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return true;

  return [
    item.title,
    item.description,
    item.type,
    item.category,
    item.priority,
    item.docketState,
    item.sprint,
    item.id,
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function sprintMatchesQuery(sprint, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return true;

  return [
    sprint.id,
    sprint.title,
    sprint.docketState,
    "sprint",
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function filterWorkItemsForSearch(items, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return items;

  const itemById = new Map(items.map((item) => [item.id, item]));
  const visibleIds = new Set();

  items.forEach((item) => {
    if (!itemMatchesQuery(item, normalized)) return;

    visibleIds.add(item.id);

    let parentId = item.parentId;

    while (parentId && parentId !== ROOT_ID) {
      visibleIds.add(parentId);
      parentId = itemById.get(parentId)?.parentId;
    }
  });

  return items.filter((item) => visibleIds.has(item.id));
}

function primaryWorklogDate(item) {
  const primary = Array.isArray(item?.worklogs) ? item.worklogs[0] : null;
  return primary?.date || item?.updatedAt || item?.createdAt;
}

function MetadataBadge({ children }) {
  return <span className="metadata-badge">{children || "-"}</span>;
}

function DashboardView({ workItems, sprints, rootTitle, totals, lastSyncedAt }) {
  const stories = workItems.filter((item) => item.type === "story");
  const jobs = workItems.filter((item) => item.type === "job");
  const epics = workItems.filter((item) => item.type === "epic");
  const todayKey = formatDateInput(new Date());
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const loggedToday = workItems.reduce(
    (total, item) =>
      total +
      (item.worklogs || [])
        .filter((entry) => formatDateInput(entry.date) === todayKey)
        .reduce((sum, entry) => sum + Number(entry.timeMinutes || 0), 0),
    0
  );
  const loggedThisWeek = workItems.reduce(
    (total, item) =>
      total +
      (item.worklogs || [])
        .filter((entry) => {
          const date = new Date(entry.date);
          return !Number.isNaN(date.getTime()) && date >= weekStart;
        })
        .reduce((sum, entry) => sum + Number(entry.timeMinutes || 0), 0),
    0
  );
  const cards = [
    ["Active Sprint", rootTitle || sprints[0]?.title || "-"],
    ["Total Epics", epics.length],
    ["Total Stories", stories.length],
    ["Total Jobs", jobs.length],
    ["Completed Jobs", jobs.filter((item) => item.docketState === "artifact" || item.docketState === "closed").length],
    ["In Progress Jobs", jobs.filter((item) => item.docketState === "concept" || item.docketState === "design").length],
    ["Blocked Jobs", jobs.filter((item) => item.docketState === "blocked").length],
    ["Story Points", totals.rootTotal],
    ["Hours Logged Today", formatWorkTime(loggedToday)],
    ["Hours Logged This Week", formatWorkTime(loggedThisWeek)],
    ["Last Sync Time", formatRelativeSync(lastSyncedAt)],
  ];

  return (
    <main className="dashboard-view">
      <header className="dashboard-header">
        <span>Overview</span>
        <h1>Dashboard</h1>
      </header>
      <section className="dashboard-grid">
        {cards.map(([label, value]) => (
          <article key={label} className="dashboard-card">
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
    </main>
  );
}

function ModalSection({ title, children, className = "" }) {
  return (
    <section className={`modal-section ${className}`}>
      <h3>{title}</h3>
      <div className="modal-section-grid">{children}</div>
    </section>
  );
}

function ReadOnlyField({ label, value, badge = false, wide = false }) {
  return (
    <div className={`modal-field readonly-disabled ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {badge ? (
        <MetadataBadge>{value}</MetadataBadge>
      ) : (
        <strong>{value || "-"}</strong>
      )}
    </div>
  );
}

function CustomSelectField({
  label,
  value,
  options,
  onChange,
  onOpen,
  wide = false,
  getOptionLabel = formatLabel,
}) {
  const [open, setOpen] = useState(false);
  const fieldRef = useRef(null);
  const selectedLabel = getOptionLabel(value);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (!fieldRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleOpen() {
    onOpen?.();
    setOpen((current) => !current);
  }

  function selectOption(option) {
    onChange(option);
    setOpen(false);
  }

  return (
    <div
      ref={fieldRef}
      className={`modal-field custom-select-field custom-select-value-${value || "empty"} ${
        open ? "open" : ""
      } ${wide ? "wide" : ""}`}
    >
      <span>{label}</span>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selectedLabel || "-"}</span>
        <span className="custom-select-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="custom-select-menu" role="listbox">
          {options.map((option) => {
            const selected = option === value;

            return (
              <button
                key={option}
                type="button"
                className={`custom-select-option custom-select-value-${option} ${
                  selected ? "selected" : ""
                }`}
                onClick={() => selectOption(option)}
                role="option"
                aria-selected={selected}
              >
                <span className="custom-select-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span>{getOptionLabel(option)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContextGraphSelector({
  label,
  options,
  value,
  onChange,
  viewMode,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectorRef = useRef(null);
  const selectedOption = options.find((option) => option.id === value);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) return options;

    return options.filter((option) =>
      [
        contextOptionLabel(option, viewMode),
        contextOptionMeta(option, viewMode),
        option.id,
      ].some((entry) => String(entry || "").toLowerCase().includes(normalized))
    );
  }, [options, query, viewMode]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, viewMode]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (selectorRef.current?.contains(event.target)) return;

      setOpen(false);
      setQuery("");
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function selectOption(optionId) {
    onChange(optionId);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        Math.min(current + 1, Math.max(0, filteredOptions.length - 1))
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === "Enter" && open && filteredOptions[activeIndex]) {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex].id);
    }
  }

  return (
    <section className="context-graph-selector" ref={selectorRef}>
      <span>{label}</span>
      <div className="context-graph-select">
        <input
          type="text"
          value={open ? query : contextOptionLabel(selectedOption, viewMode)}
          placeholder={`Select ${label}`}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          aria-label={`Select ${label}`}
          aria-expanded={open}
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label={`Toggle ${label} list`}
        >
          v
        </button>
        {open && (
          <div className="context-graph-menu" role="listbox">
            {filteredOptions.length === 0 ? (
              <div className="context-graph-empty">No options</div>
            ) : (
              filteredOptions.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${option.id === value ? "selected" : ""} ${
                    index === activeIndex ? "active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectOption(option.id)}
                  role="option"
                  aria-selected={option.id === value}
                >
                  <span>{contextOptionLabel(option, viewMode)}</span>
                  <small>{contextOptionMeta(option, viewMode)}</small>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DayViewToolbar({ value, onChange, summary }) {
  if (!summary) return null;

  const rows = [
    ["Worklogs", summary.worklogs],
    ["Logged", formatWorkTime(summary.totalMinutes)],
    ["Projects", summary.projects],
    ["Sprints", summary.sprints],
    ["Epics", summary.epics],
    ["Stories", summary.stories],
    ["Jobs", summary.jobs],
    ["Tasks", summary.tasks],
  ];

  return (
    <section className="day-view-toolbar" aria-label="Day View toolbar">
      <label className="day-view-date-field">
        <span>Date</span>
        <input
          type="date"
          value={value || formatDateInput(new Date())}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Select date"
        />
      </label>
      <div className="day-view-stats" aria-label="Day View statistics">
        {rows.map(([label, value]) => (
          <span key={label}>
            {label} {value}
          </span>
        ))}
      </div>
    </section>
  );
}

function InlineField({
  label,
  value,
  field,
  editingField,
  onEdit,
  onChange,
  type = "text",
  options = [],
  step,
  badge = false,
  wide = false,
  onCommit,
}) {
  const editing = editingField === field;
  const displayValue =
    type === "select"
      ? formatLabel(value)
      : type === "date"
      ? formatDateLabel(dateInputToIso(value))
      : badge
      ? value
      : value;

  if (type === "select") {
    return (
      <CustomSelectField
        label={label}
        value={value}
        options={options}
        onOpen={() => onEdit(field)}
        onChange={onChange}
        wide={wide}
      />
    );
  }

  if (editing) {
    if (type === "textarea") {
      return (
        <label className={`modal-field inline-active ${wide ? "wide" : ""}`}>
          <span>{label}</span>
          <textarea
            className="modal-control inline-control"
            rows="2"
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onCommit}
          />
        </label>
      );
    }

    return (
      <label className={`modal-field inline-active ${wide ? "wide" : ""}`}>
        <span>{label}</span>
        <input
          className="modal-control inline-control"
          type={type}
          step={step}
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
        />
      </label>
    );
  }

  return (
    <div
      className={`modal-field inline-readable ${wide ? "wide" : ""}`}
      onClick={() => onEdit(field)}
    >
      <span>{label}</span>
      {badge ? (
        <MetadataBadge>{displayValue}</MetadataBadge>
      ) : (
        <strong>{displayValue || "-"}</strong>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
  wide = false,
}) {
  return (
    <label className={`modal-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <input
        className="modal-control"
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({ label, value, onChange, wide = false }) {
  return (
    <label className={`modal-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <textarea
        className="modal-control"
        rows="3"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function validEditableParent(item, parentId, workItems) {
  const parent = workItems.find((entry) => entry.id === parentId);

  if (item.type === "epic") return true;
  if (item.type === "story") return parent?.type === "epic";
  if (item.type === "task") return parent?.type === "epic";
  if (item.type === "job") return parent?.type === "story";

  return false;
}

function parentOptionsForItem(item, workItems) {
  if (item.type === "story" || item.type === "task") {
    return workItems.filter((entry) => entry.type === "epic");
  }

  if (item.type === "job") {
    return workItems.filter((entry) => entry.type === "story");
  }

  return [];
}

function persistedDocketSprintId(item) {
  if (!item) return "";
  if (item.elitical) return item.elitical.sprintId || "";

  return item.sprintId || "";
}

function localPropertyLookups(item, workItems = [], sprints = []) {
  const sameProject = (entry) =>
    !item?.elitical?.projectId ||
    !entry?.elitical?.projectId ||
    entry.elitical.projectId === item.elitical.projectId;

  return {
    users: buildLocalAssigneeOptions(item, workItems),
    states: buildLocalStateOptions(item, workItems),
    priorities: normalizeLookupOptions([
      ...fallbackLookupOptions(PRIORITIES),
      ...workItems
        .filter((entry) => sameProject(entry) && entry?.priority)
        .map((entry) => ({
          id: entry.priority,
          name: formatLabel(entry.priority),
        })),
    ]),
    categories: normalizeLookupOptions([
      ...fallbackLookupOptions(CATEGORIES),
      ...workItems
        .filter((entry) => sameProject(entry) && entry?.category)
        .map((entry) => ({
          id: entry.category,
          name: formatLabel(entry.category),
        })),
    ]),
    sprints: buildLocalSprintOptions(sprints),
  };
}

function PropertyPanel({
  item,
  workItems,
  sprints,
  onClose,
  onSave,
  readOnly = false,
}) {
  const persistedSprintId = persistedDocketSprintId(item);
  const persistedSprintLabel = persistedSprintId ? item?.sprint || "" : "";
  const initialDraft = useMemo(() => ({
    title: item?.title || "",
    description: item?.description || "",
    stateId: item?.elitical?.stateId || item?.dktStateId || "",
    priority: item?.priority || "",
    category: item?.category || "",
    storyPoints: item?.storyPoints ?? 0,
    assigneeId: item?.elitical?.assigneeId || "",
    parentId: item?.parentId || "",
    epicId: item?.elitical?.epicId || item?.epicId || item?.parentId || "",
    sprintId: persistedSprintId,
  }), [item, persistedSprintId]);
  const [draft, setDraft] = useState(initialDraft);
  const lookups = useMemo(
    () => localPropertyLookups(item, workItems, sprints),
    [item, workItems, sprints]
  );
  const [saveState, setSaveState] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(initialDraft);
    setError("");
    setSaveState("idle");
  }, [initialDraft]);

  if (!item) return null;

  const stateOptions = mergeOption(lookups.states, initialDraft.stateId, item.docketState);
  const priorityOptions = mergeOption(
    lookups.priorities.length ? lookups.priorities : fallbackLookupOptions(PRIORITIES),
    optionIdForValue(lookups.priorities, initialDraft.priority, initialDraft.priority),
    formatLabel(initialDraft.priority)
  );
  const categoryOptions = mergeOption(
    lookups.categories.length ? lookups.categories : fallbackLookupOptions(CATEGORIES),
    optionIdForValue(lookups.categories, initialDraft.category, initialDraft.category),
    formatLabel(initialDraft.category)
  );
  const userOptions = mergeOption(
    lookups.users,
    initialDraft.assigneeId,
    item.assignee
  );
  const sprintOptions = buildLocalSprintOptions(sprints);
  const parentOptions = item.type === "story" ? buildLocalEpicOptions(item, workItems) : [];
  const priorityValue = optionIdForValue(priorityOptions, draft.priority, draft.priority);
  const categoryValue = optionIdForValue(categoryOptions, draft.category, draft.category);
  const initialPriorityValue = optionIdForValue(
    priorityOptions,
    initialDraft.priority,
    initialDraft.priority
  );
  const initialCategoryValue = optionIdForValue(
    categoryOptions,
    initialDraft.category,
    initialDraft.category
  );
  const hasChanges =
    draft.title !== initialDraft.title ||
    draft.description !== initialDraft.description ||
    draft.stateId !== initialDraft.stateId ||
    priorityValue !== initialPriorityValue ||
    categoryValue !== initialCategoryValue ||
    Number(draft.storyPoints || 0) !== Number(initialDraft.storyPoints || 0) ||
    draft.assigneeId !== initialDraft.assigneeId ||
    draft.parentId !== initialDraft.parentId ||
    draft.sprintId !== initialDraft.sprintId;

  function updateDraft(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    setError("");
    setSaveState("idle");
  }

  function updateDraftFields(fields) {
    setDraft((current) => ({
      ...current,
      ...fields,
    }));
    setError("");
    setSaveState("idle");
  }

  function resetDraft() {
    setDraft(initialDraft);
    setError("");
    setSaveState("idle");
  }

  async function handleSave() {
    if (readOnly || saveState === "saving") return;

    const title = draft.title.trim();

    if (!title) {
      setError("Title is required.");
      return;
    }

    if (!validEditableParent(item, draft.parentId, workItems)) {
      setError("Choose a valid parent for this work item type.");
      return;
    }

    const localChangedFields = new Set();
    const localUpdates = {
      title,
      description: draft.description.trim(),
      docketState: localDocketStateValue(
        optionLabel(stateOptions, draft.stateId, item.docketState),
        item.docketState
      ),
      priority: priorityValue,
      category: categoryValue,
      assignee: optionLabel(userOptions, draft.assigneeId, item.assignee),
      parentId: draft.parentId,
      epicId: draft.epicId,
      sprint: optionLabel(sprintOptions, draft.sprintId, ""),
      elitical: {
        ...(item.elitical || {}),
        stateId: draft.stateId,
        assigneeId: draft.assigneeId,
        sprintId: draft.sprintId,
      },
    };
    const sdkUpdates = supportedUpdatePayloadForItem(item, {
      ...localUpdates,
      dktStateId: draft.stateId,
      dktStateName: localUpdates.docketState,
      assigneeId: draft.assigneeId,
      sprintId: draft.sprintId,
      sprintName: localUpdates.sprint,
      category: categoryValue,
      priority: priorityValue,
      parentId: draft.parentId,
      storyPoints: item.type === "story" ? Number(draft.storyPoints || 0) : undefined,
    }, { workItems, sprints });

    if (title !== initialDraft.title) {
      localChangedFields.add("title");
    }
    if (draft.description.trim() !== initialDraft.description) {
      localChangedFields.add("description");
    }
    if (draft.stateId && draft.stateId !== initialDraft.stateId) {
      localChangedFields.add("docketState");
      localChangedFields.add("elitical");
    }
    if (priorityValue !== initialPriorityValue) {
      localChangedFields.add("priority");
    }
    if (categoryValue !== initialCategoryValue) {
      localChangedFields.add("category");
    }
    if (draft.assigneeId !== initialDraft.assigneeId) {
      localChangedFields.add("assignee");
      localChangedFields.add("elitical");
    }
    if (draft.parentId !== initialDraft.parentId) {
      localChangedFields.add("parentId");
    }
    if (draft.sprintId !== initialDraft.sprintId) {
      localChangedFields.add("sprint");
      localChangedFields.add("elitical");
    }

    if (item.type === "story") {
      const storyPoints = Number(draft.storyPoints || 0);

      localUpdates.storyPoints = storyPoints;

      if (storyPoints !== Number(initialDraft.storyPoints || 0)) {
        localChangedFields.add("storyPoints");
      }
    }

    setSaveState("saving");

    const result = await onSave(item, {
      sdkUpdates,
      localUpdates,
      localChangedFields: Array.from(localChangedFields),
    });

    if (!result.ok) {
      setSaveState("failed");
      setError(result.error);
      return;
    }

    setSaveState("saved");
  }

  return (
    <aside className="worklog-panel" aria-label="Property panel">
      <div className="worklog-panel-card">
        <header>
          <div>
            <span className="modal-kicker">{formatType(item.type)}</span>
            <h2>{item.title}</h2>
            <p>Local properties</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            x
          </button>
        </header>

        <section className="worklog-panel-section">
          <ModalSection title="Basic Information">
            <TextField
              label="Title"
              value={draft.title}
              onChange={(value) => updateDraft("title", value)}
            />
            <TextAreaField
              label="Description"
              value={draft.description}
              onChange={(value) => updateDraft("description", value)}
              wide
            />
          </ModalSection>

          <ModalSection title="Workflow">
            <CustomSelectField
              label="Status"
              value={draft.stateId}
              options={stateOptions.map((option) => option.id)}
              onChange={(value) => updateDraft("stateId", value)}
              getOptionLabel={(value) => optionLabel(stateOptions, value, formatLabel(value))}
            />
            <CustomSelectField
              label="Priority"
              value={priorityValue}
              options={priorityOptions.map((option) => option.id)}
              onChange={(value) => updateDraft("priority", value)}
              getOptionLabel={(value) => optionLabel(priorityOptions, value, formatLabel(value))}
            />
            <CustomSelectField
              label="Category"
              value={categoryValue}
              options={categoryOptions.map((option) => option.id)}
              onChange={(value) => updateDraft("category", value)}
              getOptionLabel={(value) => optionLabel(categoryOptions, value, formatLabel(value))}
            />
            {item.type === "story" && (
              <TextField
                label="Story Points"
                type="number"
                value={draft.storyPoints}
                onChange={(value) => updateDraft("storyPoints", value)}
              />
            )}
            <CustomSelectField
              label="Assignee"
              value={draft.assigneeId}
              options={userOptions.map((option) => option.id)}
              onChange={(value) => updateDraft("assigneeId", value)}
              getOptionLabel={(value) => optionLabel(userOptions, value, item.assignee)}
              wide
            />
          </ModalSection>

          <ModalSection title="Hierarchy">
            <ReadOnlyField label="Type" value={formatType(item.type)} />
            {parentOptions.length > 0 ? (
              <CustomSelectField
                label="Parent"
                value={draft.parentId}
                options={parentOptions.map((option) => option.id)}
                onChange={(value) => {
                  const selectedEpic = parentOptions.find((option) => option.id === value);
                  updateDraftFields({
                    parentId: value,
                    epicId: selectedEpic?.remoteId || value,
                  });
                }}
                getOptionLabel={(value) => optionLabel(parentOptions, value, parentLabel(value, workItems))}
                wide
              />
            ) : (
              <ReadOnlyField label="Parent" value={parentLabel(draft.parentId, workItems)} />
            )}
            <CustomSelectField
              label="Sprint"
              value={draft.sprintId}
              options={sprintOptions.map((option) => option.id)}
              onChange={(value) => updateDraft("sprintId", value)}
              getOptionLabel={(value) => optionLabel(sprintOptions, value, persistedSprintLabel)}
              wide
            />
          </ModalSection>

          {error && <p className="modal-error">{error}</p>}
        </section>

        {!readOnly && (
          <footer className="modal-footer">
            <div className="modal-footer-danger" />
            <div className="modal-footer-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={resetDraft}
                disabled={!hasChanges || saveState === "saving"}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!hasChanges || saveState === "saving"}
              >
                {saveState === "saving" ? "Saving..." : "Save"}
              </button>
            </div>
          </footer>
        )}
      </div>
    </aside>
  );
}

const WORKLOG_DURATION_OPTIONS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "45m", minutes: 45 },
  { label: "1h", minutes: 60 },
  { label: "1h30m", minutes: 90 },
  { label: "2h", minutes: 120 },
];

function WorklogPanelField({ label, value }) {
  return (
    <div className="worklog-panel-field">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function normalizePanelWorklog(entry = {}) {
  const date = entry.date || entry.worklogDate || "";
  const durationMinutes = Number(entry.durationMinutes ?? entry.timeMinutes ?? 0);

  return {
    ...entry,
    date,
    durationMinutes: Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : 0,
    description: String(entry.description || entry.comment || ""),
    employeeName: String(entry.employeeName || ""),
  };
}

function sortWorklogsNewestFirst(entries = []) {
  return [...entries]
    .map(normalizePanelWorklog)
    .sort((first, second) => {
      const firstTime = new Date(first.date || 0).getTime() || 0;
      const secondTime = new Date(second.date || 0).getTime() || 0;

      return secondTime - firstTime;
    });
}

function worklogPanelHierarchy(item, itemById) {
  const parent = itemById.get(item.parentId);

  if (item.type === "job") {
    const story = parent?.type === "story" ? parent : null;
    const epic = story ? itemById.get(story.parentId) : parent?.type === "epic" ? parent : null;

    return { epic, story };
  }

  if (item.type === "task") {
    const story = parent?.type === "story" ? parent : null;
    const epic = story ? itemById.get(story.parentId) : parent?.type === "epic" ? parent : null;

    return { epic, story };
  }

  if (item.type === "story") {
    return {
      epic: parent?.type === "epic" ? parent : null,
      story: item,
    };
  }

  return { epic: null, story: null };
}

function WorklogPanel({ item, workItems, onClose, readOnly = false }) {
  const [date, setDate] = useState(formatDateInput(new Date()));
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [customDuration, setCustomDuration] = useState("");
  const [description, setDescription] = useState("");
  const [history, setHistory] = useState([]);
  const [pending, setPending] = useState([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const itemById = useMemo(
    () => new Map(workItems.map((item) => [item.id, item])),
    [workItems]
  );
  const { epic, story } = useMemo(
    () => worklogPanelHierarchy(item, itemById),
    [item, itemById]
  );
  const sortedHistory = useMemo(
    () => sortWorklogsNewestFirst(history),
    [history]
  );
  const totalLoggedMinutes = useMemo(
    () =>
      sortedHistory.reduce(
        (total, entry) => total + Number(entry.durationMinutes || 0),
        0
      ),
    [sortedHistory]
  );

  const loggedMinutes = useMemo(
    () =>
      (item.worklogs || []).reduce(
        (total, entry) => total + Number(entry.timeMinutes || 0),
        0
      ),
    [item.worklogs]
  );

  const remainingMinutes = Math.max(0, Number(item.timeMinutes || 0) - loggedMinutes);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setDraftLoaded(false);
    setError("");
    setStatusMessage("");
    setDate(formatDateInput(new Date()));
    setDurationMinutes(0);
    setCustomDuration("");
    setDescription("");

    if (readOnly) {
      setHistory(item.worklogs || []);
      setPending([]);
      setLoading(false);
      setDraftLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    loadJobWorklogState(item.id)
      .then((state) => {
        if (cancelled) return;

        const draft = state.draft;

        if (draft) {
          setDate(draft.date || formatDateInput(new Date()));
          setDurationMinutes(Number(draft.durationMinutes || 0));
          setDescription(draft.description || "");
        }

        setPending(state.pending || []);
        setHistory(
          Array.isArray(state.history) && state.history.length > 0
            ? state.history
            : item.worklogs || []
        );
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError.message || "Unable to load worklog data.");
          setHistory(item.worklogs || []);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setDraftLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [item.id, item.worklogs, readOnly]);

  useEffect(() => {
    if (!draftLoaded || readOnly) return undefined;

    const handle = window.setTimeout(() => {
      saveJobWorklogDraft(item.id, {
        date,
        durationMinutes,
        description,
      }).catch((requestError) => {
        setError(requestError.message || "Unable to save draft.");
      });
    }, 650);

    return () => window.clearTimeout(handle);
  }, [date, description, draftLoaded, durationMinutes, item.id, readOnly]);

  const saveDraft = useCallback(async () => {
    setError("");
    const result = await saveJobWorklogDraft(item.id, {
      date,
      durationMinutes,
      description,
    });
    setStatusMessage(`Draft saved ${formatTimestamp(result.draft?.updatedAt)}`);
  }, [date, description, durationMinutes, item.id]);

  const clearDraft = useCallback(async () => {
    setError("");
    await clearJobWorklogDraft(item.id);
    setDate(formatDateInput(new Date()));
    setDurationMinutes(0);
    setCustomDuration("");
    setDescription("");
    setStatusMessage("Draft cleared");
  }, [item.id]);

  const submitWorklog = useCallback(async () => {
    if (!durationMinutes) {
      setError("Duration is required.");
      return;
    }

    if (!description.trim()) {
      setError("Description is required.");
      return;
    }

    setSubmitting(true);
    setError("");
    setStatusMessage("");

    try {
      const result = await submitJobWorklog(item.id, {
        date,
        durationMinutes,
        description,
      });
      setDate(formatDateInput(new Date()));
      setDurationMinutes(0);
      setCustomDuration("");
      setDescription("");
      setPending((current) => [result.entry, ...current]);
      setHistory((current) => [result.entry, ...current]);
      setStatusMessage(result.message || "Pending Upload");
    } catch (requestError) {
      setError(requestError.message || "Unable to submit worklog.");
    } finally {
      setSubmitting(false);
    }
  }, [date, description, durationMinutes, item.id]);

  const selectDuration = useCallback((minutes) => {
    setDurationMinutes(minutes);
    setCustomDuration("");
  }, []);

  const updateCustomDuration = useCallback((value) => {
    setCustomDuration(value);
    setDurationMinutes(Number(value || 0));
  }, []);

  return (
    <aside className="worklog-side-panel" aria-label={`${formatType(item.type)} details and worklog`}>
      <header className="worklog-panel-header">
        <div>
          <span>{formatType(item.type)} Details</span>
          <h2>{item.elitical?.num || item.id}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close worklog panel">
          x
        </button>
      </header>

      <div className="worklog-panel-scroll">
        <section className="worklog-panel-section">
          <h3>{item.title || `Untitled ${formatType(item.type)}`}</h3>
          <div className="worklog-panel-grid">
            <WorklogPanelField label="Epic" value={epic?.title} />
            {item.type !== "story" && <WorklogPanelField label="Story" value={story?.title} />}
            <WorklogPanelField label="Sprint" value={item.sprint} />
            <WorklogPanelField label="Current Status" value={formatDocketState(item.docketState)} />
            <WorklogPanelField label="Priority" value={formatLabel(item.priority)} />
            {item.type === "story" && (
              <WorklogPanelField label="Story Points" value={item.storyPoints ?? 0} />
            )}
            <WorklogPanelField label="Assignee" value={item.assignee} />
            <WorklogPanelField label="Reviewer" value={item.reviewer || item.reviewerName} />
            <WorklogPanelField label="Created Date" value={formatTimestamp(item.createdAt)} />
            <WorklogPanelField label="Updated Date" value={formatTimestamp(item.updatedAt)} />
            <WorklogPanelField label="Logged" value={formatWorkTime(loggedMinutes)} />
            <WorklogPanelField label="Remaining" value={formatWorkTime(remainingMinutes)} />
          </div>
          <div className="worklog-panel-description">
            <span>Description</span>
            <p>{item.description || "-"}</p>
          </div>
        </section>

        {!readOnly && (
        <section className="worklog-panel-section">
          <div className="worklog-panel-section-title">
            <h3>Worklog</h3>
            {loading && <span>Loading...</span>}
          </div>

          <label className="worklog-panel-input">
            <span>Date</span>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>

          <div className="worklog-panel-input">
            <span>Duration</span>
            <div className="worklog-duration-grid">
              {WORKLOG_DURATION_OPTIONS.map((option) => (
                <button
                  key={option.minutes}
                  type="button"
                  className={durationMinutes === option.minutes ? "active" : ""}
                  onClick={() => selectDuration(option.minutes)}
                >
                  {option.label}
                </button>
              ))}
              <label className="worklog-custom-duration">
                <span>Custom</span>
                <input
                  type="number"
                  min="1"
                  step="15"
                  value={customDuration}
                  placeholder="min"
                  onChange={(event) => updateCustomDuration(event.target.value)}
                />
              </label>
            </div>
          </div>

          <label className="worklog-panel-input">
            <span>Description</span>
            <textarea
              rows="7"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What did you work on?"
            />
          </label>

          {error && <p className="worklog-panel-error">{error}</p>}
          {statusMessage && <p className="worklog-panel-status">{statusMessage}</p>}

          <div className="worklog-panel-actions">
            <button type="button" onClick={saveDraft}>
              Save Draft
            </button>
            <button
              type="button"
              className="primary"
              onClick={submitWorklog}
              disabled={submitting}
            >
              {submitting ? "Submitting..." : "Submit Worklog"}
            </button>
            <button type="button" onClick={clearDraft}>
              Clear
            </button>
          </div>
        </section>
        )}

        <section className="worklog-panel-section">
          <div className="worklog-panel-section-title">
            <h3>Worklogs ({sortedHistory.length})</h3>
            <span>Logged {formatWorkTime(totalLoggedMinutes)}</span>
          </div>
          {sortedHistory.length === 0 ? (
            <p className="worklog-empty">No worklogs yet.</p>
          ) : (
            <div className="worklog-history-list">
              {sortedHistory.map((entry) => (
                <article key={entry.id || `${entry.date}-${entry.description}`} className="worklog-history-entry">
                  <div>
                    <strong>{formatDateLabel(entry.date)}</strong>
                    <span>{formatWorkTime(entry.durationMinutes)}</span>
                    <span>{entry.employeeName || "Unknown employee"}</span>
                    {entry.status === "pending" && <em>Pending Upload</em>}
                  </div>
                  <p>{entry.description || "No comment"}</p>
                </article>
              ))}
            </div>
          )}
          {pending.length > 0 && (
            <p className="worklog-panel-note">
              {pending.length} pending upload{pending.length === 1 ? "" : "s"} will stay queued until the Elitical upload endpoint is connected.
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <CustomSelectField
      label={label}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function WorkItemModal({
  modal,
  mainTitle,
  rootTitle,
  rootDocketState,
  sprints,
  workItems,
  totals,
  onClose,
  onSaveMain,
  onSaveRoot,
  onSaveSprint,
  onSaveItem,
  onCreateItem,
  onDeleteItem,
  onSetView,
  readOnly = false,
}) {
  const [mode, setMode] = useState(
    modal.kind === "create" ? "edit" : "view"
  );
  const [editingField, setEditingField] = useState(null);
  const isMainRoot =
    modal.kind === "details" && modal.id === MAIN_ROOT_ID;
  const activeSprint =
    modal.kind === "details" && modal.id !== ROOT_ID
      ? sprints.find((sprint) => sprint.id === modal.id)
      : null;
  const activeItem =
    modal.kind === "details" &&
    modal.id !== ROOT_ID &&
    modal.id !== MAIN_ROOT_ID &&
    !activeSprint
      ? workItems.find((item) => item.id === modal.id)
      : null;
  const isRoot =
    modal.kind === "details" && modal.id === ROOT_ID;
  const isSprint = isRoot || Boolean(activeSprint);
  const itemType = isMainRoot
    ? "main-root"
    : isSprint
    ? "story-root"
    : modal.kind === "create"
    ? modal.type
    : activeItem?.type;
  const sprintParentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
  const createSprintParent =
    modal.kind === "create"
      ? sprints.find((sprint) => sprint.id === modal.parentId)
      : null;
  const fallbackSprint = modal.kind === "create" && modal.sprint
    ? modal.sprint
    : createSprintParent
    ? createSprintParent.title
    : isSprint || isMainRoot
    ? rootTitle
    : inheritedSprint(sprintParentId, workItems, rootTitle);
  const fallbackDocketState = modal.kind === "create" && modal.docketState
    ? modal.docketState
    : createSprintParent
    ? createSprintParent.docketState || rootDocketState || "concept"
    : isSprint
    ? rootDocketState || "concept"
    : isMainRoot
    ? "concept"
    : inheritedDocketState(sprintParentId, workItems, rootDocketState);
  const initialDraft =
    modal.kind === "create"
      ? makeCreateDraft(modal.type, fallbackSprint, fallbackDocketState)
      : isMainRoot
      ? { title: mainTitle || "Genesis" }
      : isRoot
      ? { title: rootTitle, docketState: rootDocketState || "concept" }
      : activeSprint
      ? makeSprintDraft(activeSprint, rootTitle, rootDocketState)
      : activeItem
      ? makeEditDraft(activeItem, fallbackSprint)
      : null;
  const [draft, setDraft] = useState(initialDraft);
  const editedDraftFieldsRef = useRef(new Set());
  const commitInFlightRef = useRef(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const isEditing = mode === "edit";
  const parentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
  const createTypeOptions =
    modal.kind === "create"
      ? createTypesForParent(parentId, workItems, sprints)
      : [];
  const selectedItemType =
    modal.kind === "create" ? draft?.type || modal.type : itemType;
  const currentCategory = activeItem?.category || draft?.category || "feature";
  const currentPriority = activeItem?.priority || draft?.priority || "info";
  const currentDocketState = isRoot
    ? rootDocketState || "concept"
    : activeSprint
    ? activeSprint.docketState || "concept"
    : isMainRoot
    ? "concept"
    : activeItem?.docketState || draft?.docketState || "concept";
  const currentSprint = isSprint || isMainRoot
    ? rootTitle
    : activeItem?.sprint || draft?.sprint || fallbackSprint;
  const modalStateOptions = activeItem ? mergeOption(
    buildLocalStateOptions(activeItem, workItems),
    draft?.stateId || "",
    draft?.stateName || currentDocketState
  ) : [];
  const modalAssigneeOptions = activeItem ? mergeOption(
    buildLocalAssigneeOptions(activeItem, workItems),
    draft?.assigneeId || "",
    draft?.assigneeName || activeItem.assignee
  ) : [];
  const modalSprintOptions = buildLocalSprintOptions(sprints);
  const modalEpicOptions = activeItem?.type === "story"
    ? buildLocalEpicOptions(activeItem, workItems)
    : [];
  const hasWorklog = acceptsTime(selectedItemType);
  const contextLabel =
    modal.kind === "create"
      ? `Create ${formatType(selectedItemType)}`
      : isMainRoot
      ? "Main"
      : isSprint
      ? "Sprint"
      : `${formatType(activeItem?.type).toUpperCase()} · ${formatLabel(
          currentCategory
        ).toUpperCase()}`;

  useEffect(() => {
    setDraft(initialDraft);
    editedDraftFieldsRef.current.clear();
    commitInFlightRef.current = false;
    setError("");
    setSaveState("idle");
    setEditingField(null);
    setMode(modal.kind === "create" ? "edit" : "view");
  }, [modal.id, modal.kind]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") discardAndClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (
    !draft ||
    (
      modal.kind === "details" &&
      !isMainRoot &&
      !isSprint &&
      !activeItem
    )
  ) {
    return null;
  }

  function updateDraft(field, value) {
    editedDraftFieldsRef.current.add(field);
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    setError("");
  }

  function updateDraftFields(fields) {
    Object.keys(fields || {}).forEach((field) => editedDraftFieldsRef.current.add(field));
    setDraft((current) => ({
      ...current,
      ...fields,
    }));
    setError("");
  }

  useEffect(() => {
    if (modal.kind !== "details" || !activeItem || !acceptsTime(activeItem.type)) return;

    const primaryWorklog = Array.isArray(activeItem.worklogs)
      ? activeItem.worklogs[0]
      : null;

    if (!primaryWorklog) return;

    const updates = {
      worklogDate: formatDateInput(
        primaryWorklog.date ||
          primaryWorklog.worklogDate ||
          activeItem.updatedAt ||
          activeItem.createdAt
      ),
      time: formatTimeInput(
        durationMinutesForWorklogDraft(primaryWorklog, activeItem)
      ),
      worklogDescription:
        primaryWorklog.description || primaryWorklog.comment || "",
    };

    setDraft((current) => {
      if (!current) return current;

      const editedFields = editedDraftFieldsRef.current;
      let changed = false;
      const next = { ...current };

      Object.entries(updates).forEach(([field, value]) => {
        if (editedFields.has(field) || current[field] === value) return;
        next[field] = value;
        changed = true;
      });

      return changed ? next : current;
    });
  }, [activeItem, modal.kind]);

  function startInlineEdit(field) {
    if (readOnly || saveState === "saving") return;
    if (modal.kind !== "details") return;
    setMode("view");
    setEditingField(field);
  }

  function finishInlineEdit() {
    setEditingField(null);
  }

  function updateWorklogTimePart(part, value) {
    const [currentHours, currentMinutes] = String(draft.time || "00:00")
      .split(":")
      .map((entry) => Number(entry));
    const nextHours = part === "hour" ? Number(value || 0) : currentHours || 0;
    const nextMinutes = part === "min" ? Number(value || 0) : currentMinutes || 0;

    updateDraft(
      "time",
      `${String(Math.max(0, nextHours)).padStart(2, "0")}:${String(Math.max(0, Math.min(59, nextMinutes))).padStart(2, "0")}`
    );
  }

  function worklogTimePart(part) {
    const [hours, minutes] = String(draft.time || "00:00").split(":");

    return part === "hour" ? String(Number(hours || 0)) : String(Number(minutes || 0));
  }

  function primaryWorklogPayload() {
    if (!hasWorklog) return undefined;
    if (!isMeaningfulWorklogDraft(draft)) return undefined;

    const otherWorklogs =
      modal.kind === "details" && Array.isArray(activeItem?.worklogs)
        ? activeItem.worklogs.slice(1)
        : [];
    const worklog = worklogDraftFromFields(draft);

    return [
      {
        id: worklog.id,
        date: dateInputToIso(worklog.worklogDate, worklog.worklogDate),
        worklogDate: dateInputToIso(worklog.worklogDate, worklog.worklogDate),
        description: worklog.comment,
        comment: worklog.comment,
        hour: worklog.hour,
        min: worklog.min,
        timeMinutes: worklog.hour * 60 + worklog.min,
      },
      ...otherWorklogs,
    ];
  }

  async function commitModalDraft({ closeAfterCommit = false } = {}) {
    if (readOnly) return;
    if (commitInFlightRef.current || saveState === "saving") return;

    if (!draft.title.trim()) {
      setError("Title is required.");
      return;
    }

    if (isMainRoot) {
      if (modal.kind === "details" && editedDraftFieldsRef.current.size === 0) {
        if (closeAfterCommit) onClose();
        return;
      }

      const result = onSaveMain({
        title: draft.title,
      });
      if (result.ok) {
        editedDraftFieldsRef.current.clear();
        setMode("view");
        setEditingField(null);
        if (closeAfterCommit) onClose();
      } else {
        setError(result.error);
      }
      return;
    }

    if (isSprint) {
      if (modal.kind === "details" && editedDraftFieldsRef.current.size === 0) {
        if (closeAfterCommit) onClose();
        return;
      }

      const result = isRoot ? onSaveRoot({
        title: draft.title,
        docketState: draft.docketState,
      }) : onSaveSprint(activeSprint.id, {
        title: draft.title,
        docketState: draft.docketState,
        code: draft.code,
        sprintStartDate: draft.sprintStartDate,
        sprintEndDate: draft.sprintEndDate,
        sprintState: draft.sprintState,
        state: draft.state,
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        updatedBy: draft.updatedBy,
        updatedAt: draft.updatedAt,
      });
      if (result.ok) {
        editedDraftFieldsRef.current.clear();
        setMode("view");
        setEditingField(null);
        if (closeAfterCommit) onClose();
      }
      else setError(result.error);
      return;
    }

    const payload = {
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      sprint: draft.sprint.trim() || fallbackSprint,
      sprintId: modal.kind === "create" ? modal.sprintId || "" : draft.sprintId || "",
      isOrphanSprint: modal.kind === "create" ? Boolean(modal.isOrphanSprint) : false,
      docketState: draft.docketState || "concept",
      type: selectedItemType,
      createdAt:
        modal.kind === "create" && selectedItemType === "epic"
          ? draft.createdAt || modal.worklogDate
          : draft.createdAt,
      updatedAt:
        modal.kind === "create" && selectedItemType === "epic"
          ? draft.updatedAt || draft.createdAt || modal.worklogDate
          : draft.updatedAt,
      storyPoints:
        selectedItemType === "story"
          ? Number(draft.storyPoints || 0)
          : undefined,
      timeMinutes: acceptsTime(selectedItemType)
        ? parseTimeInput(draft.time)
        : undefined,
      worklogs: primaryWorklogPayload(),
      worklog:
        hasWorklog && isMeaningfulWorklogDraft(draft)
          ? worklogDraftFromFields(draft)
          : undefined,
    };

    if (hasWorklog && isMeaningfulWorklogDraft(draft)) {
      const worklogValidationError = validateWorklogDraft(draft);

      if (worklogValidationError) {
        setError(worklogValidationError);
        return;
      }
    }

    if (modal.kind === "create") {
      const validationError = validateCreatePayload(
        {
          ...payload,
          parentId: modal.parentId,
        },
        workItems,
        sprints
      );

      if (validationError) {
        setError(validationError);
        return;
      }
    }

    if (modal.kind === "details" && editedDraftFieldsRef.current.size === 0) {
      if (closeAfterCommit) onClose();
      return;
    }

    commitInFlightRef.current = true;
    setSaveState("saving");

    const result = await Promise.resolve(
      modal.kind === "create"
        ? onCreateItem({
            ...payload,
            parentId: modal.parentId,
          })
        : onSaveItem(activeItem.id, {
            ...payload,
            parentId: activeItem.type === "story"
              ? draft.parentId || activeItem.parentId
              : activeItem.parentId,
          })
    );

    if (!result.ok) {
      commitInFlightRef.current = false;
      setSaveState("failed");
      setError(result.error);
      return;
    }

    setSaveState("saved");
    editedDraftFieldsRef.current.clear();
    commitInFlightRef.current = false;

    if (modal.kind === "create") {
      onClose();
      return;
    }

    setMode("view");
    setEditingField(null);
    if (closeAfterCommit) onClose();
  }

  function handleSave() {
    return commitModalDraft({ closeAfterCommit: modal.kind === "details" });
  }

  function discardAndClose() {
    editedDraftFieldsRef.current.clear();
    setDraft(
      isMainRoot
        ? { title: mainTitle || "Genesis" }
        : isRoot
        ? { title: rootTitle, docketState: rootDocketState || "concept" }
        : activeSprint
        ? makeSprintDraft(activeSprint, rootTitle, rootDocketState)
        : makeEditDraft(activeItem, fallbackSprint)
    );
    setError("");
    setSaveState("idle");
    setMode("view");
    setEditingField(null);
    commitInFlightRef.current = false;
    onClose();
  }

  function handleCancel() {
    discardAndClose();
  }

  function handleBackdropMouseDown(event) {
    if (event.target !== event.currentTarget) return;

    if (readOnly) {
      discardAndClose();
      return;
    }

    if (modal.kind === "details") {
      commitModalDraft({ closeAfterCommit: true });
      return;
    }

    discardAndClose();
  }

  function handleDelete() {
    if (readOnly) return;
    if (!activeItem) return;

    const childCount = descendantCount(workItems, activeItem.id);

    if (
      childCount > 0 &&
      !window.confirm(
        `${activeItem.title} has ${childCount} child item${
          childCount === 1 ? "" : "s"
        }. Delete it and all children?`
      )
    ) {
      return;
    }

    const result = onDeleteItem(activeItem);
    if (result?.ok !== false) onClose();
  }

  const calculatedSp = isSprint || isMainRoot
    ? totals.rootTotal
    : activeItem?.type === "epic"
    ? totals.byId[activeItem.id] || 0
    : null;
  const calculatedTime = isSprint || isMainRoot
    ? totals.rootTimeMinutes || 0
    : activeItem
    ? totals.timeById[activeItem.id] || 0
    : 0;
  const headerSummary = modal.kind === "create"
    ? `${formatType(selectedItemType)} · ${parentLabel(parentId, workItems)}`
    : isMainRoot
    ? `${sprints.length} Sprint${sprints.length === 1 ? "" : "s"} · ${
        totals.rootTotal
      } SP · ${formatWorkTime(totals.rootTimeMinutes || 0)}`
    : isSprint
    ? `${formatDocketState(currentDocketState)} · ${
        totals.rootTotal
      } SP · ${formatWorkTime(totals.rootTimeMinutes || 0)}`
    : `${formatLabel(currentPriority)} · ${formatDocketState(
        currentDocketState
      )} · ${formatWorkTime(calculatedTime)}`;
  const showFooter = !readOnly && (modal.kind === "create" || modal.kind === "details");

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <section
        className={`modal-card ${isEditing ? "modal-card-edit" : "modal-card-view"}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-header-main">
            <span className="modal-kicker">{contextLabel}</span>
            <h2>
              {modal.kind === "create"
                ? "New work item"
                : isMainRoot
                ? mainTitle || "Genesis"
                : isRoot
                ? rootTitle
                : activeSprint
                ? activeSprint.title
                : activeItem.title}
            </h2>
            <p>{headerSummary}</p>
          </div>
          <div className="modal-header-actions">
            {modal.kind === "details" && activeItem && (
              <button
                type="button"
                onClick={() => {
                  onSetView(activeItem.id);
                  discardAndClose();
                }}
              >
                Set View
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={discardAndClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="modal-body">
          {modal.kind === "details" && activeItem && !readOnly && (
            modalStateOptions.length > 0 ? (
              <CustomSelectField
                label="Docket State"
                value={draft.stateId || ""}
                options={modalStateOptions.map((option) => option.id)}
                onChange={(value) => {
                  const stateName = optionLabel(modalStateOptions, value, currentDocketState);
                  updateDraftFields({
                    stateId: value,
                    stateName,
                    docketState: localDocketStateValue(stateName, currentDocketState),
                  });
                }}
                getOptionLabel={(value) => optionLabel(modalStateOptions, value, currentDocketState)}
                wide
              />
            ) : (
              <ReadOnlyField label="Docket State" value={currentDocketState} wide />
            )
          )}

          {!isEditing ? (
            <div className="modal-sections">
              {isMainRoot ? (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                      onCommit={finishInlineEdit}
                      wide
                    />
                  </ModalSection>
                  <ModalSection title="Rollup">
                    <ReadOnlyField
                      label="Sprints"
                      value={String(sprints.length)}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Story Points"
                      value={`${totals.rootTotal} SP`}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Time"
                      value={formatWorkTime(totals.rootTimeMinutes || 0)}
                      badge
                    />
                  </ModalSection>
                </>
              ) : isSprint ? (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                      onCommit={finishInlineEdit}
                      wide
                    />
                    {activeSprint && (
                      <>
                        <ReadOnlyField label="Code" value={draft.code} />
                        <ReadOnlyField
                          label="Sprint Start Date"
                          value={formatDateLabel(draft.sprintStartDate)}
                        />
                        <ReadOnlyField
                          label="Sprint End Date"
                          value={formatDateLabel(draft.sprintEndDate)}
                        />
                        <ReadOnlyField
                          label="Sprint State"
                          value={draft.sprintState}
                          badge
                        />
                        <ReadOnlyField label="State" value={draft.state} badge />
                      </>
                    )}
                  </ModalSection>
                  {activeSprint && (
                    <section className="modal-section modal-section-untitled">
                      <div className="modal-section-grid">
                        <ReadOnlyField label="Created By" value={draft.createdBy} />
                        <ReadOnlyField
                          label="Created At"
                          value={formatTimestamp(activeSprint.createdAt)}
                        />
                        <ReadOnlyField label="Updated By" value={draft.updatedBy} />
                        <ReadOnlyField
                          label="Updated At"
                          value={formatTimestamp(activeSprint.updatedAt)}
                        />
                      </div>
                    </section>
                  )}
                  <ModalSection title="Effort & Time">
                    <ReadOnlyField
                      label="Calculated Story Points"
                      value={`${totals.rootTotal} SP`}
                      badge
                    />
                    <ReadOnlyField
                      label="Calculated Time"
                      value={formatWorkTime(totals.rootTimeMinutes || 0)}
                      badge
                    />
                  </ModalSection>
                </>
              ) : (
                <>
                  <ModalSection title="Basic Information">
                    <InlineField
                      label="Title"
                      field="title"
                      value={draft.title}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("title", value)}
                      onCommit={finishInlineEdit}
                    />
                    <InlineField
                      label="Description"
                      field="description"
                      value={draft.description}
                      type="textarea"
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) =>
                        updateDraft("description", value)
                      }
                      onCommit={finishInlineEdit}
                    />
                  </ModalSection>
                  {hasWorklog && (
                    <ModalSection title="Worklog" className="worklog-section">
                      <TextField
                        label="Worklog Date"
                        type="date"
                        value={draft.worklogDate}
                        onChange={(value) => updateDraft("worklogDate", value)}
                      />
                      <TextField
                        label="Hours"
                        type="number"
                        value={worklogTimePart("hour")}
                        onChange={(value) => updateWorklogTimePart("hour", value)}
                      />
                      <TextField
                        label="Minutes"
                        type="number"
                        value={worklogTimePart("min")}
                        onChange={(value) => updateWorklogTimePart("min", value)}
                      />
                      <TextAreaField
                        label="Comment"
                        value={draft.worklogDescription}
                        onChange={(value) =>
                          updateDraft("worklogDescription", value)
                        }
                        wide
                      />
                    </ModalSection>
                  )}
                  <ModalSection title="Workflow">
                    <InlineField
                      label="Category"
                      field="category"
                      value={draft.category}
                      type="select"
                      options={CATEGORIES}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("category", value)}
                      badge
                    />
                    <InlineField
                      label="Priority"
                      field="priority"
                      value={draft.priority}
                      type="select"
                      options={PRIORITIES}
                      editingField={editingField}
                      onEdit={startInlineEdit}
                      onChange={(value) => updateDraft("priority", value)}
                      badge
                    />
                    {activeItem.type === "story" && (
                      <InlineField
                        label="Story Points"
                        field="storyPoints"
                        value={draft.storyPoints}
                        type="number"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("storyPoints", value)}
                        onCommit={finishInlineEdit}
                        badge
                      />
                    )}
                  </ModalSection>
                  <ModalSection title="Hierarchy">
                    <ReadOnlyField
                      label="Type"
                      value={formatType(activeItem.type)}
                    />
                    {activeItem.type === "story" && modalEpicOptions.length > 0 ? (
                      <CustomSelectField
                        label="Epic"
                        value={draft.parentId || activeItem.parentId}
                        options={modalEpicOptions.map((option) => option.id)}
                        onChange={(value) => {
                          const selectedEpic = modalEpicOptions.find((option) => option.id === value);
                          updateDraftFields({
                            parentId: value,
                            epicId: selectedEpic?.remoteId || value,
                          });
                        }}
                        getOptionLabel={(value) => optionLabel(modalEpicOptions, value, parentLabel(value, workItems))}
                        wide
                      />
                    ) : (
                      <ReadOnlyField
                        label={parentFieldLabel(activeItem.parentId, workItems)}
                        value={parentLabel(activeItem.parentId, workItems)}
                      />
                    )}
                    {modalSprintOptions.length > 0 ? (
                      <CustomSelectField
                        label="Sprint"
                        value={draft.sprintId || ""}
                        options={modalSprintOptions.map((option) => option.id)}
                        onChange={(value) => {
                          const sprintName = optionLabel(modalSprintOptions, value, currentSprint);
                          updateDraftFields({
                            sprintId: value,
                            sprintName,
                            sprint: sprintName,
                          });
                        }}
                        getOptionLabel={(value) => optionLabel(modalSprintOptions, value, currentSprint)}
                      />
                    ) : (
                      <ReadOnlyField label="Sprint" value={currentSprint} />
                    )}
                    {modalAssigneeOptions.length > 0 ? (
                      <CustomSelectField
                        label="Assignee"
                        value={draft.assigneeId || ""}
                        options={modalAssigneeOptions.map((option) => option.id)}
                        onChange={(value) => {
                          const assigneeName = optionLabel(modalAssigneeOptions, value, activeItem.assignee);
                          updateDraftFields({
                            assigneeId: value,
                            assigneeName,
                            assignee: assigneeName,
                          });
                        }}
                        getOptionLabel={(value) => optionLabel(modalAssigneeOptions, value, activeItem.assignee)}
                        wide
                      />
                    ) : (
                      activeItem.assignee && <ReadOnlyField label="Assignee" value={activeItem.assignee} />
                    )}
                  </ModalSection>
                  <section className="modal-section modal-section-untitled">
                    <div className="modal-section-grid">
                      {activeItem.createdBy && (
                        <ReadOnlyField label="Created By" value={activeItem.createdBy} />
                      )}
                      <ReadOnlyField
                        label="Created At"
                        value={formatTimestamp(activeItem.createdAt)}
                      />
                      {activeItem.updatedBy && (
                        <ReadOnlyField label="Updated By" value={activeItem.updatedBy} />
                      )}
                      <ReadOnlyField
                        label="Updated At"
                        value={formatTimestamp(activeItem.updatedAt)}
                      />
                    </div>
                  </section>
                </>
              )}
            </div>
          ) : (
            <div className="modal-sections">
              <ModalSection title="Basic Information">
                <TextField
                  label="Title"
                  value={draft.title}
                  onChange={(value) => updateDraft("title", value)}
                />

                {activeSprint && (
                  <>
                    <TextField
                      label="Code"
                      value={draft.code}
                      onChange={(value) => updateDraft("code", value)}
                    />
                    <TextField
                      label="Sprint Start Date"
                      type="date"
                      value={draft.sprintStartDate}
                      onChange={(value) => updateDraft("sprintStartDate", value)}
                    />
                    <TextField
                      label="Sprint End Date"
                      type="date"
                      value={draft.sprintEndDate}
                      onChange={(value) => updateDraft("sprintEndDate", value)}
                    />
                    <TextField
                      label="Sprint State"
                      value={draft.sprintState}
                      onChange={(value) => updateDraft("sprintState", value)}
                    />
                    <TextField
                      label="State"
                      value={draft.state}
                      onChange={(value) => updateDraft("state", value)}
                    />
                    <TextField
                      label="Created By"
                      value={draft.createdBy}
                      onChange={(value) => updateDraft("createdBy", value)}
                    />
                    <TextField
                      label="Created Time"
                      type="datetime-local"
                      value={draft.createdAt}
                      onChange={(value) => updateDraft("createdAt", value)}
                    />
                    <TextField
                      label="Updated By"
                      value={draft.updatedBy}
                      onChange={(value) => updateDraft("updatedBy", value)}
                    />
                    <TextField
                      label="Updated Time"
                      type="datetime-local"
                      value={draft.updatedAt}
                      onChange={(value) => updateDraft("updatedAt", value)}
                    />
                  </>
                )}

                {!isSprint && !isMainRoot && (
                  <TextAreaField
                    label="Description"
                    value={draft.description}
                    onChange={(value) => updateDraft("description", value)}
                  />
                )}
              </ModalSection>

              {!isSprint && !isMainRoot && hasWorklog && (
                <ModalSection title="Worklog">
                  <TextField
                    label="Worklog Date"
                    type="date"
                    value={draft.worklogDate}
                    onChange={(value) => updateDraft("worklogDate", value)}
                  />
                  <TextAreaField
                    label="Comment"
                    value={draft.worklogDescription}
                    onChange={(value) =>
                      updateDraft("worklogDescription", value)
                    }
                    wide
                  />
                  <TextField
                    label="Hours"
                    type="number"
                    value={worklogTimePart("hour")}
                    onChange={(value) => updateWorklogTimePart("hour", value)}
                  />
                  <TextField
                    label="Minutes"
                    type="number"
                    value={worklogTimePart("min")}
                    onChange={(value) => updateWorklogTimePart("min", value)}
                  />
                </ModalSection>
              )}

              {!isMainRoot && (
                <ModalSection title="Workflow">
                  {isSprint ? (
                    <SelectField
                      label="Docket State"
                      value={draft.docketState || "concept"}
                      options={DOCKET_STATES}
                      onChange={(value) => updateDraft("docketState", value)}
                    />
                  ) : (
                    <>
                      <SelectField
                        label="Category"
                        value={draft.category}
                        options={CATEGORIES}
                        onChange={(value) => updateDraft("category", value)}
                      />

                      <SelectField
                        label="Priority"
                        value={draft.priority}
                        options={PRIORITIES}
                        onChange={(value) => updateDraft("priority", value)}
                      />

                      {modalStateOptions.length > 0 ? (
                        <CustomSelectField
                          label="Docket State"
                          value={draft.stateId || ""}
                          options={modalStateOptions.map((option) => option.id)}
                          onChange={(value) => {
                            const stateName = optionLabel(modalStateOptions, value, currentDocketState);
                            updateDraftFields({
                              stateId: value,
                              stateName,
                              docketState: localDocketStateValue(stateName, currentDocketState),
                            });
                          }}
                          getOptionLabel={(value) => optionLabel(modalStateOptions, value, currentDocketState)}
                        />
                      ) : (
                        <ReadOnlyField label="Docket State" value={currentDocketState} />
                      )}
                    </>
                  )}
                </ModalSection>
              )}

              {!isSprint && !isMainRoot && (
                <ModalSection title="Hierarchy">
                  {modal.kind === "create" && createTypeOptions.length > 1 ? (
                    <SelectField
                      label="Type"
                      value={selectedItemType}
                      options={createTypeOptions}
                      onChange={(value) => updateDraft("type", value)}
                    />
                  ) : (
                    <ReadOnlyField label="Type" value={formatType(selectedItemType)} />
                  )}
                  {activeItem?.type === "story" && modalEpicOptions.length > 0 ? (
                    <CustomSelectField
                      label="Epic"
                      value={draft.parentId || activeItem.parentId}
                      options={modalEpicOptions.map((option) => option.id)}
                      onChange={(value) => {
                        const selectedEpic = modalEpicOptions.find((option) => option.id === value);
                        updateDraftFields({
                          parentId: value,
                          epicId: selectedEpic?.remoteId || value,
                        });
                      }}
                      getOptionLabel={(value) => optionLabel(modalEpicOptions, value, parentLabel(value, workItems))}
                      wide
                    />
                  ) : (
                    <ReadOnlyField
                      label={parentFieldLabel(parentId, workItems)}
                      value={parentLabel(parentId, workItems)}
                    />
                  )}
                  {modalSprintOptions.length > 0 ? (
                    <CustomSelectField
                      label="Sprint"
                      value={draft.sprintId || ""}
                      options={modalSprintOptions.map((option) => option.id)}
                      onChange={(value) => {
                        const sprintName = optionLabel(modalSprintOptions, value, draft.sprint);
                        updateDraftFields({
                          sprintId: value,
                          sprintName,
                          sprint: sprintName,
                        });
                      }}
                      getOptionLabel={(value) => optionLabel(modalSprintOptions, value, draft.sprint)}
                    />
                  ) : (
                    <ReadOnlyField label="Sprint" value={draft.sprint} />
                  )}
                  {modalAssigneeOptions.length > 0 && (
                    <CustomSelectField
                      label="Assignee"
                      value={draft.assigneeId || ""}
                      options={modalAssigneeOptions.map((option) => option.id)}
                      onChange={(value) => {
                        const assigneeName = optionLabel(modalAssigneeOptions, value, draft.assigneeName);
                        updateDraftFields({
                          assigneeId: value,
                          assigneeName,
                          assignee: assigneeName,
                        });
                      }}
                      getOptionLabel={(value) => optionLabel(modalAssigneeOptions, value, draft.assigneeName)}
                      wide
                    />
                  )}
                </ModalSection>
              )}

              {modal.kind !== "create" ||
              selectedItemType === "story" ||
              acceptsTime(selectedItemType) ? (
                <ModalSection title="Effort & Time">
                  {selectedItemType === "story" && (
                    <TextField
                      label="Story Points"
                      type="number"
                      value={draft.storyPoints}
                      onChange={(value) => updateDraft("storyPoints", value)}
                    />
                  )}

                  {acceptsTime(selectedItemType) && !hasWorklog && (
                    <TextField
                      label="Time"
                      value={draft.time}
                      placeholder="HH:MM"
                      onChange={(value) => updateDraft("time", value)}
                    />
                  )}

                  {modal.kind !== "create" && (
                    <>
                      {(isSprint || isMainRoot) && (
                        <ReadOnlyField
                          label="Calculated Story Points"
                          value={`${totals.rootTotal} SP`}
                          badge
                        />
                      )}
                      {!isSprint && !isMainRoot && activeItem.type === "epic" && (
                        <ReadOnlyField
                          label="Calculated Story Points"
                          value={`${calculatedSp} SP`}
                          badge
                        />
                      )}
                      <ReadOnlyField
                        label="Calculated Time"
                        value={formatWorkTime(calculatedTime)}
                        badge
                      />
                    </>
                  )}
                </ModalSection>
              ) : null}

              {modal.kind !== "create" && !isSprint && !isMainRoot && (
                <section className="modal-section modal-section-untitled">
                  <div className="modal-section-grid">
                    <ReadOnlyField
                      label="Created At"
                      value={formatTimestamp(activeItem.createdAt)}
                    />
                    <ReadOnlyField
                      label="Updated At"
                      value={formatTimestamp(activeItem.updatedAt)}
                    />
                  </div>
                </section>
              )}
            </div>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        {showFooter && (
          <footer className="modal-footer">
            <div className="modal-footer-danger">
              {modal.kind === "details" && activeItem && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="modal-footer-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleCancel}
                disabled={saveState === "saving"}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveState === "saving"}
              >
                {saveState === "saving"
                  ? modal.kind === "create"
                    ? "Creating..."
                    : "Saving..."
                  : modal.kind === "create"
                  ? "Create Work Item"
                  : "Save Changes"}
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}

function App() {
  const isReadOnlyViewer = useMemo(() => isHostedViewerRuntime(), []);
  const isBrowserRefreshStartup = useMemo(
    () => isBrowserReloadNavigation(),
    []
  );
  const browserRefreshStateRef = useRef(
    isBrowserRefreshStartup ? readBrowserRefreshState() : null
  );
  const [storyState, setStoryState] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(
    "Loading local cache..."
  );
  const [layoutNonce, setLayoutNonce] = useState(1);
  const [viewMode, setViewMode] = useState("main");
  const [viewRootId, setViewRootId] = useState(null);
  const [contextSelections, setContextSelections] = useState({});
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadState, setLoadState] = useState(
    "loading-cache"
  );
  const [syncState, setSyncState] = useState(
    isBrowserRefreshStartup ? "synced" : "syncing"
  );
  const [saveState, setSaveState] = useState("idle");
  const [baseSha, setBaseSha] = useState("");
  const [baselineSnapshot, setBaselineSnapshot] = useState(
    null
  );
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [legacyState, setLegacyState] = useState(null);
  const [showLegacyNotice, setShowLegacyNotice] = useState(false);
  const [liveSyncState, setLiveSyncState] = useState("idle");
  const [liveSyncProgress, setLiveSyncProgress] = useState("");
  const [liveSyncSummary, setLiveSyncSummary] = useState(null);
  const [syncQueueSummary, setSyncQueueSummary] = useState({
    pendingCount: 0,
    actionableCount: 0,
    mutationActionableCount: 0,
    reconciliationActionableCount: 0,
    unconfirmedCount: 0,
    failedCount: 0,
    operations: [],
  });
  const [importedWorklogs, setImportedWorklogs] = useState([]);
  const [publishedWorklogsLoaded, setPublishedWorklogsLoaded] = useState(false);
  const [syncStatusPopoverOpen, setSyncStatusPopoverOpen] = useState(false);

  const {
    mainTitle = "Genesis",
    rootTitle = "",
    rootDocketState = "concept",
    sprints = [],
    workItems: rawWorkItems = [],
  } = storyState || {};
  const workItems = useMemo(
    () => applyImportedWorklogs(rawWorkItems, importedWorklogs),
    [importedWorklogs, rawWorkItems]
  );
  const workItemsRef = useRef(workItems);
  const storyStateRef = useRef(storyState);
  const saveRequestIdRef = useRef(0);
  const hasCheckedLegacyRef = useRef(false);
  const syncStatusPopoverRef = useRef(null);
  const currentSnapshot = useMemo(
    () => (storyState ? snapshotFromState(storyState) : null),
    [storyState]
  );
  const dirty = Boolean(
    currentSnapshot &&
      baselineSnapshot &&
      !snapshotEquals(currentSnapshot, baselineSnapshot)
  );
  const canSave =
    !isReadOnlyViewer &&
    loadState === "ready" &&
    dirty &&
    syncState !== "offline" &&
    !saveState.startsWith("saving") &&
    baseSha;
  const totals = useMemo(
    () => calculateStoryPoints(workItems),
    [workItems]
  );
  const isContextView = CONTEXT_VIEW_IDS.has(viewMode);
  const graphScopeOptions = useMemo(
    () => scopesWithOrphanSprint(sprints, workItems),
    [sprints, workItems]
  );
  const contextOptions = useMemo(
    () => contextOptionsForView({ viewMode, sprints: graphScopeOptions, workItems }),
    [graphScopeOptions, viewMode, workItems]
  );
  const selectedContextId =
    contextSelections[viewMode] ||
    defaultContextSelection({ viewMode, sprints: graphScopeOptions, workItems });
  const selectedContextOption = useMemo(
    () =>
      viewMode === "day"
        ? {
            id: selectedContextId,
            title: selectedContextId,
          }
        : contextOptions.find((option) => option.id === selectedContextId) || null,
    [contextOptions, selectedContextId, viewMode]
  );
  const contextGraph = useMemo(
    () =>
      isContextView
        ? buildContextGraph({
            workItems,
            sprints: graphScopeOptions,
            viewMode,
            selectedId: selectedContextOption?.id || "",
          })
        : {
            workItems,
            rootId: null,
            sprints: [],
          },
    [graphScopeOptions, isContextView, selectedContextOption, viewMode, workItems]
  );
  const visibleWorkItems = useMemo(
    () => descendantsIncluding(contextGraph.workItems, viewRootId),
    [contextGraph.workItems, viewRootId]
  );
  const searchedWorkItems = useMemo(
    () => filterWorkItemsForSearch(visibleWorkItems, searchQuery),
    [searchQuery, visibleWorkItems]
  );
  const searchedSprints = useMemo(() => {
    if (viewMode !== "main" || !searchQuery.trim()) return graphScopeOptions;

    return graphScopeOptions.filter((sprint) => sprintMatchesQuery(sprint, searchQuery));
  }, [graphScopeOptions, searchQuery, viewMode]);
  const graphWorkItems = searchedWorkItems;
  const graphSprints =
    viewMode === "main"
      ? searchedSprints
      : isContextView
      ? contextGraph.sprints
      : [];
  const graphMainTitle =
    viewMode === "sprint"
      ? selectedContextOption?.title || "Sprint"
      : viewMode === "day"
      ? formatDateLabel(selectedContextOption?.id || formatDateInput(new Date()))
      : mainTitle;
  const graphRootTitle =
    viewMode === "sprint" || viewMode === "day"
      ? rootTitle || mainTitle || "Project"
      : rootTitle;
  const graphRootId = viewRootId || contextGraph.rootId;
  const graphTotals = useMemo(
    () => calculateStoryPoints(graphWorkItems),
    [graphWorkItems]
  );
  const daySummary = useMemo(
    () =>
      viewMode === "day"
        ? dayViewSummary({
            workItems,
            graphWorkItems: contextGraph.workItems,
            selectedDate: selectedContextOption?.id || formatDateInput(new Date()),
            rootTitle,
          })
        : null,
    [contextGraph.workItems, rootTitle, selectedContextOption, viewMode, workItems]
  );
  const viewRootItem = viewRootId
    ? workItems.find((item) => item.id === viewRootId)
    : null;
  const isPlanningView = PLANNING_VIEW_IDS.has(viewMode);
  const usesPlanningSurface = isPlanningView;
  const isDashboardView = viewMode === "dashboard";
  const showGraphEmptyState =
    graphWorkItems.length === 0 &&
    !usesPlanningSurface &&
    !isDashboardView &&
    viewMode !== "main";
  const selectedEditableItem = selectedId
    ? workItems.find(
        (item) =>
          item.id === selectedId &&
          ["epic", "story", "job", "task"].includes(item.type)
      )
    : null;
  const currentAppView = APP_VIEWS.find((view) => view.id === viewMode);
  const contextTitle =
    currentAppView
      ? currentAppView.label
      : viewMode === "main"
      ? "Tree View"
      : viewRootItem
      ? `${viewRootItem.title} View`
      : "Sprint View";
  const contextItemCount =
    searchedWorkItems.length +
    (!isPlanningView && viewMode === "main" ? searchedSprints.length : 0) +
    (!isPlanningView && !isDashboardView && viewMode !== "main" ? 1 : 0);
  const contextStoryPoints =
    graphRootId ? graphTotals.byId[graphRootId] || 0 : graphTotals.rootTotal;
  const contextTimeMinutes =
    graphRootId
      ? graphTotals.timeById[graphRootId] || 0
      : graphTotals.rootTimeMinutes || 0;
  const projectStats = useMemo(() => ({
    projects: mainTitle ? 1 : 0,
    sprints: sprints.length,
    dockets: workItems.length,
    epics: workItems.filter((item) => item.type === "epic").length,
    stories: workItems.filter((item) => item.type === "story").length,
    jobs: workItems.filter((item) => item.type === "job").length,
    tasks: workItems.filter((item) => item.type === "task").length,
  }), [mainTitle, sprints.length, workItems]);

  useEffect(() => {
    if (!isContextView) return;
    if (viewMode === "day") {
      if (selectedContextId) return;

      setContextSelections((current) => ({
        ...current,
        [viewMode]: defaultContextSelection({ viewMode, sprints, workItems }),
      }));
      return;
    }

    if (
      selectedContextId &&
      contextOptions.some((option) => option.id === selectedContextId)
    ) {
      return;
    }

    const nextSelection = defaultContextSelection({ viewMode, sprints, workItems });

    setContextSelections((current) => ({
      ...current,
      [viewMode]: nextSelection,
    }));
  }, [
    contextOptions,
    isContextView,
    selectedContextId,
    sprints,
    viewMode,
    workItems,
  ]);

  const ensurePublishedWorklogs = useCallback(async () => {
    if (!isReadOnlyViewer || publishedWorklogsLoaded) return;

    setMessage("Loading worklogs...");

    try {
      const result = await loadPublishedWorklogs();

      setImportedWorklogs(result.worklogs.worklogs || []);
      setPublishedWorklogsLoaded(true);
      setMessage("Loaded published data");
    } catch (error) {
      setMessage(error.message || "Unable to load published worklogs.");
    }
  }, [isReadOnlyViewer, publishedWorklogsLoaded]);

  useEffect(() => {
    if (!isReadOnlyViewer || loadState !== "ready") return;
    if (!WORKLOG_DEPENDENT_VIEW_IDS.has(viewMode) && !selectedEditableItem) return;

    Promise.resolve().then(ensurePublishedWorklogs);
  }, [
    ensurePublishedWorklogs,
    isReadOnlyViewer,
    loadState,
    selectedEditableItem,
    viewMode,
  ]);

  useEffect(() => {
    workItemsRef.current = workItems;
    storyStateRef.current = storyState;
  }, [storyState, workItems]);

  useEffect(() => {
    if (!syncStatusPopoverOpen) return undefined;

    const handlePointerDown = (event) => {
      if (syncStatusPopoverRef.current?.contains(event.target)) return;

      setSyncStatusPopoverOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [syncStatusPopoverOpen]);

  const checkLegacyState = useCallback((remoteSnapshot) => {
    if (hasCheckedLegacyRef.current) return;

    hasCheckedLegacyRef.current = true;

    const legacy = loadLegacyStoryViewState();

    if (legacy) {
      const legacySnapshot = snapshotFromState(legacy);
      const differs = !snapshotEquals(legacySnapshot, remoteSnapshot);

      if (differs) {
        setLegacyState(legacy);
        setShowLegacyNotice(true);
      }
    }
  }, []);

  const applyLoadedSnapshot = useCallback(({
    snapshot,
    baseSha: nextSha,
    cache = true,
    message: nextMessage = "Synced",
  }) => {
    const normalized = normalizeLoadedSnapshot(snapshot);
    const syncedAt = new Date().toISOString();

    setStoryState(normalized.state);
    workItemsRef.current = normalized.state.workItems;
    setBaselineSnapshot(normalized.snapshot);
    setBaseSha(nextSha);
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setLoadState("ready");
    setSyncState("synced");
    setSaveState("idle");
    setMessage(nextMessage);
    setLastSyncedAt(syncedAt);
    setLayoutNonce((value) => value + 1);
    if (cache) {
      saveCache({
        snapshot: normalized.snapshot,
        sha: nextSha,
        lastSyncedAt: syncedAt,
      });
    }
    return normalized.snapshot;
  }, []);

  const loadRemoteSnapshot = useCallback(async ({ block = false } = {}) => {
    if (block) {
      setLoadState("loading");
      setSyncState("loading");
      setMessage("Loading worklog...");
    } else {
      setSyncState("syncing");
    }

    try {
      const result = await loadWorklogSnapshot();
      const remoteSha = result.baseSha;

      if (!block && baseSha && remoteSha === baseSha) {
        const normalized = normalizeLoadedSnapshot(result.snapshot);
        const syncedAt = new Date().toISOString();
        setBaselineSnapshot(normalized.snapshot);
        setBaseSha(remoteSha);
        setLoadState("ready");
        setSyncState("synced");
        setLastSyncedAt(syncedAt);
        setMessage((current) =>
          current === "Offline (using cached data)" || current === "Syncing..."
            ? "Synced"
            : current || "Synced"
        );
        saveCache({
          snapshot: normalized.snapshot,
          sha: remoteSha,
          lastSyncedAt: syncedAt,
        });
        checkLegacyState(normalized.snapshot);
        return;
      }

      const remoteSnapshot = applyLoadedSnapshot({
        ...result,
        message: "Synced",
      });
      checkLegacyState(remoteSnapshot);
    } catch (error) {
      setSyncState("offline");
      setMessage("Offline (using cached data)");

      if (block) {
        setLoadState("error");
        setMessage(error.message || "Unable to load remote worklog.");
      } else {
        setLoadState("ready");
      }
    }
  }, [applyLoadedSnapshot, baseSha, checkLegacyState]);

  const applyNormalizedGraphPayload = useCallback((result, {
    message: nextMessage = "Loaded local cache",
    preserveView = true,
    updateSummary = false,
  } = {}) => {
    const normalizedState = normalizeStoryStateArtifactRollup(
      result.normalized.appState
    );
    const mergedState = mergeGraphState(storyStateRef.current, normalizedState);
    const normalizedSnapshot = snapshotFromState(mergedState);
    const syncedAt =
      result.syncedAt ||
      result.metadata?.lastSyncTime ||
      result.cache?.metadata?.lastSyncTime ||
      new Date().toISOString();
    const nextIds = new Set([
      ROOT_ID,
      MAIN_ROOT_ID,
      ...mergedState.sprints.map((sprint) => sprint.id),
      ...mergedState.workItems.map((item) => item.id),
    ]);

    setStoryState(mergedState);
    workItemsRef.current = mergedState.workItems;
    setBaselineSnapshot(normalizedSnapshot);
    setSelectedId((current) =>
      preserveView && nextIds.has(current) ? current : null
    );
    setViewRootId((current) =>
      preserveView && nextIds.has(current) ? current : null
    );
    setModal((current) =>
      current?.id && !nextIds.has(current.id) ? null : current
    );
    setLoadState("ready");
    setSyncState("synced");
    setSaveState("idle");
    setLastSyncedAt(syncedAt);
    setSyncQueueSummary(normalizeSyncQueueSummary(result.syncQueue));
    setMessage(nextMessage);
    setLayoutNonce((value) => value + 1);

    if (updateSummary) {
      setLiveSyncSummary({
        status: "Success",
        counts: result.counts || {
          projects: result.normalized.projects?.length || 0,
          sprints: result.normalized.sprints?.length || 0,
          epics: result.normalized.epics?.length || 0,
          stories: result.normalized.stories?.length || 0,
          jobs: result.normalized.jobs?.length || 0,
          tasks: result.normalized.tasks?.length || 0,
        },
        durationMs: result.durationMs || 0,
        syncedAt,
        incremental: result.incremental || null,
      });
    }

    return {
      normalizedSnapshot,
      syncedAt,
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadStartupData() {
      try {
        if (isReadOnlyViewer) {
          const result = await loadPublishedData();

          if (cancelled) return;

          applyNormalizedGraphPayload(result, {
            message: "Loaded published data",
            preserveView: false,
            updateSummary: true,
          });
          setSyncState("synced");
          setLiveSyncState("synced");
          return;
        }

        const [result, worklogCache] = await Promise.all([
          loadLocalGraphCache({
            skipBackgroundSync: isBrowserRefreshStartup,
          }),
          loadLocalWorklogsCache().catch(() => null),
        ]);

        if (cancelled) return;

        setImportedWorklogs(worklogCache?.worklogs || []);
        applyNormalizedGraphPayload(result, {
          message: "Loaded local cache",
          preserveView: false,
        });

        const refreshState = browserRefreshStateRef.current;

        if (isBrowserRefreshStartup && refreshState) {
          const normalizedState = normalizeStoryStateArtifactRollup(
            result.normalized.appState
          );
          const validIds = new Set([
            ROOT_ID,
            MAIN_ROOT_ID,
            ...normalizedState.sprints.map((sprint) => sprint.id),
            ...normalizedState.workItems.map((item) => item.id),
          ]);
          const knownViewModes = new Set([
            ...APP_VIEWS.map((view) => view.id),
            "focused",
          ]);
          const nextViewMode = knownViewModes.has(refreshState.viewMode)
            ? refreshState.viewMode
            : "main";
          const nextViewRootId =
            refreshState.viewRootId && validIds.has(refreshState.viewRootId)
              ? refreshState.viewRootId
              : null;

          setViewMode(
            nextViewMode === "focused" && !nextViewRootId ? "main" : nextViewMode
          );
          setViewRootId(nextViewRootId);
          setSelectedId(
            refreshState.selectedId && validIds.has(refreshState.selectedId)
              ? refreshState.selectedId
              : null
          );
          if (
            refreshState.contextSelections &&
            typeof refreshState.contextSelections === "object"
          ) {
            setContextSelections(refreshState.contextSelections);
          }
          setSearchQuery(refreshState.searchQuery || "");
          setSearchOpen(
            Boolean(refreshState.searchOpen && refreshState.searchQuery)
          );
        }
      } catch (error) {
        if (cancelled) return;

        setStoryState(null);
        setLoadState("no-cache");
        setSyncState("offline");
        setMessage(
          isReadOnlyViewer
            ? error.message || "Unable to load published data."
            : error.status === 404
            ? "No local cache"
            : error.message || "Unable to load local cache."
        );
      }
    }

    loadStartupData();

    const events = isReadOnlyViewer || isBrowserRefreshStartup
      ? null
      : subscribeToLocalCacheEvents({
          onUpdated(payload) {
            if (cancelled) return;

            loadLocalWorklogsCache()
              .then((worklogCache) => {
                if (!cancelled) setImportedWorklogs(worklogCache.worklogs || []);
              })
              .catch(() => {
                if (!cancelled) setImportedWorklogs([]);
              });
            applyNormalizedGraphPayload(payload, {
              message: "Updated from Elitical",
              preserveView: true,
            });
          },
          onFailed(payload) {
            if (cancelled) return;

            setSyncState("offline");
            setLiveSyncState("failed");
            setLiveSyncProgress(payload?.message || payload?.error || "Background sync failed.");
            setMessage(payload?.message || "Background sync failed.");
          },
          onWarning(payload) {
            if (cancelled) return;

            setMessage(payload?.message || payload?.warning || "GitHub publish warning.");
          },
          onSyncStarted(payload) {
            if (cancelled) return;

            const nextMessage = payload?.message || "Syncing from Elitical...";

            setSyncState("syncing");
            setLiveSyncState("syncing");
            setLiveSyncProgress(nextMessage);
            setMessage(nextMessage);
          },
          onSyncFinished(payload) {
            if (cancelled) return;

            setSyncState("synced");
            setLiveSyncState((current) => (current === "syncing" ? "synced" : current));
            setLiveSyncProgress((current) =>
              current === "Sync Complete" ? current : payload?.message || ""
            );
          },
        });

    return () => {
      cancelled = true;
      events?.close();
    };
  }, [applyNormalizedGraphPayload, isBrowserRefreshStartup, isReadOnlyViewer]);

  useEffect(() => {
    const handlePageHide = () => {
      saveBrowserRefreshState({
        selectedId,
        contextSelections,
        viewMode,
        viewRootId,
        searchOpen,
        searchQuery,
      });
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [contextSelections, searchOpen, searchQuery, selectedId, viewMode, viewRootId]);

  useEffect(() => {
    if (!dirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectNode = useCallback((id) => {
    const selectedItem = resolveCanonicalWorkItem(id, workItemsRef.current);
    const selectedId = selectedItem?.id || id;

    setSelectedId(selectedId);

    if (selectedId) {

      if (["epic", "story", "job", "task"].includes(selectedItem?.type)) {
        setModal(null);
        return;
      }

      setModal({
        kind: "details",
        id: selectedId,
      });
    } else {
      setModal(null);
    }
  }, []);

  const handleStartSprint = useCallback(() => {
    const currentSprints = storyStateRef.current?.sprints || [];
    const id = generateSprintId(currentSprints);
    const now = new Date().toISOString();

    setStoryState((current) => ({
      ...current,
      sprints: [
        ...(current?.sprints || []),
        {
          id,
          code: "",
          title: "New Sprint",
          docketState: "concept",
          sprintStartDate: "",
          sprintEndDate: "",
          sprintState: "",
          state: "",
          createdBy: "",
          createdAt: now,
          updatedBy: "",
          updatedAt: "",
        },
      ],
    }));
    setSelectedId(id);
    setModal({
      kind: "details",
      id,
    });
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);
  }, []);

  const createItem = useCallback(async (payload) => {
    const currentWorkItems = workItemsRef.current;
    const parentId = payload.parentId || ROOT_ID;
    const isOrphanSprintCreate = Boolean(payload.isOrphanSprint);
    const validationError = validateCreatePayload(
      {
        ...payload,
        parentId,
      },
      currentWorkItems,
      sprints
    );

    if (validationError) {
      setMessage(validationError);
      return {
        ok: false,
        error: validationError,
      };
    }

    const type = payload.type;
    const sprintId = isOrphanSprintCreate
      ? ""
      : sprintIdForCreate(parentId, payload.sprintId, currentWorkItems, sprints);
    const usesNativeDocketCreatePayload = ["story", "job", "task", "epic"].includes(type);
    const nativeStorySprint =
      type === "story" && !isOrphanSprintCreate
        ? nativeStorySprintForCreate(parentId, payload.sprintId, currentWorkItems, sprints)
        : null;
    const createPayload = {
      ...parentPayloadForCreate(type, parentId, currentWorkItems),
      type,
      title: payload.title,
      description: payload.description || "",
      descr: payload.description || "",
      projectId: projectIdForCreate(parentId, currentWorkItems, sprints),
      projectName:
        usesNativeDocketCreatePayload
          ? nativeStoryProjectNameForCreate(parentId, currentWorkItems, sprints, rootTitle)
          : undefined,
      sprintId: nativeStorySprint?.sprintId || sprintId,
      sprintName: nativeStorySprint?.sprintName || undefined,
      sprint: isOrphanSprintCreate
        ? ""
        : payload.sprint || nativeStorySprint?.sprintName || sprints.find((sprint) => sprint.id === sprintId)?.title || "",
      docketState: payload.docketState || "concept",
      category:
        usesNativeDocketCreatePayload
          ? String(payload.category || "ENHANCEMENT").toUpperCase()
          : payload.category || "feature",
      priority:
        usesNativeDocketCreatePayload
          ? String(payload.priority || "MINOR").toUpperCase()
          : payload.priority || "info",
      assigneeId:
        usesNativeDocketCreatePayload
          ? nativeStoryAssigneeIdForCreate(parentId, payload, currentWorkItems)
          : payload.assigneeId,
      storyPoints: type === "story" ? Number(payload.storyPoints || 0) : undefined,
      storyPointEst: type === "story" ? Number(payload.storyPoints || 0) : undefined,
      hasNoSprint: type === "story" ? isOrphanSprintCreate : undefined,
      imgAttachmentDtoSet: type === "story" ? [] : undefined,
      videoAttachmentDtoSet: type === "story" ? [] : undefined,
      worklog: acceptsTime(type) && payload.worklog ? payload.worklog : undefined,
    };

    try {
      setMessage("Creating docket locally...");

      const result = await createEliticalDocket(createPayload);

      applyNormalizedGraphPayload(result, {
        message: result.message || `Created ${formatType(type)} locally`,
        preserveView: true,
      });
      setSelectedId(result.item?.id || result.docket?.id || null);

      return {
        ok: true,
        item: result.item,
        docket: result.docket,
      };
    } catch (error) {
      const message =
        error.payload?.message ||
        error.payload?.error ||
        error.message ||
        "Unable to create Elitical docket.";

      setMessage(message);

      return {
        ok: false,
        error: message,
      };
    }
  }, [applyNormalizedGraphPayload, sprints]);

  const handleStartChild = useCallback((type, parentId, options = {}) => {
    const currentWorkItems = workItemsRef.current;
    const sprintParent = sprints.find((sprint) => sprint.id === parentId);
    const isOrphanSprintCreate =
      Boolean(options.isOrphanSprint) || isOrphanSprintId(parentId);
    const actualParentId =
      type === "epic" && (sprintParent || isOrphanSprintCreate)
        ? ROOT_ID
        : parentId;
    const sprintId = isOrphanSprintCreate
      ? ""
      : sprintParent
      ? sprintParent.id
      : sprintIdForCreate(actualParentId, options.sprintId, currentWorkItems, sprints);
    const fallbackSprint = isOrphanSprintCreate
      ? ORPHAN_SPRINT_TITLE
      : sprintParent
      ? sprintParent.title
      : options.sprint || inheritedSprint(actualParentId, currentWorkItems, rootTitle);
    const fallbackDocketState = inheritedDocketState(
      actualParentId,
      currentWorkItems,
      sprintParent?.docketState || rootDocketState
    );

    setModal({
      kind: "create",
      type,
      parentId: actualParentId,
      sprint: fallbackSprint,
      sprintId,
      isOrphanSprint: isOrphanSprintCreate,
      docketState: fallbackDocketState,
      worklogDate: options.worklogDate,
    });
  }, [rootDocketState, rootTitle, sprints]);

  const openDetailsModal = useCallback((id) => {
    const selectedItem = resolveCanonicalWorkItem(id, workItemsRef.current);
    const canonicalId = selectedItem?.id || id;

    if (!selectedItem || !["epic", "story", "job", "task"].includes(selectedItem.type)) {
      setSelectedId(canonicalId || null);
      setModal(null);
      return;
    }

    setSelectedId(canonicalId);
    setModal({
      kind: "details",
      id: canonicalId,
    });
    setMessage("");
  }, []);

  const setFocusedView = useCallback((id) => {
    setViewMode("focused");
    setViewRootId(id);
    setSelectedId(id);
    setViewMenuOpen(false);
    setLayoutNonce((value) => value + 1);
  }, []);

  const showSprintView = useCallback(() => {
    setViewMode("sprint");
    setViewRootId(null);
    setSelectedId(null);
    setViewMenuOpen(false);
    setLayoutNonce((value) => value + 1);
  }, []);

  const showAppView = useCallback((nextViewMode) => {
    setViewMode(nextViewMode);
    setViewRootId(null);
    setSelectedId(null);
    setViewMenuOpen(false);
    if (nextViewMode === "main" || CONTEXT_VIEW_IDS.has(nextViewMode)) {
      setLayoutNonce((value) => value + 1);
    }
  }, []);

  const selectContextViewOption = useCallback((optionId) => {
    setContextSelections((current) => ({
      ...current,
      [viewMode]: optionId,
    }));
    setViewRootId(null);
    setSelectedId(null);
    setLayoutNonce((value) => value + 1);
  }, [viewMode]);

  const saveRootTitle = useCallback((updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Root title is required.");
      return {
        ok: false,
        error: "Root title is required.",
      };
    }

    const requestedDocketState = updates.docketState || "concept";
    const blockedError =
      requestedDocketState === "artifact"
        ? artifactBlockedError(ROOT_ID, workItemsRef.current)
        : "";

    if (blockedError) {
      setMessage(blockedError);
      return {
        ok: false,
        error: blockedError,
      };
    }

    const normalized = normalizeArtifactRollup(
      workItemsRef.current,
      requestedDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootTitle: trimmed,
      rootDocketState: normalized.rootDocketState,
      sprints: (current?.sprints || []).map((sprint) =>
        sprint.id === ROOT_ID
          ? {
              ...sprint,
              title: trimmed,
              docketState: normalized.rootDocketState,
            }
          : sprint
      ),
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveMainTitle = useCallback((updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Main title is required.");
      return {
        ok: false,
        error: "Main title is required.",
      };
    }

    setStoryState((current) => ({
      ...current,
      mainTitle: trimmed,
    }));
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveSprint = useCallback((id, updates) => {
    const trimmed = updates.title.trim();

    if (!trimmed) {
      setMessage("Sprint title is required.");
      return {
        ok: false,
        error: "Sprint title is required.",
      };
    }

    setStoryState((current) => ({
      ...current,
      sprints: (current?.sprints || []).map((sprint) =>
        sprint.id === id
          ? {
              ...sprint,
              title: trimmed,
              docketState: updates.docketState || "concept",
              code: updates.code || "",
              sprintStartDate: optionalDateInputToIso(updates.sprintStartDate),
              sprintEndDate: optionalDateInputToIso(updates.sprintEndDate),
              sprintState: updates.sprintState || "",
              state: updates.state || "",
              createdBy: updates.createdBy || "",
              createdAt: dateTimeInputToIso(updates.createdAt) || sprint.createdAt || "",
              updatedBy: updates.updatedBy || "",
              updatedAt: dateTimeInputToIso(updates.updatedAt) || "",
            }
          : sprint
      ),
    }));
    setMessage("Unsaved Changes");

    return {
      ok: true,
    };
  }, []);

  const saveWorkItem = useCallback((id, updates) => {
    const existingItems = workItemsRef.current;
    const requestedDocketState = updates.docketState || "concept";
    const blockedError =
      requestedDocketState === "artifact"
        ? artifactBlockedError(id, existingItems)
        : "";

    if (blockedError) {
      setMessage(blockedError);
      return {
        ok: false,
        error: blockedError,
      };
    }

    const result = updateWorkItem(
      existingItems,
      id,
      updates
    );

    if (!result.ok) {
      setMessage(result.error);
      return result;
    }

    const normalized = normalizeArtifactRollup(
      result.items,
      rootDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootDocketState: normalized.rootDocketState,
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setMessage("Unsaved Changes");

    return result;
  }, [rootDocketState]);

  const saveEditableWorkItem = useCallback(async (item, {
    sdkUpdates = {},
    localUpdates = {},
    localChangedFields = [],
  } = {}) => {
    const sdkFieldCount = Object.keys(sdkUpdates).length;

    try {
      let remoteResult = null;

      if (sdkFieldCount > 0) {
        const canonicalDocketId = canonicalDocketIdForUpdate(item);

        if (!canonicalDocketId) {
          return {
            ok: false,
            error: "Cannot update a reference, ghost, virtual, or orphan docket node.",
          };
        }

        setMessage("Saving locally...");
        remoteResult = await updateEliticalDocket(canonicalDocketId, sdkUpdates);

        if (remoteResult?.normalized?.appState) {
          applyNormalizedGraphPayload(remoteResult, {
            message: remoteResult.message || "Saved locally",
            preserveView: true,
          });
        } else {
          setMessage(remoteResult?.message || "Saved locally");
        }
      }

      const remoteFields = new Set(Object.keys(sdkUpdates));
      const changedLocalFields = localChangedFields.length
        ? localChangedFields
        : Object.keys(localUpdates);
      const localOnlyUpdates = {};

      changedLocalFields.forEach((field) => {
        if (remoteFields.has(field)) return;
        if (Object.prototype.hasOwnProperty.call(localUpdates, field)) {
          localOnlyUpdates[field] = localUpdates[field];
        }
      });

      const shouldSaveLocalOnly = Object.keys(localOnlyUpdates).length > 0;

      if (!shouldSaveLocalOnly) {
        setMessage(remoteResult?.message || (sdkFieldCount > 0 ? "Saved locally" : "No changes"));

        return {
          ok: true,
          update: remoteResult?.update || null,
          reconciliation: remoteResult?.reconciliation || null,
        };
      }

      if (localOnlyUpdates.worklog) {
        const canonicalDocketId = canonicalDocketIdForUpdate(item);

        if (!canonicalDocketId) {
          return {
            ok: false,
            error: "Cannot update a reference, ghost, virtual, or orphan docket node.",
          };
        }

        setMessage("Saving worklog locally...");
        remoteResult = await updateEliticalDocket(canonicalDocketId, {
          worklog: localOnlyUpdates.worklog,
        });
        delete localOnlyUpdates.worklog;

        if (remoteResult?.normalized?.appState) {
          applyNormalizedGraphPayload(remoteResult, {
            message: remoteResult.message || "Saved worklog locally",
            preserveView: true,
          });
        } else {
          setMessage(remoteResult?.message || "Saved worklog locally");
        }
      }

      if (!Object.keys(localOnlyUpdates).length) {
        return {
          ok: true,
          update: remoteResult?.update || null,
          reconciliation: remoteResult?.reconciliation || null,
        };
      }

      const result = saveWorkItem(item.id, {
        ...localOnlyUpdates,
        type: item.type,
      });

      if (!result.ok) return result;

      setMessage(sdkFieldCount > 0 ? remoteResult?.message || "Saved locally" : "No changes");

      if (
        localOnlyUpdates.parentId !== undefined &&
        localOnlyUpdates.parentId !== item.parentId
      ) {
        setLayoutNonce((value) => value + 1);
      }

      return {
        ok: true,
      };
    } catch (error) {
      const message = error.payload?.message || error.payload?.error || error.message || "Elitical save failed.";

      setMessage(message);

      return {
        ok: false,
        error: message,
      };
    }
  }, [applyNormalizedGraphPayload, saveWorkItem]);

  const saveModalWorkItem = useCallback(async (id, updates = {}) => {
    const item = workItemsRef.current.find((entry) => entry.id === id);

    if (!item) {
      return {
        ok: false,
        error: "Work item was not found.",
      };
    }

    const localChangedFields = Object.keys(updates || {});
    const sdkUpdates = supportedUpdatePayloadForItem(item, updates, {
      workItems: workItemsRef.current,
      sprints,
    });

    if (Object.keys(sdkUpdates).length || updates.worklog) {
      return saveEditableWorkItem(item, {
        sdkUpdates,
        localUpdates: {
          ...updates,
          title: String(updates.title || "").trim(),
          description: String(updates.description || "").trim(),
        },
        localChangedFields,
      });
    }

    return saveWorkItem(id, updates);
  }, [saveEditableWorkItem, saveWorkItem, sprints]);

  const removeWorkItem = useCallback((item) => {
    const result = deleteWorkItem(workItemsRef.current, item.id);

    if (!result.ok) {
      setMessage(result.error);
      return result;
    }

    const normalized = normalizeArtifactRollup(
      result.items,
      rootDocketState
    );

    setStoryState((current) => ({
      ...current,
      rootDocketState: normalized.rootDocketState,
      workItems: normalized.workItems,
    }));
    workItemsRef.current = normalized.workItems;
    setSelectedId(null);
    if (result.deletedIds.includes(viewRootId)) {
      setViewRootId(null);
    }
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);

    return result;
  }, [rootDocketState, viewRootId]);

  const handleSaveChanges = useCallback(async () => {
    if (isReadOnlyViewer || !canSave || !currentSnapshot) return;

    const sentSnapshot = currentSnapshot;
    const sentSnapshotString = stableSnapshotString(sentSnapshot);
    const requestId = saveRequestIdRef.current + 1;

    saveRequestIdRef.current = requestId;
    setSaveState("saving");
    setMessage("Saving...");

    try {
      const result = await saveWorklogSnapshot({
        snapshot: sentSnapshot,
        baseSha,
        commitMessage: `worklog: save snapshot ${new Date().toISOString()}`,
      });
      const normalized = normalizeLoadedSnapshot(result.snapshot);
      const syncedAt = new Date().toISOString();

      if (saveRequestIdRef.current !== requestId) return;

      setBaseSha(result.baseSha);
      setBaselineSnapshot(normalized.snapshot);
      saveCache({
        snapshot: normalized.snapshot,
        sha: result.baseSha,
        lastSyncedAt: syncedAt,
      });
      setLastSyncedAt(syncedAt);
      setSyncState("synced");
      setSaveState("idle");

      const latestSnapshot = snapshotFromState(storyStateRef.current);
      const stillDirty =
        stableSnapshotString(latestSnapshot) !== sentSnapshotString;

      setMessage(stillDirty ? "Unsaved Changes" : "Saved");
    } catch (error) {
      setSaveState(error.status === 409 ? "conflict" : "failed");
      setSyncState(error.status === 409 ? "synced" : "offline");
      setMessage(
        error.status === 409
          ? "Remote worklog changed since you loaded it."
          : error.message || "Save failed."
      );
    }
  }, [
    baseSha,
    canSave,
    currentSnapshot,
    isReadOnlyViewer,
  ]);

  const handleDiscardChanges = useCallback(() => {
    if (!dirty || !baselineSnapshot) return;

    if (!window.confirm("Discard all unsaved working-copy changes?")) {
      return;
    }

    const normalized = normalizeLoadedSnapshot(baselineSnapshot);
    setStoryState(normalized.state);
    workItemsRef.current = normalized.state.workItems;
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setSaveState("idle");
    setMessage("Saved");
    setLayoutNonce((value) => value + 1);
  }, [baselineSnapshot, dirty]);

  const handleReloadRemote = useCallback(async () => {
    if (isReadOnlyViewer) return;

    if (
      dirty &&
      !window.confirm("Reload remote worklog and discard local changes?")
    ) {
      return;
    }

    setSaveState("idle");
    await loadRemoteSnapshot({ block: false });
  }, [dirty, isReadOnlyViewer, loadRemoteSnapshot]);

  const handleSyncFromElitical = useCallback(async () => {
    if (isReadOnlyViewer || liveSyncState === "syncing") return;

    setSyncStatusPopoverOpen(false);
    setLiveSyncState("syncing");
    setLiveSyncProgress("Authenticating...");
    setSyncState("syncing");
    setMessage("Syncing from Elitical...");

    try {
      const result = await syncLiveEliticalData({
        onProgress(progress) {
          if (progress?.message) {
            setLiveSyncProgress(progress.message);
          }
        },
      });
      const worklogCache = await loadLocalWorklogsCache().catch(() => null);

      setImportedWorklogs(worklogCache?.worklogs || []);
      const { normalizedSnapshot, syncedAt } = applyNormalizedGraphPayload(result, {
        message: "Sync Complete",
        preserveView: true,
        updateSummary: true,
      });
      saveCache({
        snapshot: normalizedSnapshot,
        sha: baseSha,
        lastSyncedAt: syncedAt,
      });
      setLiveSyncState("synced");
      setLiveSyncProgress("Sync Complete");
    } catch (error) {
      const errorMessage =
        error.payload?.message ||
        error.payload?.error ||
        error.message ||
        "Elitical import failed.";

      setLiveSyncState("failed");
      setLiveSyncProgress(errorMessage);
      setLiveSyncSummary((current) => current
        ? {
            ...current,
            status: "Failed",
            errorMessage,
          }
        : {
            status: "Failed",
            errorMessage,
            counts: {
              projects: 0,
              sprints: 0,
              epics: 0,
              stories: 0,
              jobs: 0,
              tasks: 0,
            },
            durationMs: 0,
            syncedAt: "",
            incremental: null,
          }
      );
      setSyncState("offline");
      setMessage(errorMessage);
    }
  }, [
    applyNormalizedGraphPayload,
    baseSha,
    isReadOnlyViewer,
    liveSyncState,
  ]);

  const handleSyncToElitical = useCallback(async () => {
    if (isReadOnlyViewer || liveSyncState === "syncing") return;

    if (!syncQueueSummary.actionableCount) {
      setMessage("Everything is synced.");
      return;
    }

    setSyncStatusPopoverOpen(false);
    setLiveSyncState("syncing");
    setLiveSyncProgress("Syncing pending changes to Elitical...");
    setSyncState("syncing");
    setMessage("Syncing pending changes to Elitical...");

    try {
      const result = await syncPendingToElitical({
        onProgress(progress) {
          if (progress?.message) {
            setLiveSyncProgress(progress.message);
          }
        },
      });
      const worklogCache = await loadLocalWorklogsCache().catch(() => null);

      setImportedWorklogs(worklogCache?.worklogs || []);
      const { normalizedSnapshot, syncedAt } = applyNormalizedGraphPayload(result, {
        message: result.message || "Sync to Elitical complete",
        preserveView: true,
        updateSummary: true,
      });
      saveCache({
        snapshot: normalizedSnapshot,
        sha: baseSha,
        lastSyncedAt: syncedAt,
      });
      setLiveSyncState(result.syncSummary?.failed ? "failed" : "synced");
      setLiveSyncProgress(result.message || "Sync to Elitical complete");
    } catch (error) {
      const errorMessage =
        error.payload?.message ||
        error.payload?.error ||
        error.message ||
        "Sync to Elitical failed.";

      setLiveSyncState("failed");
      setLiveSyncProgress(errorMessage);
      setSyncState("offline");
      setMessage(errorMessage);
    }
  }, [
    applyNormalizedGraphPayload,
    baseSha,
    isReadOnlyViewer,
    liveSyncState,
    syncQueueSummary.actionableCount,
  ]);

  const handleUseLegacyState = useCallback(() => {
    if (!legacyState) return;

    const normalized = normalizeStoryStateArtifactRollup(legacyState);
    setStoryState(normalized);
    workItemsRef.current = normalized.workItems;
    setShowLegacyNotice(false);
    setMessage("Unsaved Changes");
    setSelectedId(null);
    setViewMode("sprint");
    setViewRootId(null);
    setModal(null);
    setLayoutNonce((value) => value + 1);
  }, [legacyState]);

  const handleIgnoreLegacyState = useCallback(() => {
    setShowLegacyNotice(false);
  }, []);

  const statusLabel =
    liveSyncState === "syncing"
      ? "🔄 Syncing..."
    : liveSyncState === "failed"
      ? liveSyncProgress || message || "Elitical sync failed"
      : saveState === "failed"
      ? "Save failed"
      : saveState === "saving"
      ? "Syncing..."
      : syncState === "offline"
      ? "Offline"
    : syncState === "syncing" || syncState === "loading"
      ? "Syncing..."
      : syncQueueSummary.actionableCount
      ? `Pending Sync (${syncQueueSummary.actionableCount})`
      : "✓ Synced";
  const syncStatusSummary = liveSyncSummary || {
    status: liveSyncState === "failed" ? "Failed" : "Success",
    counts: {
      projects: 0,
      sprints: 0,
      epics: 0,
      stories: 0,
      jobs: 0,
      tasks: 0,
    },
    durationMs: 0,
    syncedAt: lastSyncedAt,
    incremental: null,
  };
  const syncStatusCounts = syncStatusSummary.counts || {};
  const syncIncremental = syncStatusSummary.incremental || {};
  const syncStatusRows = [
    ["Status", syncStatusSummary.status || (liveSyncState === "failed" ? "Failed" : "Success")],
    ["Actionable Sync Items", syncQueueSummary.actionableCount || 0],
    ["Pending Mutations", syncQueueSummary.mutationActionableCount || 0],
    ["Unconfirmed Creates", syncQueueSummary.unconfirmedCount || 0],
    ["Sync Failures", syncQueueSummary.failedCount || 0],
    ["Last Synced", syncStatusSummary.syncedAt ? formatTimestamp(syncStatusSummary.syncedAt) : "-"],
    ["Duration", syncStatusSummary.durationMs ? `${Math.round(syncStatusSummary.durationMs / 1000)} sec` : "-"],
    ["Projects", syncStatusCounts.projects ?? "-"],
    ["Sprints", syncStatusCounts.sprints ?? "-"],
    ["Epics", syncStatusCounts.epics ?? "-"],
    ["Stories", syncStatusCounts.stories ?? "-"],
    ["Jobs", syncStatusCounts.jobs ?? "-"],
    ["Tasks", syncStatusCounts.tasks ?? "-"],
    ["Incremental Sync", syncIncremental.mode === "incremental" ? "Yes" : syncIncremental.mode ? "No" : "-"],
    ["New", syncIncremental.newDockets ?? "-"],
    ["Modified", syncIncremental.modifiedDockets ?? "-"],
    ["Unchanged", syncIncremental.unchangedDockets ?? "-"],
  ];

  if (loadState === "loading-cache") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>{isReadOnlyViewer ? "Loading published data" : "Loading local cache"}</h1>
          <p>
            {isReadOnlyViewer
              ? "Reading the latest GitHub-published Elitical cache..."
              : "Checking the desktop backend for cached Elitical data..."}
          </p>
        </section>
      </div>
    );
  }

  if (loadState === "no-cache") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>{isReadOnlyViewer ? "No published data" : "No local cache"}</h1>
          <p>
            {isReadOnlyViewer
              ? message || "The GitHub data repository does not have a published cache yet."
              : "Run Sync from Elitical once to create the desktop cache."}
          </p>
          {!isReadOnlyViewer && (
            <div className="state-actions">
              <button
                type="button"
                onClick={handleSyncFromElitical}
                disabled={liveSyncState === "syncing"}
              >
                {liveSyncState === "syncing" ? "Syncing..." : "Sync from Elitical"}
              </button>
            </div>
          )}
          {liveSyncProgress ? <p>{liveSyncProgress}</p> : null}
        </section>
      </div>
    );
  }

  if (loadState === "loading") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>Loading worklog</h1>
          <p>Loading the latest GitHub snapshot...</p>
        </section>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="app-container app-state-screen">
        <section className="state-panel">
          <h1>Unable to load worklog</h1>
          <p>{message}</p>
          <div className="state-actions">
            <button
              type="button"
              onClick={() => {
                if (isReadOnlyViewer) {
                  window.location.reload();
                  return;
                }

                loadRemoteSnapshot({ block: true });
              }}
            >
              Retry
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="top-toolbar">
        <div className="toolbar-left">
          <div className="app-logo" aria-label="Jira Flow">
            JF
          </div>
          <div className="view-selector">
            <button
              type="button"
              className="view-selector-button"
              onClick={() => setViewMenuOpen((open) => !open)}
              aria-expanded={viewMenuOpen}
              aria-haspopup="listbox"
            >
              <span>
                {currentAppView?.label ||
                  (viewRootItem ? `${viewRootItem.title} View` : "Tree View")}
              </span>
              <span className="view-selector-caret" aria-hidden="true">
                v
              </span>
            </button>
            {viewMenuOpen && (
              <div className="view-selector-menu" role="listbox">
                {APP_VIEWS.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className={viewMode === view.id ? "selected" : ""}
                    onClick={() => showAppView(view.id)}
                    role="option"
                    aria-selected={viewMode === view.id}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-context" aria-label="Current view summary">
          <div className="toolbar-context-row primary">
            <strong>{contextTitle}</strong>
            {viewMode !== "day" && (
              <>
                <span>{contextItemCount} Items</span>
                <span>{contextStoryPoints} SP</span>
                <span>{formatWorkTime(contextTimeMinutes)} Logged</span>
              </>
            )}
            <span>Last synced {formatRelativeSync(lastSyncedAt)}</span>
          </div>
          {viewMode !== "day" && (
            <div className="toolbar-context-row secondary">
              <span>Projects: {projectStats.projects}</span>
              <span>Sprints: {projectStats.sprints}</span>
              <span>Dockets: {projectStats.dockets}</span>
              <span>Epics: {projectStats.epics}</span>
              <span>Stories: {projectStats.stories}</span>
              <span>Jobs: {projectStats.jobs}</span>
              <span>Tasks: {projectStats.tasks}</span>
            </div>
          )}
        </div>

        <div className="toolbar-actions">
          <button
            type="button"
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
          >
            Search
            <span>Ctrl K</span>
          </button>
          <div className="sync-status-control" ref={syncStatusPopoverRef}>
            <span className={`sync-status ${syncState}`}>
              {statusLabel}
            </span>
            <button
              type="button"
              className="sync-status-icon"
              onClick={() => setSyncStatusPopoverOpen((open) => !open)}
              aria-label="Sync status"
              aria-expanded={syncStatusPopoverOpen}
            >
              i
            </button>
            {syncStatusPopoverOpen && (
              <div className="sync-status-popover">
                <h2>Last Sync</h2>
                {syncStatusSummary.errorMessage ? (
                  <p className="sync-status-error">{syncStatusSummary.errorMessage}</p>
                ) : null}
                <dl>
                  {syncStatusRows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>

          {!isReadOnlyViewer && (
            <button
              type="button"
              className="primary-button"
              onClick={handleSyncToElitical}
              disabled={liveSyncState === "syncing" || !syncQueueSummary.actionableCount}
            >
              {liveSyncState === "syncing"
                ? "Syncing..."
                : `Sync to Elitical${syncQueueSummary.actionableCount ? ` (${syncQueueSummary.actionableCount})` : ""}`}
            </button>
          )}

          {!isReadOnlyViewer && (
            <button
              type="button"
              className="secondary-button"
              onClick={handleSyncFromElitical}
              disabled={liveSyncState === "syncing"}
            >
              {liveSyncState === "syncing" ? "Syncing..." : "Sync from Elitical"}
            </button>
          )}

          {!isReadOnlyViewer && dirty && (
            <>
              <button
                type="button"
                className="primary-button"
                onClick={handleSaveChanges}
                disabled={!canSave}
              >
                {saveState === "saving" ? "Saving..." : "Save Changes"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleDiscardChanges}
                disabled={saveState === "saving"}
              >
                Discard Changes
              </button>
            </>
          )}
          {!isReadOnlyViewer && saveState === "conflict" && (
            <button type="button" onClick={handleReloadRemote}>
              Reload Remote
            </button>
          )}
          {viewRootId && (
            <button type="button" onClick={showSprintView}>
              Sprint View
            </button>
          )}
        </div>
      </header>

      {showLegacyNotice && (
        <div className="legacy-notice">
          <span>Local worklog data was found.</span>
          <button type="button" onClick={handleIgnoreLegacyState}>
            Ignore
          </button>
          <button type="button" onClick={handleUseLegacyState}>
            Replace Working Copy with Local Data
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="search-overlay" onMouseDown={() => setSearchOpen(false)}>
          <section
            className="search-panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <label>
              <span>Search workspace</span>
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search epics, stories, tasks, jobs, sprints..."
              />
            </label>
            <div className="search-results">
              <span>{searchedWorkItems.length} work items</span>
              {viewMode === "main" && <span>{searchedSprints.length} sprints</span>}
            </div>
          </section>
        </div>
      )}

      {viewMode === "day" && !usesPlanningSurface && !isDashboardView ? (
        <DayViewToolbar
          value={selectedContextOption?.id || formatDateInput(new Date())}
          onChange={selectContextViewOption}
          summary={daySummary}
        />
      ) : isContextView && !usesPlanningSurface && !isDashboardView ? (
        <ContextGraphSelector
          label={contextViewLabel(viewMode)}
          options={contextOptions}
          value={selectedContextOption?.id || ""}
          onChange={selectContextViewOption}
          viewMode={viewMode}
        />
      ) : null}

      {showGraphEmptyState && (
        <div className="empty-canvas-state">
          <h2>{viewMode === "day" ? "No work logged" : "No work assigned"}</h2>
          <p>
            {viewMode === "day"
              ? "No imported worklogs match this date."
              : `No imported work items match this ${contextViewLabel(viewMode).toLowerCase()} view.`}
          </p>
        </div>
      )}

      {usesPlanningSurface ? (
        <PlanningView
          viewMode={viewMode}
          workItems={searchedWorkItems}
          allWorkItems={workItems}
          sprints={searchedSprints}
          onOpenDetails={openDetailsModal}
        />
      ) : isDashboardView ? (
        <DashboardView
          workItems={workItems}
          sprints={sprints}
          rootTitle={rootTitle}
          totals={totals}
          lastSyncedAt={lastSyncedAt}
        />
      ) : showGraphEmptyState ? null : (
        <GraphView
          workItems={graphWorkItems}
          allWorkItems={workItems}
          mainTitle={graphMainTitle}
          rootTitle={graphRootTitle}
          rootDocketState={rootDocketState}
          sprints={graphSprints}
          storyPointTotals={graphTotals}
          viewRootId={graphRootId}
          viewMode={viewMode}
          selectedId={selectedId}
          daySummary={daySummary}
          onSelect={handleSelectNode}
          onOpenDetails={openDetailsModal}
          onStartChild={handleStartChild}
          onStartSprint={handleStartSprint}
          layoutNonce={layoutNonce}
          searchQuery={searchQuery}
          readOnly={isReadOnlyViewer}
        />
      )}

      {modal && (
        <WorkItemModal
          modal={modal}
          mainTitle={mainTitle}
          rootTitle={rootTitle}
          rootDocketState={rootDocketState}
          sprints={sprints}
          workItems={workItems}
          totals={totals}
          onClose={() => setModal(null)}
          onSaveMain={saveMainTitle}
          onSaveRoot={saveRootTitle}
          onSaveSprint={saveSprint}
          onSaveItem={saveModalWorkItem}
          onCreateItem={createItem}
          onDeleteItem={removeWorkItem}
          onSetView={setFocusedView}
          readOnly={
            isReadOnlyViewer ||
            modal.id === MAIN_ROOT_ID ||
            modal.id === ROOT_ID ||
            sprints.some((sprint) => sprint.id === modal.id)
          }
        />
      )}

      {selectedEditableItem && (
        <PropertyPanel
          item={selectedEditableItem}
          workItems={workItems}
          sprints={sprints}
          onClose={() => setSelectedId(null)}
          onSave={saveEditableWorkItem}
          readOnly={isReadOnlyViewer}
        />
      )}
    </div>
  );
}

export default App;
