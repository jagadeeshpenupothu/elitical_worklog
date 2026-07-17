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
  createWorkItem,
  deleteWorkItem,
  generateWorkItemId,
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
  loadLocalGraphCache,
  loadLocalWorklogsCache,
  subscribeToLocalCacheEvents,
} from "./services/localCacheClient";
import { loadPublishedData } from "./services/publishedDataClient";
import {
  clearJobWorklogDraft,
  loadJobWorklogState,
  saveJobWorklogDraft,
  submitJobWorklog,
} from "./services/worklogEngineClient";
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

function isHostedViewerRuntime() {
  if (import.meta.env.VITE_APP_MODE === "desktop") return false;
  if (import.meta.env.VITE_APP_MODE === "viewer") return true;
  if (typeof window === "undefined") return false;

  return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function formatType(type) {
  if (type === "main-root") return "Main";
  if (type === "story-root") return "Sprint";
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function makeCreateDraft(type, sprint, docketState) {
  const now = new Date().toISOString();

  return {
    title: "",
    description: "",
    worklogDescription: "",
    worklogDate: formatDateInput(now),
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

  return {
    title: item.title || "",
    description: item.description || "",
    worklogDescription: primaryWorklog?.description || item.description || "",
    worklogDate: formatDateInput(
      primaryWorklog?.date || item.updatedAt || item.createdAt
    ),
    category: item.category || "feature",
    priority: item.priority || "info",
    sprint: item.sprint || fallbackSprint,
    docketState: item.docketState || "concept",
    storyPoints: item.storyPoints || 0,
    time: formatTimeInput(primaryWorklog?.timeMinutes || item.timeMinutes || 0),
  };
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
  return type === "story" || type === "job";
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

function sprintIdForItem(item) {
  return item?.elitical?.sprintId || item?.sprintId || "";
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
  return workItems
    .filter((item) => item.type === type)
    .sort((first, second) => updatedSortTime(second) - updatedSortTime(first))[0]?.id || "";
}

function contextOptionLabel(option, viewMode) {
  if (!option) return "";
  if (viewMode === "sprint") return option.title || option.id;

  const prefix = option.elitical?.num || option.id;
  return `${prefix} ${option.title || ""}`.trim();
}

function contextOptionMeta(option, viewMode) {
  if (!option) return "";
  if (viewMode === "sprint") return option.sprintState || option.state || option.code || "";

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

function rootAncestorIdForItem(item, itemById) {
  let current = item;

  while (current?.parentId && current.parentId !== ROOT_ID) {
    current = itemById.get(current.parentId);
  }

  return current?.id || item?.id || "";
}

function addAncestors(item, itemById, contextIds) {
  let parentId = item?.parentId;

  while (parentId && parentId !== ROOT_ID) {
    const parent = itemById.get(parentId);

    if (!parent) break;

    contextIds.add(parent.id);
    parentId = parent.parentId;
  }
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
  const contextIds = new Set();
  const selectedSprintIds = new Set();
  const branchSprintTitles = new Map();
  const dayAggregates = new Map();
  const childrenByParent = workItems.reduce((acc, item) => {
    if (!acc.has(item.parentId)) acc.set(item.parentId, []);
    acc.get(item.parentId).push(item);
    return acc;
  }, new Map());

  if (viewMode === "sprint") {
    workItems.forEach((item) => {
      if (sprintIdForItem(item) !== selectedId) return;

      selectedIds.add(item.id);
      addAncestors(item, itemById, contextIds);
    });
  } else if (viewMode === "day") {
    workItems.forEach((item) => {
      const aggregate = aggregateDayWorklogs(item, selectedId);

      if (aggregate.count === 0) return;

      selectedIds.add(item.id);
      dayAggregates.set(item.id, aggregate);
      addAncestors(item, itemById, contextIds);

      const sprintId = sprintIdForItem(item);
      const sprint = sprintById.get(sprintId);

      if (!sprint) return;

      selectedSprintIds.add(sprintId);

      const rootAncestorId = rootAncestorIdForItem(item, itemById);

      if (rootAncestorId && !branchSprintTitles.has(rootAncestorId)) {
        branchSprintTitles.set(rootAncestorId, sprint.title);
      }
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
      addAncestors(selected, itemById, contextIds);
      addDescendants(selected.id, childrenByParent, selectedIds);
    }
  } else if (viewMode === "job" || viewMode === "task") {
    const selected = itemById.get(selectedId);

    if (selected) {
      selectedIds.add(selected.id);
      addAncestors(selected, itemById, contextIds);
    }
  }

  contextIds.forEach((id) => {
    if (selectedIds.has(id)) contextIds.delete(id);
  });

  const contextWorkItems = workItems
    .filter((item) => selectedIds.has(item.id) || contextIds.has(item.id))
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
      const next =
        contextIds.has(dayItem.id) && !selectedIds.has(dayItem.id)
          ? {
              ...dayItem,
              worklogs: [],
              timeMinutes: 0,
              isContextNode: true,
            }
          : selectedIds.has(dayItem.id)
          ? {
              ...dayItem,
              isContextPrimary: true,
            }
          : dayItem;
      const branchSprintTitle =
        viewMode === "day" && dayItem.parentId === ROOT_ID
          ? branchSprintTitles.get(dayItem.id)
          : "";

      return branchSprintTitle && next.sprint !== branchSprintTitle
        ? {
            ...next,
            sprint: branchSprintTitle,
          }
        : next;
    });

  return {
    workItems: contextWorkItems,
    rootId: viewMode === "epic" ? selectedId : null,
    sprints:
      viewMode === "day"
        ? sprints.filter((sprint) => selectedSprintIds.has(sprint.id))
        : [],
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
  const [error, setError] = useState("");
  const isEditing = mode === "edit";
  const parentId =
    modal.kind === "create" ? modal.parentId : activeItem?.parentId;
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
  const hasWorklog = acceptsTime(itemType);
  const contextLabel =
    modal.kind === "create"
      ? `Create ${formatType(itemType)}`
      : isMainRoot
      ? "Main"
      : isSprint
      ? "Sprint"
      : `${formatType(activeItem?.type).toUpperCase()} · ${formatLabel(
          currentCategory
        ).toUpperCase()}`;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    setError("");
  }

  function startInlineEdit(field) {
    if (readOnly) return;
    if (modal.kind !== "details") return;
    setMode("view");
    setEditingField(field);
  }

  function primaryWorklogPayload() {
    if (!hasWorklog) return undefined;

    const otherWorklogs =
      modal.kind === "details" && Array.isArray(activeItem?.worklogs)
        ? activeItem.worklogs.slice(1)
        : [];
    const fallbackDate =
      modal.kind === "details"
        ? primaryWorklogDate(activeItem)
        : new Date().toISOString();

    return [
      {
        date: dateInputToIso(draft.worklogDate, fallbackDate),
        description: draft.worklogDescription.trim(),
        timeMinutes: parseTimeInput(draft.time),
      },
      ...otherWorklogs,
    ];
  }

  function handleSave() {
    if (readOnly) return;

    if (!draft.title.trim()) {
      setError("Title is required.");
      return;
    }

    if (isMainRoot) {
      const result = onSaveMain({
        title: draft.title,
      });
      if (result.ok) {
        setMode("view");
        setEditingField(null);
      } else {
        setError(result.error);
      }
      return;
    }

    if (isSprint) {
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
        setMode("view");
        setEditingField(null);
      }
      else setError(result.error);
      return;
    }

    const payload = {
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      sprint: draft.sprint.trim() || fallbackSprint,
      docketState: draft.docketState || "concept",
      type: itemType,
      createdAt:
        modal.kind === "create" && itemType === "epic"
          ? draft.createdAt || modal.worklogDate
          : draft.createdAt,
      updatedAt:
        modal.kind === "create" && itemType === "epic"
          ? draft.updatedAt || draft.createdAt || modal.worklogDate
          : draft.updatedAt,
      storyPoints:
        itemType === "story"
          ? Number(draft.storyPoints || 0)
          : undefined,
      timeMinutes: acceptsTime(itemType)
        ? parseTimeInput(draft.time)
        : undefined,
      worklogs: primaryWorklogPayload(),
    };
    const result =
      modal.kind === "create"
        ? onCreateItem({
            ...payload,
            parentId: modal.parentId,
          })
        : onSaveItem(activeItem.id, {
            ...payload,
            parentId: activeItem.parentId,
          });

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (modal.kind === "create") {
      onClose();
      return;
    }

    setMode("view");
    setEditingField(null);
  }

  function handleCancel() {
    if (modal.kind === "create") {
      onClose();
      return;
    }

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
    setMode("view");
    setEditingField(null);
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
    ? `${formatType(itemType)} · ${parentLabel(parentId, workItems)}`
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
      onMouseDown={onClose}
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
                  onClose();
                }}
              >
                Set View
              </button>
            )}
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

        <div className="modal-body">
          {modal.kind === "details" && !isMainRoot && !readOnly && (
            <CustomSelectField
              label="Docket State"
              value={draft.docketState || currentDocketState}
              options={DOCKET_STATES}
              onChange={(value) => updateDraft("docketState", value)}
              wide
            />
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
                      onCommit={handleSave}
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
                      onCommit={handleSave}
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
                      onCommit={handleSave}
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
                      onCommit={handleSave}
                    />
                  </ModalSection>
                  {hasWorklog && (
                    <ModalSection title="Worklog" className="worklog-section">
                      <InlineField
                        label="Date"
                        field="worklogDate"
                        value={draft.worklogDate}
                        type="date"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("worklogDate", value)}
                        onCommit={handleSave}
                      />
                      <InlineField
                        label="Time"
                        field="time"
                        value={draft.time}
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) => updateDraft("time", value)}
                        onCommit={handleSave}
                        badge
                      />
                      <InlineField
                        label="Description"
                        field="worklogDescription"
                        value={draft.worklogDescription}
                        type="textarea"
                        editingField={editingField}
                        onEdit={startInlineEdit}
                        onChange={(value) =>
                          updateDraft("worklogDescription", value)
                        }
                        onCommit={handleSave}
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
                        onCommit={handleSave}
                        badge
                      />
                    )}
                  </ModalSection>
                  <ModalSection title="Hierarchy">
                    <ReadOnlyField
                      label="Type"
                      value={formatType(activeItem.type)}
                    />
                    <ReadOnlyField
                      label={parentFieldLabel(activeItem.parentId, workItems)}
                      value={parentLabel(activeItem.parentId, workItems)}
                    />
                    <ReadOnlyField label="Sprint" value={currentSprint} />
                    {activeItem.assignee && (
                      <ReadOnlyField label="Assignee" value={activeItem.assignee} />
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
                    label="Date"
                    type="date"
                    value={draft.worklogDate}
                    onChange={(value) => updateDraft("worklogDate", value)}
                  />
                  <TextAreaField
                    label="Description"
                    value={draft.worklogDescription}
                    onChange={(value) =>
                      updateDraft("worklogDescription", value)
                    }
                    wide
                  />
                  <TextField
                    label="Time"
                    value={draft.time}
                    placeholder="HH:MM"
                    onChange={(value) => updateDraft("time", value)}
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

                      <SelectField
                        label="Docket State"
                        value={draft.docketState || "concept"}
                        options={DOCKET_STATES}
                        onChange={(value) => updateDraft("docketState", value)}
                      />
                    </>
                  )}
                </ModalSection>
              )}

              {!isSprint && !isMainRoot && (
                <ModalSection title="Hierarchy">
                  <ReadOnlyField label="Type" value={formatType(itemType)} />
                  <ReadOnlyField
                    label={parentFieldLabel(parentId, workItems)}
                    value={parentLabel(parentId, workItems)}
                  />
                  <ReadOnlyField label="Sprint" value={draft.sprint} />
                </ModalSection>
              )}

              {modal.kind !== "create" ||
              itemType === "story" ||
              acceptsTime(itemType) ? (
                <ModalSection title="Effort & Time">
                  {itemType === "story" && (
                    <TextField
                      label="Story Points"
                      type="number"
                      value={draft.storyPoints}
                      onChange={(value) => updateDraft("storyPoints", value)}
                    />
                  )}

                  {acceptsTime(itemType) && !hasWorklog && (
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
              >
                Cancel
              </button>
              <button type="button" onClick={handleSave}>
                {modal.kind === "create" ? "Create Work Item" : "Save"}
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
  const [importedWorklogs, setImportedWorklogs] = useState([]);
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
  const contextOptions = useMemo(
    () => contextOptionsForView({ viewMode, sprints, workItems }),
    [sprints, viewMode, workItems]
  );
  const selectedContextId =
    contextSelections[viewMode] ||
    defaultContextSelection({ viewMode, sprints, workItems });
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
            sprints,
            viewMode,
            selectedId: selectedContextOption?.id || "",
          })
        : {
            workItems,
            rootId: null,
            sprints: [],
          },
    [isContextView, selectedContextOption, sprints, viewMode, workItems]
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
    if (viewMode !== "main" || !searchQuery.trim()) return sprints;

    return sprints.filter((sprint) => sprintMatchesQuery(sprint, searchQuery));
  }, [searchQuery, sprints, viewMode]);
  const graphWorkItems = searchedWorkItems;
  const graphSprints =
    viewMode === "main"
      ? searchedSprints
      : viewMode === "day"
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
  const selectedWorklogItem = selectedId
    ? workItems.find(
        (item) =>
          item.id === selectedId &&
          ["story", "job", "task"].includes(item.type)
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

          setImportedWorklogs(result.worklogs.worklogs || []);
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
            setMessage(payload?.message || "Background sync failed.");
          },
          onWarning(payload) {
            if (cancelled) return;

            setMessage(payload?.message || payload?.warning || "GitHub publish warning.");
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
    setSelectedId(id);

    if (id) {
      const selectedItem = workItemsRef.current.find((item) => item.id === id);

      if (["story", "job", "task"].includes(selectedItem?.type)) {
        setModal(null);
        return;
      }

      setModal({
        kind: "details",
        id,
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

  const createItem = useCallback((payload) => {
    const currentWorkItems = workItemsRef.current;
    const id = payload.id || generateWorkItemId(currentWorkItems, payload.type);
    const result = createWorkItem(currentWorkItems, {
      ...payload,
      id,
    });

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
    setSelectedId(result.item.id);
    setMessage("Unsaved Changes");
    setLayoutNonce((value) => value + 1);

    return result;
  }, [rootDocketState]);

  const handleStartChild = useCallback((type, parentId, options = {}) => {
    const currentWorkItems = workItemsRef.current;
    const sprintParent = sprints.find((sprint) => sprint.id === parentId);
    const actualParentId =
      type === "epic" && sprintParent ? ROOT_ID : parentId;
    const fallbackSprint = sprintParent
      ? sprintParent.title
      : inheritedSprint(actualParentId, currentWorkItems, rootTitle);
    const fallbackDocketState = inheritedDocketState(
      actualParentId,
      currentWorkItems,
      sprintParent?.docketState || rootDocketState
    );

    if (type === "epic") {
      setModal({
        kind: "create",
        type,
        parentId: actualParentId,
        sprint: fallbackSprint,
        docketState: fallbackDocketState,
        worklogDate: options.worklogDate,
      });
      return;
    }

    const typeLabel = formatType(type);
    const worklogDate = options.worklogDate || new Date().toISOString();

    createItem({
      title: `New ${typeLabel}`,
      description: "",
      category: "feature",
      priority: "info",
      sprint: fallbackSprint,
      docketState: fallbackDocketState,
      type,
      parentId: actualParentId,
      createdAt: options.worklogDate || undefined,
      updatedAt: options.worklogDate || undefined,
      storyPoints: type === "story" ? 0 : undefined,
      timeMinutes: acceptsTime(type) ? 0 : undefined,
      worklogs: acceptsTime(type)
        ? [
            {
              date: worklogDate,
              description: "",
              timeMinutes: 0,
            },
          ]
        : undefined,
    });
  }, [createItem, rootDocketState, rootTitle, sprints]);

  const openDetailsModal = useCallback((id) => {
    const selectedItem = workItemsRef.current.find((item) => item.id === id);

    setSelectedId(id);

    if (selectedItem?.type === "job") {
      setModal(null);
      setMessage("");
      return;
    }

    setModal({
      kind: "details",
      id,
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
        error.status === 401
          ? "Authentication failed."
          : error.status === 502
          ? "Unable to contact Elitical."
          : error.message || "Elitical import failed.";

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
      ? "Elitical Sync Failed"
      : saveState === "failed"
      ? "Save failed"
      : saveState === "saving"
      ? "Syncing..."
      : syncState === "offline"
      ? "Offline"
    : syncState === "syncing" || syncState === "loading"
      ? "Syncing..."
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

      {graphWorkItems.length === 0 && !usesPlanningSurface && !isDashboardView && viewMode !== "main" && (
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
      ) : (
        <GraphView
          workItems={graphWorkItems}
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
          onSaveItem={saveWorkItem}
          onCreateItem={createItem}
          onDeleteItem={removeWorkItem}
          onSetView={setFocusedView}
          readOnly={isReadOnlyViewer}
        />
      )}

      {selectedWorklogItem && (
        <WorklogPanel
          item={selectedWorklogItem}
          workItems={workItems}
          onClose={() => setSelectedId(null)}
          readOnly={isReadOnlyViewer}
        />
      )}
    </div>
  );
}

export default App;
