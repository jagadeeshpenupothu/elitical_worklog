import {
  ORPHAN_SPRINT_ID,
  ORPHAN_SPRINT_TITLE,
  isOrphanSprintId,
  projectionScopeIdForItem,
  scopesWithOrphanSprint,
} from "./hierarchyProjection.js";
import { ROOT_ID } from "./worklogModel.js";
import {
  BACKLOG_ACTIVE_DOCKET_STATES,
  isBacklogDocketState,
  isClosedDocketState,
  normalizeDocketState,
} from "./docketStates.js";

export const BACKLOG_GROUPINGS = Object.freeze([
  { id: "sprint", label: "Sprint" },
  { id: "epic", label: "Epic" },
  { id: "story", label: "Story" },
  { id: "date", label: "Date" },
]);

export const DEFAULT_BACKLOG_GROUPING = "sprint";

export const BACKLOG_ELIGIBLE_STATES = BACKLOG_ACTIVE_DOCKET_STATES;

const DOCKET_TYPES = new Set(["epic", "story", "job", "task"]);

function text(value) {
  return String(value ?? "").trim();
}

export function backlogDocketState(item = {}) {
  return normalizeDocketState(item.docketState || item.status || item.stateName || item.dktStateName);
}

export function isBacklogEligible(item = {}) {
  if (!DOCKET_TYPES.has(item.type)) return false;

  return isBacklogDocketState(backlogDocketState(item));
}

export function isClosedBacklogDocket(item = {}) {
  return isClosedDocketState(backlogDocketState(item));
}

function dateKeyFromValue(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(text(value))) return text(value).slice(0, 10);

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function backlogDateKey(item = {}) {
  const primaryWorklog = Array.isArray(item.worklogs) ? item.worklogs[0] : null;

  return (
    dateKeyFromValue(item.primaryWorklogDate) ||
    dateKeyFromValue(primaryWorklog?.worklogDate || primaryWorklog?.date) ||
    dateKeyFromValue(item.worklogDate) ||
    dateKeyFromValue(item.updatedAt) ||
    dateKeyFromValue(item.createdAt) ||
    "unscheduled"
  );
}

function dateLabel(dateKey) {
  if (dateKey === "unscheduled") return "Unscheduled";

  const [year, month, day] = String(dateKey).split("-");

  return year && month && day ? `${day}/${month}/${year.slice(-2)}` : "Unscheduled";
}

function canonicalId(item = {}) {
  return text(item.sourceItemId || item.sourceDocketId || item.sourceId || item.id);
}

function sprintTitleById(sprints = []) {
  return new Map(sprints.map((sprint) => [sprint.id, sprint.title || sprint.name || sprint.id]));
}

function parentChain(item, itemById) {
  const chain = [];
  const visited = new Set();
  let parentId = item?.parentId;

  while (parentId && parentId !== ROOT_ID && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = itemById.get(parentId);

    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId;
  }

  return chain;
}

function groupingStartIndex(grouping, chain, item) {
  if (grouping === "epic") {
    const index = chain.findIndex((entry) => entry.type === "epic");
    if (index >= 0) return index;
    return item.type === "epic" ? chain.length : chain.length;
  }

  if (grouping === "story") {
    const index = chain.findIndex((entry) => entry.type === "story");
    if (index >= 0) return index;
    return item.type === "story" ? chain.length : chain.length;
  }

  return 0;
}

function cloneForBacklog(item, {
  id = canonicalId(item),
  parentId = ROOT_ID,
  scopeId = "",
  scopeTitle = "",
  eligible = isBacklogEligible(item),
} = {}) {
  const sourceId = canonicalId(item);
  const isStructural = !eligible;
  const sprintId = projectionScopeIdForItem(item);
  const isOrphanScope = isOrphanSprintId(sprintId);

  return {
    ...item,
    id,
    sourceId: id,
    sourceItemId: sourceId,
    sourceDocketId: sourceId,
    parentId,
    visualParentId: parentId,
    canonicalParentId: item.parentId || "",
    targetScopeId: scopeId,
    targetSprintId: sprintId,
    sprintId: isOrphanScope ? "" : sprintId || item.sprintId || "",
    sprint: scopeTitle || item.sprint || "",
    childParentId: sourceId,
    childSprintId: isOrphanScope ? "" : sprintId || item.sprintId || "",
    childSprint: item.sprint || scopeTitle || "",
    isBacklogEligible: eligible,
    isBacklogStructural: isStructural,
    isReference: isStructural,
    isGhost: isStructural,
    isVirtual: isStructural || item.isVirtual,
    allowChildActions: eligible && item.allowChildActions !== false,
    storyPoints: isStructural ? 0 : item.storyPoints,
    worklogs: isStructural ? [] : item.worklogs,
    timeMinutes: isStructural ? 0 : item.timeMinutes,
    durationMinutes: isStructural ? 0 : item.durationMinutes,
  };
}

