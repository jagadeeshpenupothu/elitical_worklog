import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const queueSource = await fs.readFile(
  new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url),
  "utf8"
);
const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const localDataSource = await fs.readFile(
  new URL("../local-backend/services/LocalDataService.mjs", import.meta.url),
  "utf8"
);

assert.match(queueSource, /const ACTIONABILITY = \{/);
assert.match(queueSource, /MUTATION_ACTIONABLE: "mutation-actionable"/);
assert.match(queueSource, /RECONCILIATION_ACTIONABLE: "reconciliation-actionable"/);
assert.match(queueSource, /COMPLETED: "completed"/);
assert.match(queueSource, /BLOCKED: "blocked"/);
assert.match(queueSource, /function classifyOperation/);
assert.match(queueSource, /isAcceptedButUnconfirmed\(operation\)/);
assert.match(queueSource, /acceptedMutation === true && operation\.retryMutation === false/);
assert.match(queueSource, /actionableCount: actionable\.length/);
assert.match(queueSource, /mutationActionableCount: mutationActionable\.length/);
assert.match(queueSource, /reconciliationActionableCount: reconciliationActionable\.length/);
assert.match(queueSource, /pendingCount: actionable\.length/);
assert.match(queueSource, /operations,/);
assert.match(queueSource, /classification: classifyOperation\(operation, queue\)/);
assert.match(queueSource, /orderedPendingOperations\(queue\)/);
assert.match(queueSource, /const pending = processableOperations\(queue\)/);
assert.match(localDataSource, /syncQueue: queue \? await this\.syncQueueService\.summary\(\) : undefined/);
assert.match(serverSource, /const operationClassification = syncQueueService\.classifyOperation\(operation\)/);
assert.match(serverSource, /const createWasAlreadyAccepted = operationClassification\.reconciliationActionable/);
assert.match(appSource, /function normalizeSyncQueueSummary/);
assert.match(appSource, /summary\.actionableCount \?\? summary\.pendingCount/);
assert.match(appSource, /setSyncQueueSummary\(normalizeSyncQueueSummary\(result\.syncQueue\)\)/);
assert.match(appSource, /if \(!syncQueueSummary\.actionableCount\)/);
assert.match(appSource, /disabled=\{liveSyncState === "syncing" \|\| !syncQueueSummary\.actionableCount\}/);
assert.match(appSource, /onSyncToElitical=\{handleSyncToElitical\}/);
assert.match(appSource, /onClick=\{onSyncToElitical\}/);
assert.match(appSource, /aria-label="Sync to Elitical"/);
assert.match(appSource, /syncQueueSummary\.actionableCount \? \(/);
assert.match(appSource, /className="sync-action-count"/);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-queue-actionability-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });

const localDocketId = queue.localDocketId();
const localWorklogId = queue.localWorklogId();

await queue.enqueueCreate({
  item: {
    id: localDocketId,
    type: "job",
    title: "Queued job",
    description: "",
  },
  payload: {
    id: localDocketId,
    type: "job",
    title: "Queued job",
    parentId: "remote-story-1",
  },
});
await queue.enqueueWorklogCreate({
  worklog: {
    id: localWorklogId,
    docketId: "remote-job-1",
    comment: "accepted worklog",
    worklogDate: 1784140200000,
    hour: 1,
    min: 0,
  },
});

let loaded = await queue.load();
const worklogCreate = loaded.operations.find((operation) => operation.entityType === "worklog");

await queue.markOperationUnconfirmed(
  worklogCreate.operationId,
  new Error("Accepted mutation could not be reconciled.")
);

let summary = await queue.summary();
const docketSummary = summary.operations.find((operation) => operation.entityType === "docket");
const worklogSummary = summary.operations.find((operation) => operation.entityType === "worklog");

assert.equal(summary.actionableCount, 2);
assert.equal(summary.pendingCount, 2);
assert.equal(summary.mutationActionableCount, 1);
assert.equal(summary.reconciliationActionableCount, 1);
assert.equal(summary.retryablePendingCount, 1);
assert.equal(summary.unconfirmedCount, 1);
assert.equal(docketSummary.classification.actionability, "mutation-actionable");
assert.equal(worklogSummary.classification.actionability, "reconciliation-actionable");
assert.equal(worklogSummary.classification.mutationActionable, false);
assert.equal(worklogSummary.classification.reconciliationActionable, true);

await queue.markOperationSynced(docketSummary.operationId, {
  localId: localDocketId,
  remoteId: "remote-job-1",
});
await queue.markOperationSynced(worklogSummary.operationId, {
  localId: localWorklogId,
  remoteId: "remote-worklog-1",
});

summary = await queue.summary();
assert.equal(summary.actionableCount, 0);
assert.equal(summary.pendingCount, 0);
assert.equal(summary.mutationActionableCount, 0);
assert.equal(summary.reconciliationActionableCount, 0);
assert.equal(
  summary.operations.every((operation) => operation.classification.completed),
  true
);

console.log("Sync queue actionability verification PASS");
