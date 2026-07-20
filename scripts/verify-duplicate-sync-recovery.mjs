import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import { buildSyncStatusPresentation } from "../src/utils/syncStatusPresentation.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-duplicate-recovery-"));

function operation(overrides = {}) {
  return {
    operationId: overrides.operationId || crypto.randomUUID(),
    entityType: "docket",
    operation: "create",
    localId: "local-docket-parent",
    remoteId: "",
    docketType: "job",
    payload: {
      id: "local-docket-parent",
      title: "Duplicate Job",
    },
    changes: {},
    createdAt: "2026-07-19T13:13:57.799Z",
    updatedAt: "2026-07-19T13:13:57.799Z",
    status: "sync-failed",
    attempts: 1,
    lastError: "HTTP 400",
    ...overrides,
  };
}

const parent = operation({
  operationId: "parent-op",
});
const dependent = operation({
  operationId: "dependent-op",
  entityType: "worklog",
  operation: "create",
  localId: "local-worklog-child",
  docketType: "",
  docketId: "local-docket-parent",
  dependsOn: "local-docket-parent",
  payload: {
    id: "local-worklog-child",
    docketId: "local-docket-parent",
    comment: "Duplicate worklog",
    worklogDate: 1783987200000,
    hour: 1,
    min: 30,
  },
  status: "dependency-blocked",
  attempts: 0,
  lastError: "Waiting for parent",
});

const queue = new LocalSyncQueueService({ cacheDir: tempDir });
await queue.write({
  version: 1,
  operations: [parent, dependent],
  localToRemote: {},
});

const before = JSON.stringify(await queue.load());
const result = await queue.resolveDuplicateCreateWithDependent({
  parentOperationId: "parent-op",
  dependentOperationId: "dependent-op",
  replacementRemoteDocketId: "remote-docket-1",
  replacementDocketNumber: "DES-1",
  replacementRemoteWorklogId: "remote-worklog-1",
});

assert.equal(result.parentOperation.status, "superseded");
assert.equal(result.dependentOperation.status, "superseded");
assert.equal(result.parentOperation.retryMutation, false);
assert.equal(result.dependentOperation.retryMutation, false);
assert.equal(result.parentOperation.supersededByRemoteId, "remote-docket-1");
assert.equal(result.parentOperation.supersededByDocketNumber, "DES-1");
assert.equal(result.dependentOperation.supersededByRemoteId, "remote-worklog-1");
assert.equal(result.dependentOperation.supersededByDocketId, "remote-docket-1");
assert.equal(result.parentOperation.recovery.originalOperationId, "parent-op");
assert.equal(result.dependentOperation.recovery.originalOperationId, "dependent-op");
assert.equal(result.parentOperation.payload.title, "Duplicate Job");
assert.equal(result.dependentOperation.payload.comment, "Duplicate worklog");
assert.equal(result.parentOperation.attempts, 1);
assert.deepEqual((await queue.load()).localToRemote, {}, "recovery must not create a normal localToRemote mapping");

const summary = await queue.summary();
assert.equal(summary.actionableCount, 0);
assert.equal(summary.pendingCount, 0);
assert.equal(summary.mutationActionableCount, 0);
assert.equal(summary.reconciliationActionableCount, 0);
assert.equal(summary.failedCount, 0);
assert.equal(summary.blockedCount, 0);
assert.equal(summary.supersededCount, 2);
assert.equal(summary.operations.every((entry) => entry.classification.completed), true);

const restarted = new LocalSyncQueueService({ cacheDir: tempDir });
const restartedSummary = await restarted.summary();
assert.equal(restartedSummary.actionableCount, 0);
assert.equal(restartedSummary.failedCount, 0);
assert.equal(restartedSummary.blockedCount, 0);
assert.equal(restartedSummary.supersededCount, 2);
assert.equal(restartedSummary.operations.every((entry) => entry.status === "superseded"), true);

const presentation = buildSyncStatusPresentation({
  activity: {
    direction: "outbound",
    state: "synced",
    message: "Recovered locally.",
  },
  queueSummary: restartedSummary,
  summary: {
    status: "Success",
  },
  liveState: "synced",
});
assert.equal(presentation.failedOperations.length, 0);
assert.equal(presentation.blockedOperations.length, 0);

async function assertAtomicFailure(label, setup, request, messagePattern) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `elitical-${label}-`));
  const service = new LocalSyncQueueService({ cacheDir: dir });
  const initialQueue = {
    version: 1,
    operations: setup,
    localToRemote: {},
  };

  await service.write(initialQueue);
  const snapshot = JSON.stringify(await service.load());

  await assert.rejects(
    () => service.resolveDuplicateCreateWithDependent(request),
    messagePattern
  );
  assert.equal(JSON.stringify(await service.load()), snapshot, `${label} must not partially modify the queue`);
}

await assertAtomicFailure(
  "bad-parent-id",
  [parent, dependent],
  {
    parentOperationId: "missing",
    dependentOperationId: "dependent-op",
    replacementRemoteDocketId: "remote-docket-1",
    replacementDocketNumber: "DES-1",
    replacementRemoteWorklogId: "remote-worklog-1",
  },
  /Parent operation was not found/
);
await assertAtomicFailure(
  "bad-dependent-id",
  [parent, dependent],
  {
    parentOperationId: "parent-op",
    dependentOperationId: "missing",
    replacementRemoteDocketId: "remote-docket-1",
    replacementDocketNumber: "DES-1",
    replacementRemoteWorklogId: "remote-worklog-1",
  },
  /Dependent operation was not found/
);
await assertAtomicFailure(
  "wrong-dependent-parent",
  [
    parent,
    {
      ...dependent,
      dependsOn: "local-docket-other",
    },
  ],
  {
    parentOperationId: "parent-op",
    dependentOperationId: "dependent-op",
    replacementRemoteDocketId: "remote-docket-1",
    replacementDocketNumber: "DES-1",
    replacementRemoteWorklogId: "remote-worklog-1",
  },
  /does not depend/
);

const serverSource = await fs.readFile("local-backend/server.mjs", "utf8");
assert.match(serverSource, /\/api\/local\/sync\/recovery\/resolve-duplicate/);
assert.match(serverSource, /body\.previewOnly/);
assert.match(serverSource, /Replacement Docket was not found in the local cache/);
assert.match(serverSource, /Replacement Worklog was not found in the local cache/);
assert.match(serverSource, /validateDuplicateRecoveryRequest/);

console.log("Duplicate sync recovery verification passed.");
