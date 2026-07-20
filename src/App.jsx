import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import {
  subscribeToSyncProgress,
  syncPendingToElitical,
} from "./services/syncClient";
import {
  previewDuplicateSyncRecovery,
  resolveDuplicateSyncRecovery,
} from "./services/syncRecoveryClient";
import {
  loadLocalGraphCache,
  loadLocalWorklogsCache,
  subscribeToLocalCacheEvents,
} from "./services/localCacheClient";
import { loadApplicationLogs } from "./services/logsClient";
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
  ORPHAN_SPRINT_ID,
  isOrphanSprintId,
  isReferenceNode,
  projectionScopeIdForItem,
  scopesWithOrphanSprint,
} from "./utils/hierarchyProjection";
import {
  addDayProjectionSelection,
  dateKeyFromValue,
  dayEpicScopeKey,
  dayScopeIdForItem,
  daySelectionForDate,
  loadDayProjectionState,
  saveDayProjectionState,
  sprintContainsDate,
  sprintScopesForDay,
  sprintTitleForScope,
} from "./utils/dayViewProjection";
import {
  childActionItemsForNode as capabilityActionItemsForNode,
  childCreateTypesForCanonicalType,
} from "./utils/nodeCapabilities";
import {
  EMPTY_SEARCH_FILTERS,
  SEARCH_FILTER_KEYS,
  SEARCH_FILTER_LABELS,
  activeSearchFilterCount,
  applySearchFilters,
  buildSearchFilterOptions,
  pruneSearchFilters,
  searchFilterLabel,
} from "./utils/globalSearchFilter";
import { formatWorkDuration } from "./utils/durationFormat";
import {
  DOCKET_STATE_OPTIONS,
  docketStateApiId,
  docketStateApiName,
  docketStateLabel,
  normalizeDocketState,
} from "./utils/docketStates";
import {
  docketNumberForItem,
  isExactDocketNumberQuery,
  normalizeDocketNumber,
} from "./utils/docketIdentity";
import {
  normalizeEliticalDescription,
  validateEliticalDescription,
} from "./utils/eliticalDocketCreate";
import {
  buildSyncStatusPresentation,
  syncDirectionLabel as syncPresentationDirectionLabel,
} from "./utils/syncStatusPresentation";
import {
  addRetainedCreationContext,
  clearRetainedCreationContexts,
  loadRetainedCreationContextState,
  removeRetainedCreationContexts,
  retainedNodeIdsForContext,
  saveRetainedCreationContextState,
} from "./utils/retainedCreationContext";
import {
  BACKLOG_GROUPINGS,
  DEFAULT_BACKLOG_GROUPING,
  BACKLOG_ELIGIBLE_STATES,
  buildBacklogProjection,
  isBacklogEligible,
} from "./utils/backlogProjection";
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
const PLANNING_VIEW_IDS = new Set(["worklog"]);
const CONTEXT_VIEW_IDS = new Set(["sprint", "epic", "story", "job", "task", "day"]);
const WORKLOG_DEPENDENT_VIEW_IDS = new Set(["day", "worklog", "dashboard"]);
const DOCKET_CONTEXT_TYPES = new Set(["epic", "story", "job", "task"]);
const BROWSER_REFRESH_STATE_KEY = "elitical-worklog.browser-refresh-state.v1";
const BACKLOG_GROUPING_STORAGE_KEY = "elitical-worklog.backlog-grouping.v1";

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

