import { ROOT_ID } from "./worklogModel";

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date) {
  const next = startOfDay(date);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function dateKey(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

function rangeDays(start, end) {
  const days = [];
  let cursor = startOfDay(start);
  const last = startOfDay(end);

  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }

  return days;
}

function monthDays(anchor) {
  const first = startOfWeek(startOfMonth(anchor));
  const last = addDays(startOfWeek(endOfMonth(anchor)), 6);
  return rangeDays(first, last);
}

function formatDate(value, options = {}) {
  const date = toDate(value);
  if (!date) return "Unscheduled";
  return new Intl.DateTimeFormat("en", options).format(date);
}

function itemScheduleDate(item) {
  return item.plannedStartDate || item.dueDate || item.actualStartDate || item.createdAt;
}

function itemEndDate(item) {
  return item.plannedEndDate || item.dueDate || item.actualEndDate || itemScheduleDate(item);
}

function worklogDates(item) {
  return Array.isArray(item.worklogs)
    ? item.worklogs.map((entry) => entry.date).filter(Boolean)
    : [];
}

function itemMatchesDay(item, key) {
  return dateKey(itemScheduleDate(item)) === key ||
    dateKey(itemEndDate(item)) === key ||
    dateKey(item.dueDate) === key ||
    worklogDates(item).some((date) => dateKey(date) === key);
}

function itemWithinRange(item, start, end) {
  const itemStart = toDate(itemScheduleDate(item));
  const itemEnd = toDate(itemEndDate(item));
  const logs = worklogDates(item).map(toDate).filter(Boolean);

  if (!itemStart && !itemEnd && logs.length === 0) return false;

  const normalizedStart = startOfDay(start);
  const normalizedEnd = startOfDay(end);

  if (logs.some((log) => startOfDay(log) >= normalizedStart && startOfDay(log) <= normalizedEnd)) {
    return true;
  }

  const scheduledStart = startOfDay(itemStart || itemEnd);
  const scheduledEnd = startOfDay(itemEnd || itemStart);

  return scheduledStart <= normalizedEnd && scheduledEnd >= normalizedStart;
}

function itemLoggedMinutes(item) {
  if (Number.isFinite(Number(item.timeMinutes))) return Number(item.timeMinutes);
  if (Number.isFinite(Number(item.loggedHours))) return Number(item.loggedHours) * 60;
  return 0;
}

function virtualNode({
  id,
  title,
  parentId,
  type = "task",
  docketState = "concept",
  updatedAt,
  storyPoints = 0,
  timeMinutes = 0,
}) {
  return {
    id,
    title,
    description: "",
    category: "feature",
    type,
    priority: "info",
    parentId,
    openQueue: false,
    assignee: "",
    sprint: "",
    docketState,
    createdAt: updatedAt,
    updatedAt,
    storyPoints,
    timeMinutes,
    isVirtual: true,
  };
}

function sprintTitleForItem(item, sprintByTitle, rootTitle) {
  return item.sprint && sprintByTitle.has(item.sprint) ? item.sprint : rootTitle;
}

function collectAncestors(item, itemById, ids) {
  let parentId = item.parentId;

  while (parentId && parentId !== ROOT_ID) {
    const parent = itemById.get(parentId);
    if (!parent || ids.has(parent.id)) break;
    ids.add(parent.id);
    parentId = parent.parentId;
  }
}

function appendDayHierarchy({
  output,
  sourceItems,
  itemById,
  sprintByTitle,
  rootTitle,
  day,
  parentId,
  pathId,
}) {
  const dayKey = dateKey(day);
  const matchingIds = new Set();

  sourceItems
    .filter((item) => itemMatchesDay(item, dayKey))
    .forEach((item) => {
      matchingIds.add(item.id);
      collectAncestors(item, itemById, matchingIds);
    });

  const ordered = Array.from(matchingIds)
    .map((id) => itemById.get(id))
    .filter(Boolean)
    .sort((a, b) => {
      const typeOrder = { epic: 0, story: 1, task: 2, job: 3 };
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) ||
        a.title.localeCompare(b.title);
  });
  const sprintNodeByTitle = new Map();
  const nodeIdForItem = (id) => `${pathId}:item:${id}`;

  ordered.forEach((item) => {
    const sprintTitle = sprintTitleForItem(item, sprintByTitle, rootTitle);
    const sprint = sprintByTitle.get(sprintTitle);
    const sprintNodeId = `${pathId}:sprint:${sprint?.id || sprintTitle}`;

    if (!sprintNodeByTitle.has(sprintTitle)) {
      sprintNodeByTitle.set(sprintTitle, sprintNodeId);
      output.push(virtualNode({
        id: sprintNodeId,
        title: sprintTitle,
        parentId,
        type: "story-root",
        docketState: sprint?.docketState || "concept",
        updatedAt: day.toISOString(),
      }));
    }

    const parent = item.parentId && item.parentId !== ROOT_ID
      ? itemById.get(item.parentId)
      : null;
    const parentIdForItem = parent && matchingIds.has(parent.id)
      ? nodeIdForItem(parent.id)
      : sprintNodeId;

    output.push({
      ...item,
      id: nodeIdForItem(item.id),
      sourceId: item.id,
      parentId: parentIdForItem,
    });
  });
}

