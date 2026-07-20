import assert from "node:assert/strict";
import { calculateStoryPoints, ROOT_ID } from "../src/utils/worklogModel.js";
import { ORPHAN_SPRINT_ID, ORPHAN_SPRINT_TITLE } from "../src/utils/hierarchyProjection.js";

function worklog(id, date, minutes) {
  return {
    id,
    date,
    worklogDate: date,
    timeMinutes: minutes,
    durationMinutes: minutes,
  };
}

function story(id, parentId, storyPoints, worklogs = [], extra = {}) {
  return {
    id,
    type: "story",
    title: id,
    parentId,
    storyPoints,
    worklogs,
    ...extra,
  };
}

function epic(id, parentId = ROOT_ID, extra = {}) {
  return {
    id,
    type: "epic",
    title: id,
    parentId,
    storyPoints: 0,
    worklogs: [],
    ...extra,
  };
}

function job(id, parentId, worklogs = [], extra = {}) {
  return {
    id,
    type: "job",
    title: id,
    parentId,
    storyPoints: 99,
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
    storyPoints: 42,
    worklogs,
    ...extra,
  };
}

function scoped(item, sprintId, sprintTitle) {
  return {
    ...item,
    visualParentId: item.parentId === ROOT_ID ? sprintId : item.visualParentId,
    targetScopeId: sprintId,
    targetSprintId: sprintId,
    sprintId: sprintId === ORPHAN_SPRINT_ID ? "" : sprintId,
    sprint: sprintTitle,
  };
}

function selectedDateWorklogs(worklogs, selectedDate) {
  return worklogs.filter((entry) => String(entry.worklogDate || entry.date).slice(0, 10) === selectedDate);
}

const sprintA = { id: "sprint-a", title: "Sprint A" };
const orphanSprint = {
  id: ORPHAN_SPRINT_ID,
  title: ORPHAN_SPRINT_TITLE,
  isVirtual: true,
  isOrphanSprint: true,
};

{
  const items = [
    epic("epic-a"),
    story("story-a", "epic-a", 2),
    story("story-b", "epic-a", 3),
  ];
  const totals = calculateStoryPoints(items);

  assert.equal(totals.byId["epic-a"], 5, "Epic rolls up direct Story SP");
  assert.equal(totals.rootTotal, 5, "Project rolls up Epic Story SP");
}

{
  const items = [
    scoped(epic("epic-a"), "sprint-a", "Sprint A"),
    scoped(story("story-a", "epic-a", 2), "sprint-a", "Sprint A"),
    scoped(epic("epic-b"), "sprint-a", "Sprint A"),
    scoped(story("story-b", "epic-b", 3), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });

  assert.equal(totals.byId["epic-a"], 2, "Epic A SP rolls up");
  assert.equal(totals.byId["epic-b"], 3, "Epic B SP rolls up");
  assert.equal(totals.sprintStoryPointsById["sprint-a"], 5, "Sprint SP rolls up Epics");
  assert.equal(totals.rootTotal, 5, "Project SP rolls up selected Sprint scope");
}

{
  const items = [
    scoped(epic("epic-a"), "sprint-a", "Sprint A"),
    scoped(story("story-a", "epic-a", 2, [worklog("w-story", "2026-07-15", 30)]), "sprint-a", "Sprint A"),
    scoped(job("job-a", "story-a", [worklog("w-job-a", "2026-07-15", 120)]), "sprint-a", "Sprint A"),
    scoped(job("job-b", "story-a", [worklog("w-job-b", "2026-07-15", 90)]), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });

  assert.equal(totals.timeById["story-a"], 240, "Story time includes own and Job worklogs once");
  assert.equal(totals.timeById["epic-a"], 240, "Epic time rolls up Story and Jobs");
  assert.equal(totals.sprintTimeById["sprint-a"], 240, "Sprint time rolls up visual descendants");
  assert.equal(totals.rootTimeMinutes, 240, "Project time rolls up all scoped worklogs once");
}

{
  const allWorklogs = [
    worklog("w-14", "2026-07-14", 60),
    worklog("w-15", "2026-07-15", 420),
    worklog("w-16", "2026-07-16", 120),
  ];
  const items = [
    scoped(epic("epic-a"), "sprint-a", "Sprint A"),
    scoped(story("story-a", "epic-a", 1, selectedDateWorklogs(allWorklogs, "2026-07-15")), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });

  assert.equal(totals.timeById["story-a"], 420, "Day scoped Story time includes selected date only");
  assert.equal(totals.timeById["epic-a"], 420, "Day scoped Epic time includes selected date only");
  assert.equal(totals.rootTimeMinutes, 420, "Day scoped Project time includes selected date only");
}

