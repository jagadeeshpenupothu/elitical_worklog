import assert from "node:assert/strict";

import {
  buildReportQuery,
  resolveReportDateRange,
} from "../src/utils/reportDateRange.js";
import { generateReportModel } from "../src/utils/reportModel.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const referenceDate = "2026-08-20";
const jag = {
  employeeId: "jagadeesh-id",
  name: "Jagadeesh",
};
const sashank = {
  employeeId: "sashank-id",
  name: "Sashank",
};

function plainRange(range) {
  return {
    preset: range.preset,
    startDate: range.startDate,
    endDate: range.endDate,
    label: range.label,
  };
}

function worklog(id, employee, date, minutes) {
  return {
    id,
    worklogDate: date,
    date,
    timeMinutes: minutes,
    durationMinutes: minutes,
    employeeId: employee.employeeId,
    employeeName: employee.name,
    description: id,
  };
}

const single = resolveReportDateRange({
  preset: "single",
  date: "2026-08-14",
}, referenceDate);
assert.deepEqual(plainRange(single), {
  preset: "single",
  startDate: "2026-08-14",
  endDate: "2026-08-14",
  label: "Fri, 14 Aug 2026",
});

const custom = resolveReportDateRange({
  preset: "custom",
  startDate: "2026-08-11",
  endDate: "2026-08-14",
}, referenceDate);
assert.deepEqual(plainRange(custom), {
  preset: "custom",
  startDate: "2026-08-11",
  endDate: "2026-08-14",
  label: "Tue, 11 Aug - Fri, 14 Aug 2026",
});

assert.deepEqual(plainRange(resolveReportDateRange({
  preset: "this-week",
}, referenceDate)), {
  preset: "this-week",
  startDate: "2026-08-17",
  endDate: "2026-08-20",
  label: "Mon, 17 Aug - Thu, 20 Aug 2026",
});

assert.deepEqual(plainRange(resolveReportDateRange({
  preset: "this-week",
}, "2026-08-22")), {
  preset: "this-week",
  startDate: "2026-08-17",
  endDate: "2026-08-21",
  label: "Mon, 17 Aug - Fri, 21 Aug 2026",
});

assert.deepEqual(plainRange(resolveReportDateRange({
  preset: "this-week",
}, "2026-08-23")), {
  preset: "this-week",
  startDate: "2026-08-17",
  endDate: "2026-08-21",
  label: "Mon, 17 Aug - Fri, 21 Aug 2026",
});

assert.deepEqual(plainRange(resolveReportDateRange({
  preset: "last-week",
}, referenceDate)), {
  preset: "last-week",
  startDate: "2026-08-10",
  endDate: "2026-08-14",
  label: "Mon, 10 Aug - Fri, 14 Aug 2026",
});

assert.deepEqual(plainRange(resolveReportDateRange({
  preset: "last-week",
}, "2026-08-23")), {
  preset: "last-week",
  startDate: "2026-08-10",
  endDate: "2026-08-14",
  label: "Mon, 10 Aug - Fri, 14 Aug 2026",
});

[
  ["2026-08-20", "2026-08-01", "2026-08-31", "Aug 2026"],
  ["2026-02-12", "2026-02-01", "2026-02-28", "Feb 2026"],
  ["2024-02-12", "2024-02-01", "2024-02-29", "Feb 2024"],
  ["2026-12-12", "2026-12-01", "2026-12-31", "Dec 2026"],
].forEach(([date, startDate, endDate, label]) => {
  assert.deepEqual(plainRange(resolveReportDateRange({
    preset: "this-month",
  }, date)), {
    preset: "this-month",
    startDate,
    endDate,
    label,
  });
});

const invalid = resolveReportDateRange({
  preset: "custom",
  startDate: "2026-08-14",
  endDate: "2026-08-11",
}, referenceDate);
assert.equal(invalid.error, "Custom report startDate must be on or before endDate.");

const missingStart = resolveReportDateRange({
  preset: "custom",
  endDate: "2026-08-11",
}, referenceDate);
assert.equal(missingStart.error, "Custom reports require a valid startDate.");

const employeeQuery = buildReportQuery({
  preset: "custom",
  startDate: "2026-08-11",
  endDate: "2026-08-14",
  employeeIds: [jag.employeeId, sashank.employeeId],
  teamId: "ux-designer-team",
}, referenceDate);
assert.deepEqual(employeeQuery, {
  startDate: "2026-08-11",
  endDate: "2026-08-14",
  employeeIds: [jag.employeeId, sashank.employeeId],
  teamId: "ux-designer-team",
  preset: "custom",
  label: "Tue, 11 Aug - Fri, 14 Aug 2026",
});

assert.deepEqual(buildReportQuery({
  preset: "single",
  date: "2026-08-14",
}, referenceDate).employeeIds, [], "empty employeeIds represents all employees");

assert.equal(
  buildReportQuery({
    preset: "custom",
    startDate: "2026-08-14",
    endDate: "2026-08-11",
  }, referenceDate).error,
  "Custom report startDate must be on or before endDate.",
  "query exposes validation errors for UI callers"
);

const workItems = [
  {
    id: "epic-1",
    type: "epic",
    title: "Epic",
    parentId: ROOT_ID,
  },
  {
    id: "story-1",
    type: "story",
    title: "Story",
    parentId: "epic-1",
  },
  {
    id: "job-1",
    type: "job",
    title: "Job",
    parentId: "story-1",
    worklogs: [
      worklog("jag-in-range", jag, "2026-08-11", 60),
      worklog("sashank-in-range", sashank, "2026-08-14", 90),
      worklog("jag-out-of-range", jag, "2026-08-15", 120),
    ],
  },
];
const report = generateReportModel({
  workItems,
  employees: [jag, sashank],
  query: employeeQuery,
});

assert.deepEqual(
  report.members.map((member) => member.employeeId),
  [jag.employeeId, sashank.employeeId],
  "query employee IDs feed report model membership"
);
assert.deepEqual(
  report.members.map((member) => member.days.flatMap((day) => day.entries.map((entry) => entry.worklogId))),
  [["jag-in-range"], ["sashank-in-range"]],
  "generateReportModel still performs date and employee filtering from the query"
);
assert.equal(report.totals.durationMinutes, 150, "report data still comes from Phase 1 worklog extraction");

assert.equal(
  buildReportQuery({
    preset: "single",
    date: "2026-08-14T23:30:00.000Z",
  }, referenceDate).startDate,
  "2026-08-14",
  "YYYY-MM-DD prefix is preserved without timezone shifting"
);

console.log("Report date range verification PASS");