function addClone(map, item, options) {
  const current = map.get(options.id || canonicalId(item));
  const next = cloneForBacklog(item, options);

  if (!current || (next.isBacklogEligible && !current.isBacklogEligible)) {
    map.set(next.id, next);
  }

  return map.get(next.id) || next;
}

function addBranch({ map, item, chain, parentId, scopeId, scopeTitle, idPrefix = "" }) {
  let nextParentId = parentId;

  chain
    .filter((ancestor) => !isClosedBacklogDocket(ancestor))
    .forEach((ancestor) => {
      const id = `${idPrefix}${canonicalId(ancestor)}`;
      const clone = addClone(map, ancestor, {
        id,
        parentId: nextParentId,
        scopeId,
        scopeTitle,
        eligible: isBacklogEligible(ancestor),
      });

      nextParentId = clone.id;
    });

  addClone(map, item, {
    id: `${idPrefix}${canonicalId(item)}`,
    parentId: nextParentId,
    scopeId,
    scopeTitle,
    eligible: true,
  });
}

function buildSprintGrouping({ eligibleItems, itemById, sprints }) {
  const scopeTitles = sprintTitleById(scopesWithOrphanSprint(sprints, eligibleItems));
  const scopeIds = new Set();
  const map = new Map();

  eligibleItems.forEach((item) => {
    const scopeId = projectionScopeIdForItem(item) || ORPHAN_SPRINT_ID;
    const scopeTitle = scopeTitles.get(scopeId) || item.sprint || ORPHAN_SPRINT_TITLE;

    scopeIds.add(scopeId);
    addBranch({
      map,
      item,
      chain: parentChain(item, itemById),
      parentId: scopeId,
      scopeId,
      scopeTitle,
    });
  });

  const scopes = scopesWithOrphanSprint(sprints, eligibleItems)
    .filter((scope) => scopeIds.has(scope.id))
    .map((scope) => ({
      ...scope,
      title: scope.title || scope.name || (isOrphanSprintId(scope.id) ? ORPHAN_SPRINT_TITLE : scope.id),
    }));

  return {
    workItems: Array.from(map.values()),
    sprints: scopes,
  };
}

function buildHierarchyGrouping({ eligibleItems, itemById, grouping }) {
  const map = new Map();

  eligibleItems.forEach((item) => {
    const chain = parentChain(item, itemById);
    const start = groupingStartIndex(grouping, chain, item);
    const visibleChain = chain.slice(start);

    addBranch({
      map,
      item,
      chain: visibleChain,
      parentId: ROOT_ID,
    });
  });

  return {
    workItems: Array.from(map.values()),
    sprints: [],
  };
}

function buildDateGrouping({ eligibleItems, itemById }) {
  const map = new Map();

  eligibleItems.forEach((item) => {
    const dateKey = backlogDateKey(item);
    const dateNodeId = `backlog-date:${dateKey}`;

    if (!map.has(dateNodeId)) {
      map.set(dateNodeId, {
        id: dateNodeId,
        title: dateLabel(dateKey),
        type: "story-root",
        parentId: ROOT_ID,
        visualParentId: ROOT_ID,
        docketState: "concept",
        isVirtual: true,
        isBacklogDateGroup: true,
        allowChildActions: false,
        storyPoints: 0,
        worklogs: [],
        timeMinutes: 0,
        durationMinutes: 0,
      });
    }

    addBranch({
      map,
      item,
      chain: parentChain(item, itemById),
      parentId: dateNodeId,
      idPrefix: `${dateNodeId}:`,
    });
  });

  return {
    workItems: Array.from(map.values()),
    sprints: [],
  };
}

export function buildBacklogProjection({
  items = [],
  sprints = [],
  grouping = DEFAULT_BACKLOG_GROUPING,
} = {}) {
  const selectedGrouping = BACKLOG_GROUPINGS.some((entry) => entry.id === grouping)
    ? grouping
    : DEFAULT_BACKLOG_GROUPING;
  const itemById = new Map(items.map((item) => [item.id, item]));
  const eligibleItems = items.filter(isBacklogEligible);
  const projection =
    selectedGrouping === "sprint"
      ? buildSprintGrouping({ eligibleItems, itemById, sprints })
      : selectedGrouping === "date"
      ? buildDateGrouping({ eligibleItems, itemById })
      : buildHierarchyGrouping({ eligibleItems, itemById, grouping: selectedGrouping });

  return {
    ...projection,
    eligibleItems,
    grouping: selectedGrouping,
    rootTitle: `Backlog by ${
      BACKLOG_GROUPINGS.find((entry) => entry.id === selectedGrouping)?.label || "Sprint"
    }`,
  };
}
