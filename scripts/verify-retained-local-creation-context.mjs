import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addRetainedCreationContext,
  clearRetainedCreationContexts,
  removeRetainedCreationContexts,
  retainedNodeIdsForContext,
} from "../src/utils/retainedCreationContext.js";
import { ORPHAN_SPRINT_ID } from "../src/utils/dayViewProjection.js";
import { buildProjectedHierarchy } from "../src/utils/hierarchyProjection.js";
import { calculateStoryPoints, ROOT_ID } from "../src/utils/worklogModel.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const sprint = {
  id: "sprint-a",
  title: "Sprint A",
  sprintStartDate: "2026-07-01T00:00:00.000Z",
  sprintEndDate: "2026-07-31T23:59:59.999Z",
};
const epic = {
  id: "epic-a",
  type: "epic",
  title: "Epic A",
  parentId: ROOT_ID,
  sprintId: "sprint-a",
  sprint: "Sprint A",
  sync: { status: "pending-create" },
};
const story = {
  id: "local-story-a",
  type: "story",
  title: "Story A",
  parentId: "epic-a",
  sprintId: "sprint-a",
  sprint: "Sprint A",
  sync: { status: "pending-create" },
};
const job = {
  id: "local-job-a",
  type: "job",
  title: "Job A",
  parentId: "local-story-a",
  sprintId: "sprint-a",
  sprint: "Sprint A",
  sync: { status: "pending-create" },
};

let retained = addRetainedCreationContext({
  state: null,
  viewMode: "day",
  contextId: "2026-07-19",
  nodeId: story.id,
  parentId: epic.id,
  sprintId: sprint.id,
});

assert.deepEqual(
  retainedNodeIdsForContext({
    state: retained,
    viewMode: "day",
    contextId: "2026-07-19T12:00:00.000Z",
  }),
  [story.id],
  "retained local Story is scoped by Day View date"
);

const projectedStory = buildProjectedHierarchy({
  items: [story],
  allItems: [epic, story],
  scopes: [sprint],
}).items;

assert.equal(
  projectedStory.filter((item) => item.id === story.id).length,
  1,
  "retained Story remains one canonical node"
);
assert.equal(
  projectedStory.some((item) => item.sourceItemId === epic.id && item.isReference),
  true,
  "missing visible ancestor can be projected without cloning the retained Story"
);

retained = addRetainedCreationContext({
  state: retained,
  viewMode: "day",
  contextId: "2026-07-19",
  nodeId: epic.id,
  sprintId: sprint.id,
});
retained = addRetainedCreationContext({
  state: retained,
  viewMode: "day",
  contextId: "2026-07-19",
  nodeId: job.id,
  parentId: story.id,
  sprintId: sprint.id,
});

const projectedChain = buildProjectedHierarchy({
  items: [epic, story, job],
  allItems: [epic, story, job],
  scopes: [sprint],
}).items;

assert.equal(projectedChain.filter((item) => item.id === epic.id).length, 1);
assert.equal(projectedChain.filter((item) => item.id === story.id).length, 1);
assert.equal(projectedChain.filter((item) => item.id === job.id).length, 1);
assert.equal(projectedChain.find((item) => item.id === story.id)?.parentId, epic.id);
assert.equal(projectedChain.find((item) => item.id === job.id)?.parentId, story.id);

const jobWithWorklog = {
  ...job,
  worklogs: [
    {
      id: "local-worklog-a",
      docketId: job.id,
      date: "2026-07-19",
      worklogDate: "2026-07-19",
      hour: 2,
      min: 30,
      timeMinutes: 150,
      sync: { status: "pending-create" },
    },
  ],
};
const totals = calculateStoryPoints([epic, story, jobWithWorklog], {
  sprints: [sprint],
});

assert.equal(totals.timeById[job.id], 150, "retained Job uses existing worklog aggregation");
assert.equal(totals.timeById[story.id], 150, "retained Story rolls up retained Job worklog time");

assert.deepEqual(
  retainedNodeIdsForContext({
    state: retained,
    viewMode: "day",
    contextId: "2026-07-20",
  }),
  [],
  "retained nodes do not leak to another Day View date"
);
assert.deepEqual(
  retainedNodeIdsForContext({
    state: retained,
    viewMode: "day",
    contextId: "2026-07-19",
  }).sort(),
  [epic.id, job.id, story.id].sort(),
  "retained chain is visible again when returning to the same date"
);

const cleared = clearRetainedCreationContexts();
assert.deepEqual(
  retainedNodeIdsForContext({
    state: cleared,
    viewMode: "day",
    contextId: "2026-07-19",
  }),
  [],
  "successful sync boundaries can clear retained context"
);

const afterFailedSync = retained;
assert.deepEqual(
  retainedNodeIdsForContext({
    state: afterFailedSync,
    viewMode: "day",
    contextId: "2026-07-19",
  }).sort(),
  [epic.id, job.id, story.id].sort(),
  "failed sync leaves retained context intact"
);

const afterDelete = removeRetainedCreationContexts(retained, [story.id, job.id]);
assert.deepEqual(
  retainedNodeIdsForContext({
    state: afterDelete,
    viewMode: "day",
    contextId: "2026-07-19",
  }),
  [epic.id],
  "delete cleanup prunes retained pointers for deleted local nodes"
);

const orphanRetained = addRetainedCreationContext({
  state: null,
  viewMode: "day",
  contextId: "2026-08-01",
  nodeId: "local-orphan-epic",
  sprintId: ORPHAN_SPRINT_ID,
});

assert.deepEqual(
  retainedNodeIdsForContext({
    state: orphanRetained,
    viewMode: "day",
    contextId: "2026-08-01",
  }),
  ["local-orphan-epic"],
  "orphan sprint retained context uses the same local pointer model"
);

assert.match(
  appSource,
  /const \[retainedCreationContexts, setRetainedCreationContexts\] = useState/,
  "App owns retained local creation context as UI/projection state"
);
assert.match(
  appSource,
  /retainedNodeIdsForContext\(\{[\s\S]*viewMode: "day"[\s\S]*contextId: selectedDate/,
  "Day View composes retained IDs into context graph selection"
);
assert.match(
  appSource,
  /if \(viewMode === "day" && createdId\) \{[\s\S]*addRetainedCreationContext/,
  "newly created Day View dockets are retained automatically"
);
assert.match(
  appSource,
  /if \(!result\.syncSummary\?\.failed\) \{[\s\S]*clearRetainedCreationContextState\(\)/,
  "successful outbound sync clears retained contexts"
);
assert.match(
  appSource,
  /catch \(error\) \{[\s\S]*setLiveSyncState\("failed"\)[\s\S]*setMessage\(errorMessage\);[\s\S]*\}/,
  "failed outbound sync path reports failure without clearing retained context"
);
assert.match(
  appSource,
  /removeRetainedCreationContexts\(current, result\.deletedIds\)/,
  "delete flow prunes retained node pointers"
);

console.log("Retained local creation context verification passed");
