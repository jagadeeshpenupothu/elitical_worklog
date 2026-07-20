import { ROOT_ID } from "./worklogModel.js";
import {
  ORPHAN_SPRINT_ID,
  ORPHAN_SPRINT_TITLE,
  isOrphanSprintId,
  orphanSprintScope,
} from "./hierarchyProjection.js";

export { ORPHAN_SPRINT_ID };

export const DAY_VIEW_PROJECTION_STORAGE_KEY =
  "elitical-worklog.day-view-projections.v1";

export function dateKeyFromValue(value) {
  if (!value) return "";

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";

    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }

  const text = String(value).trim();

  if (!text) return "";

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;

  if (/^\d+$/.test(text)) return dateKeyFromValue(new Date(Number(text)));

  return dateKeyFromValue(new Date(text));
}

export function dateOrdinal(value) {
  const key = dateKeyFromValue(value);
  const [year, month, day] = key.split("-").map((part) => Number(part));

  if (![year, month, day].every(Number.isFinite)) return null;

  return Date.UTC(year, month - 1, day) / 86400000;
}

function sprintStartValue(sprint) {
  return sprint?.sprintStartDate || sprint?.startDate || sprint?.plannedStartDate || "";
}

function sprintEndValue(sprint) {
  return sprint?.sprintEndDate || sprint?.endDate || sprint?.plannedEndDate || "";
}

function sprintSortKey(sprint) {
  return [
    dateKeyFromValue(sprintStartValue(sprint)) || "9999-12-31",
    dateKeyFromValue(sprintEndValue(sprint)) || "9999-12-31",
    sprint?.title || sprint?.name || "",
    sprint?.id || "",
  ].join(":");
}

export function sprintContainsDate(sprint, selectedDate) {
  const selected = dateOrdinal(selectedDate);
  const start = dateOrdinal(sprintStartValue(sprint));
  const end = dateOrdinal(sprintEndValue(sprint));

  if (selected === null || start === null || end === null) return false;

  return start <= selected && selected <= end;
}

export function sprintsForDay(sprints = [], selectedDate) {
  return sprints
    .filter((sprint) => sprint?.id && sprint.id !== ROOT_ID)
    .filter((sprint) => !isOrphanSprintId(sprint.id))
    .filter((sprint) => sprintContainsDate(sprint, selectedDate))
    .sort((first, second) => sprintSortKey(first).localeCompare(sprintSortKey(second)));
}

export function sprintScopesForDay(sprints = [], selectedDate) {
  const matched = sprintsForDay(sprints, selectedDate);

  return matched.length > 0 ? matched : [orphanSprintScope()];
}

export function dayScopeIdForItem(item) {
  return item?.elitical?.sprintId || item?.sprintId || ORPHAN_SPRINT_ID;
}

export function normalizeDayProjectionState(value) {
  const input = value && typeof value === "object" ? value : {};
  const days = input.days && typeof input.days === "object" ? input.days : {};
  const normalizedDays = {};

  Object.entries(days).forEach(([date, day]) => {
    const dateKey = dateKeyFromValue(date);
    if (!dateKey || !day || typeof day !== "object") return;

    const epicsBySprint = {};
    Object.entries(day.epicsBySprint || {}).forEach(([sprintId, ids]) => {
      const values = Array.isArray(ids)
        ? ids.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      if (values.length > 0) epicsBySprint[sprintId || ORPHAN_SPRINT_ID] = [...new Set(values)];
    });

    const storiesByEpicScope = {};
    Object.entries(day.storiesByEpicScope || {}).forEach(([scopeKey, ids]) => {
      const values = Array.isArray(ids)
        ? ids.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      if (values.length > 0) storiesByEpicScope[scopeKey] = [...new Set(values)];
    });

    normalizedDays[dateKey] = {
      epicsBySprint,
      storiesByEpicScope,
    };
  });

  return {
    version: 1,
    days: normalizedDays,
  };
}

export function loadDayProjectionState(storage) {
  if (!storage) return normalizeDayProjectionState();

  try {
    return normalizeDayProjectionState(
      JSON.parse(storage.getItem(DAY_VIEW_PROJECTION_STORAGE_KEY) || "{}")
    );
  } catch {
    return normalizeDayProjectionState();
  }
}

export function saveDayProjectionState(storage, state) {
  if (!storage) return;

  storage.setItem(
    DAY_VIEW_PROJECTION_STORAGE_KEY,
    JSON.stringify(normalizeDayProjectionState(state))
  );
}

export function dayEpicScopeKey(epicId, sprintId) {
  return `${epicId || ""}::${sprintId || ORPHAN_SPRINT_ID}`;
}

export function emptyDaySelection() {
  return {
    epicsBySprint: {},
    storiesByEpicScope: {},
  };
}

export function daySelectionForDate(state, selectedDate) {
  const dateKey = dateKeyFromValue(selectedDate);

  return normalizeDayProjectionState(state).days[dateKey] || emptyDaySelection();
}

export function addDayProjectionSelection({
  state,
  selectedDate,
  kind,
  parentId,
  sprintId,
  childId,
}) {
  const normalized = normalizeDayProjectionState(state);
  const dateKey = dateKeyFromValue(selectedDate);
  const id = String(childId || "").trim();

  if (!dateKey || !id) return normalized;

  const day = {
    ...emptyDaySelection(),
    ...(normalized.days[dateKey] || {}),
  };

  if (kind === "epic") {
    const scopeId = sprintId || ORPHAN_SPRINT_ID;
    const current = day.epicsBySprint[scopeId] || [];

    day.epicsBySprint = {
      ...day.epicsBySprint,
      [scopeId]: [...new Set([...current, id])],
    };
  }

  if (kind === "story") {
    const scopeKey = dayEpicScopeKey(parentId, sprintId);
    const current = day.storiesByEpicScope[scopeKey] || [];

    day.storiesByEpicScope = {
      ...day.storiesByEpicScope,
      [scopeKey]: [...new Set([...current, id])],
    };
  }

  return {
    ...normalized,
    days: {
      ...normalized.days,
      [dateKey]: day,
    },
  };
}

export function sprintTitleForScope(sprintId, sprints = []) {
  if (!sprintId || isOrphanSprintId(sprintId)) return ORPHAN_SPRINT_TITLE;

  return sprints.find((sprint) => sprint.id === sprintId)?.title || "";
}
