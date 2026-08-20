import assert from "node:assert/strict";

import {
  generateReportModel,
  reportDateKey,
  reportDayLabel,
  reportRangeLabel,
} from "../src/utils/reportModel.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const jag = {
  employeeId: "employee-jag",
  name: "Jagadeesh",
};
const sashank = {
  employeeId: "employee-sashank",
  name: "Sashank",
};
const unknown = {
  employeeId: "employee-unknown",
  name: "",
};
const sprintA = {
  id: "sprint-a",
  title: "UX Designer -17",
};
const sprintB = {
  id: "sprint-b",
  title: "UX Designer -18",
};

function worklog(id, employee, date, minutes, description = "", extra = {}) {
  return {
    id,
    worklogDate: date,
    date,
    timeMinutes: minutes,
    durationMinutes: minutes,
    employeeId: employee.employeeId,
    employeeName: employee.name,
    comment: description,
    description,
    ...extra,
  };
}

function epic(id, extra = {}) {
  return {
    id,
    type: "epic",
    title: id,
    parentId: ROOT_ID,
    sprintId: sprintA.id,
    sprint: sprintA.title,
    ...extra,
  };
}

function story(id, parentId, extra = {}) {
  return {
    id,
    type: "story",
    title: id,
    parentId,
    sprintId: sprintA.id,
    sprint: sprintA.title,
    ...extra,
  };
}

function job(id, parentId, worklogs = [], extra = {}) {
  return {
    id,
    type: "job",
    title: id,
    parentId,
    sprintId: sprintA.id,
    sprint: sprintA.title,
    worklogs,
    ...extra,
  };
}

function task(id, parentId, worklogs = [], extra = {}) {
  return {
    id,
    type: "task",
    title: id,
    parentId,
    sprintId: sprintB.id,
    sprint: sprintB.title,
    worklogs,
    ...extra,
  };
}

const workItems = [
  epic("epic-office", {
    title: "Office Works",
    elitical: {
      num: "DES-700",
      remoteId: "remote-epic-office",
      sprintId: sprintA.id,
    },
  }),
  story("story-design", "epic-office", {
    title: "Technology campaign",
    elitical: {
      num: "DES-701",
      remoteId: "remote-story-design",
      sprintId: sprintA.id,
    },
  }),
  job("job-poster", "story-design", [
    worklog("wl-jag-11-a", jag, "2026-08-11", 120, "Designed technology post", {
      startTime: "10:00",
    }),
    worklog("wl-jag-11-b", jag, "2026-08-11", 30, "Reviewed final poster", {
      startTime: "14:00",
    }),
    worklog("wl-jag-12", jag, "2026-08-12", 60, "Updated layout"),
    worklog("wl-outside", jag, "2026-08-15", 240, "Outside range"),
  ], {
    title: "Technology post design",
    docketState: "design",
    elitical: {
      num: "DES-702",
      remoteId: "remote-job-poster",
      sprintId: sprintA.id,
    },
  }),
  job("job-duplicate", "story-design", [
    worklog("wl-duplicate", sashank, "2026-08-11", 45, "Generated variant A"),
    worklog("wl-duplicate", sashank, "2026-08-11", 45, "Generated variant A duplicate"),
  ], {
    title: "Duplicate imported worklog holder",
    elitical: {
      num: "DES-703",
      sprintId: sprintA.id,
    },
  }),
  task("task-review", "story-design", [
    {
      worklogId: "wl-sashank-14",
      worklogDate: "2026-08-14T23:30:00.000Z",
      durationMinutes: 90,
      employeeId: sashank.employeeId,
      employeeName: sashank.name,
      description: "Reviewed design system",
      startTime: "09:00",
    },
    {
      id: "wl-hours-only",
      worklogDate: "2026-08-14",
      hour: 2,
      min: 15,
      employeeId: sashank.employeeId,
      employeeName: sashank.name,
      description: "Checked exports",
      startTime: "15:00",
    },
  ], {
    title: "Review exports",
    docketState: "in-review",
  }),
  job("job-no-description", "story-design", [
    {
      id: "wl-no-description",
      worklogDate: "2026-08-13",
      durationMinutes: 15,
      employeeId: jag.employeeId,
      employeeName: jag.name,
    },
  ], {
    title: "Fallback title job",
    elitical: {
      sprintId: sprintA.id,
    },
  }),
  job("job-unknown-employee", "story-design", [
    {
      id: "wl-unknown",
      worklogDate: "2026-08-12",
      durationMinutes: 10,
      employeeId: unknown.employeeId,
      description: "Unresolved employee work",
    },
  ]),
  job("job-without-worklog", "story-design", [], {
    title: "No worklog should not appear",
  }),
];

{
  const report = generateReportModel({
    workItems,
    employees: [sashank, jag],
    sprints: [sprintA, sprintB],
    query: {
      startDate: "2026-08-11",
      endDate: "2026-08-11",
      employeeIds: [jag.employeeId],
    },
  });

  assert.equal(report.range.startDate, "2026-08-11", "single-date start is normalized");
  assert.equal(report.range.endDate, "2026-08-11", "single-date end is normalized");
  assert.equal(report.range.label, "Tue, 11 Aug 2026", "single-date range label is deterministic");
  assert.equal(report.members.length, 1, "employee filtering keeps one member");
  assert.deepEqual(
    report.members[0].days.flatMap((day) => day.entries.map((entry) => entry.worklogId)),
    ["wl-jag-11-a", "wl-jag-11-b"],
    "single-date filtering includes only matching employee worklogs"
  );
  assert.equal(report.totals.durationMinutes, 150, "single-date total duration is normalized minutes");
}

