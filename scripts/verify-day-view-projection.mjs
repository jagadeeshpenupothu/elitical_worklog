import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ORPHAN_SPRINT_ID,
  addDayProjectionSelection,
  addDayProjectionSelectionForItem,
  dayProjectionSelectionIncludesItem,
  dayProjectionSelectionTargetForItem,
  dayProjectionSprintIdForCreate,
  dayEpicScopeKey,
  dayStoryScopeKey,
  dateKeyFromValue,
  daySelectionForDate,
  sprintContainsDate,
  sprintScopesForDay,
} from "../src/utils/dayViewProjection.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const graphViewSource = readFileSync(new URL("../src/views/GraphView.jsx", import.meta.url), "utf8");
const jiraNodeSource = readFileSync(new URL("../src/components/JiraNode.jsx", import.meta.url), "utf8");
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
const withJob = addDayProjectionSelection({
  state: withStory,
  selectedDate: "2026-06-01",
  kind: "job",
  parentId: "story-1",
  sprintId: "sprint-14",
  childId: "job-1",
});
const selected = daySelectionForDate(withJob, "2026-06-01T00:00:00.000Z");

assert.deepEqual(selected.epicsBySprint["sprint-14"], ["epic-1"]);
assert.deepEqual(selected.storiesByEpicScope["epic-1::sprint-14"], ["story-1"]);
assert.deepEqual(selected.jobsByStoryScope[dayStoryScopeKey("story-1", "sprint-14")], ["job-1"]);
assert.deepEqual(initialState, { version: 1, days: {} });

{
  const selectedDate = "2026-08-24";
  const targetSprint = "rendered-day-sprint";
  const importedEpic = {
    id: "imported-epic",
    type: "epic",
    title: "Imported Epic",
    parentId: ROOT_ID,
    createdAt: "2024-08-23T21:39:55.000Z",
    updatedAt: "2026-01-22T19:25:22.000Z",
    elitical: {
      num: "GEN-1",
      sprintId: "canonical-sprint",
    },
  };
  const importedStory = {
    id: "imported-story",
    type: "story",
    title: "Imported Story",
    parentId: importedEpic.id,
    createdAt: "2024-08-24T21:39:55.000Z",
    updatedAt: "2026-01-23T19:25:22.000Z",
    elitical: {
      num: "GEN-2",
      sprintId: "canonical-sprint",
    },
  };
  const importedJob = {
    id: "imported-job",
    type: "job",
    title: "Imported Job",
    parentId: importedStory.id,
    createdAt: "2024-08-25T21:39:55.000Z",
    updatedAt: "2026-01-24T19:25:22.000Z",
    elitical: {
      num: "GEN-3",
      sprintId: "canonical-sprint",
    },
  };
  const projectedImportedEpic = addDayProjectionSelectionForItem({
    state: initialState,
    selectedDate,
    item: importedEpic,
    sprintId: targetSprint,
  });
  const projectedImportedStory = addDayProjectionSelectionForItem({
    state: projectedImportedEpic,
    selectedDate,
    item: importedStory,
    sprintId: targetSprint,
  });
  const projectedImportedJob = addDayProjectionSelectionForItem({
    state: projectedImportedStory,
    selectedDate,
    item: importedJob,
    sprintId: targetSprint,
  });
  const importedSelection = daySelectionForDate(projectedImportedJob, selectedDate);

  assert.deepEqual(
    importedSelection.epicsBySprint[targetSprint],
    [importedEpic.id],
    "Add Existing Epic uses the selected item's actual Epic projection bucket"
  );
  assert.deepEqual(
    importedSelection.storiesByEpicScope[dayEpicScopeKey(importedEpic.id, targetSprint)],
    [importedStory.id],
    "Add Existing Story uses the selected Story's actual Epic parent projection key"
  );
  assert.deepEqual(
    importedSelection.jobsByStoryScope[dayStoryScopeKey(importedStory.id, targetSprint)],
    [importedJob.id],
    "Add Existing Job uses the selected Job's actual Story parent projection key"
  );
  assert.equal(
    dayProjectionSelectionIncludesItem({
      state: projectedImportedJob,
      selectedDate,
      item: importedJob,
      sprintId: targetSprint,
    }),
    true,
    "Projected Job membership survives normalized state reload checks"
  );
  assert.equal(
    importedSelection.storiesByEpicScope[dayEpicScopeKey("wrong-epic", targetSprint)],
    undefined,
    "Add Existing Story does not use the request parent when it differs from actual hierarchy"
  );
  assert.equal(
    importedSelection.jobsByStoryScope[dayStoryScopeKey("wrong-story", targetSprint)],
    undefined,
    "Add Existing Job does not use the request parent when it differs from actual hierarchy"
  );
  assert.deepEqual(
    dayProjectionSelectionTargetForItem({
      item: importedJob,
      sprintId: targetSprint,
    }),
    {
      kind: "job",
      parentId: importedStory.id,
      sprintId: targetSprint,
      childId: importedJob.id,
    },
    "Projection target derivation comes from the selected record type and hierarchy"
  );
  assert.equal(
    importedJob.createdAt,
    "2024-08-25T21:39:55.000Z",
    "Day View membership projection does not mutate cross-date createdAt metadata"
  );
}

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
  createdAt: "2026-07-03T09:00:00.000Z",
  updatedAt: "2026-07-03T09:30:00.000Z",
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
  createdAt: "2026-07-03T10:00:00.000Z",
  updatedAt: "2026-07-03T10:30:00.000Z",
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

