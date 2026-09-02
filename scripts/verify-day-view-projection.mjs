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

const canonicalSprint = {
  id: "canonical-sprint",
  title: "Canonical Sprint",
};
const orphanScope = {
  id: ORPHAN_SPRINT_ID,
  title: "Orphan Sprint",
  isVirtual: true,
  isOrphanSprint: true,
};
const alternateDaySprint = {
  id: "day-target-sprint",
  title: "Day Target Sprint",
};
const canonicalEpicWithOtherSprint = {
  id: "epic-e1",
  type: "epic",
  title: "Epic E1",
  parentId: ROOT_ID,
  sprint: canonicalSprint.title,
  elitical: {
    num: "SYN-1",
    sprintId: canonicalSprint.id,
  },
};
const canonicalStoryUnderEpic = {
  id: "story-s1",
  type: "story",
  title: "Story S1",
  parentId: canonicalEpicWithOtherSprint.id,
  sprint: canonicalSprint.title,
  elitical: {
    num: "SYN-2",
    sprintId: canonicalSprint.id,
    epicId: canonicalEpicWithOtherSprint.id,
  },
};
const canonicalJobUnderStory = {
  id: "job-j1",
  type: "job",
  title: "Job J1",
  parentId: canonicalStoryUnderEpic.id,
  sprint: canonicalSprint.title,
  elitical: {
    num: "SYN-3",
    sprintId: canonicalSprint.id,
    epicId: canonicalEpicWithOtherSprint.id,
    storyId: canonicalStoryUnderEpic.id,
  },
};
const dayProjectedOrphanEpic = {
  ...canonicalEpicWithOtherSprint,
  sprintId: "",
  sprint: orphanScope.title,
  targetScopeId: ORPHAN_SPRINT_ID,
  targetSprintId: ORPHAN_SPRINT_ID,
  visualParentId: ORPHAN_SPRINT_ID,
  childSprintId: "",
  childSprint: orphanScope.title,
  dayContextDate: "2026-07-02",
  isDayProjectionSelected: true,
};
const projectedOrphanEpicItems = buildProjectedHierarchy({
  items: [dayProjectedOrphanEpic],
  allItems: [canonicalEpicWithOtherSprint],
  scopes: [canonicalSprint, orphanScope],
}).items;
const projectedGenericEpic = projectedOrphanEpicItems.find(
  (item) => item.id === canonicalEpicWithOtherSprint.id
);

assert.equal(
  projectedGenericEpic?.targetScopeId,
  ORPHAN_SPRINT_ID,
  "Day Add Existing Epic prefers the explicit Day target scope over canonical elitical.sprintId"
);
assert.equal(
  projectedGenericEpic?.visualParentId,
  ORPHAN_SPRINT_ID,
  "Day Add Existing Epic renders under the Orphan Sprint target instead of the old canonical Sprint"
);
assert.notEqual(
  projectedGenericEpic?.targetScopeId,
  canonicalSprint.id,
  "Day Add Existing Epic does not snap back to the old canonical Sprint"
);

const dayProjectedRealSprintEpic = {
  ...canonicalEpicWithOtherSprint,
  sprintId: alternateDaySprint.id,
  sprint: alternateDaySprint.title,
  targetScopeId: alternateDaySprint.id,
  targetSprintId: alternateDaySprint.id,
  visualParentId: alternateDaySprint.id,
  childSprintId: alternateDaySprint.id,
  childSprint: alternateDaySprint.title,
  dayContextDate: "2026-07-03",
  isDayProjectionSelected: true,
};
const projectedRealSprintEpic = buildProjectedHierarchy({
  items: [dayProjectedRealSprintEpic],
  allItems: [canonicalEpicWithOtherSprint],
  scopes: [canonicalSprint, alternateDaySprint],
}).items.find((item) => item.id === canonicalEpicWithOtherSprint.id);

assert.equal(
  projectedRealSprintEpic?.targetScopeId,
  alternateDaySprint.id,
  "Day Add Existing Epic renders under a real Day target Sprint when one applies"
);
assert.equal(
  canonicalEpicWithOtherSprint.elitical.sprintId,
  canonicalSprint.id,
  "Day projection does not mutate canonical elitical.sprintId"
);

const dayWorklogHierarchy = buildProjectedHierarchy({
  items: [canonicalJobUnderStory],
  allItems: [
    canonicalEpicWithOtherSprint,
    canonicalStoryUnderEpic,
    canonicalJobUnderStory,
  ],
  scopes: [canonicalSprint],
  missingAncestorLimit: 1,
  skipRootMissingAncestors: true,
}).items;
const structuralEpic = dayWorklogHierarchy.find(
  (item) => item.sourceItemId === canonicalEpicWithOtherSprint.id
);
const structuralStory = dayWorklogHierarchy.find(
  (item) => item.sourceItemId === canonicalStoryUnderEpic.id
);
const visibleJob = dayWorklogHierarchy.find((item) => item.id === canonicalJobUnderStory.id);