{
  const report = generateReportModel({
    workItems,
    employees: [jag, sashank],
    sprints: [sprintA, sprintB],
    query: {
      startDate: "2026-08-11",
      endDate: "2026-08-14",
      employeeIds: [jag.employeeId, sashank.employeeId, "employee-empty"],
    },
  });
  const jagMember = report.members.find((member) => member.employeeId === jag.employeeId);
  const sashankMember = report.members.find((member) => member.employeeId === sashank.employeeId);
  const emptyMember = report.members.find((member) => member.employeeId === "employee-empty");

  assert.equal(report.range.label, "Tue, 11 Aug - Fri, 14 Aug 2026", "multi-day range label is deterministic");
  assert.deepEqual(
    report.members.map((member) => member.employeeId),
    ["employee-empty", jag.employeeId, sashank.employeeId],
    "members sort by display name/id deterministically"
  );
  assert.deepEqual(
    jagMember.days.map((day) => day.dateKey),
    ["2026-08-11", "2026-08-12", "2026-08-13"],
    "multi-day filtering includes inclusive start/end dates and excludes outside dates"
  );
  assert.equal(jagMember.totalMinutes, 225, "multiple worklogs on same day and range aggregate");
  assert.equal(sashankMember.totalMinutes, 270, "multiple employees are grouped separately");
  assert.deepEqual(emptyMember.days, [], "selected employee with no worklog remains in report with empty days");
  assert.equal(report.totals.worklogCount, 7, "duplicate worklog and outside range are excluded");
  assert.equal(report.totals.durationMinutes, 495, "report total sums de-duplicated included entries");
}

{
  const report = generateReportModel({
    workItems,
    employees: [jag, sashank],
    sprints: [sprintA, sprintB],
    query: {
      startDate: "2026-08-11",
      endDate: "2026-08-14",
    },
  });
  const sashankEntry = report.members
    .find((member) => member.employeeId === sashank.employeeId)
    .days.find((day) => day.dateKey === "2026-08-14")
    .entries.find((entry) => entry.worklogId === "wl-sashank-14");
  const fallbackEntry = report.members
    .find((member) => member.employeeId === jag.employeeId)
    .days.find((day) => day.dateKey === "2026-08-13")
    .entries[0];
  const unknownMember = report.members.find((member) => member.employeeId === unknown.employeeId);

  assert.equal(sashankEntry.dateKey, "2026-08-14", "YYYY-MM-DD prefix prevents timezone date shifting");
  assert.equal(sashankEntry.parentEpicTitle, "Office Works", "Epic hierarchy resolves");
  assert.equal(sashankEntry.storyTitle, "Technology campaign", "Story hierarchy resolves for Task/Job entries");
  assert.equal(sashankEntry.sprintId, sprintB.id, "Sprint ID resolves from work item");
  assert.equal(sashankEntry.sprintName, sprintB.title, "Sprint title resolves from work item/sprint list");
  assert.equal(sashankEntry.durationMinutes, 90, "durationMinutes is preserved as numeric minutes");
  assert.equal(fallbackEntry.description, "Fallback title job", "missing description falls back to docket title");
  assert.equal(fallbackEntry.docketNumber, "", "missing docket number falls back to empty display number, not invented data");
  assert.equal(unknownMember.name, unknown.employeeId, "missing employee resolution preserves employee ID as display fallback");
}

{
  const report = generateReportModel({
    workItems,
    employees: [jag, sashank],
    sprints: [sprintA, sprintB],
    query: {
      startDate: "2026-08-14",
      endDate: "2026-08-14",
      employeeIds: [sashank.employeeId],
    },
  });
  const entries = report.members[0].days[0].entries;

  assert.deepEqual(
    entries.map((entry) => entry.worklogId),
    ["wl-sashank-14", "wl-hours-only"],
    "entries sort by start time before docket/title"
  );
  assert.equal(entries[1].durationMinutes, 135, "hour/min duration normalizes to minutes");
}

{
  const report = generateReportModel({
    workItems,
    employees: [jag],
    query: {
      startDate: "2026-08-20",
      endDate: "2026-08-21",
      employeeIds: [jag.employeeId],
    },
  });

  assert.equal(report.totals.worklogCount, 0, "worklogs outside selected range are excluded");
  assert.equal(report.members[0].totalMinutes, 0, "empty selected range keeps employee with zero total");
}

{
  const report = generateReportModel({
    workItems: [],
    employees: [],
    query: {
      startDate: "2026-08-11",
      endDate: "2026-08-14",
    },
  });

  assert.deepEqual(report.members, [], "completely empty report has no members");
  assert.deepEqual(report.totals, { worklogCount: 0, durationMinutes: 0 }, "completely empty report has zero totals");
}

{
  const report = generateReportModel({
    workItems: [
      epic("epic-empty-only"),
      story("story-empty-only", "epic-empty-only"),
      job("job-empty-only", "story-empty-only", []),
    ],
    employees: [jag],
    query: {
      startDate: "2026-08-11",
      endDate: "2026-08-14",
      employeeIds: [jag.employeeId],
    },
  });

  assert.equal(report.totals.worklogCount, 0, "work items without worklogs are not reported as completed work");
}

assert.equal(reportDateKey("2026-08-11T23:30:00.000Z"), "2026-08-11", "ISO date prefix is kept without timezone conversion");
assert.equal(reportDayLabel("2026-08-11"), "Tue (11 Aug)", "day label is deterministic");
assert.equal(reportRangeLabel("2026-12-31", "2027-01-01"), "Thu, 31 Dec 2026 - Fri, 1 Jan 2027", "cross-year range labels include both years");

console.log("Report model verification PASS");
