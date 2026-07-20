import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applySearchFilters } from "../src/utils/globalSearchFilter.js";
import { calculateStoryPoints, ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

const jag = {
  employeeId: "employee-jag",
  name: "Jag",
};
const sashank = {
  employeeId: "employee-sashank",
  name: "Sashank",
};
const sprintA = {
  id: "sprint-a",
  title: "Sprint A",
};

function worklog(id, employee, minutes, date = "2026-07-15") {
  return {
    id,
    worklogDate: date,
    date,
    timeMinutes: minutes,
    durationMinutes: minutes,
    employeeId: employee.employeeId,
    employeeName: employee.name,
  };
}

function epic(id, extra = {}) {
  return {
    id,
    title: id,
    type: "epic",
    parentId: ROOT_ID,
    ...extra,
  };
}

function story(id, parentId, assignee, storyPoints, worklogs = [], extra = {}) {
  return {
    id,
    title: id,
    type: "story",
    parentId,
    storyPoints,
    assignee: assignee.name,
    assigneeId: assignee.employeeId,
    elitical: {
      assigneeId: assignee.employeeId,
      assigneeName: assignee.name,
    },
    worklogs,
    ...extra,
  };
}

function job(id, parentId, assignee, worklogs = [], extra = {}) {
  return {
    id,
    title: id,
    type: "job",
    parentId,
    assignee: assignee.name,
    assigneeId: assignee.employeeId,
    elitical: {
      assigneeId: assignee.employeeId,
      assigneeName: assignee.name,
    },
    worklogs,
    ...extra,
  };
}

function scoped(item, sprintId = sprintA.id) {
  return {
    ...item,
    targetScopeId: sprintId,
    targetSprintId: sprintId,
    visualParentId: item.parentId === ROOT_ID ? sprintId : item.parentId,
    sprintId,
    sprint: sprintA.title,
  };
}

function dateScopedItems(items, selectedDate) {
  return items.map((item) => ({
    ...item,
    worklogs: (item.worklogs || []).filter((entry) =>
      String(entry.worklogDate || entry.date).startsWith(selectedDate)
    ),
  }));
}

{
  const items = [
    story("story-shared", ROOT_ID, jag, 5, [
      worklog("jag-2h", jag, 120),
      worklog("sashank-3h", sashank, 180),
    ]),
  ];

  assert.equal(
    calculateStoryPoints(items, { employeeScope: jag }).rootTimeMinutes,
    120,
    "Default/current user metrics include only Jag-owned worklogs"
  );
  assert.equal(
    calculateStoryPoints(items, { employeeScope: sashank }).rootTimeMinutes,
    180,
    "Selecting Sashank metrics includes only Sashank-owned worklogs"
  );
  assert.equal(
    calculateStoryPoints(items, { employeeScope: sashank }).rootTotal,
    0,
    "Sashank does not receive SP for a Story assigned to Jag"
  );
}

{
  const items = [
    epic("epic-a"),
    story("story-a", "epic-a", jag, 8, [
      worklog("jag-1", jag, 60),
      worklog("jag-2", jag, 90),
    ]),
  ];
  const totals = calculateStoryPoints(items, { employeeScope: jag });

  assert.equal(totals.rootTimeMinutes, 150, "Multiple same-employee worklogs aggregate");
  assert.equal(totals.rootTotal, 8, "Story SP is not double-counted for multiple worklogs");
  assert.equal(totals.byId["epic-a"], 8, "Parent SP uses scoped Story ownership");
}

{
  const items = [
    epic("epic-team"),
    story("story-jag", "epic-team", jag, 3, [worklog("jag-work", jag, 120)]),
    story("story-sashank", "epic-team", sashank, 5, [worklog("sashank-work", sashank, 180)]),
  ];
  const jagTotals = calculateStoryPoints(items, { employeeScope: jag });
  const sashankTotals = calculateStoryPoints(items, { employeeScope: sashank });

  assert.equal(items.length, 3, "Graph can retain team dockets");
  assert.equal(jagTotals.byId["epic-team"], 3, "Jag parent SP excludes Sashank Story SP");
  assert.equal(jagTotals.timeById["epic-team"], 120, "Jag parent time excludes Sashank worklogs");
  assert.equal(sashankTotals.byId["epic-team"], 5, "Sashank parent SP excludes Jag Story SP");
  assert.equal(sashankTotals.timeById["epic-team"], 180, "Sashank parent time excludes Jag worklogs");
}

{
  const items = [
    story("story-day", ROOT_ID, jag, 2, [
      worklog("jag-day", jag, 120, "2026-07-15"),
      worklog("jag-other-day", jag, 60, "2026-07-16"),
      worklog("sashank-day", sashank, 180, "2026-07-15"),
    ]),
  ];
  const dayItems = dateScopedItems(items, "2026-07-15");

  assert.equal(
    calculateStoryPoints(dayItems, { employeeScope: jag }).rootTimeMinutes,
    120,
    "Day scope composes with current employee scope"
  );
  assert.equal(
    calculateStoryPoints(dayItems, { employeeScope: sashank }).rootTimeMinutes,
    180,
    "Day scope composes with selected employee scope"
  );
}

{
  const items = [
    scoped(epic("epic-sprint")),
    scoped(story("story-jag-sprint", "epic-sprint", jag, 4, [worklog("jag-sprint", jag, 90)])),
    scoped(story("story-sashank-sprint", "epic-sprint", sashank, 6, [worklog("sashank-sprint", sashank, 150)])),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA], employeeScope: jag });

  assert.equal(totals.sprintStoryPointsById[sprintA.id], 4, "Sprint SP is employee-scoped");
  assert.equal(totals.sprintTimeById[sprintA.id], 90, "Sprint logged time is employee-scoped");
}

{
  const items = [
    story("story-assigned-jag", ROOT_ID, jag, 1, []),
    story("story-worklogged-by-sashank", ROOT_ID, jag, 1, [worklog("sashank-cross", sashank, 30)]),
  ];
  const result = applySearchFilters({
    items,
    filters: {
      assignee: sashank.employeeId,
    },
  });

  assert.deepEqual(
    result.matchedItems.map((item) => item.id),
    ["story-worklogged-by-sashank"],
    "Assignee filter can find dockets by selected worklog owner"
  );
}

assert.match(appSource, /const selectedEmployeeScope = useMemo/);
assert.match(appSource, /searchFilters\.assignee/);
assert.match(appSource, /calculateStoryPoints\(graphWorkItems, \{ sprints: graphSprints, employeeScope: selectedEmployeeScope \}\)/);
assert.match(appSource, /buildDayTimelineModel\(\{[\s\S]*employeeScope: selectedEmployeeScope/);
assert.match(appSource, /dayViewSummary\(\{[\s\S]*employeeScope: selectedEmployeeScope/);
assert.doesNotMatch(appSource, /assigneeId:\s*searchFilters\.assignee/);

console.log("Employee-scoped aggregation verification PASS");
