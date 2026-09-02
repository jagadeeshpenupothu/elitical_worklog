import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import {
  childDocketStateForCreate,
  normalizeDocketState,
} from "../src/utils/docketStates.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";
import { ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = readFileSync("src/App.jsx", "utf8");
const graphViewSource = readFileSync("src/views/GraphView.jsx", "utf8");
const serverSource = readFileSync("local-backend/server.mjs", "utf8");
const sprintId = `sprint-${crypto.randomUUID()}`;
const existingEpicId = `epic-${crypto.randomUUID()}`;
const otherEpicId = `epic-${crypto.randomUUID()}`;
const existingStoryId = `story-${crypto.randomUUID()}`;
const createdStoryAId = `story-${crypto.randomUUID()}`;
const createdStoryBId = `story-${crypto.randomUUID()}`;
const createdOtherStoryId = `story-${crypto.randomUUID()}`;
const scopedStoryId = `story-${crypto.randomUUID()}`;

assert.equal(
  childDocketStateForCreate("artifact"),
  "concept",
  "new children under Artifact parents start open so the graph does not collapse them"
);
assert.equal(
  childDocketStateForCreate("closed"),
  "concept",
  "new children under Closed parents start open so the graph does not collapse them"
);
assert.equal(
  childDocketStateForCreate("design"),
  "design",
  "new children still inherit ordinary open parent states"
);

assert.match(
  appSource,
  /import \{[\s\S]*childDocketStateForCreate[\s\S]*\} from "\.\/utils\/docketStates";/,
  "App uses the shared create-state helper"
);
assert.match(
  appSource,
  /function inheritedCreateDocketState\([\s\S]*childDocketStateForCreate\(/,
  "create modals normalize inherited parent state through the create-state helper"
);
assert.match(
  appSource,
  /const fallbackDocketState = inheritedCreateDocketState\(/,
  "Add-child flow uses the create-safe inherited state"
);
assert.match(
  graphViewSource,
  /function childCreateContextForItem\([\s\S]*item\.targetSprintId[\s\S]*item\.targetScopeId[\s\S]*hierarchyScopeIdForItem\(item\)/,
  "Graph item nodes derive Add Story sprint context from their rendered projection scope"
);
assert.match(
  graphViewSource,
  /\.\.\.childCreateContext,/,
  "React Flow node data includes the derived child-create context"
);
assert.match(
  serverSource,
  /type === "epic" \? "" : parent\?\.elitical\?\.sprintId[\s\S]*type === "epic" \? "" : parent\?\.sprintId/,
  "backend canonical local create inherits missing child sprint scope from the parent"
);
assert.match(
  serverSource,
  /const canonicalCreatePayload = \{[\s\S]*sprintId: records\.appItem\.elitical\?\.sprintId/,
  "sync queue create payload uses the canonical local child sprint scope"
);

const existingEpic = {
  id: existingEpicId,
  sourceId: existingEpicId,
  sourceDocketId: existingEpicId,
  type: "epic",
  title: "Existing Epic",
  parentId: ROOT_ID,
  docketState: "artifact",
  sprintId,
  sprint: "Sprint",
};
const existingStory = {
  id: existingStoryId,
  sourceId: existingStoryId,
  sourceDocketId: existingStoryId,
  type: "story",
  title: "Existing Story",
  parentId: existingEpic.id,
  docketState: "design",
  sprintId,
  sprint: "Sprint",
  elitical: {
    epicId: existingEpic.id,
    sprintId,
  },
};
const otherEpic = {
  id: otherEpicId,
  sourceId: otherEpicId,
  sourceDocketId: otherEpicId,
  type: "epic",
  title: "Other Existing Epic",
  parentId: ROOT_ID,
  docketState: "closed",
  sprintId,
  sprint: "Sprint",
};
const createdStoryA = {
  id: createdStoryAId,
  sourceId: createdStoryAId,
  sourceDocketId: createdStoryAId,
  type: "story",
  title: "Newly Created Story A",
  parentId: existingEpic.id,
  docketState: childDocketStateForCreate(existingEpic.docketState),
  sprintId,
  sprint: "Sprint",
  elitical: {
    epicId: existingEpic.id,
    sprintId,
  },
};
const createdStoryB = {
  ...createdStoryA,
  id: createdStoryBId,
  sourceId: createdStoryBId,
  sourceDocketId: createdStoryBId,
  title: "Newly Created Story B",
};
const createdStoryForOtherEpic = {
  ...createdStoryA,
  id: createdOtherStoryId,
  sourceId: createdOtherStoryId,
  sourceDocketId: createdOtherStoryId,
  title: "Newly Created Story For Other Epic",
  parentId: otherEpic.id,
  docketState: childDocketStateForCreate(otherEpic.docketState),
  elitical: {
    epicId: otherEpic.id,
    sprintId,
  },
};

assert.equal(
  normalizeDocketState(createdStoryA.docketState),
  "concept",
  "created story is locally inserted as an open child item"
);
assert.equal(
  createdStoryA.parentId,
  existingStory.parentId,
  "created story uses the same local parent Epic id as existing visible stories"
);

const localItems = [
  existingEpic,
  otherEpic,
  existingStory,
  createdStoryA,
  createdStoryB,
  createdStoryForOtherEpic,
];
const projected = buildProjectedHierarchy({
  items: localItems,
  allItems: localItems,
  scopes: [{ id: sprintId, title: "Sprint" }],
}).items;
const projectedCreatedStories = projected.filter((item) => item.id === createdStoryA.id);

assert.equal(
  projectedCreatedStories.length,
  1,
  "created story is projected as a single graph item"
);
assert.equal(
  projectedCreatedStories[0].parentId,
  existingEpic.id,
  "created story remains under the existing Epic after hierarchy projection"
);
assert.equal(
  projected.filter((item) => item.parentId === existingEpic.id && item.type === "story").length,
  3,
  "existing and multiple newly created stories are all visible under the Epic"
);
assert.equal(
  projected.filter((item) => item.parentId === otherEpic.id && item.type === "story").length,
  1,
  "newly created story under a different Epic projects under that Epic"
);
assert.equal(
  new Set(projected.map((item) => item.id)).size,
  projected.length,
  "graph projection does not create duplicate Story nodes"
);

const scopedEpic = {
  ...existingEpic,
  targetScopeId: sprintId,
  targetSprintId: sprintId,
};
const scopedCreatedStory = {
  ...createdStoryA,
  id: scopedStoryId,
  sourceId: scopedStoryId,
  sourceDocketId: scopedStoryId,
  title: "Newly Created Story From Scoped Epic",
  sprintId,
  elitical: {
    ...createdStoryA.elitical,
    sprintId,
  },
};
const scopedProjection = buildProjectedHierarchy({
  items: [scopedEpic, scopedCreatedStory],
  allItems: [existingEpic, scopedCreatedStory],
  scopes: [{ id: sprintId, title: "Sprint" }],
}).items;
const scopedProjectedStory = scopedProjection.find((item) => item.id === scopedCreatedStory.id);

assert.equal(
  scopedProjectedStory?.parentId,
  scopedEpic.id,
  "story created from a scoped Epic remains under that rendered Epic scope"
);
assert.equal(
  scopedProjectedStory?.targetSprintId,
  sprintId,
  "story created from a scoped Epic carries the same sprint scope into graph projection"
);

console.log("Existing Epic story create visibility verification PASS");
