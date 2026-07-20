import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKLOG_ELIGIBLE_STATES,
  buildBacklogProjection,
  isBacklogEligible,
} from "../src/utils/backlogProjection.js";
import { ORPHAN_SPRINT_ID } from "../src/utils/hierarchyProjection.js";

const app = readFileSync("src/App.jsx", "utf8");
const graphView = readFileSync("src/views/GraphView.jsx", "utf8");
const planningView = readFileSync("src/views/PlanningView.jsx", "utf8");
const backlogProjection = readFileSync("src/utils/backlogProjection.js", "utf8");
const durationFormat = readFileSync("src/utils/durationFormat.js", "utf8");
const css = readFileSync("src/App.css", "utf8");

const sprints = [{ id: "sprint-a", title: "Sprint A" }];
const items = [
  { id: "epic-concept", type: "epic", title: "Concept Epic", docketState: "concept", sprintId: "sprint-a", parentId: "root", storyPoints: 0 },
  { id: "story-design", type: "story", title: "Design Story", docketState: "design", sprintId: "sprint-a", sprint: "Sprint A", parentId: "epic-concept", storyPoints: 3 },
  { id: "job-review", type: "job", title: "In Review Job", docketState: "review", sprintId: "sprint-a", sprint: "Sprint A", parentId: "story-design", worklogs: [{ id: "wl-1", timeMinutes: 630 }] },
  { id: "task-artifact", type: "task", title: "Artifact Task", docketState: "Artifacts", sprintId: "", sprint: "", parentId: "epic-concept", updatedAt: "2026-07-14T10:00:00.000Z" },
  { id: "story-closed", type: "story", title: "Closed Story", docketState: "closed", sprintId: "sprint-a", parentId: "epic-concept", storyPoints: 99 },
  { id: "job-under-closed", type: "job", title: "Child Under Closed", docketState: "concept", sprintId: "sprint-a", parentId: "story-closed" },
];

assert.deepEqual(BACKLOG_ELIGIBLE_STATES, ["concept", "design", "in-review", "artifact"]);
assert.equal(isBacklogEligible(items[0]), true, "Concept dockets appear");
assert.equal(isBacklogEligible(items[1]), true, "Design dockets appear");
assert.equal(isBacklogEligible(items[2]), true, "Legacy Review dockets appear as In Review");
assert.equal(isBacklogEligible(items[3]), true, "Artifacts dockets appear after canonical normalization");
assert.equal(isBacklogEligible(items[4]), false, "Closed dockets are not backlog-eligible");

for (const grouping of ["sprint", "epic", "story", "date"]) {
  const projection = buildBacklogProjection({ items, sprints, grouping });
  const ids = new Set(projection.workItems.map((item) => item.sourceItemId || item.id));

  assert.equal(projection.grouping, grouping);
  assert.equal(ids.has("story-closed"), false, `${grouping} grouping excludes Closed dockets`);
  assert.equal(ids.has("job-review"), true, `${grouping} grouping keeps eligible descendants`);
  assert.equal(items.find((item) => item.id === "job-review").parentId, "story-design", `${grouping} grouping does not mutate canonical parentId`);
  assert.equal(items.find((item) => item.id === "job-review").sprintId, "sprint-a", `${grouping} grouping does not mutate canonical sprintId`);
}

const sprintProjection = buildBacklogProjection({ items, sprints, grouping: "sprint" });
assert.ok(sprintProjection.sprints.some((sprint) => sprint.id === "sprint-a"), "Sprint grouping includes real sprint scope");
assert.ok(sprintProjection.sprints.some((sprint) => sprint.id === ORPHAN_SPRINT_ID), "Sprint grouping includes Orphan Sprint for no-sprint items");

const dateProjection = buildBacklogProjection({ items, sprints, grouping: "date" });
assert.ok(dateProjection.workItems.some((item) => item.id.startsWith("backlog-date:")), "Date grouping creates projection-only date nodes");
assert.ok(dateProjection.workItems.every((item) => !item.id.includes("story-closed")), "Date grouping does not surface Closed nodes");

assert.match(app, /const PLANNING_VIEW_IDS = new Set\(\["worklog"\]\)/, "Backlog no longer uses PlanningView flat surface");
assert.match(app, /viewMode === "backlog" \? backlogProjection\.workItems : visibleWorkItems/, "Backlog is the base graph dataset");
assert.match(app, /viewMode === "backlog"\s*\?\s*backlogProjection\.sprints/, "Backlog scopes drive graph grouping");
assert.match(app, /<BacklogGroupingSelector/);
assert.match(app, /projectHierarchy=\{viewMode !== "backlog"\}/, "Backlog uses pre-projected graph data");
assert.match(app, /filters: effectiveSearchFilters/, "Search and filters compose after Backlog eligibility");
assert.match(app, /filter\(\(item\) => item\.isBacklogEligible \|\| item\.isBacklogDateGroup\)/, "Backlog search only sees eligible projection scope");
assert.doesNotMatch(planningView, /renderBacklog\(\)/, "Old flat backlog renderer is not used by App");

assert.match(graphView, /projectHierarchy = true/);
assert.match(graphView, /projectHierarchy[\s\S]*\? buildProjectedHierarchy/, "GraphView can reuse pre-projected Backlog data");
assert.match(backlogProjection, /export function isBacklogEligible/);
assert.match(backlogProjection, /BACKLOG_ELIGIBLE_STATES/);
assert.match(backlogProjection, /backlogDateKey/);
assert.match(backlogProjection, /primaryWorklogDate[\s\S]*updatedAt[\s\S]*createdAt/, "Date grouping uses existing worklog/update/create date fields");
assert.match(backlogProjection, /isClosedBacklogDocket/);
assert.match(backlogProjection, /\.filter\(\(ancestor\) => !isClosedBacklogDocket\(ancestor\)\)/, "Closed ancestors are excluded from Backlog projection");
assert.match(backlogProjection, /canonicalParentId: item\.parentId/, "Projection preserves canonical parentId separately");
assert.match(backlogProjection, /childSprintId: isOrphanScope \? "" : sprintId/, "Create actions use canonical sprint, not grouping parent");
assert.match(durationFormat, /WORKDAY_MINUTES = 8 \* 60/, "Backlog uses the global 8-hour duration formatter via shared nodes/header");
assert.match(css, /\.backlog-grouping-selector/);

console.log("Backlog graph view verification PASS");