const directActualEpicWithReferenceCollision = {
  ...canonicalEpicWithOtherSprint,
  sprintId: alternateDaySprint.id,
  sprint: alternateDaySprint.title,
  targetScopeId: alternateDaySprint.id,
  targetSprintId: alternateDaySprint.id,
  visualParentId: alternateDaySprint.id,
  childSprintId: alternateDaySprint.id,
  childSprint: alternateDaySprint.title,
  dayContextDate: "2026-07-04",
  isDayProjectionSelected: true,
  dayContextRole: "direct",
};
const orphanJobSharingActualEpicAncestor = {
  ...canonicalJobUnderStory,
  id: "orphan-job-with-actual-epic-ancestor",
  sprint: "",
  sprintId: "",
  elitical: {
    ...canonicalJobUnderStory.elitical,
    sprintId: "",
  },
};
const actualEpicReferenceCollisionItems = buildProjectedHierarchy({
  items: [directActualEpicWithReferenceCollision, orphanJobSharingActualEpicAncestor],
  allItems: [
    canonicalEpicWithOtherSprint,
    canonicalStoryUnderEpic,
    orphanJobSharingActualEpicAncestor,
  ],
  scopes: [alternateDaySprint, orphanScope],
  missingAncestorLimit: 1,
  skipRootMissingAncestors: true,
}).items;

assert.equal(
  actualEpicReferenceCollisionItems.some(
    (item) => item.id === canonicalEpicWithOtherSprint.id && !item.isReference
  ),
  true,
  "Direct actual-sprint Day Epic remains visible even when another item needs a scoped reference to the same Epic"
);
assert.equal(
  actualEpicReferenceCollisionItems.some(
    (item) =>
      item.isReference &&
      item.sourceItemId === canonicalEpicWithOtherSprint.id &&
      item.targetScopeId === ORPHAN_SPRINT_ID
  ),
  true,
  "Reference ancestor for a different scope is still preserved alongside the direct Day Epic"
);

const actualStoryWithReferenceCollision = {
  ...canonicalStoryUnderEpic,
  sprintId: alternateDaySprint.id,
  sprint: alternateDaySprint.title,
  targetScopeId: alternateDaySprint.id,
  targetSprintId: alternateDaySprint.id,
  childSprintId: alternateDaySprint.id,
  childSprint: alternateDaySprint.title,
  dayContextDate: "2026-07-04",
  isDayProjectionSelected: true,
  dayContextRole: "direct",
};
const actualStoryReferenceCollisionItems = buildProjectedHierarchy({
  items: [actualStoryWithReferenceCollision, orphanJobSharingActualEpicAncestor],
  allItems: [
    canonicalEpicWithOtherSprint,
    canonicalStoryUnderEpic,
    orphanJobSharingActualEpicAncestor,
  ],
  scopes: [alternateDaySprint, orphanScope],
  missingAncestorLimit: 1,
  skipRootMissingAncestors: true,
}).items;

