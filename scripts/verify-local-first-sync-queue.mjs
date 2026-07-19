import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import { validateDocketOperation } from "../src/utils/docketOperationValidation.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-local-first-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });

const realEpic = {
  id: "remote-epic-1",
  type: "epic",
  title: "Remote Epic",
  parentId: "storyRoot",
  sync: {
    status: "synced",
    remoteId: "remote-epic-1",
  },
};
const remoteJob = {
  id: "remote-job-1",
  type: "job",
  title: "Job A",
  description: "",
  parentId: "remote-story-1",
  sync: {
    status: "synced",
    remoteId: "remote-job-1",
  },
};

assert.equal(
  validateDocketOperation({
    operation: "create",
    payload: {
      type: "story",
      title: "Story under real Epic",
      parentId: realEpic.id,
    },
    workItems: [realEpic],
  }),
  ""
);

const localEpic = {
  id: queue.localDocketId(),
  type: "epic",
  title: "Local Epic",
  parentId: "storyRoot",
};
const localStory = {
  id: queue.localDocketId(),
  type: "story",
  title: "Local Story",
  parentId: localEpic.id,
};
const localJob = {
  id: queue.localDocketId(),
  type: "job",
  title: "Local Job",
  parentId: localStory.id,
};
const localTask = {
  id: queue.localDocketId(),
  type: "task",
  title: "Local Task",
  parentId: localEpic.id,
};

await queue.enqueueCreate({ item: localEpic, payload: localEpic });
await queue.enqueueCreate({ item: localStory, payload: localStory });
await queue.enqueueCreate({ item: localJob, payload: localJob });
await queue.enqueueCreate({ item: localTask, payload: localTask });

let loaded = await queue.load();
let ordered = queue.orderedPendingOperations(loaded);
assert.deepEqual(
  ordered.map((operation) => operation.localId),
  [localEpic.id, localStory.id, localTask.id, localJob.id]
);

await queue.enqueueUpdate({
  item: remoteJob,
  changes: {
    title: "Job B",
  },
});
await queue.enqueueUpdate({
  item: {
    ...remoteJob,
    title: "Job B",
  },
  changes: {
    title: "Job C",
  },
});
await queue.enqueueUpdate({
  item: {
    ...remoteJob,
    title: "Job C",
  },
  changes: {
    title: "Final Job",
  },
});

loaded = await queue.load();
const jobUpdates = loaded.operations.filter(
  (operation) => operation.operation === "update" && operation.localId === remoteJob.id
);
assert.equal(jobUpdates.length, 1);
assert.equal(jobUpdates[0].changes.title, "Final Job");

await queue.enqueueUpdate({
  item: {
    ...remoteJob,
    description: "",
  },
  changes: {
    description: "Final description",
  },
});
loaded = await queue.load();
const coalescedJobUpdate = loaded.operations.find(
  (operation) => operation.operation === "update" && operation.localId === remoteJob.id
);
assert.deepEqual(coalescedJobUpdate.changes, {
  title: "Final Job",
  description: "Final description",
});

await queue.enqueueUpdate({
  item: localStory,
  changes: {
    title: "Final Local Story",
    description: "Local story description",
  },
});
loaded = await queue.load();
const localStoryCreates = loaded.operations.filter(
  (operation) => operation.operation === "create" && operation.localId === localStory.id
);
const localStoryUpdates = loaded.operations.filter(
  (operation) => operation.operation === "update" && operation.localId === localStory.id
);
assert.equal(localStoryCreates.length, 1);
assert.equal(localStoryUpdates.length, 0);
assert.equal(localStoryCreates[0].payload.title, "Final Local Story");
assert.equal(localStoryCreates[0].payload.description, "Local story description");

const graph = {
  appState: {
    sprints: [],
    workItems: [
      {
        ...remoteJob,
        title: "Remote Job",
      },
    ],
  },
  epics: [],
  stories: [],
  tasks: [],
  jobs: [
    {
      ...remoteJob,
      title: "Remote Job",
    },
  ],
};
const overlaid = queue.applyPendingToGraph(graph, loaded);
const overlaidJob = overlaid.appState.workItems.find((item) => item.id === remoteJob.id);

assert.equal(overlaidJob.title, "Final Job");
assert.equal(overlaidJob.description, "Final description");
assert.equal(overlaidJob.sync.status, "pending-update");
assert.equal(overlaidJob.sync.remoteBaseline.title, "Job A");

await queue.markOperationSynced(coalescedJobUpdate.operationId, {
  localId: remoteJob.id,
  remoteId: remoteJob.id,
});
await queue.markOperationFailed(localStoryCreates[0].operationId, new Error("simulated failure"));
loaded = await queue.load();
assert.equal(
  loaded.operations.find((operation) => operation.operationId === coalescedJobUpdate.operationId).status,
  "synced"
);
assert.equal(
  loaded.operations.find((operation) => operation.operationId === localStoryCreates[0].operationId).status,
  "sync-failed"
);

await queue.markOperationUnconfirmed(localTask.id, new Error("wrong id should be ignored"));
const localTaskCreate = loaded.operations.find(
  (operation) => operation.operation === "create" && operation.localId === localTask.id
);
await queue.markOperationUnconfirmed(localTaskCreate.operationId, new Error("accepted but unmatched"));
loaded = await queue.load();
let summary = await queue.summary();
assert.equal(
  loaded.operations.find((operation) => operation.operationId === localTaskCreate.operationId).status,
  "sync-unconfirmed"
);
assert.equal(summary.actionableCount, summary.pendingCount);
assert.equal(summary.reconciliationActionableCount, 1);
assert.equal(summary.unconfirmedCount, 1);
assert.equal(summary.operations.find(
  (operation) => operation.operationId === localTaskCreate.operationId
).classification.actionability, "reconciliation-actionable");
assert.equal(
  queue.orderedPendingOperations(loaded).some((operation) => operation.operationId === localTaskCreate.operationId),
  true,
  "Accepted-but-unconfirmed create operations must remain actionable for read-only recovery."
);
assert.equal(
  loaded.operations.find((operation) => operation.operationId === localTaskCreate.operationId).retryMutation,
  false,
  "Accepted-but-unconfirmed create operations must not be retried as Create mutations."
);

assert.equal(
  validateDocketOperation({
    operation: "create",
    payload: {
      type: "story",
      title: "Bad Story",
      parentId: "virtual-orphan-sprint",
      sprintId: "virtual-orphan-sprint",
    },
    workItems: [],
  }),
  "Orphan Sprint is render-only and cannot be persisted."
);

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.equal(
  appSource.includes("loadEliticalLookups"),
  false,
  "Normal create/edit UI must not call live Elitical lookups."
);

console.log("Local-first sync queue simulation PASS");