function timelineDays(workItems) {
  const dates = workItems
    .flatMap((item) => [
      itemScheduleDate(item),
      itemEndDate(item),
      item.dueDate,
      ...worklogDates(item),
    ])
    .map(toDate)
    .filter(Boolean);

  if (dates.length === 0) return [startOfDay(new Date())];

  const start = new Date(Math.min(...dates.map((date) => date.getTime())));
  const end = new Date(Math.max(...dates.map((date) => date.getTime())));
  return rangeDays(start, end);
}

export function calendarDaysForAnchor(anchorDate) {
  return monthDays(toDate(anchorDate) || new Date());
}

export function buildTimeGraph({
  viewMode,
  workItems,
  sprints,
  rootTitle,
  anchorDate,
  rangeStart,
  rangeEnd,
}) {
  const anchor = toDate(anchorDate) || new Date();
  const start = toDate(rangeStart) || addDays(anchor, -7);
  const end = toDate(rangeEnd) || addDays(anchor, 14);
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const sprintByTitle = new Map(sprints.map((sprint) => [sprint.title, sprint]));
  const output = [];
  let days = [];
  let rootLabel;
  const rootId = `time-root:${viewMode}:${dateKey(anchor)}:${dateKey(start)}:${dateKey(end)}`;

  if (viewMode === "day") {
    days = [startOfDay(anchor)];
    rootLabel = formatDate(anchor, { day: "numeric", month: "long", year: "numeric" });
  } else if (viewMode === "week") {
    const weekStart = startOfWeek(anchor);
    days = rangeDays(weekStart, addDays(weekStart, 6));
    rootLabel = `Week of ${formatDate(weekStart, { day: "numeric", month: "long", year: "numeric" })}`;
  } else if (viewMode === "month") {
    days = monthDays(anchor);
    rootLabel = formatDate(anchor, { month: "long", year: "numeric" });
  } else if (viewMode === "range") {
    days = rangeDays(start <= end ? start : end, end >= start ? end : start);
    rootLabel = `${formatDate(days[0], { day: "numeric", month: "short", year: "numeric" })} - ${formatDate(days[days.length - 1], { day: "numeric", month: "short", year: "numeric" })}`;
  } else {
    days = timelineDays(workItems);
    rootLabel = "Timeline View";
  }

  const sourceItems = workItems.filter((item) =>
    days.some((day) => itemMatchesDay(item, dateKey(day))) ||
    itemWithinRange(item, days[0], days[days.length - 1])
  );

  output.push(virtualNode({
    id: rootId,
    title: rootLabel,
    parentId: ROOT_ID,
    type: "story-root",
    docketState: "concept",
    updatedAt: anchor.toISOString(),
  }));

  if (viewMode === "day") {
    appendDayHierarchy({
      output,
      sourceItems,
      itemById,
      sprintByTitle,
      rootTitle,
      day: days[0],
      parentId: rootId,
      pathId: rootId,
    });
  } else if (viewMode === "month") {
    const weeks = new Map();
    days.forEach((day) => {
      const weekKey = dateKey(startOfWeek(day));
      if (!weeks.has(weekKey)) weeks.set(weekKey, []);
      weeks.get(weekKey).push(day);
    });

    weeks.forEach((weekDays, weekKey) => {
      const weekId = `${rootId}:week:${weekKey}`;
      output.push(virtualNode({
        id: weekId,
        title: `Week of ${formatDate(weekDays[0], { day: "numeric", month: "short" })}`,
        parentId: rootId,
        updatedAt: weekDays[0].toISOString(),
      }));

      weekDays.forEach((day) => {
        const dayId = `${weekId}:day:${dateKey(day)}`;
        output.push(virtualNode({
          id: dayId,
          title: formatDate(day, { weekday: "short", day: "numeric" }),
          parentId: weekId,
          updatedAt: day.toISOString(),
          timeMinutes: sourceItems
            .filter((item) => itemMatchesDay(item, dateKey(day)))
            .reduce((total, item) => total + itemLoggedMinutes(item), 0),
        }));
        appendDayHierarchy({
          output,
          sourceItems,
          itemById,
          sprintByTitle,
          rootTitle,
          day,
          parentId: dayId,
          pathId: dayId,
        });
      });
    });
  } else {
    days.forEach((day) => {
      const dayId = `${rootId}:day:${dateKey(day)}`;
      output.push(virtualNode({
        id: dayId,
        title: formatDate(day, { weekday: "long", day: "numeric", month: "short" }),
        parentId: rootId,
        updatedAt: day.toISOString(),
        timeMinutes: sourceItems
          .filter((item) => itemMatchesDay(item, dateKey(day)))
          .reduce((total, item) => total + itemLoggedMinutes(item), 0),
      }));
      appendDayHierarchy({
        output,
        sourceItems,
        itemById,
        sprintByTitle,
        rootTitle,
        day,
        parentId: dayId,
        pathId: dayId,
      });
    });
  }

  return {
    rootId,
    title: rootLabel,
    workItems: output,
  };
}
