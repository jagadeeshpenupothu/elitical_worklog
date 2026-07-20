import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { calculateStoryPoints, ROOT_ID } from "../src/utils/worklogModel.js";
import { ORPHAN_SPRINT_ID, ORPHAN_SPRINT_TITLE } from "../src/utils/hierarchyProjection.js";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const worklogModelSource = await fs.readFile(new URL("../src/utils/worklogModel.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} must exist.`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

function appWorklogHelpers() {
  const context = {};

  vm.runInNewContext(
    [
      extractFunction(appSource, "parseTimeInput"),
      extractFunction(appSource, "worklogDraftFromFields"),
      extractFunction(appSource, "isMeaningfulWorklogDraft"),
      extractFunction(appSource, "validateWorklogDraft"),
      "({ parseTimeInput, worklogDraftFromFields, isMeaningfulWorklogDraft, validateWorklogDraft });",
    ].join("\n"),
    context
  );

  return context;
}

function serverWorklogHelpers() {
  const context = {
    eliticalWorklogDateMillis(value) {
      if (value === undefined || value === null || value === "") return 0;
      if (Number.isFinite(Number(value))) return Number(value);

      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    },
  };

  return vm.runInNewContext(
    [
      extractFunction(serverSource, "firstString"),
      extractFunction(serverSource, "firstNumber"),
      extractFunction(serverSource, "normalizeDocketType"),
      extractFunction(serverSource, "acceptsWorklog"),
      extractFunction(serverSource, "normalizeWorklogDate"),
      extractFunction(serverSource, "normalizeWorklogForInput"),
      extractFunction(serverSource, "isMeaningfulWorklogPayload"),
      extractFunction(serverSource, "validateWorklogPayload"),
      "({ normalizeWorklogForInput, isMeaningfulWorklogPayload, validateWorklogPayload });",
    ].join("\n"),
    context
  );
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const app = appWorklogHelpers();
const server = serverWorklogHelpers();

assert.match(appSource, /worklog:\s*hasWorklog && isMeaningfulWorklogDraft\(draft\)\s*\?\s*worklogDraftFromFields\(draft\)\s*:\s*undefined/s);
assert.match(appSource, /worklogs: primaryWorklogPayload\(\)/);
assert.match(serverSource, /const requestedWorklog = payload\.worklog \|\| null/);
assert.match(serverSource, /if \(localWorklog\) \{[\s\S]*enqueueWorklogCreate/s);
assert.match(serverSource, /worklog: undefined/);
assert.match(worklogModelSource, /function normalizeWorklogs\(input, fallbackDate, fallbackDescription, fallbackTime\) \{\s*const source = Array\.isArray\(input\) \? input : \[\]/);

const zeroTimeDraft = {
  title: "Zero-time Story",
  worklogDate: "2026-07-19",
  worklogDescription: "prefilled or typed comment",
  time: "00:00",
};
assert.equal(app.isMeaningfulWorklogDraft(zeroTimeDraft), false, "Frontend: zero-time draft is docket-only");
assert.equal(app.validateWorklogDraft(zeroTimeDraft), "", "Frontend: zero-time draft does not require worklog fields");
assert.deepEqual(plain(app.worklogDraftFromFields(zeroTimeDraft)), {
  id: "",
  comment: "prefilled or typed comment",
  worklogDate: "2026-07-19",
  hour: 0,
  min: 0,
});

for (const type of ["story", "job", "task"]) {
  const zeroPayload = {
    comment: "comment should not force worklog",
    worklogDate: "2026-07-19",
    hour: 0,
    min: 0,
  };

  assert.equal(server.isMeaningfulWorklogPayload(zeroPayload), false, `${type}: zero duration is not a worklog request`);
  assert.equal(server.validateWorklogPayload(zeroPayload, { docketType: type }), "", `${type}: zero duration can create docket only`);
}

assert.equal(server.isMeaningfulWorklogPayload(null), false, "Backend: explicit null worklog is docket-only");
assert.deepEqual(plain(server.normalizeWorklogForInput(null)), {
  id: "",
  docketId: "",
  comment: "",
  worklogDate: "",
  hour: 0,
  min: 0,
});

for (const draft of [
  { time: "00:30", worklogDate: "2026-07-19", worklogDescription: "30m" },
  { time: "02:00", worklogDate: "2026-07-19", worklogDescription: "2h" },
  { time: "02:30", worklogDate: "2026-07-19", worklogDescription: "2h 30m" },
]) {
  assert.equal(app.isMeaningfulWorklogDraft(draft), true, `Frontend: ${draft.time} requests worklog`);
  assert.equal(app.validateWorklogDraft(draft), "", `Frontend: ${draft.time} valid worklog passes`);
}

const nonZeroPayload = {
  comment: "Worked on docket",
  worklogDate: "2026-07-19",
  hour: 2,
  min: 30,
};
assert.equal(server.isMeaningfulWorklogPayload(nonZeroPayload), true, "Backend: 02:30 requests worklog");
assert.equal(server.validateWorklogPayload(nonZeroPayload, { docketType: "job" }), "", "Backend: valid 02:30 worklog passes");
assert.equal(server.validateWorklogPayload({ ...nonZeroPayload, comment: "" }, { docketType: "job" }), "Worklog comment is required.");
assert.equal(server.validateWorklogPayload(nonZeroPayload, { docketType: "epic" }), "Worklogs are supported only for Story, Task, and Job.");

const noWorklogItems = [
  {
    id: "epic-orphan",
    type: "epic",
    title: "Panchayat Seva UX Works",
    parentId: ROOT_ID,
    visualParentId: ORPHAN_SPRINT_ID,
    targetScopeId: ORPHAN_SPRINT_ID,
    targetSprintId: ORPHAN_SPRINT_ID,
    sprintId: "",
    sprint: ORPHAN_SPRINT_TITLE,
  },
  {
    id: "story-zero",
    type: "story",
    title: "Zero-time Story",
    parentId: "epic-orphan",
    storyPoints: 2,
    visualParentId: "epic-orphan",
    targetScopeId: ORPHAN_SPRINT_ID,
    targetSprintId: ORPHAN_SPRINT_ID,
    sprintId: "",
    sprint: ORPHAN_SPRINT_TITLE,
    worklogs: [],
  },
  {
    id: "job-zero",
    type: "job",
    title: "Zero-time Job",
    parentId: "story-zero",
    visualParentId: "story-zero",
    targetScopeId: ORPHAN_SPRINT_ID,
    targetSprintId: ORPHAN_SPRINT_ID,
    sprintId: "",
    sprint: ORPHAN_SPRINT_TITLE,
    worklogs: [],
  },
  {
    id: "task-zero",
    type: "task",
    title: "Zero-time Task",
    parentId: "epic-orphan",
    visualParentId: "epic-orphan",
    targetScopeId: ORPHAN_SPRINT_ID,
    targetSprintId: ORPHAN_SPRINT_ID,
    sprintId: "",
    sprint: ORPHAN_SPRINT_TITLE,
    worklogs: [],
  },
];
const totals = calculateStoryPoints(noWorklogItems, {
  sprints: [{ id: ORPHAN_SPRINT_ID, title: ORPHAN_SPRINT_TITLE, isVirtual: true, isOrphanSprint: true }],
});
assert.equal(totals.timeById["story-zero"], 0, "Story with no worklogs logs zero minutes");
assert.equal(totals.timeById["job-zero"], 0, "Job with no worklogs logs zero minutes");
assert.equal(totals.timeById["task-zero"], 0, "Task with no worklogs logs zero minutes");
assert.equal(totals.sprintTimeById[ORPHAN_SPRINT_ID], 0, "Orphan Sprint no-worklog branch logs zero minutes");
assert.equal(totals.rootTimeMinutes, 0, "Project no-worklog branch logs zero minutes");
assert.equal(noWorklogItems[0].sprintId, "", "Orphan Sprint keeps no-sprint contract");

console.log("Optional worklog create verification PASS");
