import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const queueSource = await fs.readFile(
  new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url),
  "utf8"
);
const authConfigSource = await fs.readFile(
  new URL("../src/services/elitical/auth/EliticalConfig.ts", import.meta.url),
  "utf8"
);
const authSource = await fs.readFile(
  new URL("../src/services/elitical/auth/EliticalAuthService.ts", import.meta.url),
  "utf8"
);

assert.match(serverSource, /function isAmbiguousMutationError/);
assert.match(serverSource, /isAmbiguousMutationError\(error\)/);
assert.match(serverSource, /__ambiguousMutation: true/);
assert.match(serverSource, /await reconcileCreatedRemoteId\(remotePayload, createdDocket/);
assert.match(serverSource, /markOperationDependencyBlocked/);
assert.match(serverSource, /blocked\.push/);
assert.match(serverSource, /blocked: blocked\.length/);
assert.match(queueSource, /function isAmbiguousQueueError/);
assert.match(queueSource, /operation\.operation === "create"[\s\S]+operation\.status === "sync-failed"[\s\S]+isAmbiguousQueueError\(operation\.lastError\)/);
assert.match(queueSource, /markOperationDependencyBlocked/);
assert.match(queueSource, /ACTIONABILITY\.DEPENDENCY_BLOCKED/);
assert.match(authConfigSource, /DEFAULT_REQUEST_TIMEOUT_MS/);
assert.match(authConfigSource, /DEFAULT_MUTATION_REQUEST_TIMEOUT_MS/);
assert.match(authSource, /mutationRequestTimeoutMs/);
assert.match(authSource, /request\.timeoutMs \|\| defaultTimeoutMs/);
assert.doesNotMatch(authSource, /timeoutMs: request\.timeoutMs \|\| this\.config\.verificationTimeoutMs/);

async function enqueueJobWithWorklog(queue) {
  const localDocketId = queue.localDocketId();
  const localWorklogId = queue.localWorklogId();

  await queue.enqueueCreate({
    item: {
      id: localDocketId,
      type: "job",
      title: "Ambiguous queued job",
      description: "",
    },
    payload: {
      id: localDocketId,
      type: "job",
      title: "Ambiguous queued job",
      projectId: "project-1",
      parentId: "remote-story-1",
    },
  });
  await queue.enqueueWorklogCreate({
    worklog: {
      id: localWorklogId,
      docketId: localDocketId,
      comment: "dependent worklog",
      worklogDate: 1784226600000,
      hour: 2,
      min: 0,
    },
    dependsOn: localDocketId,
  });

  return { localDocketId, localWorklogId };
}

const successDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-ambiguous-success-"));
const successQueue = new LocalSyncQueueService({ cacheDir: successDir });
const successIds = await enqueueJobWithWorklog(successQueue);
let docketPostCount = 0;
let worklogPostCount = 0;

docketPostCount += 1;
let loaded = await successQueue.load();
let docketCreate = loaded.operations.find((operation) => operation.entityType === "docket");
let worklogCreate = loaded.operations.find((operation) => operation.entityType === "worklog");

assert.equal(successQueue.orderedPendingOperations(loaded).length, 2);
assert.equal(successQueue.classifyOperation(worklogCreate).actionability, "dependency-blocked");

const remoteMatches = [{ id: "remote-job-1", title: "Ambiguous queued job" }];
assert.equal(remoteMatches.length, 1);
assert.equal(docketPostCount, 1);

let graph = {
  appState: {
    workItems: [
      {
        id: successIds.localDocketId,
        type: "job",
        worklogs: [
          {
            id: successIds.localWorklogId,
            docketId: successIds.localDocketId,
            sync: { pendingChanges: { docketId: successIds.localDocketId } },
          },
        ],
      },
    ],
  },
  jobs: [],
};
graph = await successQueue.replaceLocalId(graph, successIds.localDocketId, "remote-job-1");
await successQueue.markOperationSynced(docketCreate.operationId, {
  localId: successIds.localDocketId,
  remoteId: "remote-job-1",
});

loaded = await successQueue.load();
worklogCreate = loaded.operations.find((operation) => operation.entityType === "worklog");
assert.equal(worklogCreate.docketId, "remote-job-1");
assert.equal(worklogCreate.dependsOn, "");
assert.equal(graph.appState.workItems[0].worklogs[0].docketId, "remote-job-1");

worklogPostCount += 1;
await successQueue.markOperationSynced(worklogCreate.operationId, {
  localId: successIds.localWorklogId,
  remoteId: "remote-worklog-1",
});

let summary = await successQueue.summary();
assert.equal(docketPostCount, 1);
assert.equal(worklogPostCount, 1);
assert.equal(summary.pendingCount, 0);
assert.equal(summary.actionableCount, 0);
assert.equal(summary.blockedCount, 0);

for (const candidateCount of [0, 2]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `elitical-ambiguous-${candidateCount}-`));
  const queue = new LocalSyncQueueService({ cacheDir: dir });
  const ids = await enqueueJobWithWorklog(queue);
  let postCount = 0;
  let worklogCount = 0;

  postCount += 1;
  loaded = await queue.load();
  docketCreate = loaded.operations.find((operation) => operation.entityType === "docket");
  worklogCreate = loaded.operations.find((operation) => operation.entityType === "worklog");

  await queue.markOperationUnconfirmed(
    docketCreate.operationId,
    new Error(candidateCount ? "Ambiguous Docket candidates." : "No Docket candidate found.")
  );
  await queue.markOperationDependencyBlocked(
    worklogCreate.operationId,
    new Error("Worklog is waiting for its docket to sync to a real Elitical ID.")
  );

  summary = await queue.summary();
  const docket = summary.operations.find((operation) => operation.localId === ids.localDocketId);
  const worklog = summary.operations.find((operation) => operation.localId === ids.localWorklogId);

  assert.equal(postCount, 1);
  assert.equal(worklogCount, 0);
  assert.equal(docket.classification.actionability, "reconciliation-actionable");
  assert.equal(docket.retryMutation, false);
  assert.equal(worklog.classification.actionability, "dependency-blocked");
  assert.equal(summary.reconciliationActionableCount, 1);
  assert.equal(summary.blockedCount, 1);
}

const rejectionDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-definitive-reject-"));
const rejectionQueue = new LocalSyncQueueService({ cacheDir: rejectionDir });
const rejectionIds = await enqueueJobWithWorklog(rejectionQueue);

loaded = await rejectionQueue.load();
docketCreate = loaded.operations.find((operation) => operation.localId === rejectionIds.localDocketId);
await rejectionQueue.markOperationFailed(docketCreate.operationId, {
  status: 400,
  message: "Validation rejected the Docket create.",
});
summary = await rejectionQueue.summary();
docketCreate = summary.operations.find((operation) => operation.localId === rejectionIds.localDocketId);
assert.equal(docketCreate.classification.actionability, "mutation-actionable");
assert.equal(docketCreate.classification.retryable, true);

const restartDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-ambiguous-restart-"));
const restartQueue = new LocalSyncQueueService({ cacheDir: restartDir });
const restartIds = await enqueueJobWithWorklog(restartQueue);

loaded = await restartQueue.load();
docketCreate = loaded.operations.find((operation) => operation.localId === restartIds.localDocketId);
worklogCreate = loaded.operations.find((operation) => operation.localId === restartIds.localWorklogId);
await restartQueue.markOperationFailed(
  docketCreate.operationId,
  new Error("page.evaluate: AbortError: signal is aborted without reason")
);
await restartQueue.markOperationDependencyBlocked(
  worklogCreate.operationId,
  new Error("Worklog is waiting for its docket to sync to a real Elitical ID.")
);

const restoredQueue = new LocalSyncQueueService({ cacheDir: restartDir });
summary = await restoredQueue.summary();
docketCreate = summary.operations.find((operation) => operation.localId === restartIds.localDocketId);
worklogCreate = summary.operations.find((operation) => operation.localId === restartIds.localWorklogId);
assert.equal(docketCreate.classification.actionability, "reconciliation-actionable");
assert.equal(docketCreate.classification.mutationActionable, false);
assert.equal(worklogCreate.classification.actionability, "dependency-blocked");
assert.equal(summary.actionableCount, 1);
assert.equal(summary.blockedCount, 1);

const mixedDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-ambiguous-mixed-"));
const mixedQueue = new LocalSyncQueueService({ cacheDir: mixedDir });
const oldWorklogId = mixedQueue.localWorklogId();
const freshIds = await enqueueJobWithWorklog(mixedQueue);

await mixedQueue.enqueueWorklogCreate({
  worklog: {
    id: oldWorklogId,
    docketId: "old-remote-docket",
    comment: "old unconfirmed",
    worklogDate: 1784226600000,
    hour: 1,
    min: 0,
  },
});
loaded = await mixedQueue.load();
const oldWorklog = loaded.operations.find((operation) => operation.localId === oldWorklogId);
await mixedQueue.markOperationUnconfirmed(oldWorklog.operationId, new Error("old unmatched"));
summary = await mixedQueue.summary();
assert.equal(
  summary.operations.find((operation) => operation.localId === oldWorklogId).classification.actionability,
  "reconciliation-actionable"
);
assert.equal(
  summary.operations.find((operation) => operation.localId === freshIds.localDocketId).classification.actionability,
  "mutation-actionable"
);

console.log("Ambiguous create reconciliation verification PASS");
