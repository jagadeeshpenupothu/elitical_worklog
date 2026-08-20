import { dateKeyFromValue, dateOrdinal } from "./dayViewProjection.js";
import { docketNumberForItem } from "./docketIdentity.js";
import { normalizeDocketState } from "./docketStates.js";
import { ROOT_ID } from "./worklogModel.js";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const UNKNOWN_EMPLOYEE_ID = "unknown-employee";

function text(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || "";
}

function numberValue(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function safeWholeMinutes(minutes) {
  return Math.max(0, Math.round(numberValue(minutes)));
}

function worklogDurationMinutes(entry = {}) {
  const explicitMinutes = numberValue(
    entry.timeMinutes ?? entry.durationMinutes ?? entry.loggedMinutes
  );

  if (explicitMinutes > 0) return safeWholeMinutes(explicitMinutes);

  const hours = numberValue(
    entry.hour ?? entry.hours ?? entry.loggedHours ?? entry.duration
  );
  const minutes = numberValue(entry.min ?? entry.minutes);

  return safeWholeMinutes(hours * 60 + minutes);
}

function stableEmployeeId(employee = {}) {
  return firstText(
    employee.employeeId,
    employee.id,
    employee.empId,
    employee.userId
  );
}

function employeeDisplayName(employee = {}) {
  return firstText(
    employee.name,
    employee.employeeName,
    employee.displayName,
    employee.fullName,
    employee.userName,
    stableEmployeeId(employee)
  );
}

function itemAssigneeId(item = {}) {
  return firstText(item.elitical?.assigneeId, item.assigneeId);
}

function itemAssigneeName(item = {}) {
  return firstText(item.elitical?.assigneeName, item.assignee);
}

function worklogEmployeeId(entry = {}, item = {}) {
  return firstText(
    entry.employeeId,
    entry.empId,
    entry.employee?.id,
    entry.employee?.employeeId,
    itemAssigneeId(item),
    UNKNOWN_EMPLOYEE_ID
  );
}

function worklogEmployeeName(entry = {}, item = {}) {
  return firstText(
    entry.employeeName,
    entry.employee?.name,
    entry.employee?.employeeName,
    entry.employee?.displayName,
    itemAssigneeName(item)
  );
}

function addEmployee(directory, employee = {}, fallbackName = "") {
  const employeeId = stableEmployeeId(employee);

  if (!employeeId) return;

  const previous = directory.get(employeeId) || {};
  directory.set(employeeId, {
    ...previous,
    ...employee,
    employeeId,
    id: employeeId,
    name: employeeDisplayName(employee) || fallbackName || previous.name || employeeId,
  });
}

export function buildReportEmployeeDirectory({
  employees = [],
  employeeDirectory,
  workItems = [],
  storyState,
} = {}) {
  const directory = new Map();

  if (employeeDirectory instanceof Map) {
    employeeDirectory.forEach((employee, id) => {
      addEmployee(directory, {
        ...employee,
        employeeId: employee?.employeeId || employee?.id || id,
      });
    });
  }

  if (Array.isArray(employees)) {
    employees.forEach((employee) => addEmployee(directory, employee));
  }

  [
    storyState?.employee,
    storyState?.metadata?.employee,
    ...(Array.isArray(storyState?.employees) ? storyState.employees : []),
  ].forEach((employee) => addEmployee(directory, employee));

  workItems.forEach((item) => {
    addEmployee(directory, {
      employeeId: itemAssigneeId(item),
      name: itemAssigneeName(item),
    });
    (item.worklogs || []).forEach((entry) => {
      addEmployee(directory, {
        employeeId: worklogEmployeeId(entry, item),
        name: worklogEmployeeName(entry, item),
      });
    });
  });

  return directory;
}

function dateParts(dateKey) {
  const [year, month, day] = text(dateKey).split("-").map((part) => Number(part));

  if (![year, month, day].every(Number.isFinite)) return null;

  return { year, month, day };
}

export function reportDateKey(value) {
  return dateKeyFromValue(value);
}

export function reportDayLabel(dateKey) {
  const parts = dateParts(dateKey);

  if (!parts) return text(dateKey);

  const ordinal = dateOrdinal(dateKey);
  const date = new Date(ordinal * 86400000);
  const dayName = DAY_LABELS[date.getUTCDay()] || "";
  const monthName = MONTH_LABELS[parts.month - 1] || "";

  return `${dayName} (${parts.day} ${monthName})`;
}

function rangeEndpointLabel(dateKey, includeYear = false) {
  const parts = dateParts(dateKey);

  if (!parts) return text(dateKey);

  const ordinal = dateOrdinal(dateKey);
  const date = new Date(ordinal * 86400000);
  const dayName = DAY_LABELS[date.getUTCDay()] || "";
  const monthName = MONTH_LABELS[parts.month - 1] || "";
  const suffix = includeYear ? ` ${parts.year}` : "";

  return `${dayName}, ${parts.day} ${monthName}${suffix}`;
}

export function reportRangeLabel(startDate, endDate) {
  const startKey = reportDateKey(startDate);
  const endKey = reportDateKey(endDate || startDate);
  const startParts = dateParts(startKey);
  const endParts = dateParts(endKey);

  if (!startKey && !endKey) return "";
  if (startKey === endKey) return rangeEndpointLabel(startKey, true);
  if (!startParts || !endParts) return [startKey, endKey].filter(Boolean).join(" - ");

  return startParts.year === endParts.year
    ? `${rangeEndpointLabel(startKey)} - ${rangeEndpointLabel(endKey, true)}`
    : `${rangeEndpointLabel(startKey, true)} - ${rangeEndpointLabel(endKey, true)}`;
}

function dateKeyInRange(dateKey, startDate, endDate) {
  const current = dateOrdinal(dateKey);
  const start = dateOrdinal(startDate);
  const end = dateOrdinal(endDate);

  if (current === null || start === null || end === null) return false;

  return start <= current && current <= end;
}

function worklogDateKey(entry = {}) {
  return reportDateKey(firstText(entry.worklogDate, entry.date, entry.createdDate));
}

function worklogStableId(entry = {}, itemId = "", index = 0) {
  return firstText(
    entry.id,
    entry.worklogId,
    entry.eliticalId,
    entry.cx,
    [
      itemId,
      entry.date || entry.worklogDate || entry.createdDate || "",
      entry.employeeId || entry.empId || entry.employeeName || "",
      entry.description || entry.comment || entry.note || "",
      entry.timeMinutes ?? entry.durationMinutes ?? entry.loggedMinutes ?? "",
      index,
    ].join(":")
  );
}

function parentChain(item = {}, itemById = new Map()) {
  const chain = [];
  const visited = new Set();
  let parentId = text(item.parentId);

  while (parentId && parentId !== ROOT_ID && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = itemById.get(parentId);

    if (!parent) break;

    chain.push(parent);
    parentId = text(parent.parentId);
  }

  return chain;
}

function nearestAncestorOfType(item, itemById, type) {
  if (item?.type === type) return item;

  return parentChain(item, itemById).find((parent) => parent.type === type) || null;
}

function sprintIdForItem(item = {}, ancestors = []) {
  return firstText(
    item.targetScopeId,
    item.targetSprintId,
    item.elitical?.sprintId,
    item.sprintId,
    ...ancestors.map((ancestor) =>
      firstText(
        ancestor.targetScopeId,
        ancestor.targetSprintId,
        ancestor.elitical?.sprintId,
        ancestor.sprintId
      )
    )
  );
}

function sprintNameForItem(item = {}, ancestors = [], sprintById = new Map()) {
  const sprintId = sprintIdForItem(item, ancestors);
  const sprint = sprintById.get(sprintId);

  return firstText(
    item.childSprint,
    item.sprintName,
    item.sprint,
    sprint?.title,
    sprint?.name,
    ...ancestors.map((ancestor) =>
      firstText(ancestor.childSprint, ancestor.sprintName, ancestor.sprint)
    )
  );
}

function docketRemoteId(item = {}) {
  return firstText(
    item.elitical?.remoteId,
    item.sync?.remoteId,
    item.remoteId,
    item.eliticalId
  );
}

function docketState(item = {}) {
  return normalizeDocketState(
    item.docketState || item.status || item.stateName || item.dktStateName
  );
}

function worklogDescription(entry = {}, item = {}) {
  return firstText(entry.comment, entry.description, entry.note, item.title);
}

function sortValue(value) {
  return text(value).toLowerCase();
}

function entrySortKey(entry) {
  return [
    firstText(entry.startedAt, entry.startTime, entry.time, entry.worklogDate),
    sortValue(entry.docketNumber || entry.docketId),
    sortValue(entry.docketTitle),
    sortValue(entry.description),
    sortValue(entry.worklogId),
  ].join("\u0000");
}

function memberSortKey(member) {
  return [sortValue(member.name), sortValue(member.employeeId)].join("\u0000");
}

function memberForId(employeeId, directory = new Map()) {
  const employee = directory.get(employeeId) || {};

  return {
    employeeId,
    name: employeeDisplayName(employee) || employeeId,
  };
}

export function generateReportModel({
  workItems = [],
  employees = [],
  employeeDirectory,
  sprints = [],
  storyState,
  query = {},
} = {}) {
  const startDate = reportDateKey(query.startDate);
  const endDate = reportDateKey(query.endDate || query.startDate);
  const directory = buildReportEmployeeDirectory({
    employees,
    employeeDirectory,
    workItems,
    storyState,
  });
  const requestedEmployeeIds = (query.employeeIds || [])
    .map(text)
    .filter(Boolean);
  const requestedEmployeeIdSet = new Set(requestedEmployeeIds);
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]));
  const entriesByEmployeeAndDate = new Map();
  const includedWorklogIds = new Set();
  let worklogCount = 0;
  let durationMinutes = 0;

  function ensureEmployeeDate(employeeId, dateKey) {
    if (!entriesByEmployeeAndDate.has(employeeId)) {
      entriesByEmployeeAndDate.set(employeeId, new Map());
    }

    const byDate = entriesByEmployeeAndDate.get(employeeId);

    if (!byDate.has(dateKey)) byDate.set(dateKey, []);

    return byDate.get(dateKey);
  }

  workItems.forEach((item) => {
    if (!item || !["epic", "story", "task", "job"].includes(item.type)) return;
    if (!Array.isArray(item.worklogs) || item.worklogs.length === 0) return;

    const ancestors = parentChain(item, itemById);
    const epic = nearestAncestorOfType(item, itemById, "epic");
    const story = nearestAncestorOfType(item, itemById, "story");
    const sprintId = sprintIdForItem(item, ancestors);
    const sprintName = sprintNameForItem(item, ancestors, sprintById);

    item.worklogs.forEach((entry, index) => {
      const dateKey = worklogDateKey(entry);

      if (!dateKey || !dateKeyInRange(dateKey, startDate, endDate)) return;

      const employeeId = worklogEmployeeId(entry, item);
      if (requestedEmployeeIdSet.size > 0 && !requestedEmployeeIdSet.has(employeeId)) {
        return;
      }

      const stableId = worklogStableId(entry, item.id, index);
      if (!stableId || includedWorklogIds.has(stableId)) return;

      includedWorklogIds.add(stableId);

      const employeeName =
        employeeDisplayName(directory.get(employeeId)) ||
        worklogEmployeeName(entry, item) ||
        employeeId;
      const minutes = worklogDurationMinutes(entry);
      const docketNumber = docketNumberForItem(item);
      const reportEntry = {
        worklogId: stableId,
        employeeId,
        employeeName,
        dateKey,
        docketId: item.id,
        docketNumber: docketNumber || "",
        docketTitle: item.title || item.id,
        docketType: item.type,
        remoteId: docketRemoteId(item),
        parentEpicId: epic?.id || "",
        parentEpicTitle: epic?.title || "",
        storyId: story?.id || "",
        storyTitle: story?.title || "",
        sprintId,
        sprintName,
        state: docketState(item),
        description: worklogDescription(entry, item),
        durationMinutes: minutes,
        startTime: firstText(entry.startedAt, entry.startTime, entry.time),
      };

      addEmployee(directory, {
        employeeId,
        name: employeeName,
      });
      ensureEmployeeDate(employeeId, dateKey).push(reportEntry);
      worklogCount += 1;
      durationMinutes += minutes;
    });
  });

  const memberIds = requestedEmployeeIds.length
    ? requestedEmployeeIds
    : Array.from(entriesByEmployeeAndDate.keys());
  const members = memberIds
    .map((employeeId) => {
      const byDate = entriesByEmployeeAndDate.get(employeeId) || new Map();
      const days = Array.from(byDate.entries())
        .sort(([first], [second]) => dateOrdinal(first) - dateOrdinal(second))
        .map(([dateKey, entries]) => {
          const sortedEntries = [...entries].sort((first, second) =>
            entrySortKey(first).localeCompare(entrySortKey(second))
          );
          const totalMinutes = sortedEntries.reduce(
            (total, entry) => total + entry.durationMinutes,
            0
          );

          return {
            dateKey,
            dayLabel: reportDayLabel(dateKey),
            entries: sortedEntries,
            totalMinutes,
          };
        });
      const totalMinutes = days.reduce((total, day) => total + day.totalMinutes, 0);

      return {
        ...memberForId(employeeId, directory),
        days,
        totalMinutes,
      };
    })
    .sort((first, second) => memberSortKey(first).localeCompare(memberSortKey(second)));

  return {
    range: {
      startDate,
      endDate,
      label: reportRangeLabel(startDate, endDate),
    },
    teamId: query.teamId || null,
    members,
    totals: {
      worklogCount,
      durationMinutes,
    },
  };
}
