import { projectionScopeIdForItem } from "./hierarchyProjection.js";
import { ROOT_ID } from "./worklogModel.js";
import {
  CANONICAL_DOCKET_STATES,
  docketStateLabel,
  normalizeDocketState,
} from "./docketStates.js";

export const SEARCH_FILTER_KEYS = [
  "date",
  "sprint",
  "epic",
  "state",
  "priority",
  "assignee",
  "storyPoints",
  "type",
  "category",
];

export const EMPTY_SEARCH_FILTERS = Object.freeze(
  SEARCH_FILTER_KEYS.reduce((acc, key) => {
    acc[key] = "";
    return acc;
  }, {})
);

export const SEARCH_FILTER_LABELS = Object.freeze({
  date: "Date",
  sprint: "Sprint",
  epic: "Epic",
  state: "State",
  priority: "Priority",
  assignee: "Assignee",
  storyPoints: "Story Points",
  type: "Type",
  category: "Category",
});

function text(value) {
  return String(value ?? "").trim();
}

function canonicalId(item = {}) {
  return text(item.sourceItemId || item.sourceDocketId || item.sourceId || item.id);
}

function dateKey(value) {
  if (!value) return "";

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";

    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }

  if (typeof value === "number") {
    return dateKey(new Date(value));
  }

  const raw = text(value);
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return dateKey(Number(raw));
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const date = new Date(raw);
  return dateKey(date);
}

function itemDates(item = {}) {
  const dates = new Set([
    dateKey(item.primaryWorklogDate),
    dateKey(item.worklogDate),
    dateKey(item.updatedAt),
    dateKey(item.createdAt),
  ].filter(Boolean));

  (item.worklogs || []).forEach((entry) => {
    const key = dateKey(entry.worklogDate || entry.date);
    if (key) dates.add(key);
  });

  return Array.from(dates);
}

function itemSprintId(item = {}) {
  return projectionScopeIdForItem(item);
}

function sprintLabelById(sprints = []) {
  return new Map(
    sprints.map((sprint) => [
      sprint.id,
      text(sprint.title || sprint.name || sprint.id),
    ])
  );
}

function itemById(items = []) {
  return new Map(items.map((item) => [item.id, item]));
}

function epicForItem(item = {}, byId = new Map()) {
  if (item.type === "epic") return item;

  const directEpicId = text(item.epicId || item.elitical?.epicId);
  if (directEpicId && byId.get(directEpicId)?.type === "epic") {
    return byId.get(directEpicId);
  }

  let parentId = text(item.parentId);
  while (parentId && parentId !== ROOT_ID) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (parent.type === "epic") return parent;
    parentId = text(parent.parentId);
  }

  return null;
}

function assigneeValue(item = {}) {
  return text(item.elitical?.assigneeId || item.assigneeId || item.assignee);
}

function assigneeLabel(item = {}) {
  return text(item.elitical?.assigneeName || item.assignee || item.assigneeId);
}

function worklogEmployeeValue(entry = {}) {
  return text(entry.employeeId);
}

function worklogEmployeeLabel(entry = {}) {
  return text(entry.employeeName || entry.employeeId);
}

function storyPointsValue(item = {}) {
  const value = Number(item.storyPoints ?? item.storyPointEst);
  return Number.isFinite(value) ? String(value) : "";
}

function filterValueForItem(item, key, context) {
  const epic = key === "epic" ? epicForItem(item, context.byId) : null;

  if (key === "date") return itemDates(item);
  if (key === "sprint") return itemSprintId(item);
  if (key === "epic") return epic ? canonicalId(epic) : "";
  if (key === "state") return normalizeDocketState(item.docketState || item.status || item.stateName || item.dktStateName);
  if (key === "priority") return text(item.priority);
  if (key === "assignee") return assigneeValue(item);
  if (key === "storyPoints") return storyPointsValue(item);
  if (key === "type") return text(item.type);
  if (key === "category") return text(item.category);

  return "";
}

function itemMatchesFilterValue(item, key, value, context) {
  if (!value) return true;

  if (key === "date") {
    const expectedDate = dateKey(value);

    if (!expectedDate) return true;
    if (dateKey(item.dayContextDate) === expectedDate) return true;

    return itemDates(item).includes(expectedDate);
  }

  if (key === "assignee") {
    if (assigneeValue(item) === value) return true;
    return (item.worklogs || []).some((entry) => worklogEmployeeValue(entry) === value);
  }

  const itemValue = filterValueForItem(item, key, context);
  if (Array.isArray(itemValue)) return itemValue.includes(value);

  return itemValue === value;
}