assert.equal(
  actualStoryReferenceCollisionItems.some(
    (item) => item.id === canonicalStoryUnderEpic.id && !item.isReference
  ),
  true,
  "Direct actual-sprint Day Story remains visible even when a scoped reference to the same Story is also needed"
);

const jobWithoutRawSprintIdInActualDayScope = {
  ...canonicalJobUnderStory,
  sprint: alternateDaySprint.title,
  sprintId: "",
  targetScopeId: alternateDaySprint.id,
  targetSprintId: alternateDaySprint.id,
  childSprintId: alternateDaySprint.id,
  childSprint: alternateDaySprint.title,
  dayContextDate: "2026-07-04",
  isDayProjectionSelected: true,
  dayContextRole: "direct",
  elitical: {
    ...canonicalJobUnderStory.elitical,
    sprintId: "",
  },
};
const actualJobWithoutRawSprintItems = buildProjectedHierarchy({
  items: [
    directActualEpicWithReferenceCollision,
    actualStoryWithReferenceCollision,
    jobWithoutRawSprintIdInActualDayScope,
  ],
  allItems: [
    canonicalEpicWithOtherSprint,
    canonicalStoryUnderEpic,
    jobWithoutRawSprintIdInActualDayScope,
  ],
  scopes: [alternateDaySprint],
  missingAncestorLimit: 1,
  skipRootMissingAncestors: true,
}).items;