function useDismissableLayer({ open, refs = [], onDismiss }) {
  useEffect(() => {
    if (!open) return undefined;

    function isInsideLayer(target, event) {
      const path =
        typeof event.composedPath === "function" ? event.composedPath() : [];

      return refs.some((ref) => {
        const node = ref?.current;

        return Boolean(
          node &&
            (node.contains(target) || (path.length > 0 && path.includes(node)))
        );
      });
    }

    function handlePointerDown(event) {
      if (isInsideLayer(event.target, event)) return;

      onDismiss();
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      onDismiss();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, refs, onDismiss]);
}

function readBacklogGroupingPreference() {
  if (typeof window === "undefined") return DEFAULT_BACKLOG_GROUPING;

  try {
    const value = window.localStorage.getItem(BACKLOG_GROUPING_STORAGE_KEY);

    return BACKLOG_GROUPINGS.some((grouping) => grouping.id === value)
      ? value
      : DEFAULT_BACKLOG_GROUPING;
  } catch {
    return DEFAULT_BACKLOG_GROUPING;
  }
}

function saveBacklogGroupingPreference(value) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(BACKLOG_GROUPING_STORAGE_KEY, value);
  } catch {
    // Preference storage is optional; Backlog still works without it.
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
    supersededCount: Number(summary.supersededCount ?? 0),
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
  const canonicalState = normalizeDocketState(docketState);

  return {
    title: "",
    description: "",
    worklogDescription: "",
    worklogDate: "",
    category: "feature",
    priority: "info",
    sprint,
    docketState: canonicalState,
    stateId: docketStateApiId(canonicalState),
    stateName: docketStateApiName(canonicalState),
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
    docketState: normalizeDocketState(sprint?.docketState || rootDocketState),
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
    docketState: normalizeDocketState(item.docketState),
    stateId: item.elitical?.stateId || item.dktStateId || "",
    stateName: docketStateApiName(item.docketState || item.dktStateName),
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
  const discoveredByState = new Map();

  workItems
    .filter((entry) => sameProject(entry) && entry?.elitical?.stateId)
    .forEach((entry) => {
      const canonical = normalizeDocketState(
        entry.docketState || entry.elitical.stateName || entry.dktStateName
      );

      if (discoveredByState.has(canonical)) return;

      discoveredByState.set(canonical, {
        id: entry.elitical.stateId,
        name: docketStateApiName(canonical),
        label: docketStateLabel(canonical),
        canonicalState: canonical,
      });
    });

  return sortLookupOptions(
    normalizeLookupOptions(
      DOCKET_STATE_OPTIONS.map((state) => (
        discoveredByState.get(state.value) || {
          id: docketStateApiId(state.value) || state.value,
          name: state.apiName,
          label: state.label,
          canonicalState: state.value,
        }
      ))
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
    name: DOCKET_STATES.includes(value) ? docketStateLabel(value) : formatLabel(value),
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
    const canonicalState = normalizeDocketState(nextStateName, item.docketState);
    sdkUpdates.dktStateId = String(nextStateId || "").trim();
    sdkUpdates.dktStateName = docketStateApiName(canonicalState);
    sdkUpdates.docketState = canonicalState;
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
  return normalizeDocketState(label, normalizeDocketState(current));
}

function stateOptionDisplayLabel(options, id, fallback = "") {
  return docketStateLabel(optionLabel(options, id, fallback));
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
    parentId === ROOT_ID &&
    (payload.isOrphanSprint ||
      sprints.some((sprint) => sprint.id === payload.sprintId && sprint.id !== ROOT_ID))
      ? ["epic"]
      : createTypesForParent(parentId, workItems, sprints);

  if (!["epic", "story", "task", "job"].includes(type)) {
    return "Choose a docket type.";
  }
  if (!validTypes.includes(type)) {
    return "Choose a valid parent for this docket type.";
  }
  if (!title) return "Title is required.";
  {
    const descriptionError = validateEliticalDescription(
      payload.description ?? payload.descr
    );

    if (descriptionError) return descriptionError;
  }
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

  return Number(worklog.hour) > 0 || Number(worklog.min) > 0;
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
  if (parentId === ROOT_ID) return normalizeDocketState(rootDocketState);

  const parent = workItems.find((item) => item.id === parentId);
  return normalizeDocketState(parent?.docketState || rootDocketState);
}

function openChildNames(parentId, workItems) {
  return workItems
    .filter(
      (item) =>
        item.parentId === parentId &&
        normalizeDocketState(item.docketState) !== "artifact"
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
    let nextState = normalizeDocketState(item?.docketState);

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
    return normalizeDocketState(item.docketState) === nextState
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

function normalizeContextSearch(value) {
  return String(value || "").toLowerCase().trim();
}

function contextOptionSearchText(option, viewMode) {
  return [
    contextOptionLabel(option, viewMode),
    contextOptionMeta(option, viewMode),
    option?.title,
    option?.name,
    option?.num,
    option?.code,
    option?.id,
    option?.elitical?.num,
    option?.elitical?.code,
    option?.elitical?.remoteId,
  ]
    .map(normalizeContextSearch)
    .filter(Boolean)
    .join(" ");
}

function emptyContextOptionsLabel(label, options, query) {
  if (options.length > 0 && query.trim()) return "No matching results";

  return `No ${label}s available`;
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

function employeeScopeId(scope) {
  return String(scope?.employeeId || scope?.id || "").trim();
}

function worklogMatchesEmployeeScope(entry, scope) {
  const scopeId = employeeScopeId(scope);

  if (!scopeId) return true;

  const entryEmployeeId = String(entry?.employeeId || "").trim();

  return entryEmployeeId ? entryEmployeeId === scopeId : false;
}

function itemAssigneeId(item = {}) {
  return String(item.elitical?.assigneeId || item.assigneeId || "").trim();
}

function itemMatchesEmployeeScope(item, scope) {
  const scopeId = employeeScopeId(scope);

  if (!scopeId) return true;

  return itemAssigneeId(item) === scopeId;
}

function worklogsForDay(item, selectedDate, employeeScope = null) {
  if (!selectedDate || !Array.isArray(item?.worklogs)) return [];

  return item.worklogs.filter(
    (entry) =>
      isRealImportedWorklog(entry) &&
      worklogMatchesEmployeeScope(entry, employeeScope) &&
      worklogDateToInput(entry.worklogDate || entry.date) === selectedDate
  );
}

function aggregateDayWorklogs(item, selectedDate, employeeScope = null) {
  const worklogs = worklogsForDay(item, selectedDate, employeeScope);
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
  dayProjectionSelections,
  retainedCreationContexts,
  employeeScope = null,
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
  const dayProjectionContextById = new Map();
  const dayContextMembershipById = new Map();
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
    const selectedDate = dateKeyFromValue(selectedId);
    const dateSprints = sprintScopesForDay(sprints, selectedDate);
    const dateSprintIds = new Set(dateSprints.map((sprint) => sprint.id));
    const daySelection = daySelectionForDate(dayProjectionSelections, selectedDate);
    const retainedIds = retainedNodeIdsForContext({
      state: retainedCreationContexts,
      viewMode: "day",
      contextId: selectedDate,
    });

    dateSprints.forEach((sprint) => selectedSprintIds.add(sprint.id));
    if (dateSprints.length > 1 && typeof console !== "undefined") {
      console.warn(
        "Day View selected date matches multiple Sprint ranges; rendering all matching Sprint scopes.",
        {
          selectedDate,
          sprints: dateSprints.map((sprint) => ({
            id: sprint.id,
            title: sprint.title,
            sprintStartDate: sprint.sprintStartDate,
            sprintEndDate: sprint.sprintEndDate,
          })),
        }
      );
    }

    workItems.forEach((item) => {
      const aggregate = aggregateDayWorklogs(item, selectedId, employeeScope);

      if (aggregate.count === 0) return;

      selectedIds.add(item.id);
      dayAggregates.set(item.id, aggregate);

      const sprintId = displaySprintIdForItem(item);
      if (sprintById.has(sprintId)) selectedSprintIds.add(sprintId);
    });

    Object.entries(daySelection.epicsBySprint || {}).forEach(([sprintId, ids]) => {
      if (!dateSprintIds.has(sprintId)) return;

      ids.forEach((id) => {
        const item = itemById.get(id);
        if (item?.type !== "epic") return;

        selectedIds.add(item.id);
        selectedSprintIds.add(sprintId);
        dayContextMembershipById.set(item.id, {
          date: selectedDate,
          source: "projection",
        });
        dayProjectionContextById.set(item.id, {
          sprintId,
          parentId: item.parentId || ROOT_ID,
        });
      });
    });

    Object.entries(daySelection.storiesByEpicScope || {}).forEach(([scopeKey, ids]) => {
      const [epicId, sprintId = ""] = scopeKey.split("::");

      if (!dateSprintIds.has(sprintId)) return;

      ids.forEach((id) => {
        const item = itemById.get(id);
        if (item?.type !== "story") return;
        if (item.parentId !== epicId) return;

        selectedIds.add(item.id);
        selectedSprintIds.add(sprintId);
        dayContextMembershipById.set(item.id, {
          date: selectedDate,
          source: "projection",
        });
        dayProjectionContextById.set(item.id, {
          sprintId,
          parentId: epicId,
        });
      });
    });

    retainedIds.forEach((id) => {
      const item = itemById.get(id);
      if (!item || item.isVirtual || isReferenceNode(item)) return;
      if (!["epic", "story", "job", "task"].includes(item.type)) return;

      const sprintId = dayScopeIdForItem(item);
      if (!dateSprintIds.has(sprintId)) return;

      selectedIds.add(item.id);
      selectedSprintIds.add(sprintId);
      dayContextMembershipById.set(item.id, {
        date: selectedDate,
        source: "retained",
      });
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
      const dayProjectionContext =
        viewMode === "day" ? dayProjectionContextById?.get(item.id) : null;
      const dayContextMembership =
        viewMode === "day" ? dayContextMembershipById?.get(item.id) : null;
      const projectedSprintId = dayProjectionContext?.sprintId || "";
      const projectedSprintTitle = dayProjectionContext
        ? sprintTitleForScope(projectedSprintId, sprints)
        : "";
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
      const contextItem =
        dayProjectionContext
          ? {
              ...dayItem,
              sprintId: isOrphanSprintId(projectedSprintId) ? "" : projectedSprintId,
              sprint: projectedSprintTitle || dayItem.sprint || "",
              targetScopeId: projectedSprintId,
              targetSprintId: projectedSprintId,
              visualParentId:
                (dayProjectionContext.parentId || dayItem.parentId || ROOT_ID) === ROOT_ID
                  ? projectedSprintId
                  : dayProjectionContext.parentId,
              childSprintId: isOrphanSprintId(projectedSprintId)
                ? ""
                : projectedSprintId,
              childSprint: projectedSprintTitle || dayItem.sprint || "",
              isOrphanSprintContext: isOrphanSprintId(projectedSprintId),
            }
          : dayItem;

      return selectedIds.has(contextItem.id)
        ? {
            ...contextItem,
            dayContextDate: dayContextMembership?.date || contextItem.dayContextDate || "",
            isDayProjectionSelected:
              dayContextMembership?.source === "projection" || Boolean(contextItem.isDayProjectionSelected),
            isRetainedDayContext:
              dayContextMembership?.source === "retained" || Boolean(contextItem.isRetainedDayContext),
            isContextPrimary: true,
          }
        : contextItem;
    });

  const selectedSprints = sprints.filter((sprint) => selectedSprintIds.has(sprint.id));

  if (viewMode === "day") {
    selectedSprintIds.forEach((id) => {
      if (selectedSprints.some((sprint) => sprint.id === id)) return;
      if (isOrphanSprintId(id)) {
        selectedSprints.push(sprintScopesForDay([], "").find((sprint) => sprint.id === id));
      }
    });
  }

  return {
    workItems: contextWorkItems,
    rootId: null,
    sprints: selectedSprints.filter(Boolean),
  };
}

function dayViewSummary({ workItems, graphWorkItems, graphSprints, selectedDate, rootTitle, employeeScope }) {
  const dayWorklogs = workItems.flatMap((item) =>
    worklogsForDay(item, selectedDate, employeeScope).map((entry) => ({
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
    sprints: Math.max(
      sprintNames.size,
      (graphSprints || []).filter((sprint) => sprint.id !== ROOT_ID).length
    ),
    epics: graphByType.epic || 0,
    stories: graphByType.story || 0,
    jobs: graphByType.job || 0,
    tasks: graphByType.task || 0,
    dockets: selectedDocketIds.size,
  };
}

function timelineDateOrdinal(value) {
  const key = dateKeyFromValue(value);
  const [year, month, day] = key.split("-").map((part) => Number(part));

  if (![year, month, day].every(Number.isFinite)) return null;

  return Date.UTC(year, month - 1, day) / 86400000;
}

function timelineDateFromOrdinal(ordinal) {
  return new Date(ordinal * 86400000).toISOString().slice(0, 10);
}

function timelineDateLabel(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-");

  return year && month && day ? `${day}/${month}/${year.slice(-2)}` : "--/--/--";
}

function timelineShortDateLabel(dateKey) {
  const [, month, day] = String(dateKey || "").split("-");

  return month && day ? `${day}/${month}` : "--/--";
}

function timelineYearLabel(yearKey) {
  return String(yearKey || "").slice(0, 4) || "Year";
}

function timelineDayLabel(dateKey) {
  const ordinal = timelineDateOrdinal(dateKey);

  if (ordinal === null) return "---";

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(ordinal * 86400000));
}

function timelineMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map((part) => Number(part));

  if (!Number.isFinite(year) || !Number.isFinite(month)) return "Unknown";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function timelineSprintDateLabel(value) {
  const key = dateKeyFromValue(value);
  if (!key) return "Open";

  const [year, month, day] = key.split("-");
  return `${day}/${month}/${year.slice(-2)}`;
}

function timelineSprintStart(sprint = {}) {
  return sprint.sprintStartDate || sprint.startDate || sprint.plannedStartDate || "";
}

function timelineSprintEnd(sprint = {}) {
  return sprint.sprintEndDate || sprint.endDate || sprint.plannedEndDate || "";
}

function timelineSprintLabel(sprint) {
  return sprint?.title || sprint?.name || sprint?.id || ORPHAN_SPRINT_TITLE;
}

function dateKeyForTimelineWorklog(entry) {
  return worklogDateToInput(entry?.worklogDate || entry?.date);
}

function storyOwnerForTimelineItem(item, itemById) {
  if (!item) return null;
  if (item.type === "story") return item;

  let parentId = item.parentId;
  const visited = new Set();

  while (parentId && parentId !== ROOT_ID && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = itemById.get(parentId);

    if (!parent) return null;
    if (parent.type === "story") return parent;
    parentId = parent.parentId;
  }

  return null;
}

function timelineSprintForDate(sprints = [], dateKey) {
  const realMatches = sprints
    .filter((sprint) => sprint?.id && sprint.id !== ROOT_ID && !isOrphanSprintId(sprint.id))
    .filter((sprint) => sprintContainsDate(sprint, dateKey))
    .sort((first, second) =>
      [
        dateKeyFromValue(timelineSprintStart(first)) || "9999-12-31",
        dateKeyFromValue(timelineSprintEnd(first)) || "9999-12-31",
        timelineSprintLabel(first),
      ].join(":").localeCompare(
        [
          dateKeyFromValue(timelineSprintStart(second)) || "9999-12-31",
          dateKeyFromValue(timelineSprintEnd(second)) || "9999-12-31",
          timelineSprintLabel(second),
        ].join(":")
      )
    );

  if (realMatches.length === 1) return realMatches[0];
  if (realMatches.length > 1) {
    return {
      id: realMatches.map((sprint) => sprint.id).join("|"),
      title: realMatches.map(timelineSprintLabel).join(" / "),
      isOverlappingSprintGroup: true,
      sourceSprints: realMatches,
    };
  }

  return {
    id: ORPHAN_SPRINT_ID,
    title: ORPHAN_SPRINT_TITLE,
    isOrphanSprint: true,
  };
}

function earliestTimelineDate({ workItems = [], sprints = [], todayKey }) {
  const candidates = [todayKey];

  sprints.forEach((sprint) => {
    const start = dateKeyFromValue(timelineSprintStart(sprint));
    if (start) candidates.push(start);
  });

  workItems.forEach((item) => {
    const created = dateKeyFromValue(item.createdAt);
    if (created) candidates.push(created);
    const updated = dateKeyFromValue(item.updatedAt);
    if (updated) candidates.push(updated);
    (item.worklogs || []).forEach((entry) => {
      const key = dateKeyForTimelineWorklog(entry);
      if (key) candidates.push(key);
    });
  });

  return candidates
    .filter(Boolean)
    .sort((first, second) => timelineDateOrdinal(first) - timelineDateOrdinal(second))[0] || todayKey;
}

function buildDayTimelineModel({ workItems = [], sprints = [], selectedDate, todayKey, employeeScope = null }) {
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const daily = new Map();

  function ensureDay(dateKey) {
    if (!daily.has(dateKey)) {
      daily.set(dateKey, {
        dateKey,
        minutes: 0,
        storyIds: new Set(),
        storyPoints: 0,
      });
    }

    return daily.get(dateKey);
  }

  workItems.forEach((item) => {
    (item.worklogs || []).forEach((entry) => {
      if (!isRealImportedWorklog(entry)) return;
      if (!worklogMatchesEmployeeScope(entry, employeeScope)) return;

      const dateKey = dateKeyForTimelineWorklog(entry);
      if (!dateKey) return;

      const day = ensureDay(dateKey);
      day.minutes += worklogMinutes(entry);

      const story = storyOwnerForTimelineItem(item, itemById);
      if (story?.id && itemMatchesEmployeeScope(story, employeeScope)) {
        day.storyIds.add(story.id);
      }
    });
  });

  daily.forEach((day) => {
    day.storyPoints = Array.from(day.storyIds).reduce(
      (total, storyId) => total + Number(itemById.get(storyId)?.storyPoints || 0),
      0
    );
  });

  const startKey = earliestTimelineDate({ workItems, sprints, todayKey });
  const startOrdinal = timelineDateOrdinal(startKey) ?? timelineDateOrdinal(todayKey);
  const todayOrdinal = timelineDateOrdinal(todayKey);
  const days = [];

  for (let ordinal = startOrdinal; ordinal <= Math.max(startOrdinal, todayOrdinal); ordinal += 1) {
    const dateKey = timelineDateFromOrdinal(ordinal);
    const day = ensureDay(dateKey);
    const sprint = timelineSprintForDate(sprints, dateKey);
    const dayOfWeek = new Date(ordinal * 86400000).getUTCDay();

    days.push({
      ...day,
      storyIds: Array.from(day.storyIds),
      sprint,
      sprintId: sprint.id,
      sprintTitle: timelineSprintLabel(sprint),
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      isToday: dateKey === todayKey,
      isSelected: dateKey === selectedDate,
    });
  }

  const monthsByKey = new Map();
  const yearsByKey = new Map();
  const sprintsById = new Map();

  days.forEach((day) => {
    const monthKey = day.dateKey.slice(0, 7);
    const yearKey = day.dateKey.slice(0, 4);
    if (!monthsByKey.has(monthKey)) {
      monthsByKey.set(monthKey, {
        key: monthKey,
        label: timelineMonthLabel(monthKey),
        startDate: day.dateKey,
        endDate: day.dateKey,
        minutes: 0,
        storyIds: new Set(),
      });
    }
    const month = monthsByKey.get(monthKey);
    month.endDate = day.dateKey;
    month.minutes += day.minutes;
    day.storyIds.forEach((id) => month.storyIds.add(id));

    if (!yearsByKey.has(yearKey)) {
      yearsByKey.set(yearKey, {
        key: yearKey,
        label: timelineYearLabel(yearKey),
        startDate: day.dateKey,
        endDate: day.dateKey,
        minutes: 0,
        storyIds: new Set(),
      });
    }
    const year = yearsByKey.get(yearKey);
    year.endDate = day.dateKey;
    year.minutes += day.minutes;
    day.storyIds.forEach((id) => year.storyIds.add(id));

    const sprintId = day.sprintId || ORPHAN_SPRINT_ID;
    if (!sprintsById.has(sprintId)) {
      sprintsById.set(sprintId, {
        id: sprintId,
        title: day.sprintTitle,
        startDate: day.dateKey,
        endDate: day.dateKey,
        minutes: 0,
        storyIds: new Set(),
        isOrphanSprint: sprintId === ORPHAN_SPRINT_ID,
      });
    }
    const sprint = sprintsById.get(sprintId);
    sprint.endDate = day.dateKey;
    sprint.minutes += day.minutes;
    day.storyIds.forEach((id) => sprint.storyIds.add(id));
  });

  function finalizeAggregate(entry) {
    const storyIds = Array.from(entry.storyIds);

    return {
      ...entry,
      storyIds,
      storyPoints: storyIds.reduce(
        (total, storyId) => total + Number(itemById.get(storyId)?.storyPoints || 0),
        0
      ),
    };
  }

  return {
    days,
    months: Array.from(monthsByKey.values()).map(finalizeAggregate),
    years: Array.from(yearsByKey.values()).map(finalizeAggregate),
    sprints: Array.from(sprintsById.values()).map(finalizeAggregate),
    todayKey,
    selectedDate,
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
  return docketStateLabel(state);
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

const EMPTY_SYNC_ACTIVITY = {
  direction: "idle",
  phase: "idle",
  state: "idle",
  message: "Idle",
  entityType: "",
  operationType: "",
  current: null,
  total: null,
  unit: "",
  startedAt: "",
  updatedAt: "",
  completedAt: "",
  error: "",
  history: [],
};

function sanitizeSyncActivityText(value, fallback = "") {
  const text = String(value || fallback || "").trim();

  if (!text) return "";
  if (/(authorization|cookie|jwt|token|session|password|secret)/i.test(text)) {
    return "Progress update";
  }

  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function numericProgressValue(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function syncActivityStateFromProgress(progress = {}, fallbackState = "running") {
  if (progress.state) return progress.state;
  if (progress.phase === "complete") return "synced";
  if (progress.phase === "failed") return "failed";
  if (progress.phase === "warning") return "running";

  return fallbackState;
}

function normalizeSyncActivityEvent(progress = {}, fallbackDirection = "inbound", previous = EMPTY_SYNC_ACTIVITY) {
  const now = progress.emittedAt || new Date().toISOString();
  const state = syncActivityStateFromProgress(progress);
  const direction = progress.direction || fallbackDirection;
  const current = numericProgressValue(progress.current);
  const total = numericProgressValue(progress.total);
  const historyEntry =
    previous?.message && previous.message !== "Idle"
      ? {
          message: previous.message,
          phase: previous.phase,
          direction: previous.direction,
          updatedAt: previous.updatedAt,
        }
      : null;
  const nextHistory = historyEntry
    ? [historyEntry, ...(previous.history || [])].slice(0, 5)
    : previous.history || [];

  return {
    direction,
    phase: progress.phase || previous.phase || "running",
    state,
    message: sanitizeSyncActivityText(progress.message, previous.message || "Syncing..."),
    entityType: sanitizeSyncActivityText(progress.entityType || previous.entityType || ""),
    operationType: sanitizeSyncActivityText(progress.operationType || previous.operationType || ""),
    current,
    total,
    unit: sanitizeSyncActivityText(progress.unit || previous.unit || ""),
    startedAt: previous.startedAt || now,
    updatedAt: now,
    completedAt: state === "synced" || state === "failed" ? now : "",
    error: state === "failed" ? sanitizeSyncActivityText(progress.error || progress.message || "") : "",
    history: nextHistory,
  };
}

function localSavedSyncActivity(message = "Saved locally", previous = EMPTY_SYNC_ACTIVITY) {
  const now = new Date().toISOString();

  return {
    ...EMPTY_SYNC_ACTIVITY,
    direction: "local",
    phase: "saved-local",
    state: "local",
    message,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    history: previous?.message && previous.message !== "Idle"
      ? [
          {
            message: previous.message,
            phase: previous.phase,
            direction: previous.direction,
            updatedAt: previous.updatedAt,
          },
          ...(previous.history || []),
        ].slice(0, 5)
      : previous.history || [],
  };
}

function completeSyncActivity(direction, message, previous = EMPTY_SYNC_ACTIVITY) {
  return normalizeSyncActivityEvent(
    {
      direction,
      state: "synced",
      phase: "complete",
      message,
      current: previous.current,
      total: previous.total,
      unit: previous.unit,
    },
    direction,
    previous
  );
}

function failedSyncActivity(direction, message, previous = EMPTY_SYNC_ACTIVITY) {
  return normalizeSyncActivityEvent(
    {
      direction,
      state: "failed",
      phase: "failed",
      message,
      error: message,
      current: previous.current,
      total: previous.total,
      unit: previous.unit,
    },
    direction,
    previous
  );
}

function syncActivityDirectionLabel(direction, presentation = {}) {
  return presentation.directionLabel || syncPresentationDirectionLabel(direction);
}

function syncActivityProgressLabel(activity) {
  if (activity.current !== null && activity.total !== null && activity.total > 0) {
    const unit = activity.unit ? ` ${activity.unit}` : "";

    return `${activity.current} / ${activity.total}${unit}`;
  }

  return "Unknown";
}

function syncActivityRows(activity, presentation = {}) {
  const rows = [
    ["State", formatLabel(activity.state)],
    ["Direction", syncActivityDirectionLabel(activity.direction, presentation)],
    ["Activity", activity.message || "Idle"],
  ];

  if (activity.state === "running" && activity.entityType) {
    rows.push(["Entity", formatLabel(activity.entityType)]);
  }
  if (activity.state === "running" && activity.operationType) {
    rows.push(["Operation", formatLabel(activity.operationType)]);
  }
  if (activity.state === "running" || activity.current !== null || activity.total !== null) {
    rows.push(["Progress", syncActivityProgressLabel(activity)]);
  }
  if (activity.error) rows.push(["Error", activity.error]);
  if (activity.updatedAt) rows.push(["Updated", formatTimestamp(activity.updatedAt)]);

  return rows;
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

function normalizeInlineSearch(value) {
  return String(value || "").toLowerCase().trim();
}

function workItemSearchText(item = {}) {
  const worklogText = Array.isArray(item.worklogs)
    ? item.worklogs
        .flatMap((entry) => [
          entry?.comment,
          entry?.description,
          entry?.date,
          entry?.worklogDate,
        ])
        .join(" ")
    : "";

  return [
    item.title,
    item.name,
    item.description,
    item.type,
    item.category,
    item.priority,
    item.docketState,
    item.sprint,
    item.id,
    item.num,
    item.docketNum,
    item.docketNumber,
    item.code,
    item.elitical?.num,
    item.elitical?.code,
    item.elitical?.remoteId,
    worklogText,
  ]
    .map(normalizeInlineSearch)
    .filter(Boolean)
    .join(" ");
}

function searchItemForWorkItem(item = {}) {
  return {
    id: item.id,
    focusId: item.sourceItemId || item.sourceDocketId || item.sourceId || item.id,
    canonicalId: item.sourceItemId || item.sourceDocketId || item.sourceId || item.id,
    entityType: item.type || "docket",
    label: item.title || item.id,
    docketNumber: docketNumberForItem(item),
    sourceItem: item,
    searchText: workItemSearchText(item),
  };
}

function sprintSearchText(sprint = {}) {
  return [
    sprint.id,
    sprint.title,
    sprint.name,
    sprint.code,
    sprint.num,
    sprint.sprintState,
    sprint.state,
    "sprint",
  ]
    .map(normalizeInlineSearch)
    .filter(Boolean)
    .join(" ");
}

function worklogSearchItemsForWorkItems(items = []) {
  return items.flatMap((item) =>
    (item.worklogs || []).map((entry, index) => ({
      id: `worklog:${item.id}:${entry.id || entry.worklogId || entry.date || index}`,
      focusId: item.id,
      entityType: "worklog",
      label: entry.comment || entry.description || `${item.title} Worklog`,
      searchText: [
        item.title,
        item.id,
        docketNumberForItem(item),
        entry.comment,
        entry.description,
        entry.date,
        entry.worklogDate,
        entry.employeeName,
        "worklog",
      ]
        .map(normalizeInlineSearch)
        .filter(Boolean)
        .join(" "),
    }))
  );
}

function searchItemsForCurrentView({
  viewMode,
  graphWorkItems = [],
  graphSprints = [],
  rootTitle = "",
  mainTitle = "",
}) {
  // Future views must expose only their current rendered/scope dataset here.
  // Do not fall back to a global workspace search for unknown view modes.
  if (viewMode === "dashboard") {
    return [
      {
        id: ROOT_ID,
        focusId: ROOT_ID,
        entityType: "project",
        label: rootTitle || mainTitle || "Project",
        searchText: normalizeInlineSearch(`${rootTitle} ${mainTitle} project dashboard`),
      },
      ...graphSprints.map((sprint) => ({
        id: sprint.id,
        focusId: sprint.id,
        entityType: "sprint",
        label: sprint.title || sprint.id,
        searchText: sprintSearchText(sprint),
      })),
      ...graphWorkItems.map((item) => ({
        ...searchItemForWorkItem(item),
      })),
    ];
  }

  if (viewMode === "worklog") {
    return [
      ...graphWorkItems
        .filter((item) => item.type === "job")
        .map((item) => searchItemForWorkItem(item)),
      ...worklogSearchItemsForWorkItems(graphWorkItems),
    ];
  }

  if (viewMode === "backlog") {
    return graphWorkItems
      .filter((item) => item.isBacklogEligible || item.isBacklogDateGroup)
      .map((item) => searchItemForWorkItem(item));
  }

  if (
    viewMode === "main" ||
    viewMode === "sprint" ||
    viewMode === "epic" ||
    viewMode === "story" ||
    viewMode === "job" ||
    viewMode === "task" ||
    viewMode === "day" ||
    viewMode === "focused"
  ) {
    return [
      ...graphSprints.map((sprint) => ({
        id: sprint.id,
        focusId: sprint.id,
        entityType: "sprint",
        label: sprint.title || sprint.id,
        searchText: sprintSearchText(sprint),
      })),
      ...graphWorkItems.map((item) => searchItemForWorkItem(item)),
    ];
  }

  return [];
}

function primaryWorklogDate(item) {
  const primary = Array.isArray(item?.worklogs) ? item.worklogs[0] : null;
  return primary?.date || item?.updatedAt || item?.createdAt;
}

function MetadataBadge({ children }) {
  return <span className="metadata-badge">{children || "-"}</span>;
}

function DashboardView({ workItems, sprints, rootTitle, totals, lastSyncedAt, employeeScope = null }) {
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
        .filter((entry) => worklogMatchesEmployeeScope(entry, employeeScope))
        .reduce((sum, entry) => sum + Number(entry.timeMinutes || 0), 0),
    0
  );
  const loggedThisWeek = workItems.reduce(
    (total, item) =>
      total +
      (item.worklogs || [])
        .filter((entry) => {
          const date = new Date(entry.date);
          return (
            !Number.isNaN(date.getTime()) &&
            date >= weekStart &&
            worklogMatchesEmployeeScope(entry, employeeScope)
          );
        })
        .reduce((sum, entry) => sum + Number(entry.timeMinutes || 0), 0),
    0
  );
  const cards = [
    ["Active Sprint", rootTitle || sprints[0]?.title || "-"],
    ["Total Epics", epics.length],
    ["Total Stories", stories.length],
    ["Total Jobs", jobs.length],
    ["Completed Jobs", jobs.filter((item) => ["artifact", "closed"].includes(normalizeDocketState(item.docketState))).length],
    ["In Progress Jobs", jobs.filter((item) => ["concept", "design", "in-review"].includes(normalizeDocketState(item.docketState))).length],
    ["Artifact Jobs", jobs.filter((item) => normalizeDocketState(item.docketState) === "artifact").length],
    ["Story Points", totals.rootTotal],
    ["Hours Logged Today", formatWorkDuration(loggedToday)],
    ["Hours Logged This Week", formatWorkDuration(loggedThisWeek)],
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
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const selectedOption = options.find((option) => option.id === value);
  const filteredOptions = useMemo(() => {
    const normalized = normalizeContextSearch(query);

    if (!normalized) return options;

    return options.filter((option) =>
      contextOptionSearchText(option, viewMode).includes(normalized)
    );
  }, [options, query, viewMode]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, viewMode, options.length]);

  useEffect(() => {
    if (!open) return undefined;

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    function closeSelector({ focusTrigger = false } = {}) {
      setOpen(false);
      setQuery("");
      setActiveIndex(0);
      if (focusTrigger) triggerRef.current?.focus();
    }

    function handlePointerDown(event) {
      if (selectorRef.current?.contains(event.target)) return;

      closeSelector();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeSelector({ focusTrigger: true });
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function openSelector() {
    setOpen(true);
  }

  function closeSelector({ focusTrigger = false } = {}) {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function selectOption(optionId) {
    onChange(optionId);
    closeSelector({ focusTrigger: true });
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openSelector();
      setActiveIndex((current) =>
        Math.min(current + 1, Math.max(0, filteredOptions.length - 1))
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      openSelector();
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === "Enter" && open && filteredOptions[activeIndex]) {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex].id);
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeSelector({ focusTrigger: true });
    }
  }

  return (
    <section className="context-graph-selector" ref={selectorRef}>
      <span>{label}</span>
      <div className="context-graph-select">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : contextOptionLabel(selectedOption, viewMode)}
          placeholder={`Select ${label}`}
          onClick={openSelector}
          onFocus={openSelector}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            setQuery(event.target.value);
            openSelector();
          }}
          aria-label={`Select ${label}`}
          aria-expanded={open}
          aria-controls={`context-options-${viewMode}`}
          aria-autocomplete="list"
          role="combobox"
        />
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (open) {
              closeSelector();
            } else {
              openSelector();
            }
          }}
          aria-label={`Toggle ${label} list`}
        >
          v
        </button>
        {open && (
          <div
            id={`context-options-${viewMode}`}
            className="context-graph-menu"
            role="listbox"
          >
            {filteredOptions.length === 0 ? (
              <div className="context-graph-empty">
                {emptyContextOptionsLabel(label, options, query)}
              </div>
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

function DayViewToolbar({ value, onChange, summary, inline = false }) {
  if (!summary) return null;

  const rows = [
    ["Worklogs", summary.worklogs],
    ["Logged", formatWorkDuration(summary.totalMinutes)],
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
      {!inline && (
        <div className="day-view-stats" aria-label="Day View statistics">
          {rows.map(([label, value]) => (
            <span key={label}>
              {label} {value}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function dateForTimelineMonth(month, selectedDate) {
  const selectedKey = dateKeyFromValue(selectedDate);
  const selectedOrdinal = timelineDateOrdinal(selectedKey);
  const startOrdinal = timelineDateOrdinal(month?.startDate);
  const endOrdinal = timelineDateOrdinal(month?.endDate);

  if (
    selectedOrdinal !== null &&
    startOrdinal !== null &&
    endOrdinal !== null &&
    selectedOrdinal >= startOrdinal &&
    selectedOrdinal <= endOrdinal
  ) {
    return selectedKey;
  }

  return month?.startDate || selectedKey || formatDateInput(new Date());
}

function dateForTimelineYear(year, selectedDate) {
  const selectedKey = dateKeyFromValue(selectedDate);
  const selectedOrdinal = timelineDateOrdinal(selectedKey);
  const startOrdinal = timelineDateOrdinal(year?.startDate);
  const endOrdinal = timelineDateOrdinal(year?.endDate);

  if (
    selectedOrdinal !== null &&
    startOrdinal !== null &&
    endOrdinal !== null &&
    selectedOrdinal >= startOrdinal &&
    selectedOrdinal <= endOrdinal
  ) {
    return selectedKey;
  }

  return year?.startDate || selectedKey || formatDateInput(new Date());
}

function dateForTimelineSprint(sprint, selectedDate, todayKey) {
  const selectedKey = dateKeyFromValue(selectedDate);
  const selectedOrdinal = timelineDateOrdinal(selectedKey);
  const todayOrdinal = timelineDateOrdinal(todayKey);
  const startOrdinal = timelineDateOrdinal(sprint?.startDate);
  const endOrdinal = timelineDateOrdinal(sprint?.endDate);

  if (startOrdinal !== null && endOrdinal !== null) {
    if (todayOrdinal !== null && todayOrdinal >= startOrdinal && todayOrdinal <= endOrdinal) {
      return todayKey;
    }
    if (selectedOrdinal !== null && selectedOrdinal >= startOrdinal && selectedOrdinal <= endOrdinal) {
      return selectedKey;
    }
  }

  return sprint?.startDate || selectedKey || todayKey || formatDateInput(new Date());
}

function TimelineMetric({ label, value }) {
  return (
    <span className="timeline-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function DayTimelineNavigation({ model, selectedDate, todayKey, onSelectDate }) {
  const [mode, setMode] = useState("days");
  const [expanded, setExpanded] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef(null);
  const scrollerRef = useRef(null);
  const selectedRef = useRef(null);
  const todayRef = useRef(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    const target = selectedRef.current || (!didInitialScrollRef.current ? todayRef.current : null);

    if (target) {
      target.scrollIntoView({
        block: "nearest",
        inline: didInitialScrollRef.current ? "nearest" : "end",
        behavior: didInitialScrollRef.current ? "smooth" : "auto",
      });
    } else if (!didInitialScrollRef.current && scrollerRef.current) {
      scrollerRef.current.scrollLeft = scrollerRef.current.scrollWidth;
    }

    didInitialScrollRef.current = true;
  }, [mode, selectedDate]);

  useDismissableLayer({
    open: modeMenuOpen,
    refs: [modeMenuRef],
    onDismiss: () => setModeMenuOpen(false),
  });

  if (!model) return null;

  const modes = [
    ["days", "Days"],
    ["months", "Months"],
    ["years", "Years"],
    ["sprints", "Sprints"],
  ];
  const dayItems = model.days || [];
  const monthItems = model.months || [];
  const yearItems = model.years || [];
  const sprintItems = model.sprints || [];
  const selectedModeLabel = modes.find(([id]) => id === mode)?.[1] || "Days";
  const dayStatusClass = (day) => {
    if (day.isWeekend) return "status-weekend";
    if (day.minutes >= 480) return "status-complete";
    if (day.minutes > 0) return "status-partial";

    return "status-missing";
  };

  return (
    <section
      className={`day-timeline-navigation ${expanded ? "expanded" : "collapsed"}`}
      aria-label="Day timeline navigation"
    >
      <div className="day-timeline-row">
        <div ref={modeMenuRef} className="timeline-mode-dropdown">
          <button
            type="button"
            className="timeline-mode-trigger"
            onClick={() => setModeMenuOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;

              event.preventDefault();
              setModeMenuOpen(true);
            }}
            aria-haspopup="listbox"
            aria-expanded={modeMenuOpen}
            aria-label="Timeline mode"
          >
            <span>{selectedModeLabel}</span>
            <span aria-hidden="true">v</span>
          </button>
          {modeMenuOpen ? (
            <div className="timeline-mode-menu" role="listbox" aria-label="Timeline modes">
              {modes.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={mode === id ? "selected" : ""}
                  onClick={() => {
                    setMode(id);
                    setModeMenuOpen(false);
                  }}
                  role="option"
                  aria-selected={mode === id}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div ref={scrollerRef} className="day-timeline-scroller">
        {mode === "days" &&
          dayItems.map((day, index) => {
            const previousDay = dayItems[index - 1];
            const nextDay = dayItems[index + 1];
            const startsSprintGroup = !previousDay || previousDay.sprintId !== day.sprintId;
            const endsSprintGroup = !nextDay || nextDay.sprintId !== day.sprintId;
            const className = [
              "day-timeline-cell",
              "timeline-day-cell",
              day.isSelected ? "selected" : "",
              day.isToday ? "today" : "",
              day.isWeekend ? "weekend" : "",
              dayStatusClass(day),
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <button
                key={day.dateKey}
                ref={day.isSelected ? selectedRef : day.isToday ? todayRef : null}
                type="button"
                className={className}
                onClick={() => onSelectDate(day.dateKey)}
                aria-current={day.isSelected ? "date" : undefined}
              >
                {expanded ? (
                  <span className="timeline-sprint-label">
                    {startsSprintGroup ? day.sprintTitle : "\u00a0"}
                  </span>
                ) : null}
                <span className="timeline-date-row">
                  <span className="timeline-date">
                    {expanded ? timelineDateLabel(day.dateKey) : timelineShortDateLabel(day.dateKey)}
                  </span>
                  {expanded ? (
                    <span className="timeline-day">{timelineDayLabel(day.dateKey)}</span>
                  ) : null}
                </span>
                {expanded ? (
                  <span className="timeline-metric-row">
                    <TimelineMetric label="Logged" value={formatWorkDuration(day.minutes)} />
                    <TimelineMetric label="SP" value={day.storyPoints} />
                  </span>
                ) : (
                  <span className="timeline-collapsed-time">
                    {formatWorkDuration(day.minutes)}
                  </span>
                )}
                {day.isToday ? <span className="timeline-today-label">Today</span> : null}
              </button>
            );
          })}

        {mode === "months" &&
          monthItems.map((month) => (
            <button
              key={month.key}
              type="button"
              className="day-timeline-cell timeline-month-cell"
              onClick={() => onSelectDate(dateForTimelineMonth(month, selectedDate))}
            >
              <span className="timeline-sprint-label">
                {timelineDateLabel(month.startDate)} - {timelineDateLabel(month.endDate)}
              </span>
              <span className="timeline-date">{month.label}</span>
              {expanded ? (
                <>
                  <TimelineMetric label="Logged" value={formatWorkDuration(month.minutes)} />
                  <TimelineMetric label="SP" value={month.storyPoints} />
                </>
              ) : null}
            </button>
          ))}

        {mode === "years" &&
          yearItems.map((year) => {
            const selectedYear = dateKeyFromValue(selectedDate).slice(0, 4);

            return (
              <button
                key={year.key}
                type="button"
                className={`day-timeline-cell timeline-year-cell ${
                  year.key === selectedYear ? "selected" : ""
                }`}
                onClick={() => onSelectDate(dateForTimelineYear(year, selectedDate))}
                aria-current={year.key === selectedYear ? "date" : undefined}
              >
                <span className="timeline-sprint-label">
                  {timelineDateLabel(year.startDate)} - {timelineDateLabel(year.endDate)}
                </span>
                <span className="timeline-date">{year.label}</span>
                {expanded ? (
                  <>
                    <TimelineMetric label="Logged" value={formatWorkDuration(year.minutes)} />
                    <TimelineMetric label="SP" value={year.storyPoints} />
                  </>
                ) : null}
              </button>
            );
          })}

        {mode === "sprints" &&
          sprintItems.map((sprint) => (
            <button
              key={sprint.id}
              type="button"
              className="day-timeline-cell timeline-sprint-cell"
              onClick={() => onSelectDate(dateForTimelineSprint(sprint, selectedDate, todayKey))}
            >
              <span className="timeline-sprint-label">
                {timelineDateLabel(sprint.startDate)} - {timelineDateLabel(sprint.endDate)}
              </span>
              <span className="timeline-date">{sprint.title}</span>
              {expanded ? (
                <>
                  <TimelineMetric label="Logged" value={formatWorkDuration(sprint.minutes)} />
                  <TimelineMetric label="SP" value={sprint.storyPoints} />
                </>
              ) : null}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="global-icon-button day-timeline-toggle"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? "Collapse day timeline" : "Expand day timeline"}
          aria-expanded={expanded}
          title={expanded ? "Collapse timeline" : "Expand timeline"}
        >
          <span aria-hidden="true">{expanded ? "^" : "v"}</span>
        </button>
      </div>
    </section>
  );
}

function canonicalAddExistingUpdates({ request, child, sprints }) {
  if (!request || !child) return null;

  if (request.type === "epic" && request.sprintId) {
    const sprintName = sprintNameForId(sprints, request.sprintId);

    return {
      sprintId: request.sprintId,
      sprintName,
      sprint: sprintName,
    };
  }

  if (request.type === "story" && request.parentId) {
    return {
      parentId: request.parentId,
      epicId: request.parentId,
      sprintId: request.sprintId || child.elitical?.sprintId || child.sprintId || "",
      sprintName: request.sprint || sprintNameForId(sprints, request.sprintId),
      sprint: request.sprint || sprintNameForId(sprints, request.sprintId),
    };
  }

  return null;
}

function AddExistingChildModal({
  request,
  selectedDate,
  workItems,
  sprints,
  projectionState,
  onSelect,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const modalRef = useRef(null);
  const isDayMode = request?.mode === "day";
  const scopeId = request?.isOrphanSprint
    ? ORPHAN_SPRINT_ID
    : request?.sprintId || ORPHAN_SPRINT_ID;
  const scopeTitle = sprintTitleForScope(scopeId, sprints);
  const daySelection = useMemo(
    () => daySelectionForDate(projectionState, selectedDate),
    [projectionState, selectedDate]
  );
  const options = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const alreadySelected = isDayMode
      ? new Set(
          request?.type === "story"
            ? daySelection.storiesByEpicScope[
                dayEpicScopeKey(request.parentId, scopeId)
              ] || []
            : daySelection.epicsBySprint[scopeId] || []
        )
      : new Set();
    const candidates = workItems.filter((item) => {
      if (item.type !== request?.type) return false;
      if (alreadySelected.has(item.id)) return false;
      if (isReferenceNode(item)) return false;

      if (isDayMode) {
        if (dayScopeIdForItem(item) !== scopeId) return false;
        if (request.type === "story" && item.parentId !== request.parentId) return false;
      } else if (request.type === "epic") {
        if (!request.sprintId || dayScopeIdForItem(item) === request.sprintId) return false;
      } else if (request.type === "story") {
        if (!request.parentId || item.parentId === request.parentId) return false;
      } else {
        return false;
      }

      if (!normalizedQuery) return true;

      return [
        item.title,
        item.elitical?.num,
        item.id,
        item.description,
      ].some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    });

    return candidates.sort((first, second) =>
      String(first.title || "").localeCompare(String(second.title || ""))
    );
  }, [daySelection, isDayMode, query, request, scopeId, workItems]);
  const title = `Add Existing ${formatType(request?.type || "docket")}`;
  const parentTitle =
    request?.type === "story"
      ? workItems.find((item) => item.id === request.parentId)?.title || "Epic"
      : scopeTitle;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropMouseDown(event) {
    if (event.target !== event.currentTarget) return;
    onClose();
  }

  const modalContent = (
    <div
      className="modal-backdrop add-existing-backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <section
        ref={modalRef}
        className="modal-card day-add-existing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-existing-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-header-main">
            <span className="modal-kicker">
              {isDayMode ? `Day View · ${dateKeyFromValue(selectedDate)}` : "Current View"}
            </span>
            <h2 id="add-existing-title">{title}</h2>
            <p>{parentTitle}</p>
          </div>
          <div className="modal-header-actions">
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>
        <div className="modal-body add-existing-body">
          <label className="modal-field wide">
            <span>Search</span>
            <input
              autoFocus
              className="modal-control"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${request?.type || "docket"}s...`}
            />
          </label>
          <div className="day-add-existing-list">
            {options.length === 0 ? (
              <div className="context-graph-empty">No matching existing items</div>
            ) : (
              options.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                >
                  <span>{item.title}</span>
                  <small>
                    {[item.elitical?.num || item.id, scopeTitle]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </button>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );

  return createPortal(modalContent, document.body);
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

  const stateOptions = mergeOption(
    lookups.states,
    initialDraft.stateId,
    docketStateApiName(item.docketState)
  );
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
    const nextDocketState = localDocketStateValue(
      optionLabel(stateOptions, draft.stateId, item.docketState),
      item.docketState
    );
    const localUpdates = {
      title,
      description: draft.description.trim(),
      docketState: nextDocketState,
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
      dktStateName: docketStateApiName(localUpdates.docketState),
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
              getOptionLabel={(value) => stateOptionDisplayLabel(stateOptions, value, formatLabel(value))}
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
            <WorklogPanelField label="Logged" value={formatWorkDuration(loggedMinutes)} />
            <WorklogPanelField label="Remaining" value={formatWorkDuration(remainingMinutes)} />
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
            <span>Logged {formatWorkDuration(totalLoggedMinutes)}</span>
          </div>
          {sortedHistory.length === 0 ? (
            <p className="worklog-empty">No worklogs yet.</p>
          ) : (
            <div className="worklog-history-list">
              {sortedHistory.map((entry) => (
                <article key={entry.id || `${entry.date}-${entry.description}`} className="worklog-history-entry">
                  <div>
                    <strong>{formatDateLabel(entry.date)}</strong>
                    <span>{formatWorkDuration(entry.durationMinutes)}</span>
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
    ? normalizeDocketState(modal.docketState)
    : createSprintParent
    ? normalizeDocketState(createSprintParent.docketState || rootDocketState)
    : isSprint
    ? normalizeDocketState(rootDocketState)
    : isMainRoot
    ? "concept"
    : inheritedDocketState(sprintParentId, workItems, rootDocketState);
  const initialDraft =
    modal.kind === "create"
      ? makeCreateDraft(modal.type, fallbackSprint, fallbackDocketState)
      : isMainRoot
      ? { title: mainTitle || "Genesis" }
      : isRoot
      ? { title: rootTitle, docketState: normalizeDocketState(rootDocketState) }
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
    ? normalizeDocketState(rootDocketState)
    : activeSprint
    ? normalizeDocketState(activeSprint.docketState)
    : isMainRoot
    ? "concept"
    : normalizeDocketState(activeItem?.docketState || draft?.docketState);
  const currentSprint = isSprint || isMainRoot
    ? rootTitle
    : activeItem?.sprint || draft?.sprint || fallbackSprint;
  const modalStateOptions = activeItem ? mergeOption(
    buildLocalStateOptions(activeItem, workItems),
    draft?.stateId || "",
    draft?.stateName || docketStateApiName(currentDocketState)
  ) : modal.kind === "create" ? mergeOption(
    buildLocalStateOptions({}, workItems),
    draft?.stateId || docketStateApiId(currentDocketState),
    draft?.stateName || docketStateApiName(currentDocketState)
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
        docketState: normalizeDocketState(draft.docketState),
      }) : onSaveSprint(activeSprint.id, {
        title: draft.title,
        docketState: normalizeDocketState(draft.docketState),
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
      docketState: normalizeDocketState(draft.docketState),
      stateId: draft.stateId || docketStateApiId(draft.docketState),
      stateName: docketStateApiName(draft.docketState),
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
        ? { title: rootTitle, docketState: normalizeDocketState(rootDocketState) }
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
      } SP · ${formatWorkDuration(totals.rootTimeMinutes || 0)}`
    : isSprint
    ? `${formatDocketState(currentDocketState)} · ${
        totals.rootTotal
      } SP · ${formatWorkDuration(totals.rootTimeMinutes || 0)}`
    : `${formatLabel(currentPriority)} · ${formatDocketState(
        currentDocketState
      )} · ${formatWorkDuration(calculatedTime)}`;
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
                  const docketState = localDocketStateValue(stateName, currentDocketState);
                  updateDraftFields({
                    stateId: value,
                    stateName: docketStateApiName(docketState),
                    docketState,
                  });
                }}
                getOptionLabel={(value) => stateOptionDisplayLabel(modalStateOptions, value, currentDocketState)}
                wide
              />
            ) : (
              <ReadOnlyField label="Docket State" value={formatDocketState(currentDocketState)} wide />
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
                      value={formatWorkDuration(totals.rootTimeMinutes || 0)}
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
                      value={formatWorkDuration(totals.rootTimeMinutes || 0)}
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
                      value={normalizeDocketState(draft.docketState)}
                      options={DOCKET_STATES}
                      onChange={(value) => updateDraft("docketState", normalizeDocketState(value))}
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
                            const docketState = localDocketStateValue(stateName, currentDocketState);
                            updateDraftFields({
                              stateId: value,
                              stateName: docketStateApiName(docketState),
                              docketState,
                            });
                          }}
                          getOptionLabel={(value) => stateOptionDisplayLabel(modalStateOptions, value, currentDocketState)}
                        />
                      ) : (
                        <ReadOnlyField label="Docket State" value={formatDocketState(currentDocketState)} />
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
                        value={formatWorkDuration(calculatedTime)}
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

function ToolbarIcon({ type }) {
  if (type === "search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="7" />
        <path d="m16.5 16.5 4 4" />
      </svg>
    );
  }

  if (type === "sync-status") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 12a8 8 0 0 1-14.2 5" />
        <path d="M4 12a8 8 0 0 1 14.2-5" />
        <path d="M5 17H2v3" />
        <path d="M19 7h3V4" />
      </svg>
    );
  }

  if (type === "sync-failed") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
      </svg>
    );
  }

  if (type === "cloud-upload") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M17.5 18.5h.5a4 4 0 0 0 .4-7.98 6.2 6.2 0 0 0-11.9-1.8A4.8 4.8 0 0 0 6 18.5h.5" />
        <path d="M12 18V10.5" />
        <path d="M8.8 13.7 12 10.5l3.2 3.2" />
      </svg>
    );
  }

  if (type === "cloud-download") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M17.5 18.5h.5a4 4 0 0 0 .4-7.98 6.2 6.2 0 0 0-11.9-1.8A4.8 4.8 0 0 0 6 18.5h.5" />
        <path d="M12 10.5V18" />
        <path d="M8.8 14.8 12 18l3.2-3.2" />
      </svg>
    );
  }

  if (type === "terminal") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 7 5 5-5 5" />
        <path d="M12 17h7" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 21a8 8 0 0 0-16 0" />
      <path d="M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
    </svg>
  );
}

function ViewSelector({
  currentLabel,
  viewMode,
  viewMenuOpen,
  onToggle,
  onSelect,
  onClose,
}) {
  const selectorRef = useRef(null);

  useDismissableLayer({
    open: viewMenuOpen,
    refs: [selectorRef],
    onDismiss: onClose,
  });

  return (
    <div ref={selectorRef} className="view-selector">
      <button
        type="button"
        className="view-selector-button"
        onClick={onToggle}
        aria-expanded={viewMenuOpen}
        aria-haspopup="listbox"
      >
        <span>{currentLabel}</span>
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
              onClick={() => {
                onSelect(view.id);
                onClose();
              }}
              role="option"
              aria-selected={viewMode === view.id}
            >
              {view.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewSummaryStats({ items = [] }) {
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const visibleItems = items.filter(
    (item) => item?.value !== undefined && item?.value !== null && item?.value !== ""
  );
  const primaryItems = visibleItems.slice(0, 3);
  const hasMore = visibleItems.length > primaryItems.length;

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (panelRef.current?.contains(event.target)) return;

      setOpen(false);
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

  if (visibleItems.length === 0) return null;

  return (
    <div ref={panelRef} className="view-summary-stats" aria-label="View statistics">
      {primaryItems.map((item) => (
        <span key={item.label}>
          {item.label} {item.value}
        </span>
      ))}
      {hasMore ? (
        <button
          type="button"
          className="summary-stats-more"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-label="Show all view statistics"
        >
          More <span aria-hidden="true">v</span>
        </button>
      ) : null}
      {open ? (
        <div className="summary-stats-popover" aria-label="All view statistics">
          <dl>
            {visibleItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function ViewContextArea({ children, stats }) {
  return (
    <div className="view-context-area" aria-label="Current view context">
      {children ? <div className="view-context-controls">{children}</div> : null}
      <ViewSummaryStats items={stats} />
    </div>
  );
}

function BacklogGroupingSelector({ value, onChange }) {
  return (
    <label className="backlog-grouping-selector">
      <span>Group by</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Backlog grouping"
      >
        {BACKLOG_GROUPINGS.map((grouping) => (
          <option key={grouping.id} value={grouping.id}>
            {grouping.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function syncStatusIconType(syncState, liveSyncState) {
  if (liveSyncState === "failed" || syncState === "offline") return "sync-failed";

  return "sync-status";
}

function SyncOperationList({ operations = [], kind = "failed", onResolveDuplicate }) {
  return (
    <ul className="sync-operation-list">
      {operations.map((operation) => (
        <li key={operation.operationId || `${operation.title}-${operation.docketId}`}>
          <strong>{operation.title}</strong>
          <dl>
            <div>
              <dt>Entity</dt>
              <dd>{operation.entityLabel}</dd>
            </div>
            <div>
              <dt>Operation</dt>
              <dd>{operation.operationLabel}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{operation.statusLabel}</dd>
            </div>
            {operation.docketId ? (
              <div>
                <dt>Docket ID</dt>
                <dd>{operation.docketId}</dd>
              </div>
            ) : null}
            {kind === "blocked" && operation.parentTitle ? (
              <div>
                <dt>Parent</dt>
                <dd>{operation.parentTitle}</dd>
              </div>
            ) : null}
            <div>
              <dt>{kind === "blocked" ? "Reason" : "Error"}</dt>
              <dd>{kind === "blocked" ? operation.reason : operation.error}</dd>
            </div>
          </dl>
          {operation.duplicateRecovery?.eligible && onResolveDuplicate ? (
            <button
              type="button"
              className="sync-operation-recovery-button"
              onClick={() => onResolveDuplicate(operation.duplicateRecovery)}
            >
              Resolve as Duplicate
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SearchFilterSelect({
  filterKey,
  value,
  options = [],
  onChange,
  openKey,
  onToggle,
}) {
  const [query, setQuery] = useState("");
  const open = openKey === filterKey;
  const isDateFilter = filterKey === "date";
  const selectedLabel =
    isDateFilter && value
      ? formatDateLabel(value)
      : options.find((option) => option.value === value)?.label || "Any";
  const filteredOptions = useMemo(() => {
    const normalized = normalizeInlineSearch(query);

    if (isDateFilter) return options;
    if (!normalized) return options;

    return options.filter((option) =>
      normalizeInlineSearch(`${option.label} ${option.value}`).includes(normalized)
    );
  }, [isDateFilter, options, query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="search-filter-select">
      <button
        type="button"
        onClick={() => onToggle(open ? "" : filterKey)}
        aria-label={`${SEARCH_FILTER_LABELS[filterKey]} filter`}
        aria-expanded={open}
      >
        <span>{selectedLabel}</span>
        <span aria-hidden="true">v</span>
      </button>
      {open && (
        <div className="search-filter-options">
          <input
            type={isDateFilter ? "date" : "search"}
            value={isDateFilter ? value || "" : query}
            onChange={(event) => {
              if (isDateFilter) {
                onChange(filterKey, event.target.value);
                onToggle("");
                return;
              }

              setQuery(event.target.value);
            }}
            placeholder={`Find ${SEARCH_FILTER_LABELS[filterKey].toLowerCase()}`}
            aria-label={`Search ${SEARCH_FILTER_LABELS[filterKey]} options`}
            autoFocus
          />
          <button
            type="button"
            className={!value ? "selected" : ""}
            onClick={() => {
              onChange(filterKey, "");
              onToggle("");
            }}
          >
            Any
          </button>
          {filteredOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === value ? "selected" : ""}
              onClick={() => {
                onChange(filterKey, option.value);
                onToggle("");
              }}
            >
              <span>{isDateFilter ? formatDateLabel(option.value) : option.label}</span>
              <small>{option.count}</small>
            </button>
          ))}
          {filteredOptions.length === 0 ? (
            <div className="search-filter-empty">No matching options</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SearchFilterPopover({
  filters,
  inheritedFilters = EMPTY_SEARCH_FILTERS,
  optionsByKey,
  availableKeys = SEARCH_FILTER_KEYS,
  activeFilterCount,
  onFilterChange,
  onClearFilters,
  onClose,
}) {
  const panelRef = useRef(null);
  const [openKey, setOpenKey] = useState("");

  useEffect(() => {
    function handlePointerDown(event) {
      if (panelRef.current?.contains(event.target)) return;
      if (event.target?.closest?.(".inline-search-filter")) return;

      onClose();
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      if (openKey) {
        setOpenKey("");
      } else {
        onClose();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, openKey]);

  return (
    <div
      ref={panelRef}
      className="global-search-filter-popover"
      aria-label="Search filters"
    >
      <div className="search-filter-popover-header">
        <h2>Filters</h2>
        <button type="button" onClick={onClose} aria-label="Close filters">
          x
        </button>
      </div>
      <div className="search-filter-sections">
        {SEARCH_FILTER_SECTIONS.map((section) => {
          const keys = section.keys.filter((key) => availableKeys.includes(key));

          if (keys.length === 0) return null;

          return (
            <section key={section.id} className="search-filter-section">
              <h3>{section.title}</h3>
              <div className="search-filter-rows">
                {keys.map((key) => {
                  const inheritedValue = inheritedFilters[key] || "";

                  return (
                    <label
                      key={key}
                      className={`search-filter-row ${
                        inheritedValue ? "locked" : ""
                      }`}
                    >
                      <span>{SEARCH_FILTER_LABELS[key]}</span>
                      {inheritedValue ? (
                        <div className="search-filter-locked-value">
                          <strong>
                            {filterDisplayLabel(key, inheritedValue, optionsByKey)}
                          </strong>
                          <small>View Context / Locked</small>
                        </div>
                      ) : (
                        <SearchFilterSelect
                          filterKey={key}
                          value={filters[key] || ""}
                          options={optionsByKey[key] || []}
                          onChange={onFilterChange}
                          openKey={openKey}
                          onToggle={setOpenKey}
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <button
        type="button"
        className="clear-search-filters"
        onClick={onClearFilters}
        disabled={activeFilterCount === 0}
      >
        Clear Filters
      </button>
    </div>
  );
}

function SearchFilterChips({ chips = [], onClearFilter }) {
  if (!chips.length) return null;

  return (
    <div className="search-filter-chips" aria-label="Active filters">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`search-filter-chip ${chip.locked ? "locked" : "user"}`}
        >
          <span>
            {chip.label}: {chip.value}
          </span>
          {chip.note ? <small>{chip.note}</small> : null}
          {!chip.locked && chip.filterKey ? (
            <button
              type="button"
              onClick={() => onClearFilter(chip.filterKey)}
              aria-label={`Clear ${chip.label} filter`}
            >
              x
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function InlineHeaderSearch({
  open,
  query,
  scope,
  filters,
  inheritedFilters,
  filterChips,
  filterOptionsByKey,
  availableFilterKeys,
  activeFilterCount,
  matchCount,
  activeIndex,
  hasSearchableItems,
  onOpen,
  onClose,
  onQueryChange,
  onScopeChange,
  onFilterChange,
  onClearFilters,
  onNext,
  onPrevious,
}) {
  const controlRef = useRef(null);
  const inputRef = useRef(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const hasMatches = matchCount > 0;
  const hasActiveFilters = activeFilterCount > 0;
  const popoverInheritedFilters =
    scope === "global" ? EMPTY_SEARCH_FILTERS : inheritedFilters;

  useEffect(() => {
    if (!open) return undefined;

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      if (filterOpen) {
        setFilterOpen(false);
      } else if (query.trim()) {
        onQueryChange("");
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [filterOpen, onClose, onQueryChange, query]);

  function handleInputKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    }
  }

  return (
    <div
      ref={controlRef}
      className={`inline-search-control ${open ? "open" : ""}`}
      aria-label="Search current view"
    >
      <div className="inline-search-panel">
          <div className="inline-search-filter">
            <button
              type="button"
              onClick={() => {
                onOpen();
                setFilterOpen((current) => !current);
              }}
              aria-label="Filters"
              aria-expanded={filterOpen}
              className={hasActiveFilters ? "active" : ""}
            >
              <span>Filters</span>
              {hasActiveFilters ? (
                <strong>{activeFilterCount}</strong>
              ) : null}
              <span aria-hidden="true">v</span>
            </button>
          </div>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              onOpen();
              onQueryChange(event.target.value);
            }}
            onFocus={onOpen}
            onKeyDown={handleInputKeyDown}
            placeholder={
              hasSearchableItems
                ? scope === "global"
                  ? "Search all dockets"
                  : "Search current view"
                : "No searchable items"
            }
            aria-label={scope === "global" ? "Search all dockets" : "Search current view"}
            title={scope === "global" ? "Search all dockets" : "Search current view"}
          />
          <div className="inline-search-scope" aria-label="Search scope">
            {["view", "global"].map((option) => (
              <button
                key={option}
                type="button"
                className={scope === option ? "active" : ""}
                onClick={() => {
                  onOpen();
                  onScopeChange(option);
                }}
                title={option === "view" ? "Search current view" : "Search all dockets"}
              >
                {option === "view" ? "View" : "Global"}
              </button>
            ))}
          </div>
          {query.trim() ? (
            <div className="inline-search-results" aria-live="polite">
              {hasMatches ? `${activeIndex + 1} / ${matchCount}` : "No results"}
            </div>
          ) : null}
          {matchCount > 1 && (
            <>
              <button
                type="button"
                className="inline-search-nav"
                onClick={onPrevious}
                aria-label="Previous search result"
              >
                ↑
              </button>
              <button
                type="button"
                className="inline-search-nav"
                onClick={onNext}
                aria-label="Next search result"
              >
                ↓
              </button>
            </>
          )}
          <button
            type="button"
            className="inline-search-close"
            onClick={() => {
              onQueryChange("");
              onClose();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            disabled={!query.trim()}
          >
            x
          </button>
          {filterOpen && (
            <SearchFilterPopover
              filters={filters}
              inheritedFilters={popoverInheritedFilters}
              optionsByKey={filterOptionsByKey}
              availableKeys={availableFilterKeys}
              activeFilterCount={activeFilterCount}
              onFilterChange={(key, value) => {
                onFilterChange(key, value);
                inputRef.current?.focus();
              }}
              onClearFilters={onClearFilters}
              onClose={() => {
                setFilterOpen(false);
                inputRef.current?.focus();
              }}
            />
          )}
      </div>
      <SearchFilterChips
        chips={filterChips}
        onClearFilter={(key) => onFilterChange(key, "")}
      />
    </div>
  );
}

function GlobalActions({
  syncState,
  liveSyncState,
  syncActivity,
  syncVisualState,
  syncStatusPopoverOpen,
  syncStatusPopoverRef,
  onToggleSyncStatus,
  syncStatusSummary,
  syncStatusRows,
  syncStatusPresentation,
  syncQueueSummary,
  isReadOnlyViewer,
  onSyncToElitical,
  onSyncFromElitical,
  onResolveDuplicate,
  profileMenuOpen,
  profileMenuRef,
  onToggleProfile,
  onOpenLogs,
  profileInfo,
}) {
  return (
    <div className="toolbar-actions" aria-label="Global actions">
      <div className="sync-status-control" ref={syncStatusPopoverRef}>
        <button
          type="button"
          className={`global-icon-button sync-status-button ${syncVisualState || syncState}`}
          onClick={onToggleSyncStatus}
          aria-label="Sync status"
          aria-expanded={syncStatusPopoverOpen}
          title="Sync status"
        >
          {liveSyncState === "syncing" ? (
            <span className="sync-action-spinner" aria-hidden="true" />
          ) : (
            <ToolbarIcon type={syncStatusIconType(syncState, liveSyncState)} />
          )}
        </button>
        {syncStatusPopoverOpen && (
          <div className="sync-status-popover">
            <h2>Sync Status</h2>
            {syncStatusSummary.errorMessage ? (
              <p className="sync-status-error">{syncStatusSummary.errorMessage}</p>
            ) : null}
            <section className="sync-current-activity" aria-label="Current sync activity">
              <h3>Current Activity</h3>
              <dl>
                {syncActivityRows(syncActivity, syncStatusPresentation).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {syncStatusPresentation.failedOperations.length ? (
              <section className="sync-operation-section sync-failed-operations" aria-label="Failed sync operations">
                <h3>Failed Operations</h3>
                <SyncOperationList
                  operations={syncStatusPresentation.failedOperations}
                  kind="failed"
                  onResolveDuplicate={onResolveDuplicate}
                />
              </section>
            ) : null}
            {syncStatusPresentation.blockedOperations.length ? (
              <section className="sync-operation-section sync-blocked-operations" aria-label="Blocked sync operations">
                <h3>Blocked Operations</h3>
                <SyncOperationList
                  operations={syncStatusPresentation.blockedOperations}
                  kind="blocked"
                />
              </section>
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
          className="global-icon-button sync-action-button sync-action-button-upload"
          onClick={onSyncToElitical}
          disabled={liveSyncState === "syncing" || !syncQueueSummary.actionableCount}
          aria-label="Sync to Elitical"
          aria-busy={liveSyncState === "syncing"}
          title="Sync to Elitical"
        >
          {liveSyncState === "syncing" ? (
            <span className="sync-action-spinner" aria-hidden="true" />
          ) : (
            <ToolbarIcon type="cloud-upload" />
          )}
          {syncQueueSummary.actionableCount ? (
            <span className="sync-action-count">{syncQueueSummary.actionableCount}</span>
          ) : null}
        </button>
      )}
      {!isReadOnlyViewer && (
        <button
          type="button"
          className="global-icon-button sync-action-button sync-action-button-download"
          onClick={onSyncFromElitical}
          disabled={liveSyncState === "syncing"}
          aria-label="Sync from Elitical"
          aria-busy={liveSyncState === "syncing"}
          title="Sync from Elitical"
        >
          {liveSyncState === "syncing" ? (
            <span className="sync-action-spinner" aria-hidden="true" />
          ) : (
            <ToolbarIcon type="cloud-download" />
          )}
        </button>
      )}
      <div className="profile-menu-control" ref={profileMenuRef}>
        <button
          type="button"
          className="global-icon-button profile-menu-button"
          onClick={onToggleProfile}
          aria-label="Profile"
          aria-haspopup="menu"
          aria-expanded={profileMenuOpen}
          title="Profile"
        >
          <ToolbarIcon type="user" />
        </button>
        {profileMenuOpen && (
          <div className="profile-menu" role="menu">
            <div className="profile-menu-identity">
              <strong>{profileInfo.name}</strong>
              <span>{profileInfo.role}</span>
            </div>
            <button
              type="button"
              className="profile-menu-item"
              onClick={onOpenLogs}
              role="menuitem"
            >
              <ToolbarIcon type="terminal" />
              <span>View Terminal / Logs</span>
            </button>
            <div className="profile-menu-version">App Version 0.0.0</div>
          </div>
        )}
      </div>
    </div>
  );
}

function GlobalViewHeader({
  currentLabel,
  viewMode,
  viewMenuOpen,
  onToggleViewMenu,
  onCloseViewMenu,
  onSelectView,
  context,
  search,
  globalActions,
}) {
  return (
    <header className="top-toolbar">
      <div className="toolbar-left">
        <ViewSelector
          currentLabel={currentLabel}
          viewMode={viewMode}
          viewMenuOpen={viewMenuOpen}
          onToggle={onToggleViewMenu}
          onSelect={onSelectView}
          onClose={onCloseViewMenu}
        />
      </div>
      <ViewContextArea stats={context.stats}>{context.control}</ViewContextArea>
      <div className="toolbar-search-area">{search}</div>
      {globalActions}
    </header>
  );
}

function formatLogTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "--:--:--";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LogViewerModal({ open, onClose }) {
  const [entries, setEntries] = useState([]);
  const [latestId, setLatestId] = useState(0);
  const [error, setError] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNewLogs, setHasNewLogs] = useState(false);
  const logListRef = useRef(null);
  const latestIdRef = useRef(0);
  const autoScrollRef = useRef(true);

  const scrollToLatest = useCallback(() => {
    if (!logListRef.current) return;

    logListRef.current.scrollTop = logListRef.current.scrollHeight;
    setAutoScroll(true);
    setHasNewLogs(false);
  }, []);

  const handleLogScroll = useCallback(() => {
    const element = logListRef.current;

    if (!element) return;

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distanceFromBottom <= 40;

    setAutoScroll(nearBottom);
    if (nearBottom) setHasNewLogs(false);
  }, []);

  useEffect(() => {
    latestIdRef.current = latestId;
  }, [latestId]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useEffect(() => {
    if (!open) return;

    setAutoScroll(true);
    setHasNewLogs(false);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;

    async function refresh({ initial = false } = {}) {
      try {
        const result = await loadApplicationLogs({
          sinceId: initial ? 0 : latestIdRef.current,
          limit: 1000,
        });

        if (cancelled) return;

        setError("");
        setLatestId(result.latestId);
        setEntries((current) => {
          const merged = initial ? result.entries : [...current, ...result.entries];
          const seen = new Map();

          merged.forEach((entry) => seen.set(entry.id, entry));
          return Array.from(seen.values()).sort((a, b) => a.id - b.id).slice(-1000);
        });
        if (!autoScrollRef.current && result.entries.length) {
          setHasNewLogs(true);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError?.message || "Unable to load application logs.");
        }
      }
    }

    refresh({ initial: true });
    const timer = window.setInterval(() => refresh(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!autoScroll || !logListRef.current) return;

    scrollToLatest();
  }, [autoScroll, entries, scrollToLatest]);

  if (!open) return null;

  return (
    <div className="logs-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="logs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logs-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="logs-modal-header">
          <div>
            <span>Terminal</span>
            <h2 id="logs-modal-title">Application Logs</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close logs">
            x
          </button>
        </header>
        <div className="logs-modal-tabs" aria-label="Log categories">
          <span>All</span>
          <span>Backend</span>
          <span>Sync</span>
          <span>Elitical</span>
          <span>Errors</span>
        </div>
        <div className="logs-content">
          {error ? <p className="logs-error">{error}</p> : null}
          <div
            className="logs-list"
            ref={logListRef}
            aria-live="polite"
            onScroll={handleLogScroll}
          >
            {entries.length ? (
              entries.map((entry) => (
                <div key={entry.id} className={`log-entry log-entry-${String(entry.level || "info").toLowerCase()}`}>
                  <time>{formatLogTime(entry.timestamp)}</time>
                  <span className={`log-category log-category-${String(entry.category || "system").toLowerCase()}`}>
                    {entry.category || "SYSTEM"}
                  </span>
                  <p>{entry.message}</p>
                </div>
              ))
            ) : (
              <div className="logs-empty">No application logs are available yet.</div>
            )}
          </div>
          {hasNewLogs && !autoScroll ? (
            <button
              type="button"
              className="logs-latest-button"
              onClick={scrollToLatest}
              aria-label="Jump to latest logs"
            >
              New logs down
            </button>
          ) : null}
        </div>
        <footer className="logs-modal-footer">
          <label className="logs-autoscroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => {
                setAutoScroll(event.target.checked);
                if (event.target.checked) setHasNewLogs(false);
              }}
            />
            Follow Logs
          </label>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setEntries([]);
              }}
            >
              Clear View
            </button>
            <button type="button" className="primary-button" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function profileInfoFromState(storyState) {
  const employee = storyState?.employee || storyState?.metadata?.employee || {};
  const employees = Array.isArray(storyState?.employees) ? storyState.employees : [];
  const fallbackEmployee = employees.find((entry) => entry?.name || entry?.employeeName) || {};
  const name =
    employee.name ||
    employee.displayName ||
    employee.fullName ||
    employee.employeeName ||
    fallbackEmployee.name ||
    fallbackEmployee.employeeName ||
    "Elitical User";
  const role =
    employee.designation ||
    employee.designationName ||
    employee.role ||
    fallbackEmployee.designation ||
    fallbackEmployee.designationName ||
    "Workspace Member";

  return { name, role };
}

function stableEmployeeId(employee = {}) {
  return String(employee.id || employee.employeeId || employee.userId || "").trim();
}

function employeeDisplayName(employee = {}) {
  return String(
    employee.name ||
      employee.displayName ||
      employee.fullName ||
      employee.employeeName ||
      employee.assigneeName ||
      employee.userName ||
      employee.id ||
      employee.employeeId ||
      ""
  ).trim();
}

function parseStoredEmployeeId(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  try {
    return String(JSON.parse(raw) || "").trim();
  } catch {
    return raw;
  }
}

function currentEmployeeIdFromBrowserStorage() {
  if (typeof window === "undefined" || !window.localStorage) return "";

  return parseStoredEmployeeId(window.localStorage.getItem("flutter.employeeId"));
}

function buildEmployeeDirectory({ storyState, workItems = [] }) {
  const byId = new Map();

  function addEmployee(id, name, extra = {}) {
    const employeeId = String(id || "").trim();

    if (!employeeId) return;

    const previous = byId.get(employeeId) || {};
    byId.set(employeeId, {
      ...previous,
      ...extra,
      employeeId,
      id: employeeId,
      name: String(name || previous.name || employeeId).trim(),
    });
  }

  [
    storyState?.employee,
    storyState?.metadata?.employee,
    ...(Array.isArray(storyState?.employees) ? storyState.employees : []),
  ].forEach((employee) => {
    addEmployee(stableEmployeeId(employee), employeeDisplayName(employee), employee);
  });

  workItems.forEach((item) => {
    addEmployee(itemAssigneeId(item), item.elitical?.assigneeName || item.assignee);
    (item.worklogs || []).forEach((entry) => {
      addEmployee(entry.employeeId, entry.employeeName);
    });
  });

  return byId;
}

function dominantWorklogEmployee(workItems = [], employeeDirectory = new Map()) {
  const totals = new Map();

  workItems.forEach((item) => {
    (item.worklogs || []).forEach((entry) => {
      const id = String(entry.employeeId || "").trim();

      if (!id) return;

      const previous = totals.get(id) || 0;
      totals.set(id, previous + worklogMinutes(entry));
    });
  });

  const [employeeId] =
    Array.from(totals.entries()).sort((first, second) => second[1] - first[1])[0] || [];

  return employeeId ? employeeDirectory.get(employeeId) || { employeeId, id: employeeId } : null;
}

function currentEmployeeScopeFromState(storyState, workItems = [], employeeDirectory = new Map()) {
  const metadataEmployee = storyState?.employee || storyState?.metadata?.employee || {};
  const metadataEmployeeId = stableEmployeeId(metadataEmployee);
  const storedEmployeeId = currentEmployeeIdFromBrowserStorage();
  const employeeId = metadataEmployeeId || storedEmployeeId;

  if (employeeId) {
    const directoryEmployee = employeeDirectory.get(employeeId) || {};

    return {
      ...directoryEmployee,
      employeeId,
      id: employeeId,
      name: employeeDisplayName(directoryEmployee) || employeeDisplayName(metadataEmployee) || employeeId,
      isCurrentUser: true,
    };
  }

  const fallback = dominantWorklogEmployee(workItems, employeeDirectory);

  return fallback
    ? {
        ...fallback,
        employeeId: fallback.employeeId || fallback.id,
        id: fallback.employeeId || fallback.id,
        name: employeeDisplayName(fallback),
        isCurrentUser: true,
        inferredFromLocalWorklogs: true,
      }
    : null;
}

function employeeScopeForId(employeeId, employeeDirectory = new Map(), currentEmployeeScope = null) {
  const id = String(employeeId || "").trim();

  if (!id) return currentEmployeeScope;

  const employee = employeeDirectory.get(id) || {};

  return {
    ...employee,
    employeeId: id,
    id,
    name: employeeDisplayName(employee) || id,
    isCurrentUser: currentEmployeeScope?.employeeId === id,
  };
}

function scopedSearchFilterOptions(optionsByKey = {}, employeeDirectory = new Map(), currentEmployeeScope = null) {
  const next = { ...optionsByKey };
  const byValue = new Map((next.assignee || []).map((option) => [option.value, option]));

  employeeDirectory.forEach((employee) => {
    const value = employee.employeeId || employee.id;

    if (!value || byValue.has(value)) return;

    byValue.set(value, {
      value,
      label: employeeDisplayName(employee) || value,
      count: 0,
    });
  });

  const currentId = currentEmployeeScope?.employeeId || currentEmployeeScope?.id || "";
  next.assignee = Array.from(byValue.values())
    .map((option) =>
      option.value === currentId
        ? {
            ...option,
            label: `Me - ${option.label}`,
          }
        : option
    )
    .sort((first, second) => {
      if (first.value === currentId) return -1;
      if (second.value === currentId) return 1;
      return first.label.localeCompare(second.label, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  return next;
}

const SEARCH_FILTER_SECTIONS = Object.freeze([
  { id: "view", title: "View Context", keys: ["date", "sprint", "epic"] },
  { id: "work", title: "Work Item", keys: ["type", "state", "priority", "category"] },
  { id: "people", title: "People", keys: ["assignee"] },
  { id: "metrics", title: "Metrics", keys: ["storyPoints"] },
]);

const VIEW_HEADER_FILTER_CONFIG = Object.freeze({
  main: { inheritedKeys: [], contextChip: false },
  sprint: { inheritedKeys: ["sprint"], contextChip: false },
  epic: { inheritedKeys: ["epic"], contextChip: false },
  story: { inheritedKeys: [], contextChip: true },
  job: { inheritedKeys: [], contextChip: true },
  task: { inheritedKeys: [], contextChip: true },
  day: { inheritedKeys: ["date"], contextChip: false },
  backlog: { inheritedKeys: [], contextChip: false },
  worklog: { inheritedKeys: [], contextChip: false },
  dashboard: { inheritedKeys: [], contextChip: false },
});

function filterDisplayLabel(key, value, optionsByKey = {}) {
  if (!value) return "Any";
  if (key === "date") return formatDateLabel(value);

  return searchFilterLabel({ [key]: value }, optionsByKey, key);
}

function viewHeaderFilterContext({ viewMode, selectedContextOption, selectedDayDate }) {
  const config = VIEW_HEADER_FILTER_CONFIG[viewMode] || VIEW_HEADER_FILTER_CONFIG.main;
  const filters = { ...EMPTY_SEARCH_FILTERS };
  const contextChips = [];

  if (config.inheritedKeys.includes("date") && selectedDayDate) {
    filters.date = dateKeyFromValue(selectedDayDate);
  }

  if (config.inheritedKeys.includes("sprint") && selectedContextOption?.id) {
    filters.sprint = selectedContextOption.id;
  }

  if (config.inheritedKeys.includes("epic") && selectedContextOption?.id) {
    filters.epic =
      selectedContextOption.sourceItemId ||
      selectedContextOption.sourceDocketId ||
      selectedContextOption.sourceId ||
      selectedContextOption.id;
  }

  if (config.contextChip && selectedContextOption?.id) {
    contextChips.push({
      key: `context:${viewMode}`,
      label: contextViewLabel(viewMode),
      value: selectedContextOption.title || selectedContextOption.name || selectedContextOption.id,
      locked: true,
      note: "View Context",
    });
  }

  return { filters, contextChips };
}

function composeSearchFilters(userFilters = EMPTY_SEARCH_FILTERS, inheritedFilters = EMPTY_SEARCH_FILTERS) {
  return SEARCH_FILTER_KEYS.reduce((acc, key) => {
    acc[key] = inheritedFilters[key] || userFilters[key] || "";
    return acc;
  }, {});
}

function filterChipsForHeader({ inheritedFilters, userFilters, contextChips, optionsByKey }) {
  void inheritedFilters;
  void contextChips;
  const chips = [];

  SEARCH_FILTER_KEYS.forEach((key) => {
    const userValue = userFilters[key];

    if (userValue) {
      chips.push({
        key: `user:${key}`,
        filterKey: key,
        label: SEARCH_FILTER_LABELS[key],
        value: filterDisplayLabel(key, userValue, optionsByKey),
        locked: false,
      });
    }
  });

  return chips;
}

function availableSearchFilterKeys(optionsByKey = {}, inheritedFilters = EMPTY_SEARCH_FILTERS) {
  return SEARCH_FILTER_KEYS.filter((key) => {
    if (inheritedFilters[key]) return true;
    if (key === "date") return true;
    return (optionsByKey[key] || []).length > 0;
  });
}

function graphContainsCanonicalItem(items = [], canonicalId = "") {
  if (!canonicalId) return false;

  return items.some(
    (item) =>
      (item.sourceItemId || item.sourceDocketId || item.sourceId || item.id) === canonicalId
  );
}

function globalSearchViewForItem(item = {}) {
  return DOCKET_CONTEXT_TYPES.has(item.type) ? item.type : "main";
}

function updateApplicationOverlayOffset() {
  if (typeof document === "undefined") return;

  const mainContent = document.querySelector(".app-main-content");
  const offset = mainContent
    ? Math.max(0, Math.round(mainContent.getBoundingClientRect().top))
    : 0;

  document.documentElement.style.setProperty("--app-overlay-top", `${offset}px`);
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
  const [propertyPanelItemId, setPropertyPanelItemId] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(
    "Loading local cache..."
  );
  const [layoutNonce, setLayoutNonce] = useState(1);
  const [viewMode, setViewMode] = useState("main");
  const [viewRootId, setViewRootId] = useState(null);
  const [canvasFullMode, setCanvasFullMode] = useState(false);
  const [contextSelections, setContextSelections] = useState({});
  const [backlogGrouping, setBacklogGrouping] = useState(readBacklogGroupingPreference);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState("view");
  const [searchFilters, setSearchFilters] = useState(() => ({
    ...EMPTY_SEARCH_FILTERS,
  }));
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
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
  const [syncActivity, setSyncActivity] = useState(EMPTY_SYNC_ACTIVITY);
  const [syncQueueSummary, setSyncQueueSummary] = useState({
    pendingCount: 0,
    actionableCount: 0,
    mutationActionableCount: 0,
    reconciliationActionableCount: 0,
    unconfirmedCount: 0,
    failedCount: 0,
    blockedCount: 0,
    supersededCount: 0,
    operations: [],
  });
  const [importedWorklogs, setImportedWorklogs] = useState([]);
  const [publishedWorklogsLoaded, setPublishedWorklogsLoaded] = useState(false);
  const [syncStatusPopoverOpen, setSyncStatusPopoverOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [dayProjectionSelections, setDayProjectionSelections] = useState(() =>
    typeof window === "undefined"
      ? loadDayProjectionState(null)
      : loadDayProjectionState(window.localStorage)
  );
  const [retainedCreationContexts, setRetainedCreationContexts] = useState(() =>
    typeof window === "undefined"
      ? loadRetainedCreationContextState(null)
      : loadRetainedCreationContextState(window.localStorage)
  );
  const [addExistingChildRequest, setAddExistingChildRequest] = useState(null);

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
  const preserveSearchOnNextContextChangeRef = useRef(false);
  const syncStatusPopoverRef = useRef(null);
  const profileMenuRef = useRef(null);
  const persistRetainedCreationContexts = useCallback((updater) => {
    setRetainedCreationContexts((current) => {
      const next =
        typeof updater === "function"
          ? updater(current)
          : updater;

      saveRetainedCreationContextState(
        typeof window === "undefined" ? null : window.localStorage,
        next
      );

      return next;
    });
  }, []);
  const clearRetainedCreationContextState = useCallback(() => {
    persistRetainedCreationContexts(clearRetainedCreationContexts());
  }, [persistRetainedCreationContexts]);
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
  const isContextView = CONTEXT_VIEW_IDS.has(viewMode);
  const graphScopeOptions = useMemo(
    () => scopesWithOrphanSprint(sprints, workItems),
    [sprints, workItems]
  );
  const employeeDirectory = useMemo(
    () => buildEmployeeDirectory({ storyState, workItems }),
    [storyState, workItems]
  );
  const currentEmployeeScope = useMemo(
    () => currentEmployeeScopeFromState(storyState, workItems, employeeDirectory),
    [employeeDirectory, storyState, workItems]
  );
  const selectedEmployeeScope = useMemo(
    () => employeeScopeForId(searchFilters.assignee, employeeDirectory, currentEmployeeScope),
    [currentEmployeeScope, employeeDirectory, searchFilters.assignee]
  );
  const totals = useMemo(
    () => calculateStoryPoints(workItems, { sprints: graphScopeOptions, employeeScope: selectedEmployeeScope }),
    [graphScopeOptions, selectedEmployeeScope, workItems]
  );
  const backlogProjection = useMemo(
    () =>
      buildBacklogProjection({
        items: workItems,
        sprints: graphScopeOptions,
        grouping: backlogGrouping,
      }),
    [backlogGrouping, graphScopeOptions, workItems]
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
            dayProjectionSelections,
            retainedCreationContexts,
            employeeScope: selectedEmployeeScope,
          })
        : {
            workItems,
            rootId: null,
            sprints: [],
          },
    [
      dayProjectionSelections,
      retainedCreationContexts,
      selectedEmployeeScope,
      graphScopeOptions,
      isContextView,
      selectedContextOption,
      viewMode,
      workItems,
    ]
  );
  const visibleWorkItems = useMemo(
    () => descendantsIncluding(contextGraph.workItems, viewRootId),
    [contextGraph.workItems, viewRootId]
  );
  const baseGraphWorkItems =
    viewMode === "backlog" ? backlogProjection.workItems : visibleWorkItems;
  const baseGraphSprints = useMemo(
    () =>
      viewMode === "backlog"
        ? backlogProjection.sprints
        : viewMode === "main"
        ? graphScopeOptions
        : isContextView
        ? contextGraph.sprints
        : [],
    [backlogProjection.sprints, contextGraph.sprints, graphScopeOptions, isContextView, viewMode]
  );
  const baseSearchFilterOptionsByKey = useMemo(
    () =>
      buildSearchFilterOptions({
        items: searchScope === "global" ? workItems : baseGraphWorkItems,
        sprints: searchScope === "global" ? graphScopeOptions : baseGraphSprints,
      }),
    [baseGraphSprints, baseGraphWorkItems, graphScopeOptions, searchScope, workItems]
  );
  const searchFilterOptionsByKey = useMemo(
    () => scopedSearchFilterOptions(baseSearchFilterOptionsByKey, employeeDirectory, currentEmployeeScope),
    [baseSearchFilterOptionsByKey, currentEmployeeScope, employeeDirectory]
  );
  const searchViewContext = useMemo(
    () =>
      viewHeaderFilterContext({
        viewMode,
        selectedContextOption,
        selectedDayDate: selectedContextOption?.id || dateKeyFromValue(new Date()),
      }),
    [selectedContextOption, viewMode]
  );
  const inheritedSearchFilters = searchViewContext.filters;
  const effectiveSearchFilters = useMemo(
    () => composeSearchFilters(searchFilters, inheritedSearchFilters),
    [inheritedSearchFilters, searchFilters]
  );
  const availableFilterKeys = useMemo(
    () => availableSearchFilterKeys(
      searchFilterOptionsByKey,
      searchScope === "global" ? EMPTY_SEARCH_FILTERS : inheritedSearchFilters
    ),
    [inheritedSearchFilters, searchFilterOptionsByKey, searchScope]
  );
  const searchFilterChips = useMemo(
    () =>
      filterChipsForHeader({
        inheritedFilters: searchScope === "global" ? EMPTY_SEARCH_FILTERS : inheritedSearchFilters,
        userFilters: searchFilters,
        contextChips: searchScope === "global" ? [] : searchViewContext.contextChips,
        optionsByKey: searchFilterOptionsByKey,
      }),
    [inheritedSearchFilters, searchFilterOptionsByKey, searchFilters, searchScope, searchViewContext.contextChips]
  );
  const activeExplicitFilterCount = activeSearchFilterCount(searchFilters);
  const filteredGraph = useMemo(
    () =>
      applySearchFilters({
        items: baseGraphWorkItems,
        filters: effectiveSearchFilters,
      }),
    [baseGraphWorkItems, effectiveSearchFilters]
  );
  const globalFilteredSearch = useMemo(
    () =>
      applySearchFilters({
        items: workItems,
        filters: searchFilters,
      }),
    [searchFilters, workItems]
  );
  const graphWorkItems = filteredGraph.visibleItems;
  const filterMatchedWorkItems = filteredGraph.matchedItems;
  const graphSprints = useMemo(() => {
    if (viewMode === "day") return baseGraphSprints;
    if (!filteredGraph.hasExplicitFilters) return baseGraphSprints;

    const visibleSprintIds = new Set(
      graphWorkItems.map((item) => displaySprintIdForItem(item)).filter(Boolean)
    );

    return baseGraphSprints.filter((sprint) => visibleSprintIds.has(sprint.id));
  }, [
    baseGraphSprints,
    filteredGraph.hasExplicitFilters,
    graphWorkItems,
    viewMode,
  ]);
  const searchItems = useMemo(
    () =>
      searchItemsForCurrentView({
        viewMode,
        graphWorkItems:
          searchScope === "global"
            ? globalFilteredSearch.matchedItems
            : filterMatchedWorkItems,
        graphSprints:
          searchScope === "global"
            ? graphScopeOptions
            : activeExplicitFilterCount > 0
            ? []
            : viewMode === "dashboard"
            ? graphScopeOptions
            : graphSprints,
        rootTitle,
        mainTitle,
      }),
    [
      activeExplicitFilterCount,
      filterMatchedWorkItems,
      globalFilteredSearch.matchedItems,
      graphScopeOptions,
      graphSprints,
      mainTitle,
      rootTitle,
      searchScope,
      viewMode,
    ]
  );
  const searchMatches = useMemo(() => {
    const normalizedQuery = normalizeInlineSearch(searchQuery);

    if (!searchOpen || !normalizedQuery) return [];

    const normalizedDocketQuery = normalizeDocketNumber(searchQuery);
    const exactDocketMatches = isExactDocketNumberQuery(searchQuery)
      ? searchItems
          .filter((item) => normalizeDocketNumber(item.docketNumber) === normalizedDocketQuery)
          .map((item) => ({
            ...item,
            exactDocketNumberMatch: true,
          }))
      : [];
    const exactIds = new Set(exactDocketMatches.map((item) => item.id));
    const textMatches = searchItems.filter((item) => {
      if (exactIds.has(item.id)) return false;
      return item.searchText.includes(normalizedQuery);
    });

    return [...exactDocketMatches, ...textMatches];
  }, [searchItems, searchOpen, searchQuery]);
  const activeSearchMatch = searchMatches[activeSearchIndex] || null;
  const searchMatchIds = useMemo(
    () =>
      searchQuery.trim()
        ? new Set(searchMatches.map((item) => item.focusId).filter(Boolean))
        : new Set(Array.from(filteredGraph.matchedIds)),
    [filteredGraph.matchedIds, searchMatches, searchQuery]
  );
  const activeSearchId = activeSearchMatch?.focusId || "";
  const activeSearchFocusKey = [
    searchOpen ? "open" : "closed",
    searchScope,
    JSON.stringify(effectiveSearchFilters),
    searchQuery,
    activeSearchIndex,
    activeSearchMatch?.id || "",
  ].join(":");

  useEffect(() => {
    if (searchScope !== "global") return;
    if (!searchOpen || !activeSearchMatch?.exactDocketNumberMatch) return;

    const item = workItems.find((entry) => entry.id === activeSearchMatch.focusId);
    if (!item) return;
    if (graphContainsCanonicalItem(graphWorkItems, item.id)) return;

    const nextViewMode = globalSearchViewForItem(item);

    preserveSearchOnNextContextChangeRef.current = true;
    setViewMode(nextViewMode);
    setViewRootId(null);
    setSelectedId(item.id);
    setContextSelections((current) => ({
      ...current,
      [nextViewMode]: item.id,
    }));
    setLayoutNonce((value) => value + 1);
  }, [
    activeSearchMatch,
    graphWorkItems,
    searchOpen,
    searchScope,
    workItems,
  ]);
  const graphMainTitle =
    viewMode === "sprint"
      ? selectedContextOption?.title || "Sprint"
      : viewMode === "backlog"
      ? backlogProjection.rootTitle
      : viewMode === "day"
      ? formatDateLabel(selectedContextOption?.id || formatDateInput(new Date()))
      : mainTitle;
  const todayKey = useMemo(() => dateKeyFromValue(new Date()), []);
  const selectedDayDate = selectedContextOption?.id || todayKey;
  const graphRootTitle =
    viewMode === "backlog"
      ? backlogProjection.rootTitle
      : viewMode === "sprint" || viewMode === "day"
      ? rootTitle || mainTitle || "Project"
      : rootTitle;
  const graphRootId = viewRootId || contextGraph.rootId;
  const graphTotals = useMemo(
    () => calculateStoryPoints(graphWorkItems, { sprints: graphSprints, employeeScope: selectedEmployeeScope }),
    [graphSprints, graphWorkItems, selectedEmployeeScope]
  );
  const daySummary = useMemo(
    () =>
      viewMode === "day"
        ? dayViewSummary({
            workItems,
            graphWorkItems: contextGraph.workItems,
            graphSprints,
            selectedDate: selectedDayDate,
            rootTitle,
            employeeScope: selectedEmployeeScope,
          })
        : null,
    [
      contextGraph.workItems,
      graphSprints,
      rootTitle,
      selectedEmployeeScope,
      selectedDayDate,
      viewMode,
      workItems,
    ]
  );
  const dayTimelineModel = useMemo(
    () =>
      viewMode === "day"
        ? buildDayTimelineModel({
            workItems,
            sprints: graphScopeOptions,
            selectedDate: selectedDayDate,
            todayKey,
            employeeScope: selectedEmployeeScope,
          })
        : null,
    [graphScopeOptions, selectedDayDate, selectedEmployeeScope, todayKey, viewMode, workItems]
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    let animationFrame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateApplicationOverlayOffset);
    };

    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(scheduleUpdate)
        : null;
    const observedSelectors = [
      ".app-container",
      ".top-toolbar",
      ".day-timeline-navigation",
      ".toolbar-secondary-actions",
      ".app-main-content",
    ];

    observedSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => observer?.observe(element));
    });

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", scheduleUpdate);
      observer?.disconnect();
    };
  }, [
    canvasFullMode,
    dayTimelineModel,
    dirty,
    saveState,
    viewMode,
    viewRootId,
  ]);
  const viewRootItem = viewRootId
    ? workItems.find((item) => item.id === viewRootId)
    : null;
  const isPlanningView = PLANNING_VIEW_IDS.has(viewMode);
  const usesPlanningSurface = isPlanningView;
  const isDashboardView = viewMode === "dashboard";
  const showGraphEmptyState =
    viewMode !== "day" &&
    graphWorkItems.length === 0 &&
    !usesPlanningSurface &&
    !isDashboardView &&
    viewMode !== "main";
  const detailsDrawerOpen = modal?.kind === "details";
  const selectedEditableItem = propertyPanelItemId && !detailsDrawerOpen
    ? workItems.find(
        (item) =>
          item.id === propertyPanelItemId &&
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
    graphWorkItems.length +
    (!isPlanningView && viewMode === "main" ? graphSprints.length : 0) +
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

  useEffect(() => {
    if (preserveSearchOnNextContextChangeRef.current) {
      preserveSearchOnNextContextChangeRef.current = false;
      return;
    }

    setSearchOpen(false);
    setSearchQuery("");
    setActiveSearchIndex(0);
  }, [selectedContextId, viewMode, viewRootId]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchFilters, searchQuery]);

  useEffect(() => {
    if (activeSearchIndex < searchMatches.length) return;

    setActiveSearchIndex(0);
  }, [activeSearchIndex, searchMatches.length]);

  useEffect(() => {
    setSearchFilters((current) => {
      const next = pruneSearchFilters(current, searchFilterOptionsByKey);

      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [searchFilterOptionsByKey]);

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

  useDismissableLayer({
    open: syncStatusPopoverOpen,
    refs: [syncStatusPopoverRef],
    onDismiss: () => setSyncStatusPopoverOpen(false),
  });

  useEffect(() => {
    if (!profileMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (profileMenuRef.current?.contains(event.target)) return;

      setProfileMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileMenuOpen]);

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
          setSearchQuery("");
          setSearchOpen(false);
          setActiveSearchIndex(0);
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

    const progressEvents = isReadOnlyViewer
      ? null
      : subscribeToSyncProgress((progress) => {
          if (cancelled) return;

          setSyncActivity((current) =>
            normalizeSyncActivityEvent(progress, progress?.direction || "inbound", current)
          );
          if (progress?.message) setLiveSyncProgress(sanitizeSyncActivityText(progress.message));
          if (progress?.state === "running") {
            setLiveSyncState("syncing");
            setSyncState("syncing");
          }
          if (progress?.state === "synced" || progress?.phase === "complete") {
            setLiveSyncState("synced");
            setSyncState("synced");
          }
          if (progress?.state === "failed" || progress?.phase === "failed") {
            setLiveSyncState("failed");
            setSyncState("offline");
          }
        });
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
            clearRetainedCreationContextState();
          },
          onFailed(payload) {
            if (cancelled) return;

            setSyncState("offline");
            setLiveSyncState("failed");
            setLiveSyncProgress(payload?.message || payload?.error || "Background sync failed.");
            setSyncActivity((current) =>
              failedSyncActivity("inbound", payload?.message || payload?.error || "Background sync failed.", current)
            );
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
            setSyncActivity((current) =>
              normalizeSyncActivityEvent(
                {
                  direction: "inbound",
                  state: "running",
                  phase: "starting",
                  message: nextMessage,
                },
                "inbound",
                current
              )
            );
            setMessage(nextMessage);
          },
          onSyncFinished(payload) {
            if (cancelled) return;

            setSyncState("synced");
            setLiveSyncState((current) => (current === "syncing" ? "synced" : current));
            setLiveSyncProgress((current) =>
              current === "Sync Complete" ? current : payload?.message || ""
            );
            setSyncActivity((current) =>
              current.state === "running"
                ? completeSyncActivity("inbound", payload?.message || "Synced from Elitical", current)
                : current
            );
          },
        });

    return () => {
      cancelled = true;
      progressEvents?.close();
      events?.close();
    };
  }, [
    applyNormalizedGraphPayload,
    clearRetainedCreationContextState,
    isBrowserRefreshStartup,
    isReadOnlyViewer,
  ]);

  useEffect(() => {
    const handlePageHide = () => {
      saveBrowserRefreshState({
        selectedId,
        contextSelections,
        viewMode,
        viewRootId,
      });
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [contextSelections, selectedId, viewMode, viewRootId]);

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
        const target = event.target;
        const tagName = String(target?.tagName || "").toLowerCase();

        if (
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select" ||
          target?.isContentEditable
        ) {
          return;
        }

        event.preventDefault();
        setSearchOpen(true);
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
        setSearchQuery("");
        setActiveSearchIndex(0);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectNode = useCallback((id) => {
    const selectedItem = resolveCanonicalWorkItem(id, workItemsRef.current);
    const selectedId = selectedItem?.id || id;

    setSelectedId(selectedId);
    setPropertyPanelItemId(null);

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
    const normalizedDescription = normalizeEliticalDescription(payload.description);
    const createPayload = {
      ...parentPayloadForCreate(type, parentId, currentWorkItems),
      type,
      title: payload.title,
      description: normalizedDescription,
      descr: normalizedDescription,
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
      docketState: normalizeDocketState(payload.docketState),
      dktStateId: payload.stateId || docketStateApiId(payload.docketState),
      dktStateName: docketStateApiName(payload.docketState),
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
      hasNoSprint: usesNativeDocketCreatePayload ? isOrphanSprintCreate : undefined,
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
      setSyncActivity((current) =>
        localSavedSyncActivity(result.message || "Saved locally", current)
      );
      const createdId = result.item?.id || result.docket?.id || null;

      if (viewMode === "day" && createdId) {
        persistRetainedCreationContexts((current) =>
          addRetainedCreationContext({
            state: current,
            viewMode: "day",
            contextId: selectedContextOption?.id || formatDateInput(new Date()),
            nodeId: createdId,
            parentId,
            sprintId: createPayload.sprintId || ORPHAN_SPRINT_ID,
          })
        );
      }

      setSelectedId(createdId);

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
  }, [
    applyNormalizedGraphPayload,
    persistRetainedCreationContexts,
    selectedContextOption,
    sprints,
    viewMode,
  ]);

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

  const childActionItemsForNode = useCallback((node) => {
    if (!node) return [];

    return capabilityActionItemsForNode(node).filter(
      (action) =>
        viewMode === "day" ||
        action.kind !== "add-existing" ||
        !(node.isOrphanSprint || node.isOrphanSprintContext)
    );
  }, [viewMode]);

  const handleAddExistingChild = useCallback((request) => {
    setAddExistingChildRequest({
      ...request,
      mode: viewMode === "day" ? "day" : "canonical",
      selectedDate: selectedContextOption?.id || formatDateInput(new Date()),
      sprintId: request.isOrphanSprint ? "" : request.sprintId || "",
      parentId: request.parentId || request.sourceItemId || "",
    });
  }, [selectedContextOption, viewMode]);

  const handleSelectExistingChild = useCallback(async (childId) => {
    if (!addExistingChildRequest) return;

    const selectedDate =
      addExistingChildRequest.selectedDate ||
      selectedContextOption?.id ||
      formatDateInput(new Date());
    const scopeId = addExistingChildRequest.isOrphanSprint
      ? ORPHAN_SPRINT_ID
      : addExistingChildRequest.sprintId || ORPHAN_SPRINT_ID;

    if (addExistingChildRequest.mode === "day") {
      const next = addDayProjectionSelection({
        state: dayProjectionSelections,
        selectedDate,
        kind: addExistingChildRequest.type,
        parentId: addExistingChildRequest.parentId,
        sprintId: scopeId,
        childId,
      });

      setDayProjectionSelections(next);
      saveDayProjectionState(
        typeof window === "undefined" ? null : window.localStorage,
        next
      );
      setAddExistingChildRequest(null);
      setSelectedId(childId);
      setMessage("Added existing item to Day View");
      setLayoutNonce((value) => value + 1);
      return;
    }

    const child = workItemsRef.current.find((item) => item.id === childId);
    const canonicalDocketId = canonicalDocketIdForUpdate(child);
    const updates = canonicalAddExistingUpdates({
      request: addExistingChildRequest,
      child,
      sprints,
    });

    if (!child || !canonicalDocketId || !updates) {
      setMessage("Add Existing is not supported for this relationship yet.");
      return;
    }

    try {
      setMessage("Adding existing item locally...");
      const result = await updateEliticalDocket(canonicalDocketId, updates);

      if (result?.normalized?.appState) {
        applyNormalizedGraphPayload(result, {
          message: result.message || "Added existing item locally",
          preserveView: true,
        });
      } else {
        setMessage(result?.message || "Added existing item locally");
      }
      setSyncActivity((current) =>
        localSavedSyncActivity(result?.message || "Saved locally", current)
      );
      setAddExistingChildRequest(null);
      setSelectedId(child.id);
      setLayoutNonce((value) => value + 1);
    } catch (error) {
      setMessage(error.payload?.message || error.payload?.error || error.message || "Unable to add existing item.");
    }
  }, [
    addExistingChildRequest,
    applyNormalizedGraphPayload,
    dayProjectionSelections,
    selectedContextOption,
    sprints,
  ]);

  const openDetailsModal = useCallback((id) => {
    const selectedItem = resolveCanonicalWorkItem(id, workItemsRef.current);
    const canonicalId = selectedItem?.id || id;

    setPropertyPanelItemId(null);

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

  const closeDetailsModal = useCallback(() => {
    setPropertyPanelItemId(null);
    setModal(null);
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

    const requestedDocketState = normalizeDocketState(updates.docketState);
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
              docketState: normalizeDocketState(updates.docketState),
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
    const requestedDocketState = normalizeDocketState(updates.docketState);
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
          setSyncActivity((current) =>
            localSavedSyncActivity(remoteResult.message || "Saved locally", current)
          );
        } else {
          setMessage(remoteResult?.message || "Saved locally");
          setSyncActivity((current) =>
            localSavedSyncActivity(remoteResult?.message || "Saved locally", current)
          );
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
          setSyncActivity((current) =>
            localSavedSyncActivity(remoteResult.message || "Saved worklog locally", current)
          );
        } else {
          setMessage(remoteResult?.message || "Saved worklog locally");
          setSyncActivity((current) =>
            localSavedSyncActivity(remoteResult?.message || "Saved worklog locally", current)
          );
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
    persistRetainedCreationContexts((current) =>
      removeRetainedCreationContexts(current, result.deletedIds)
    );
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);

    return result;
  }, [persistRetainedCreationContexts, rootDocketState, viewRootId]);

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
    setSyncActivity((current) =>
      normalizeSyncActivityEvent(
        {
          direction: "inbound",
          state: "running",
          phase: "starting",
          message: "Syncing from Elitical...",
        },
        "inbound",
        current
      )
    );
    setSyncState("syncing");
    setMessage("Syncing from Elitical...");

    try {
      const result = await syncLiveEliticalData({
        onProgress(progress) {
          if (progress?.message) {
            setLiveSyncProgress(sanitizeSyncActivityText(progress.message));
          }
          setSyncActivity((current) =>
            normalizeSyncActivityEvent(progress, "inbound", current)
          );
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
      clearRetainedCreationContextState();
      setLiveSyncState("synced");
      setLiveSyncProgress("Sync Complete");
      setSyncActivity((current) =>
        completeSyncActivity("inbound", "Synced from Elitical", current)
      );
    } catch (error) {
      const errorMessage =
        error.payload?.message ||
        error.payload?.error ||
        error.message ||
        "Elitical import failed.";

      setLiveSyncState("failed");
      setLiveSyncProgress(errorMessage);
      setSyncActivity((current) =>
        failedSyncActivity("inbound", errorMessage, current)
      );
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
    clearRetainedCreationContextState,
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
    setSyncActivity((current) =>
      normalizeSyncActivityEvent(
        {
          direction: "outbound",
          state: "running",
          phase: "starting",
          message: "Syncing pending changes to Elitical...",
          current: 0,
          total: syncQueueSummary.actionableCount,
          unit: "operations",
        },
        "outbound",
        current
      )
    );
    setSyncState("syncing");
    setMessage("Syncing pending changes to Elitical...");

    try {
      const result = await syncPendingToElitical({
        onProgress(progress) {
          if (progress?.message) {
            setLiveSyncProgress(sanitizeSyncActivityText(progress.message));
          }
          setSyncActivity((current) =>
            normalizeSyncActivityEvent(progress, "outbound", current)
          );
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
      if (!result.syncSummary?.failed) {
        clearRetainedCreationContextState();
      }
      setLiveSyncState(result.syncSummary?.failed ? "failed" : "synced");
      setLiveSyncProgress(result.message || "Sync to Elitical complete");
      setSyncActivity((current) =>
        result.syncSummary?.failed
          ? failedSyncActivity("outbound", result.message || "Sync to Elitical completed with failures.", current)
          : completeSyncActivity("outbound", result.message || "Synced to Elitical", current)
      );
    } catch (error) {
      const errorMessage =
        error.payload?.message ||
        error.payload?.error ||
        error.message ||
        "Sync to Elitical failed.";

      setLiveSyncState("failed");
      setLiveSyncProgress(errorMessage);
      setSyncActivity((current) =>
        failedSyncActivity("outbound", errorMessage, current)
      );
      setSyncState("offline");
      setMessage(errorMessage);
    }
  }, [
    applyNormalizedGraphPayload,
    baseSha,
    clearRetainedCreationContextState,
    isReadOnlyViewer,
    liveSyncState,
    syncQueueSummary.actionableCount,
  ]);

  const handleResolveDuplicateSyncOperation = useCallback(async ({
    parentOperationId,
    dependentOperationId,
  } = {}) => {
    if (isReadOnlyViewer || liveSyncState === "syncing") return;
    if (!parentOperationId || !dependentOperationId) {
      setMessage("Duplicate recovery requires a failed Docket and blocked Worklog.");
      return;
    }

    const replacementDocketNumber = window.prompt("Replacement Docket number, for example DES-690:");
    if (!replacementDocketNumber) return;
    const replacementRemoteDocketId = window.prompt("Replacement remote Docket UUID:");
    if (!replacementRemoteDocketId) return;
    const replacementRemoteWorklogId = window.prompt("Replacement remote Worklog UUID:");
    if (!replacementRemoteWorklogId) return;

    const request = {
      parentOperationId,
      dependentOperationId,
      replacementDocketNumber: replacementDocketNumber.trim(),
      replacementRemoteDocketId: replacementRemoteDocketId.trim(),
      replacementRemoteWorklogId: replacementRemoteWorklogId.trim(),
    };

    try {
      const preview = await previewDuplicateSyncRecovery(request);
      const replacementWorklog = preview.preview?.replacementWorklog || {};
      const replacementMinutes = Number(replacementWorklog.durationMinutes || 0);
      const replacementDuration = replacementMinutes
        ? formatWorkDuration(replacementMinutes)
        : `${Number(replacementWorklog.hour || 0)}h ${Number(replacementWorklog.min || 0)}m`;
      const confirmed = window.confirm(
        [
          "Resolve as duplicate?",
          "",
          `Failed local: ${preview.preview?.parent?.title || parentOperationId}`,
          `Replacement: ${preview.preview?.replacementDocket?.num || ""} ${preview.preview?.replacementDocket?.title || ""}`.trim(),
          `Blocked Worklog: ${preview.preview?.dependent?.hour || 0}h ${preview.preview?.dependent?.min || 0}m`,
          `Existing Worklog: ${replacementDuration}`,
          "",
          "This is local-only. It will not POST or update Elitical.",
        ].join("\n")
      );

      if (!confirmed) return;

      const result = await resolveDuplicateSyncRecovery(request);

      if (result.normalized?.appState) {
        applyNormalizedGraphPayload(result, {
          message: "Duplicate sync operations resolved locally.",
          preserveView: true,
        });
      } else {
        setSyncQueueSummary(normalizeSyncQueueSummary(result.syncQueue));
      }
      setLiveSyncState("synced");
      setLiveSyncProgress("Duplicate sync operations resolved locally.");
      setSyncActivity((current) =>
        localSavedSyncActivity("Duplicate sync operations resolved locally.", current)
      );
      setSyncStatusPopoverOpen(false);
      setMessage("Duplicate sync operations resolved locally.");
    } catch (error) {
      const message =
        error.payload?.error ||
        error.message ||
        "Unable to resolve duplicate sync operations.";

      setMessage(message);
    }
  }, [
    applyNormalizedGraphPayload,
    isReadOnlyViewer,
    liveSyncState,
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

  const closeInlineSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveSearchIndex(0);
  }, []);
  const openInlineSearch = useCallback(() => {
    setSearchOpen(true);
    setActiveSearchIndex(0);
  }, []);
  const goToNextSearchResult = useCallback(() => {
    setActiveSearchIndex((current) =>
      searchMatches.length > 0 ? (current + 1) % searchMatches.length : 0
    );
  }, [searchMatches.length]);
  const goToPreviousSearchResult = useCallback(() => {
    setActiveSearchIndex((current) =>
      searchMatches.length > 0
        ? (current - 1 + searchMatches.length) % searchMatches.length
        : 0
    );
  }, [searchMatches.length]);

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
  const syncStatusPresentation = buildSyncStatusPresentation({
    activity: syncActivity,
    queueSummary: syncQueueSummary,
    summary: syncStatusSummary,
    liveState: liveSyncState,
  });
  const syncStatusRows = [
    ["Status", syncStatusPresentation.status],
    ["Actionable Sync Items", syncQueueSummary.actionableCount || 0],
    ["Pending Mutations", syncQueueSummary.mutationActionableCount || 0],
    ["Reconciliation Actionable", syncQueueSummary.reconciliationActionableCount || 0],
    ["Blocked", syncQueueSummary.blockedCount || 0],
    ["Unconfirmed Creates", syncQueueSummary.unconfirmedCount || 0],
    ["Sync Failures", syncQueueSummary.failedCount || 0],
    ["Superseded", syncQueueSummary.supersededCount || 0],
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
  const syncVisualState =
    syncActivity.state === "running" || liveSyncState === "syncing"
      ? "syncing"
      : syncStatusPresentation.hasFailures ||
        syncActivity.state === "failed" ||
        liveSyncState === "failed" ||
        syncState === "offline"
      ? "failed"
      : syncQueueSummary.actionableCount > 0
      ? "pending"
      : syncState;
  const profileInfo = profileInfoFromState(storyState);
  const selectedViewLabel =
    currentAppView?.label ||
    (viewRootItem ? `${viewRootItem.title} View` : "Tree View");
  const typeCounts = graphWorkItems.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  const treeStats = [
    { label: "Items", value: contextItemCount },
    { label: "SP", value: contextStoryPoints },
    { label: "Logged", value: formatWorkDuration(contextTimeMinutes) },
    { label: "Projects", value: projectStats.projects },
    { label: "Sprints", value: projectStats.sprints },
    { label: "Dockets", value: projectStats.dockets },
    { label: "Epics", value: projectStats.epics },
    { label: "Stories", value: projectStats.stories },
    { label: "Jobs", value: projectStats.jobs },
    { label: "Tasks", value: projectStats.tasks },
  ];
  const contextStats = [
    { label: "Items", value: contextItemCount },
    { label: "SP", value: contextStoryPoints },
    { label: "Logged", value: formatWorkDuration(contextTimeMinutes) },
    { label: "Epics", value: typeCounts.epic || 0 },
    { label: "Stories", value: typeCounts.story || 0 },
    { label: "Jobs", value: typeCounts.job || 0 },
    { label: "Tasks", value: typeCounts.task || 0 },
  ];
  const dayStats = daySummary
    ? [
        { label: "Worklogs", value: daySummary.worklogs },
        { label: "Logged", value: formatWorkDuration(daySummary.totalMinutes) },
        { label: "Projects", value: daySummary.projects },
        { label: "Sprints", value: daySummary.sprints },
        { label: "Epics", value: daySummary.epics },
        { label: "Stories", value: daySummary.stories },
        { label: "Jobs", value: daySummary.jobs },
        { label: "Tasks", value: daySummary.tasks },
      ]
    : [];
  const dashboardStats = [
    { label: "Projects", value: projectStats.projects },
    { label: "Sprints", value: projectStats.sprints },
    { label: "Dockets", value: projectStats.dockets },
    { label: "SP", value: totals.rootTotal },
    { label: "Logged", value: formatWorkDuration(totals.rootTimeMinutes || 0) },
  ];
  const contextSelectorControl = isContextView && viewMode !== "day"
    ? (
        <ContextGraphSelector
          label={contextViewLabel(viewMode)}
          options={contextOptions}
          value={selectedContextOption?.id || ""}
          onChange={selectContextViewOption}
          viewMode={viewMode}
          inline
        />
      )
    : null;
  const backlogGroupingControl = viewMode === "backlog"
    ? (
        <BacklogGroupingSelector
          value={backlogGrouping}
          onChange={(value) => {
            setBacklogGrouping(value);
            saveBacklogGroupingPreference(value);
            setViewRootId(null);
            setSelectedId(null);
            setLayoutNonce((current) => current + 1);
          }}
        />
      )
    : null;
  const headerContextByView = {
    main: { stats: treeStats },
    sprint: { control: contextSelectorControl, stats: contextStats },
    epic: { control: contextSelectorControl, stats: contextStats },
    story: { control: contextSelectorControl, stats: contextStats },
    job: { control: contextSelectorControl, stats: contextStats },
    task: { control: contextSelectorControl, stats: contextStats },
    day: {
      control: (
        <DayViewToolbar
          value={selectedDayDate}
          onChange={selectContextViewOption}
          summary={daySummary}
          inline
        />
      ),
      stats: dayStats,
    },
    backlog: { control: backlogGroupingControl, stats: contextStats },
    worklog: {
      stats: [
        { label: "Worklogs", value: importedWorklogs.length },
        {
          label: "Logged",
          value: formatWorkDuration(
            importedWorklogs.reduce((total, entry) => total + worklogMinutes(entry), 0)
          ),
        },
      ],
    },
    dashboard: { stats: dashboardStats },
  };
  const headerContext = headerContextByView[viewMode] || { stats: [] };
  const handleSearchFilterChange = (key, value) => {
    setSearchFilters((current) => ({
      ...current,
      [key]: value,
    }));
  };
  const clearExplicitSearchFilters = () => {
    setSearchFilters({ ...EMPTY_SEARCH_FILTERS });
  };
  const globalSearch = (
    <InlineHeaderSearch
      open={searchOpen}
      query={searchQuery}
      scope={searchScope}
      filters={searchFilters}
      inheritedFilters={inheritedSearchFilters}
      filterChips={searchFilterChips}
      filterOptionsByKey={searchFilterOptionsByKey}
      availableFilterKeys={availableFilterKeys}
      activeFilterCount={activeExplicitFilterCount}
      matchCount={searchMatches.length}
      activeIndex={activeSearchIndex}
      hasSearchableItems={searchItems.length > 0}
      onOpen={openInlineSearch}
      onClose={closeInlineSearch}
      onQueryChange={setSearchQuery}
      onScopeChange={(scope) => {
        setSearchScope(scope);
        setActiveSearchIndex(0);
      }}
      onFilterChange={handleSearchFilterChange}
      onClearFilters={clearExplicitSearchFilters}
      onNext={goToNextSearchResult}
      onPrevious={goToPreviousSearchResult}
    />
  );
  const globalActions = (
    <GlobalActions
      syncState={syncState}
      liveSyncState={liveSyncState}
      syncActivity={syncActivity}
      syncVisualState={syncVisualState}
      syncStatusPopoverOpen={syncStatusPopoverOpen}
      syncStatusPopoverRef={syncStatusPopoverRef}
      onToggleSyncStatus={() => {
        setViewMenuOpen(false);
        setSyncStatusPopoverOpen((open) => !open);
      }}
      syncStatusSummary={syncStatusSummary}
      syncStatusRows={syncStatusRows}
      syncStatusPresentation={syncStatusPresentation}
      syncQueueSummary={syncQueueSummary}
      isReadOnlyViewer={isReadOnlyViewer}
      onSyncToElitical={handleSyncToElitical}
      onSyncFromElitical={handleSyncFromElitical}
      onResolveDuplicate={handleResolveDuplicateSyncOperation}
      profileMenuOpen={profileMenuOpen}
      profileMenuRef={profileMenuRef}
      onToggleProfile={() => setProfileMenuOpen((open) => !open)}
      onOpenLogs={() => {
        setProfileMenuOpen(false);
        setLogsModalOpen(true);
      }}
      profileInfo={profileInfo}
    />
  );

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
    <div className={`app-container ${canvasFullMode ? "canvas-full-mode" : ""}`}>
      {!canvasFullMode ? (
        <GlobalViewHeader
          currentLabel={selectedViewLabel}
          viewMode={viewMode}
          viewMenuOpen={viewMenuOpen}
          onToggleViewMenu={() => {
            setSyncStatusPopoverOpen(false);
            setViewMenuOpen((open) => !open);
          }}
          onCloseViewMenu={() => setViewMenuOpen(false)}
          onSelectView={showAppView}
          context={headerContext}
          search={globalSearch}
          globalActions={globalActions}
        />
      ) : null}

      {!canvasFullMode && viewMode === "day" && dayTimelineModel ? (
        <DayTimelineNavigation
          model={dayTimelineModel}
          selectedDate={selectedDayDate}
          todayKey={todayKey}
          onSelectDate={selectContextViewOption}
        />
      ) : null}

      {!canvasFullMode &&
      ((!isReadOnlyViewer && dirty) || (!isReadOnlyViewer && saveState === "conflict") || viewRootId) ? (
        <div className="toolbar-secondary-actions">
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
      ) : null}

      <main className="app-main-content">
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
            workItems={graphWorkItems}
            allWorkItems={workItems}
            sprints={graphSprints}
            onOpenDetails={openDetailsModal}
            searchMatchIds={searchMatchIds}
            activeSearchId={activeSearchId}
            employeeScope={selectedEmployeeScope}
          />
        ) : isDashboardView ? (
          <DashboardView
            workItems={workItems}
            sprints={sprints}
            rootTitle={rootTitle}
            totals={totals}
            lastSyncedAt={lastSyncedAt}
            employeeScope={selectedEmployeeScope}
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
            onAddExistingChild={handleAddExistingChild}
            childActionItemsForNode={childActionItemsForNode}
            layoutNonce={layoutNonce}
            searchMatchIds={searchMatchIds}
            activeSearchId={activeSearchId}
            activeSearchNodeId={activeSearchMatch?.id || ""}
            activeSearchFocusKey={activeSearchFocusKey}
            projectHierarchy={viewMode !== "backlog"}
            canvasFullMode={canvasFullMode}
            onCanvasFullModeChange={setCanvasFullMode}
            readOnly={isReadOnlyViewer}
          />
        )}
      </main>

      <LogViewerModal open={logsModalOpen} onClose={() => setLogsModalOpen(false)} />

      {modal && (
        <WorkItemModal
          modal={modal}
          mainTitle={mainTitle}
          rootTitle={rootTitle}
          rootDocketState={rootDocketState}
          sprints={sprints}
          workItems={workItems}
          totals={totals}
          onClose={closeDetailsModal}
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

      {addExistingChildRequest && (
        <AddExistingChildModal
          request={addExistingChildRequest}
          selectedDate={
            addExistingChildRequest.selectedDate ||
            selectedContextOption?.id ||
            formatDateInput(new Date())
          }
          workItems={workItems}
          sprints={graphScopeOptions}
          projectionState={dayProjectionSelections}
          onSelect={handleSelectExistingChild}
          onClose={() => setAddExistingChildRequest(null)}
        />
      )}

      {selectedEditableItem && (
        <PropertyPanel
          item={selectedEditableItem}
          workItems={workItems}
          sprints={sprints}
          onClose={() => setPropertyPanelItemId(null)}
          onSave={saveEditableWorkItem}
          readOnly={isReadOnlyViewer}
        />
      )}
    </div>
  );
}

export default App;
