import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addExistingDiscoveryScopeId,
  discoverAddExistingItems,
} from "../src/utils/addExistingDiscovery.js";
import {
  ORPHAN_SPRINT_ID,
  addDayProjectionSelection,
  daySelectionForDate,
} from "../src/utils/dayViewProjection.js";

function ids(items) {
  return items.map((item) => item.id);
}

const sprintEpic = {
  id: "epic-current-sprint",
  type: "epic",
  title: "Already In Destination",
  sprintId: "sprint-a",
  elitical: {
    sprintId: "sprint-a",
    num: "DKT-100",
  },
};
const crossSprintEpic = {
  id: "epic-cross-sprint",
  type: "epic",
  title: "Reusable Cross Sprint Epic",
  sprintId: "sprint-b",
  elitical: {
    sprintId: "sprint-b",
    num: "DKT-222",
  },
};
const orphanEpic = {
  id: "epic-orphan",
  type: "epic",
  title: "No Sprint Epic",
  sprintId: "",
  elitical: {
    sprintId: "",
    num: "DKT-333",
  },
};
const referenceEpic = {
  id: "reference-epic-cross-sprint-sprint-a",
  sourceItemId: crossSprintEpic.id,
  type: "epic",
  title: "Reusable Cross Sprint Epic Reference",
  isReference: true,
  isGhost: true,
};
const destinationStory = {
  id: "story-current-epic",
  type: "story",
  title: "Already Under Destination",
  parentId: "epic-a",
  elitical: {
    num: "DKT-444",
  },
};
const otherStory = {
  id: "story-other-epic",
  type: "story",
  title: "Reusable Story",
  parentId: "epic-b",
  elitical: {
    num: "DKT-555",
  },
};
const workItems = [
  sprintEpic,
  crossSprintEpic,
  orphanEpic,
  referenceEpic,
  destinationStory,
  otherStory,
  {
    id: "task-1",
    type: "task",
    title: "Existing Task",
    parentId: "epic-a",
  },
  {
    id: "job-1",
    type: "job",
    title: "Existing Job",
    parentId: "story-current-epic",
  },
];
const selectedDay = "2026-07-03";

const namedSprintRequest = {
  type: "epic",
  mode: "canonical",
  sprintId: "sprint-a",
  parentId: "sprint-a",
};
const namedSprintEpicIds = ids(
  discoverAddExistingItems({
    workItems,
    request: namedSprintRequest,
  })
);

assert.deepEqual(
  namedSprintEpicIds,
  ["epic-orphan", "epic-cross-sprint"],
  "named sprint discovery includes epics from other sprints and orphan scope, but not duplicates already in the destination"
);

assert.deepEqual(
  ids(discoverAddExistingItems({
    workItems,
    request: namedSprintRequest,
    query: "cross",
  })),
  ["epic-cross-sprint"],
  "title search runs after global Epic discovery"
);

assert.deepEqual(
  ids(discoverAddExistingItems({
    workItems,
    request: namedSprintRequest,
    query: "DKT-222",
  })),
  ["epic-cross-sprint"],
  "docket ID search runs after global Epic discovery"
);

const orphanSprintRequest = {
  type: "epic",
  mode: "canonical",
  isOrphanSprint: true,
  sprintId: "",
  parentId: "storyRoot",
};

assert.equal(
  addExistingDiscoveryScopeId(orphanSprintRequest),
  ORPHAN_SPRINT_ID,
  "Orphan Sprint uses virtual scope for duplicate detection only"
);
assert.deepEqual(
  ids(discoverAddExistingItems({
    workItems,
    request: orphanSprintRequest,
    query: "cross",
  })),
  ["epic-cross-sprint"],
  "Orphan Sprint discovery can find an Epic from a named sprint"
);

const storyRequest = {
  type: "story",
  mode: "canonical",
  parentId: "epic-a",
  sourceItemId: "epic-a",
  sprintId: "sprint-a",
};

assert.deepEqual(
  ids(discoverAddExistingItems({
    workItems,
    request: storyRequest,
  })),
  ["story-other-epic"],
  "Story discovery includes stories from other Epics and excludes duplicates under the destination Epic"
);

const dayState = addDayProjectionSelection({
  state: { version: 1, days: {} },
  selectedDate: selectedDay,
  kind: "epic",
  sprintId: "sprint-a",
  childId: sprintEpic.id,
});
const daySelection = daySelectionForDate(dayState, selectedDay);
const dayRequest = {
  ...namedSprintRequest,
  mode: "day",
};

assert.deepEqual(
  ids(discoverAddExistingItems({
    workItems,
    request: dayRequest,
    daySelection,
    scopeId: "sprint-a",
  })),
  ["epic-orphan", "epic-cross-sprint"],
  "Day View discovery is global and only excludes items already projected into the destination"
);

const nextDayState = addDayProjectionSelection({
  state: dayState,
  selectedDate: selectedDay,
  kind: "epic",
  sprintId: "sprint-a",
  childId: crossSprintEpic.id,
});

assert.deepEqual(
  daySelectionForDate(nextDayState, selectedDay).epicsBySprint["sprint-a"],
  [sprintEpic.id, crossSprintEpic.id],
  "Day View selection still attaches the canonical item id to the destination sprint projection"
);

assert.equal(
  crossSprintEpic.id,
  "epic-cross-sprint",
  "Add Existing discovery preserves canonical identity"
);

const capabilities = readFileSync("src/utils/nodeCapabilities.js", "utf8");
const addExistingCapabilitiesBody =
  capabilities.match(/export function childAddExistingTypesForCanonicalType[\s\S]*?\n}\n/)?.[0] || "";
const app = readFileSync("src/App.jsx", "utf8");

assert.match(
  addExistingCapabilitiesBody,
  /if \(type === "sprint"\) return \["epic"\]/,
  "Sprint Add Existing Epic capability remains exposed"
);
assert.match(
  addExistingCapabilitiesBody,
  /if \(type === "epic"\) return \["story"\]/,
  "Epic Add Existing Story capability remains exposed"
);
assert.doesNotMatch(
  addExistingCapabilitiesBody,
  /type === "story"/,
  "Add Existing Job remains unexposed without a confirmed safe canonical move path"
);
assert.doesNotMatch(
  addExistingCapabilitiesBody,
  /"task"/,
  "Add Existing Task remains unexposed without a confirmed safe canonical move path"
);
assert.match(
  app,
  /return capabilityActionItemsForNode\(node\);/,
  "App no longer hides Orphan Sprint Add Existing discovery"
);
assert.match(
  app,
  /updateEliticalDocket\(canonicalDocketId, updates\)/,
  "canonical attachment still uses the existing local-first update endpoint"
);
assert.match(
  app,
  /addDayProjectionSelection\(/,
  "Day View attachment still uses projection selection"
);

console.log("Add Existing discovery verification PASS");
