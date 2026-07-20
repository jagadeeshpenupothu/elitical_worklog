import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ORPHAN_SPRINT_ID,
  addDayProjectionSelection,
  daySelectionForDate,
} from "../src/utils/dayViewProjection.js";
import { applySearchFilters } from "../src/utils/globalSearchFilter.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const emptyFilters = {
  date: "",
  sprint: "",
  epic: "",
  state: "",
  priority: "",
  assignee: "",
  storyPoints: "",
  type: "",
  category: "",
};
const selectedDate = "2026-07-19";
const sprint = {
  id: "sprint-a",
  title: "Sprint A",
};
const existingEpic = {
  id: "epic-gaptor",
  type: "epic",
  title: "Gaptor",
  parentId: ROOT_ID,
  sprintId: sprint.id,
  sprint: sprint.title,
  docketState: "concept",
};
const projectedEpic = {
  ...existingEpic,
  targetScopeId: sprint.id,
  targetSprintId: sprint.id,
  visualParentId: sprint.id,
  childSprintId: sprint.id,
  childSprint: sprint.title,
  dayContextDate: selectedDate,
  isDayProjectionSelected: true,
};
const existingStory = {
  id: "story-existing",
  type: "story",
  title: "Existing Story",
  parentId: existingEpic.id,
  sprintId: sprint.id,
  sprint: sprint.title,
  docketState: "concept",
};
const projectedStory = {
  ...existingStory,
  targetScopeId: sprint.id,
  targetSprintId: sprint.id,
  visualParentId: existingEpic.id,
  childSprintId: sprint.id,
  childSprint: sprint.title,
  dayContextDate: selectedDate,
  isDayProjectionSelected: true,
};

function visibleIds(items, filters) {
  return applySearchFilters({
    items,
    filters: {
      ...emptyFilters,
      ...filters,
    },
  }).visibleItems.map((item) => item.id);
}

assert.deepEqual(
  visibleIds([projectedEpic], { date: selectedDate }),
  [existingEpic.id],
  "Day-projection-selected Epic without a day worklog survives the inherited Day date filter"
);

assert.deepEqual(
  visibleIds([projectedEpic, projectedStory], { date: selectedDate }),
  [existingEpic.id, existingStory.id],
  "Day-projection-selected Story without a day worklog remains visible with its Epic ancestor"
);
assert.equal(projectedStory.parentId, existingEpic.id, "Projected Story keeps its canonical Epic parent chain");

assert.deepEqual(
  visibleIds([{ ...existingEpic, id: "ordinary-epic" }], { date: selectedDate }),
  [],
  "Ordinary non-date-relevant Epics are still filtered out"
);

assert.deepEqual(
  visibleIds([projectedEpic], { date: "2026-07-20" }),
  [],
  "Day projection visibility remains scoped to the selected Day context"
);

const withEpicSelection = addDayProjectionSelection({
  state: { version: 1, days: {} },
  selectedDate,
  kind: "epic",
  sprintId: sprint.id,
  childId: existingEpic.id,
});
const selected = daySelectionForDate(withEpicSelection, selectedDate);
const alreadySelected = new Set(selected.epicsBySprint[sprint.id] || []);

assert.equal(
  alreadySelected.has(existingEpic.id),
  true,
  "After successful Day Add Existing Epic, the candidate filter can exclude the already-visible Epic"
);

const orphanEpic = {
  ...existingEpic,
  id: "orphan-epic",
  sprintId: "",
  sprint: "",
  targetScopeId: ORPHAN_SPRINT_ID,
  targetSprintId: ORPHAN_SPRINT_ID,
  visualParentId: ORPHAN_SPRINT_ID,
  childSprintId: "",
  isOrphanSprintContext: true,
  dayContextDate: selectedDate,
  isDayProjectionSelected: true,
};

assert.deepEqual(
  visibleIds([orphanEpic], { date: selectedDate }),
  [orphanEpic.id],
  "Orphan Sprint Day projection keeps an existing orphan Epic visible"
);
assert.equal(orphanEpic.sprintId, "", "Orphan projection does not fabricate a canonical sprintId");

const projectedHierarchy = buildProjectedHierarchy({
  items: [projectedEpic],
  allItems: [existingEpic],
  scopes: [sprint],
}).items;

assert.equal(
  projectedHierarchy.filter((item) => item.id === existingEpic.id).length,
  1,
  "Day projection keeps one canonical Epic entity"
);
assert.equal(
  projectedHierarchy.some((item) => item.isReference && item.sourceItemId === existingEpic.id),
  false,
  "Day Add Existing Epic does not create a reference or cloned Epic"
);
assert.equal(existingEpic.sprintId, sprint.id, "Canonical Epic sprintId remains unchanged");
assert.equal(existingEpic.parentId, ROOT_ID, "Canonical Epic parentId remains unchanged");

assert.deepEqual(
  visibleIds([projectedEpic], { date: selectedDate, state: "design" }),
  [],
  "Projection-selected items do not bypass explicit non-date user filters"
);

assert.match(
  appSource,
  /if \(addExistingChildRequest\.mode === "day"\) \{[\s\S]*addDayProjectionSelection\([\s\S]*return;/,
  "Day Add Existing remains projection-only and exits before local-first canonical updates"
);
assert.match(
  appSource,
  /const result = await updateEliticalDocket\(canonicalDocketId, updates\)/,
  "Non-Day Add Existing still uses the existing canonical local-first update path"
);
assert.match(
  appSource,
  /dayContextMembershipById\.set\(item\.id,[\s\S]*source: "projection"/,
  "Day projection selections are tagged as Day context membership before filtering"
);
assert.match(
  appSource,
  /dayContextDate: dayContextMembership\?\.date/,
  "Day context membership date is carried into graph filter input"
);

console.log("Day projection filter visibility verification PASS");