function addOption(options, key, value, label = value) {
  const normalizedValue = text(value);
  const normalizedLabel = text(label || value);

  if (!normalizedValue) return;
  if (!options[key].has(normalizedValue)) {
    options[key].set(normalizedValue, {
      value: normalizedValue,
      label: normalizedLabel,
      count: 0,
    });
  }

  options[key].get(normalizedValue).count += 1;
}

function ensureOption(options, key, value, label = value) {
  const normalizedValue = text(value);
  const normalizedLabel = text(label || value);

  if (!normalizedValue || options[key].has(normalizedValue)) return;

  options[key].set(normalizedValue, {
    value: normalizedValue,
    label: normalizedLabel,
    count: 0,
  });
}

export function activeSearchFilterCount(filters = EMPTY_SEARCH_FILTERS) {
  return SEARCH_FILTER_KEYS.filter((key) => Boolean(text(filters[key]))).length;
}

export function buildSearchFilterOptions({ items = [], sprints = [] } = {}) {
  const options = SEARCH_FILTER_KEYS.reduce((acc, key) => {
    acc[key] = new Map();
    return acc;
  }, {});
  const byId = itemById(items);
  const sprintLabels = sprintLabelById(sprints);

  sprints.forEach((sprint) => {
    addOption(options, "sprint", sprint.id, text(sprint.title || sprint.name || sprint.id));
  });

  CANONICAL_DOCKET_STATES.forEach((state) => {
    ensureOption(options, "state", state, docketStateLabel(state));
  });

  items.forEach((item) => {
    itemDates(item).forEach((date) => addOption(options, "date", date, date));

    const sprintId = itemSprintId(item);
    addOption(options, "sprint", sprintId, sprintLabels.get(sprintId) || item.sprint || sprintId);

    const epic = epicForItem(item, byId);
    if (epic) addOption(options, "epic", canonicalId(epic), epic.title || canonicalId(epic));

    addOption(options, "state", filterValueForItem(item, "state", { byId }), docketStateLabel(filterValueForItem(item, "state", { byId })));
    addOption(options, "priority", filterValueForItem(item, "priority", { byId }));
    addOption(options, "assignee", assigneeValue(item), assigneeLabel(item));
    (item.worklogs || []).forEach((entry) => {
      addOption(options, "assignee", worklogEmployeeValue(entry), worklogEmployeeLabel(entry));
    });
    addOption(options, "storyPoints", storyPointsValue(item));
    addOption(options, "type", filterValueForItem(item, "type", { byId }));
    addOption(options, "category", filterValueForItem(item, "category", { byId }));
  });

  return SEARCH_FILTER_KEYS.reduce((acc, key) => {
    acc[key] = Array.from(options[key].values()).sort((first, second) => {
      if (key === "storyPoints") return Number(first.value) - Number(second.value);
      return first.label.localeCompare(second.label, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
    return acc;
  }, {});
}

export function pruneSearchFilters(filters = EMPTY_SEARCH_FILTERS, optionsByKey = {}) {
  return SEARCH_FILTER_KEYS.reduce((acc, key) => {
    const value = text(filters[key]);
    const options = optionsByKey[key] || [];

    if (key === "date") {
      acc[key] = dateKey(value);
      return acc;
    }

    acc[key] = value && options.some((option) => option.value === value) ? value : "";
    return acc;
  }, {});
}

export function searchFilterLabel(filters = EMPTY_SEARCH_FILTERS, optionsByKey = {}, key) {
  const value = text(filters[key]);
  if (!value) return "Any";

  return optionsByKey[key]?.find((option) => option.value === value)?.label || value;
}

export function applySearchFilters({
  items = [],
  filters = EMPTY_SEARCH_FILTERS,
} = {}) {
  const activeKeys = SEARCH_FILTER_KEYS.filter((key) => Boolean(text(filters[key])));

  if (!activeKeys.length) {
    return {
      visibleItems: items,
      matchedItems: items,
      matchedIds: new Set(),
      hasExplicitFilters: false,
    };
  }

  const byId = itemById(items);
  const context = { byId };
  const matchedIds = new Set();

  items.forEach((item) => {
    const matches = activeKeys.every((key) =>
      itemMatchesFilterValue(item, key, filters[key], context)
    );

    if (matches) matchedIds.add(item.id);
  });

  const visibleIds = new Set(matchedIds);

  matchedIds.forEach((id) => {
    let parentId = text(byId.get(id)?.parentId);

    while (parentId && parentId !== ROOT_ID) {
      const parent = byId.get(parentId);
      if (!parent) break;
      visibleIds.add(parent.id);
      parentId = text(parent.parentId);
    }
  });

  return {
    visibleItems: items.filter((item) => visibleIds.has(item.id)),
    matchedItems: items.filter((item) => matchedIds.has(item.id)),
    matchedIds,
    hasExplicitFilters: true,
  };
}
