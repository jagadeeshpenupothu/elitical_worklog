import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ORPHAN_SPRINT_ID,
  addDayProjectionSelection,
  dateKeyFromValue,
  daySelectionForDate,
  sprintContainsDate,
  sprintScopesForDay,
} from "../src/utils/dayViewProjection.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const graphViewSource = readFileSync(new URL("../src/views/GraphView.jsx", import.meta.url), "utf8");
const nodeCapabilitiesSource = readFileSync(
  new URL("../src/utils/nodeCapabilities.js", import.meta.url),
  "utf8"
);

const sprint = {
  id: "sprint-14",
  title: "UX Designer -14",
  sprintStartDate: "2026-06-01T05:30:00.000Z",
  sprintEndDate: "2026-06-26T05:30:00.000Z",
};

assert.equal(dateKeyFromValue("2026-06-01"), "2026-06-01");
assert.equal(dateKeyFromValue("2026-06-01T05:30:00.000Z"), "2026-06-01");
assert.equal(sprintContainsDate(sprint, "2026-06-01"), true);
assert.equal(sprintContainsDate(sprint, "2026-06-26"), true);
assert.equal(sprintContainsDate(sprint, "2026-06-27"), false);

assert.deepEqual(
  sprintScopesForDay([sprint], "2026-06-12").map((entry) => entry.id),
  ["sprint-14"],
  "zero-worklog dates inside a real sprint still resolve that sprint scope"
);
assert.deepEqual(
  sprintScopesForDay([sprint], "2026-06-01").map((entry) => entry.id),
  ["sprint-14"]
);
assert.deepEqual(
  sprintScopesForDay([sprint], "2026-07-01").map((entry) => entry.id),
  [ORPHAN_SPRINT_ID],
  "zero-worklog dates outside real sprint ranges resolve the virtual Orphan Sprint"
);

const initialState = { version: 1, days: {} };
const withEpic = addDayProjectionSelection({
  state: initialState,
  selectedDate: "2026-06-01",
  kind: "epic",
  sprintId: "sprint-14",
  childId: "epic-1",
});
const withStory = addDayProjectionSelection({
  state: withEpic,
  selectedDate: "2026-06-01",
  kind: "story",
  parentId: "epic-1",
  sprintId: "sprint-14",
  childId: "story-1",
});
const selected = daySelectionForDate(withStory, "2026-06-01T00:00:00.000Z");

assert.deepEqual(selected.epicsBySprint["sprint-14"], ["epic-1"]);
assert.deepEqual(selected.storiesByEpicScope["epic-1::sprint-14"], ["story-1"]);
assert.deepEqual(initialState, { version: 1, days: {} });

const existingEpic = {
  id: "existing-epic",
  type: "epic",
  title: "Existing Epic",
  parentId: ROOT_ID,
  sprintId: "other-sprint",
  sprint: "Other Sprint",
};
const dayProjectedEpic = {
  ...existingEpic,
  sprintId: sprint.id,
  sprint: sprint.title,
  targetScopeId: sprint.id,
  targetSprintId: sprint.id,
  visualParentId: sprint.id,
  childSprintId: sprint.id,
  childSprint: sprint.title,
};
const projectedEpicItems = buildProjectedHierarchy({
  items: [dayProjectedEpic],
  allItems: [existingEpic],
  scopes: [sprint],
}).items;

assert.equal(
  projectedEpicItems.filter((item) => item.id === existingEpic.id).length,
  1,
  "Day Add Existing Epic keeps one canonical Epic node"
);
assert.equal(
  projectedEpicItems.find((item) => item.id === existingEpic.id)?.visualParentId,
  sprint.id,
  "Day Add Existing Epic renders under the selected Sprint context"
);

const existingStory = {
  id: "existing-story",
  type: "story",
  title: "Existing Story",
  parentId: existingEpic.id,
  sprintId: "other-sprint",
  sprint: "Other Sprint",
};
const dayProjectedStory = {
  ...existingStory,
  sprintId: sprint.id,
  sprint: sprint.title,
  targetScopeId: sprint.id,
  targetSprintId: sprint.id,
  childSprintId: sprint.id,
  childSprint: sprint.title,
};
const projectedStoryItems = buildProjectedHierarchy({
  items: [dayProjectedStory],
  allItems: [existingEpic, existingStory],
  scopes: [sprint],
}).items;

assert.equal(
  projectedStoryItems.filter((item) => item.id === existingStory.id).length,
  1,
  "Day Add Existing Story keeps one canonical Story node"
);
assert.equal(
  projectedStoryItems.some(
    (item) => item.isReference && item.sourceItemId === existingEpic.id
  ),
  true,
  "Day Add Existing Story projects a reference ancestor instead of cloning the Epic"
);

assert.match(
  appSource,
  /const graphSprints = useMemo\(\(\) => \{[\s\S]*if \(viewMode === "day"\) return baseGraphSprints;/,
  "Day View keeps resolved sprint scopes visible even when work item filters match zero items"
);
assert.match(
  appSource,
  /const showGraphEmptyState =\s*viewMode !== "day" &&[\s\S]*graphWorkItems\.length === 0/,
  "Day View never replaces the graph with the generic zero-worklog empty state"
);
assert.match(
  appSource,
  /applySearchFilters\(\{[\s\S]*items: baseGraphWorkItems,[\s\S]*filters: effectiveSearchFilters/,
  "search and filter still apply to projected work items"
);
assert.doesNotMatch(
  appSource,
  /dayScopeIdForItem\(item\) !== sprintId/,
  "Day Add Existing projection does not require the canonical docket sprint to match the display Sprint"
);
assert.match(
  appSource,
  /dayProjectionContextById\.set\(item\.id,[\s\S]*sprintId,[\s\S]*parentId:/,
  "Day Add Existing stores display context as projection metadata"
);
assert.match(
  appSource,
  /targetSprintId: projectedSprintId/,
  "Day Add Existing carries target Sprint context into the rendered node"
);
assert.match(
  appSource,
  /viewHeaderFilterContext\(\{[\s\S]*selectedDayDate: selectedContextOption\?\.id/,
  "selected Day View date remains an inherited view-context filter"
);
assert.match(
  graphViewSource,
  /const showScopeRoot = viewMode === "day"/,
  "GraphView renders the Date root for Day View"
);
assert.match(
  graphViewSource,
  /sprints[\s\S]*\.filter\(\(sprint\) => sprint\.id !== ROOT_ID\)[\s\S]*\.map\(\(sprint\) =>/,
  "GraphView renders sprint scope nodes independently of lower-level work items"
);
assert.match(
  graphViewSource,
  /allowChildActions:\s*!readOnly && \(isOrphanSprint \|\| childActionItems\.length > 0\)/,
  "real and orphan Day View sprint nodes keep their shared child action menu"
);
assert.match(
  nodeCapabilitiesSource,
  /if \(type === "sprint"\) return \["epic"\]/,
  "real sprint nodes can create Epic children"
);
assert.match(
  nodeCapabilitiesSource,
  /if \(type === "orphan-sprint"\) return \["epic"\]/,
  "orphan sprint nodes can create Epic children"
);
assert.match(
  nodeCapabilitiesSource,
  /if \(type === "sprint"\) return \["epic"\]/,
  "real sprint nodes can add existing Epic children"
);
assert.match(
  nodeCapabilitiesSource,
  /if \(type === "orphan-sprint"\) return \["epic"\]/,
  "orphan sprint nodes can add existing Epic children"
);

console.log("Day View projection verification passed");
