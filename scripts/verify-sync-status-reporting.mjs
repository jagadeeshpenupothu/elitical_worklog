import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSyncStatusPresentation,
  summarizeSyncOperation,
} from "../src/utils/syncStatusPresentation.js";

function op(overrides = {}) {
  return {
    operationId: `queue-${Math.random().toString(16).slice(2)}`,
    entityType: "docket",
    operation: "create",
    localId: `local-docket-${Math.random().toString(16).slice(2)}`,
    remoteId: "",
    payload: {
      title: "Untitled",
    },
    status: "pending-create",
    classification: {
      actionable: true,
      mutationActionable: true,
      reconciliationActionable: false,
      blocked: false,
      completed: false,
    },
    ...overrides,
  };
}

function model(operations, activity = { direction: "outbound", state: "failed", message: "Sync completed with failures." }) {
  return buildSyncStatusPresentation({
    activity,
    queueSummary: {
      actionableCount: operations.filter((operation) => operation.classification?.actionable).length,
      failedCount: operations.filter((operation) => operation.status === "sync-failed").length,
      blockedCount: operations.filter((operation) => operation.classification?.blocked || operation.status === "dependency-blocked").length,
      operations,
    },
    summary: {
      status: "Failed",
    },
    liveState: "failed",
  });
}

const failedDocket = op({
  operationId: "queue-failed-docket",
  entityType: "docket",
  docketType: "job",
  operation: "create",
  payload: {
    title: "Docket A",
  },
  status: "sync-failed",
  lastError: "Docket.form.descr.error",
});
const syncedWorklog = op({
  operationId: "queue-synced-worklog",
  entityType: "worklog",
  operation: "create",
  localId: "local-worklog-ok",
  remoteId: "remote-worklog-ok",
  payload: {
    comment: "Worklog B",
  },
  status: "synced",
  classification: {
    actionable: false,
    mutationActionable: false,
    reconciliationActionable: false,
    blocked: false,
    completed: true,
  },
});

let presentation = model([failedDocket, syncedWorklog]);
assert.equal(presentation.status, "Failed");
assert.equal(presentation.directionLabel, "Sync to Elitical");
assert.equal(presentation.failedOperations.length, 1);
assert.equal(presentation.failedOperations[0].title, "Docket A");
assert.equal(presentation.failedOperations[0].entityLabel, "Docket");
assert.equal(presentation.failedOperations[0].operationLabel, "Create");
assert.equal(presentation.failedOperations[0].error, "Docket.form.descr.error");
assert.equal(
  presentation.failedOperations.some((operation) => operation.title === "Worklog B"),
  false,
  "a synced Worklog must not be shown as a failed operation"
);

const parent = op({
  operationId: "queue-parent",
  localId: "local-docket-parent",
  payload: {
    title: "Blocked Parent",
  },
  status: "sync-failed",
  lastError: "HTTP 400",
});
const blockedWorklog = op({
  operationId: "queue-blocked-worklog",
  entityType: "worklog",
  operation: "create",
  localId: "local-worklog-blocked",
  docketId: "local-docket-parent",
  dependsOn: "local-docket-parent",
  payload: {
    comment: "Blocked child",
  },
  status: "dependency-blocked",
  lastError: "Worklog is waiting for its docket to sync to a real Elitical ID.",
  classification: {
    actionable: false,
    mutationActionable: false,
    reconciliationActionable: false,
    blocked: true,
    dependencyBlocked: true,
    completed: false,
  },
});

presentation = model([parent, blockedWorklog]);
assert.equal(presentation.failedOperations.length, 1);
assert.equal(presentation.blockedOperations.length, 1);
assert.equal(presentation.blockedOperations[0].entityLabel, "Worklog");
assert.equal(presentation.blockedOperations[0].operationLabel, "Create");
assert.equal(presentation.blockedOperations[0].reason, "Waiting for parent Docket to sync.");
assert.equal(presentation.blockedOperations[0].parentTitle, "Blocked Parent");

presentation = model([
  op({
    operationId: "queue-failed-1",
    payload: { title: "First Failure" },
    status: "sync-failed",
    lastError: "First failed",
  }),
  op({
    operationId: "queue-failed-2",
    entityType: "worklog",
    operation: "update",
    payload: { comment: "Second Failure" },
    status: "sync-failed",
    lastError: "Second failed",
  }),
  blockedWorklog,
]);
assert.equal(presentation.status, "Failed");
assert.equal(presentation.failedOperations.length, 2);
assert.equal(presentation.blockedOperations.length, 1);

presentation = buildSyncStatusPresentation({
  activity: {
    direction: "outbound",
    state: "synced",
    message: "Synced successfully.",
  },
  queueSummary: {
    actionableCount: 0,
    failedCount: 0,
    blockedCount: 0,
    operations: [syncedWorklog],
  },
  summary: {
    status: "Success",
  },
  liveState: "synced",
});
assert.equal(presentation.status, "Success");
assert.equal(presentation.failedOperations.length, 0);
assert.equal(presentation.blockedOperations.length, 0);

assert.equal(
  summarizeSyncOperation({
    entityType: "docket",
    operation: "create",
    payload: { title: "Secret safe" },
    status: "sync-failed",
    lastError: "authorization token leaked",
  }).error,
  "Hidden"
);

const realQueuePath = path.join(os.homedir(), "Elitical Worklog Data", "sync", "sync-queue.json");
if (fs.existsSync(realQueuePath)) {
  const realQueue = JSON.parse(fs.readFileSync(realQueuePath, "utf8"));
  const realPresentation = buildSyncStatusPresentation({
    activity: {
      direction: "outbound",
      state: "failed",
      message: "Sync completed with 1 failure.",
    },
    queueSummary: {
      operations: Array.isArray(realQueue.operations) ? realQueue.operations : [],
    },
    summary: {
      status: "Failed",
    },
    liveState: "failed",
  });
  const seshaFailure = realPresentation.failedOperations.find((operation) =>
    operation.title === "Sesha sir Visiting Cards"
  );
  const blocked = realPresentation.blockedOperations.find((operation) =>
    operation.operationId === "queue-bf372358-37ff-407d-aa6b-ead89b8d9a9f"
  );

  if (seshaFailure || blocked) {
    assert.equal(seshaFailure?.entityLabel, "Docket");
    assert.equal(seshaFailure?.operationLabel, "Create");
    assert.equal(blocked?.entityLabel, "Worklog");
    assert.equal(blocked?.operationLabel, "Create");
    assert.equal(
      realPresentation.failedOperations.some((operation) =>
        operation.title.includes("DES-696") || operation.docketId.includes("DES-696")
      ),
      false,
      "DES-696 must not be identified as a failed operation"
    );
  }
}

console.log("Sync status reporting verification passed.");