assert.equal(
  structuralEpic,
  undefined,
  "Day View automatic worklog projection does not reconstruct the full unselected ancestor chain"
);
assert.equal(
  structuralStory?.isReference,
  true,
  "Day View keeps the nearest missing ancestor as a structural reference for hierarchy"
);
assert.equal(
  visibleJob?.parentId,
  structuralStory?.id,
  "Day View connects visible descendants through the nearest structural ancestor"
);

const dayStoryHierarchy = buildProjectedHierarchy({
  items: [canonicalStoryUnderEpic],
  allItems: [canonicalEpicWithOtherSprint, canonicalStoryUnderEpic],
  scopes: [canonicalSprint],
  missingAncestorLimit: 1,
  skipRootMissingAncestors: true,
}).items;

assert.equal(
  dayStoryHierarchy.some(
    (item) => item.sourceItemId === canonicalEpicWithOtherSprint.id
  ),
  false,
  "Day View does not show an unselected root-level ancestor for a visible child with Day activity"
);
assert.equal(
  dayStoryHierarchy.find((item) => item.id === canonicalStoryUnderEpic.id)?.visualParentId,
  canonicalSprint.id,
  "Visible Day child routes to its Day sprint when its root-level ancestor is structural-only"
);

const normalCanonicalEpicItems = buildProjectedHierarchy({
  items: [canonicalEpicWithOtherSprint],
  allItems: [canonicalEpicWithOtherSprint],
  scopes: [canonicalSprint, orphanScope],
}).items;
const normalCanonicalEpic = normalCanonicalEpicItems.find(
  (item) => item.id === canonicalEpicWithOtherSprint.id
);

assert.equal(
  normalCanonicalEpic?.targetScopeId,
  canonicalSprint.id,
  "normal hierarchy projection still resolves canonical items from elitical.sprintId"
);
assert.equal(
  normalCanonicalEpic?.visualParentId,
  canonicalSprint.id,
  "normal hierarchy projection keeps the existing canonical Sprint behavior"
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
  graphViewSource,
  /missingAncestorLimit:\s*viewMode === "day" \? 1 : Infinity/,
  "Day View limits missing ancestors to the nearest structural parent"
);
assert.match(
  graphViewSource,
  /skipRootMissingAncestors:\s*viewMode === "day"/,
  "Day View does not render unselected root-level ancestors as independent nodes"
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
  /allowChildActions:\s*!readOnly/,
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

// ── Regression: Create Story in Day View registers in dayProjectionSelections ──
// Simulates the fixed createItem flow: after creating a Story under an Epic in Day View,
// the story should be registered in dayProjectionSelections.storiesByEpicScope
// using the rendered Day scope sprint ID (not the canonical sprint).
{
  const dayDate = "2026-06-15";
  const renderedScopeSprintId = "sprint-14"; // Day View rendered scope
  const canonicalSprintId = "canonical-sprint-99"; // Epic's canonical sprint (different)
  const epicId = "epic-create-test";
  const createdStoryId = "story-created-in-day";

  // Start with the epic already in day projection (as it would be when visible)
  const withEpicProjection = addDayProjectionSelection({
    state: { version: 1, days: {} },
    selectedDate: dayDate,
    kind: "epic",
    sprintId: renderedScopeSprintId,
    childId: epicId,
  });

  // Simulate the fixed createItem: register the new Story with the rendered scope
  const afterCreate = addDayProjectionSelection({
    state: withEpicProjection,
    selectedDate: dayDate,
    kind: "story",
    parentId: epicId,
    sprintId: renderedScopeSprintId,
    childId: createdStoryId,
  });

  const daySelection = daySelectionForDate(afterCreate, dayDate);
  const scopeKey = `${epicId}::${renderedScopeSprintId}`;

  assert.deepEqual(
    daySelection.epicsBySprint[renderedScopeSprintId],
    [epicId],
    "Day View epic remains in projection after child story creation"
  );
  assert.deepEqual(
    daySelection.storiesByEpicScope[scopeKey],
    [createdStoryId],
    "Created story is registered in dayProjectionSelections.storiesByEpicScope with rendered scope"
  );
  assert.equal(
    daySelection.storiesByEpicScope[`${epicId}::${canonicalSprintId}`],
    undefined,
    "Created story is NOT registered under the canonical sprint scope (which would fail eligibility)"
  );
}

// Verify the createItem code path now calls addDayProjectionSelection for stories
assert.match(
  appSource,
  /if \(type === "story" \|\| type === "epic"\) \{[\s\S]*addDayProjectionSelection\(\{[\s\S]*selectedDate: dayCreateDate,[\s\S]*kind: type,[\s\S]*parentId,[\s\S]*sprintId: dayCreateScopeId,[\s\S]*childId: createdId,/,
  "createItem now registers the created item in dayProjectionSelections using the rendered Day scope"
);
assert.match(
  appSource,
  /setDayProjectionSelections\(nextProjection\)/,
  "createItem updates React state with the new day projection"
);
assert.match(
  appSource,
  /saveDayProjectionState\(\s*typeof window === "undefined" \? null : window\.localStorage,\s*nextProjection\s*\)/,
  "createItem persists the new day projection to localStorage"
);

console.log("Day View projection verification passed");