{
  const items = [
    scoped(epic("epic-a"), "sprint-a", "Sprint A"),
    scoped(story("story-a", "epic-a", 1, [
      worklog("w-1", "2026-07-15", 60),
      worklog("w-2", "2026-07-15", 75),
    ]), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });

  assert.equal(totals.timeById["story-a"], 135, "Multiple worklogs on one date aggregate");
  assert.equal(totals.rootTimeMinutes, 135, "Project includes all matching same-day worklogs");
}

{
  const items = [
    scoped(epic("epic-orphan"), ORPHAN_SPRINT_ID, ORPHAN_SPRINT_TITLE),
    scoped(story("story-a", "epic-orphan", 1, [worklog("w-a", "2026-07-15", 420)]), ORPHAN_SPRINT_ID, ORPHAN_SPRINT_TITLE),
    scoped(story("story-b", "epic-orphan", 2, [worklog("w-b", "2026-07-15", 120)]), ORPHAN_SPRINT_ID, ORPHAN_SPRINT_TITLE),
  ];
  const totals = calculateStoryPoints(items, { sprints: [orphanSprint] });

  assert.equal(totals.byId["epic-orphan"], 3, "Orphan Epic SP rolls up projected descendants");
  assert.equal(totals.sprintStoryPointsById[ORPHAN_SPRINT_ID], 3, "Virtual Orphan Sprint SP rolls up");
  assert.equal(totals.sprintTimeById[ORPHAN_SPRINT_ID], 540, "Virtual Orphan Sprint time rolls up");
  assert.equal(totals.rootTotal, 3, "Project SP includes Orphan Sprint descendants");
  assert.equal(totals.rootTimeMinutes, 540, "Project time includes Orphan Sprint descendants");
}

{
  const items = [epic("epic-empty"), story("story-empty", "epic-empty", 0, [])];
  const totals = calculateStoryPoints(items);

  assert.equal(totals.byId["epic-empty"], 0, "No SP rolls up as zero");
  assert.equal(totals.rootTotal, 0, "No project SP rolls up as zero");
  assert.equal(totals.timeById["story-empty"], 0, "No worklogs rolls up as 00:00");
  assert.equal(totals.rootTimeMinutes, 0, "No project worklogs rolls up as 00:00");
}

{
  const items = [
    scoped(epic("epic-mixed"), "sprint-a", "Sprint A"),
    scoped(story("story-mixed", "epic-mixed", 5, [worklog("w-story", "2026-07-15", 15)]), "sprint-a", "Sprint A"),
    scoped(job("job-mixed", "story-mixed", [worklog("w-job", "2026-07-15", 45)]), "sprint-a", "Sprint A"),
    scoped(task("task-mixed", "epic-mixed", [worklog("w-task", "2026-07-15", 30)]), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });

  assert.equal(totals.byId["story-mixed"], 5, "Story keeps own SP without Job double count");
  assert.equal(totals.byId["job-mixed"], 0, "Job SP is not counted");
  assert.equal(totals.byId["task-mixed"], 0, "Task SP is not counted by existing rule");
  assert.equal(totals.byId["epic-mixed"], 5, "Epic SP counts Story only");
  assert.equal(totals.timeById["epic-mixed"], 90, "Epic time includes Story, Job, and Task worklogs once");
  assert.equal(totals.rootTimeMinutes, 90, "Project time avoids double counting mixed hierarchy");
}

{
  const items = [
    scoped(epic("epic-header"), "sprint-a", "Sprint A"),
    scoped(story("story-header", "epic-header", 4, [worklog("w-header", "2026-07-15", 75)]), "sprint-a", "Sprint A"),
  ];
  const totals = calculateStoryPoints(items, { sprints: [sprintA] });
  const headerStoryPoints = totals.rootTotal;
  const headerLoggedTime = totals.rootTimeMinutes;

  assert.equal(headerStoryPoints, totals.sprintStoryPointsById["sprint-a"], "Header SP can match scoped Sprint graph total");
  assert.equal(headerLoggedTime, totals.sprintTimeById["sprint-a"], "Header logged time can match scoped Sprint graph total");
}

console.log("Aggregation rollup verification PASS");