assert.equal(
  actualJobWithoutRawSprintItems.some(
    (item) => item.id === canonicalJobUnderStory.id && item.targetScopeId === alternateDaySprint.id
  ),
  true,
  "Direct actual-sprint Day Job remains visible from targetScopeId even when raw sprintId is empty"
);
assert.equal(
  actualJobWithoutRawSprintItems.find((item) => item.id === canonicalJobUnderStory.id)?.parentId,
  canonicalStoryUnderEpic.id,
  "Direct actual-sprint Day Job stays attached to the visible projected Story instead of a duplicate reference"
);
assert.equal(
  actualJobWithoutRawSprintItems.some(
    (item) =>
      item.isReference &&
      item.sourceItemId === canonicalStoryUnderEpic.id &&
      item.targetScopeId === alternateDaySprint.id
  ),
  false,
  "Visible projected Story satisfies actual-sprint Job hierarchy even when canonical raw sprintId is empty"
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
assert.equal(
  structuralStory?.updatedAt,
  canonicalStoryUnderEpic.updatedAt,
  "Structural context ancestors may retain metadata dates that differ from the selected Day"
);
assert.notEqual(
  canonicalStoryUnderEpic.updatedAt.slice(0, 10),
  "2026-07-01",
  "The structural ancestor fixture represents a cross-date parent/child Day View case"
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

// ── Regression: orphan Day View local creates persist full Epic → Story → Job projection ──
// The UI can create an Epic in the virtual orphan sprint, then immediately create
// a Story and Job under it. Each create must append to the latest durable
// projection state, and empty local sprint IDs must normalize to the virtual
// orphan sprint scope.
{
  const dayDate = "2026-09-03";
  const orphanEpicId = "orphan-created-epic";
  const orphanStoryId = "orphan-created-story";
  const orphanJobId = "orphan-created-job";
  const orphanCreateScopeId = dayProjectionSprintIdForCreate({
    isOrphanSprintCreate: true,
    payloadSprintId: "",
    createPayloadSprintId: "",
  });

  assert.equal(
    orphanCreateScopeId,
    ORPHAN_SPRINT_ID,
    "Real UI orphan creates resolve empty raw sprint IDs to the durable virtual orphan projection scope"
  );

  const afterEpicCreate = addDayProjectionSelection({
    state: { version: 1, days: {} },
    selectedDate: dayDate,
    kind: "epic",
    sprintId: orphanCreateScopeId,
    childId: orphanEpicId,
  });
  const afterStoryCreate = addDayProjectionSelection({
    state: afterEpicCreate,
    selectedDate: dayDate,
    kind: "story",
    parentId: orphanEpicId,
    sprintId: orphanCreateScopeId,
    childId: orphanStoryId,
  });
  const afterJobCreate = addDayProjectionSelection({
    state: afterStoryCreate,
    selectedDate: dayDate,
    kind: "job",
    parentId: orphanStoryId,
    sprintId: orphanCreateScopeId,
    childId: orphanJobId,
  });

  const orphanSelection = daySelectionForDate(afterJobCreate, dayDate);
  const orphanStoryScopeKey = dayEpicScopeKey(orphanEpicId, ORPHAN_SPRINT_ID);
  const orphanJobScopeKey = dayStoryScopeKey(orphanStoryId, ORPHAN_SPRINT_ID);

  assert.deepEqual(
    orphanSelection.epicsBySprint[ORPHAN_SPRINT_ID],
    [orphanEpicId],
    "Orphan Sprint local Epic is stored under the durable virtual orphan sprint projection"
  );
  assert.deepEqual(
    orphanSelection.storiesByEpicScope[orphanStoryScopeKey],
    [orphanStoryId],
    "Orphan Sprint local Story is stored under the durable Epic plus orphan sprint scope"
  );
  assert.deepEqual(
    orphanSelection.jobsByStoryScope[orphanJobScopeKey],
    [orphanJobId],
    "Orphan Sprint local Job is stored under the durable Story plus orphan sprint scope"
  );
  assert.deepEqual(
    daySelectionForDate(afterJobCreate, dayDate).storiesByEpicScope[
      dayEpicScopeKey(orphanEpicId, "")
    ],
    [orphanStoryId],
    "Empty local sprint IDs resolve to the same orphan Story projection scope"
  );
  assert.deepEqual(
    daySelectionForDate(afterJobCreate, dayDate).jobsByStoryScope[
      dayStoryScopeKey(orphanStoryId, "")
    ],
    [orphanJobId],
    "Empty local sprint IDs resolve to the same orphan Job projection scope"
  );
}

// Verify the createItem code path now calls addDayProjectionSelection for stories and jobs
assert.match(
  appSource,
  /if \(type === "story" \|\| type === "epic" \|\| type === "job"\) \{[\s\S]*addDayProjectionSelection\(\{[\s\S]*selectedDate: dayCreateDate,[\s\S]*kind: type,[\s\S]*parentId,[\s\S]*sprintId: dayCreateScopeId,[\s\S]*childId: createdId,/,
  "createItem now registers the created item in dayProjectionSelections using the rendered Day scope"
);
assert.match(
  appSource,
  /dayProjectionSprintIdForCreate\(\{[\s\S]*isOrphanSprintCreate,[\s\S]*payloadSprintId: payload\.sprintId,[\s\S]*createPayloadSprintId: createPayload\.sprintId,[\s\S]*\}\)/,
  "createItem resolves the real UI create payload into a durable Day projection scope"
);
assert.match(
  appSource,
  /setDayProjectionSelections\(\(currentProjection\) => \{[\s\S]*addDayProjectionSelection\(\{[\s\S]*state: currentProjection,[\s\S]*selectedDate: dayCreateDate,[\s\S]*kind: type,[\s\S]*parentId,[\s\S]*sprintId: dayCreateScopeId,[\s\S]*childId: createdId,/,
  "createItem appends Day projection writes to the latest React state instead of a stale closure"
);
assert.doesNotMatch(
  appSource,
  /addDayProjectionSelection\(\{[\s\S]*state: dayProjectionSelections,[\s\S]*selectedDate: dayCreateDate,[\s\S]*kind: type,[\s\S]*childId: createdId,/,
  "createItem does not persist Day projection writes from a stale dayProjectionSelections snapshot"
);
assert.match(
  appSource,
  /Object\.entries\(daySelection\.jobsByStoryScope \|\| \{\}\)\.forEach/,
  "Day View reads durable Job projection membership after refresh"
);
assert.match(
  appSource,
  /latestGraphPayloadTimeRef/,
  "Day View graph cache updates track the latest normalized graph payload time"
);
assert.match(
  appSource,
  /payloadTime < latestGraphPayloadTimeRef\.current/,
  "Day View graph cache updates ignore stale normalized graph payloads"
);
assert.match(
  appSource,
  /reason: "stale-graph-payload"/,
  "Stale graph payloads are explicitly ignored instead of replacing newer local creates"
);
assert.match(
  appSource,
  /function dayScopeIdForPersistedItem\(item, dateSprints = \[\]\)/,
  "Day View derives persisted item scope from the current date Sprint set"
);
assert.match(
  appSource,
  /normalizeSprintTitle\(sprint\?\.title \|\| sprint\?\.name \|\| sprint\?\.id\) === itemSprintTitle/,
  "Day View can resolve local-created items to a real Sprint by persisted Sprint title"
);
assert.match(
  appSource,
  /function isLocalCreatedForDay\(item, selectedDate\)[\s\S]*item\?\.sync\?\.status !== "pending-create"[\s\S]*dateKeyFromValue\(item\.createdAt \|\| item\.updatedAt\) === selectedDate/,
  "Day View uses persisted local-create timestamps as a general Day membership source"
);
assert.match(
  appSource,
  /function includePersistedDayAncestors\(item, sprintId\)[\s\S]*const parent = itemById\.get\(parentId\)[\s\S]*includePersistedDayItem\(parent, sprintId, \{ role: "ancestor" \}\)/,
  "Day View includes persisted parent hierarchy for date-selected items"
);
assert.match(
  appSource,
  /source: previousMembership\?\.source \|\| "persisted"/,
  "Day View marks hierarchy selected from durable graph data separately from projection and retained context"
);
assert.match(
  appSource,
  /includePersistedDayItem\(parent, sprintId, \{ role: "ancestor" \}\)/,
  "Day View marks durable parent hierarchy as context-only ancestors"
);
assert.match(
  appSource,
  /dayContextRole: dayContextMembership\?\.role \|\| contextItem\.dayContextRole \|\| ""/,
  "Day View carries Day membership role into rendered node data"
);
assert.match(
  appSource,
  /isDayContextAncestor:[\s\S]*dayContextMembership\?\.role === "ancestor"/,
  "Day View exposes context-only ancestors to the shared node renderer"
);
assert.match(
  appSource,
  /return entry\?\.sync\?\.status === "pending-create" && itemMatchesEmployeeScope\(item, scope\)/,
  "Local pending Worklogs without employee IDs inherit the owning docket's employee scope"
);
assert.match(
  graphViewSource,
  /function isDayContextAncestorItem\(item, viewMode\)[\s\S]*viewMode === "day"[\s\S]*item\.isDayContextAncestor \|\| isReferenceNode\(item\)/,
  "Day View treats both persisted ancestor context and reference nodes as context-only for card date presentation"
);
assert.match(
  graphViewSource,
  /if \(viewMode === "day" && item\.dayContextDate && !isDayContextAncestorItem\(item, viewMode\)\) \{[\s\S]*return item\.dayContextDate;/,
  "Direct Day View records use the Day membership date for their card date presentation"
);
assert.match(
  graphViewSource,
  /hideDisplayDate: isDayContextAncestorItem\(item, viewMode\)/,
  "Context-only Day ancestors suppress the metadata date pill instead of presenting it as Day membership"
);
assert.match(
  graphViewSource,
  /isProjectNode: true,[\s\S]*hideDisplayDate: viewMode === "day"/,
  "Day View project scope nodes suppress graph metadata dates"
);
assert.match(
  graphViewSource,
  /isSprintNode: true,[\s\S]*hideDisplayDate: viewMode === "day"/,
  "Day View sprint scope nodes suppress graph metadata dates"
);
assert.match(
  jiraNodeSource,
  /!\s*data\.hideDisplayDate && \([\s\S]*node-meta-pill node-updated/,
  "JiraNode hides the date pill when graph projection marks it as context-only"
);
assert.match(
  appSource,
  /setDayProjectionSelections\(\(currentProjection\) => \{/,
  "createItem updates React state with a functional day projection update"
);
assert.match(
  appSource,
  /saveDayProjectionState\(\s*typeof window === "undefined" \? null : window\.localStorage,\s*nextProjection\s*\)/,
  "createItem persists the new day projection to localStorage"
);
assert.match(
  appSource,
  /addDayProjectionSelectionForItem\(\{[\s\S]*item: selectedChild,[\s\S]*sprintId: scopeId/,
  "Day View Add Existing derives projection membership from the selected item's actual data"
);
assert.match(
  appSource,
  /dayProjectionSelectionIncludesItem\(\{[\s\S]*state: loadDayProjectionState\(storage\),[\s\S]*item: selectedChild/,
  "Day View Add Existing verifies the saved projection before reporting success"
);

console.log("Day View projection verification passed");
