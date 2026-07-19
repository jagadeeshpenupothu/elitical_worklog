import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import { validateDocketOperation } from "../src/utils/docketOperationValidation.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-extended-updates-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const remoteStory = {
  id: "story-1",
  type: "story",
  title: "Story A",
  description: "Desc A",
  parentId: "epic-1",
  category: "MINOR",
  priority: "MINOR",
  storyPoints: 1,
  docketState: "Todo",
  sprint: "Sprint 1",
  elitical: {
    stateId: "state-1",
    assigneeId: "user-1",
    sprintId: "sprint-1",
  },
  sync: {
    status: "synced",
    remoteId: "story-1",
    remoteBaseline: {
      title: "Story A",
      description: "Desc A",
      dktStateId: "state-1",
      dktStateName: "Todo",
      assigneeId: "user-1",
      sprintId: "sprint-1",
      sprintName: "Sprint 1",
      category: "MINOR",
      priority: "MINOR",
      epicId: "epic-1",
      storyPointEst: 1,
    },
  },
};

async function singleUpdate(changes) {
  await queue.enqueueUpdate({
    item: {
      ...remoteStory,
      ...changes,
    },
    changes,
    baselineItem: remoteStory,
  });

  const loaded = await queue.load();
  const update = loaded.operations.find((operation) => operation.operation === "update");
  assert.ok(update, "Expected a pending update operation");
  return update;
}

let update = await singleUpdate({
  dktStateId: "state-2",
  dktStateName: "Design",
});
assert.deepEqual(update.changes, {
  dktStateId: "state-2",
  dktStateName: "Design",
});

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({ assigneeId: "user-2" });
assert.deepEqual(update.changes, { assigneeId: "user-2" });

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({
  sprintId: "sprint-2",
  sprintName: "Sprint 2",
  hasNoSprint: false,
});
assert.equal(update.changes.sprintId, "sprint-2");
assert.equal(update.changes.sprintName, "Sprint 2");
assert.equal(update.changes.hasNoSprint, false);
assert.equal(JSON.stringify(update.changes).includes("virtual-orphan-sprint"), false);

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({ category: "FEATURE" });
assert.deepEqual(update.changes, { category: "FEATURE" });

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({ priority: "MAJOR" });
assert.deepEqual(update.changes, { priority: "MAJOR" });

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({ epicId: "epic-2" });
assert.deepEqual(update.changes, { epicId: "epic-2" });

assert.match(
  validateDocketOperation({
    operation: "update",
    docket: remoteStory,
    changes: { epicId: "local-docket-epic" },
  }),
  /real canonical Epic ID/
);

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({ storyPointEst: 0 });
assert.deepEqual(update.changes, { storyPointEst: 0 });

assert.match(
  validateDocketOperation({
    operation: "update",
    docket: { ...remoteStory, type: "epic" },
    changes: { storyPointEst: 8 },
  }),
  /Only Story dockets/
);

await queue.write({ version: 1, operations: [], localToRemote: {}, updatedAt: new Date().toISOString() });
update = await singleUpdate({
  title: "Story B",
  dktStateId: "state-2",
  dktStateName: "Design",
  priority: "MAJOR",
  category: "FEATURE",
  assigneeId: "user-2",
});
assert.equal(
  (await queue.load()).operations.filter((operation) => operation.operation === "update").length,
  1
);

await queue.markUpdateFieldsSynced(update.operationId, {
  remoteId: "story-1",
  localId: "story-1",
  acceptedChanges: {
    title: "Story B",
    priority: "MAJOR",
  },
  error: new Error("Assignee failed"),
});
update = (await queue.load()).operations.find((operation) => operation.operationId === update.operationId);
assert.equal(update.status, "sync-failed");
assert.equal(Object.prototype.hasOwnProperty.call(update.changes, "title"), false);
assert.equal(Object.prototype.hasOwnProperty.call(update.changes, "priority"), false);
assert.equal(update.changes.assigneeId, "user-2");

await queue.enqueueUpdate({
  item: {
    ...remoteStory,
    priority: "MINOR",
  },
  changes: {
    priority: "MINOR",
  },
  baselineItem: remoteStory,
});
update = (await queue.load()).operations.find((operation) => operation.operationId === update.operationId);
assert.equal(Object.prototype.hasOwnProperty.call(update.changes, "priority"), false);

const localId = queue.localDocketId();
await queue.enqueueCreate({
  item: {
    id: localId,
    type: "story",
    title: "Local Story",
    description: "",
  },
  payload: {
    id: localId,
    type: "story",
    title: "Local Story",
    description: "",
  },
});
await queue.enqueueUpdate({
  item: {
    id: localId,
    type: "story",
    title: "Local Story",
    priority: "MAJOR",
    storyPoints: 3,
  },
  changes: {
    priority: "MAJOR",
    storyPointEst: 3,
  },
});
const create = (await queue.load()).operations.find((operation) => operation.operation === "create");
assert.equal(create.payload.priority, "MAJOR");
assert.equal(create.payload.storyPointEst, 3);

const clientSource = await fs.readFile(new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url), "utf8");
[
  "/api/1/Docket/state",
  "/api/1/Docket/assignee",
  "/api/1/Docket/sprint",
  "/api/1/Docket/category",
  "/api/1/Docket/priority",
  "/api/1/Docket/parent",
  "/api/1/Docket/storyPoints",
].forEach((endpoint) => {
  assert.ok(clientSource.includes(endpoint), `Missing SDK endpoint ${endpoint}`);
});
assert.match(clientSource, /nativeDocketUpdatePayload\(docketId, fields\)/);
assert.match(clientSource, /referrerPath: DOCKET_REFERRER_PATH/);

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(appSource, /function supportedUpdatePayloadForItem/);
assert.match(appSource, /const sdkUpdates = supportedUpdatePayloadForItem\(item, updates/);

console.log("Extended local-first update verification PASS");
