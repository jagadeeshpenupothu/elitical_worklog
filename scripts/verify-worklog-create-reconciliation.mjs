import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import {
  selectUniqueWorklogReconciliationMatch,
  worklogDatesSemanticallyMatch,
  worklogMatchesForReconciliation,
} from "../src/services/elitical/worklogReconciliation.js";

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const clientSource = await fs.readFile(
  new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url),
  "utf8"
);

function extractFunction(source, name, { async = false } = {}) {
  const marker = `${async ? "async " : ""}function ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} must exist.`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

function extractClassMethod(source, name) {
  const marker = `  ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} method must exist.`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

const syncPendingToElitical = extractFunction(serverSource, "syncPendingToElitical", { async: true });
const reconcileWorklogCreate = extractFunction(serverSource, "reconcileWorklogCreate", { async: true });
const worklogMatchesOperation = extractFunction(serverSource, "worklogMatchesOperation");
const mergeSyncedWorklogIntoCache = extractFunction(serverSource, "mergeSyncedWorklogIntoCache", { async: true });
const markGraphWorklogSynced = extractFunction(serverSource, "markGraphWorklogSynced");
const clientCreateWorklog = extractClassMethod(clientSource, "async createWorklog");
const clientWorklogMatcher = extractClassMethod(clientSource, "private worklogMatchesPayload");

assert.match(clientSource, /function worklogIdFromPayload\(payload: unknown\): string/);
assert.match(clientSource, /function worklogRecordFromPayload\(payload: unknown\): Worklog \| null/);
assert.match(clientSource, /Array\.isArray\(payload\)/);
assert.match(clientCreateWorklog, /const createResponse = await this\.request\(\{/);
assert.match(clientCreateWorklog, /method: "POST",\s*path: "\/api\/1\/Worklog"/s);
assert.match(clientCreateWorklog, /const responseWorklog = worklogRecordFromPayload\(createResponse\.payload\)/);
assert.match(clientCreateWorklog, /const responseWorklogId = responseWorklog \? worklogId\(responseWorklog\) : ""/);
assert.match(clientCreateWorklog, /if \(responseWorklogId\)/);
assert.match(clientCreateWorklog, /__eliticalWorklogCreateConfirmed: true/);
assert.match(clientCreateWorklog, /__eliticalWorklogCreateConfirmationSource: "post-response"/);
assert.match(clientCreateWorklog, /const beforeIds = new Set\(\(await this\.getWorklogs\(docketId\)\)\.map\(worklogId\)\)/);
assert.match(clientCreateWorklog, /const after = await this\.getWorklogs\(docketId\)/);
assert.match(clientCreateWorklog, /const newWorklogs = after\.filter/);
assert.match(clientCreateWorklog, /return id && !beforeIds\.has\(id\)/);
assert.match(clientCreateWorklog, /selectUniqueWorklogReconciliationMatch\(/);
assert.match(clientCreateWorklog, /__eliticalWorklogCreateAccepted: true/);
assert.match(clientCreateWorklog, /__eliticalWorklogCreateConfirmationSource: "post-accepted-unmatched"/);
assert.match(clientWorklogMatcher, /worklogMatchesForReconciliation/);
assert.doesNotMatch(clientWorklogMatcher, /localDateKeyFromMillis/);

assert.match(serverSource, /function worklogDatesMatch/);
assert.match(serverSource, /function worklogDurationMinutes/);
assert.match(worklogMatchesOperation, /worklogMatchesForReconciliation/);
assert.match(worklogMatchesOperation, /docketId: firstString\(operation\.payload\?\.docketId, operation\.docketId\)/);
assert.match(reconcileWorklogCreate, /await provider\.getWorklogs\(remoteDocketId\)/);
assert.match(reconcileWorklogCreate, /selectUniqueWorklogReconciliationMatch/);
assert.match(syncPendingToElitical, /const operationClassification = syncQueueService\.classifyOperation\(operation\)/);
assert.match(syncPendingToElitical, /const createWasAlreadyAccepted = operationClassification\.reconciliationActionable/);
assert.match(syncPendingToElitical, /phase: createWasAlreadyAccepted \? "reconciliation" : "mutation"/);
assert.match(syncPendingToElitical, /let worklogCreateAmbiguousError = null/);
assert.match(syncPendingToElitical, /if \(createWasAlreadyAccepted\) \{\s*createdWorklog = await reconcileWorklogCreate\(provider, operation, remoteDocketId\);/s);
assert.match(syncPendingToElitical, /createdWorklog = await provider\.createWorklog\(worklogPayloadForRemote\(operation, remoteDocketId\)\)/);
assert.match(syncPendingToElitical, /if \(!isAmbiguousMutationError\(error\)\) throw error/);
assert.match(syncPendingToElitical, /if \(!remoteWorklogId && \(!createWasAlreadyAccepted \|\| worklogCreateAmbiguousError\)\)/);
assert.match(syncPendingToElitical, /createdWorklog = await reconcileWorklogCreate\(provider, operation, remoteDocketId\)/);
assert.match(syncPendingToElitical, /await mergeSyncedWorklogIntoCache\(/);
assert.match(syncPendingToElitical, /graph = markGraphWorklogSynced\(/);
assert.match(syncPendingToElitical, /await syncQueueService\.markOperationSynced\(operation\.operationId/);
assert.doesNotMatch(reconcileWorklogCreate, /provider\.createWorklog/);
assert.doesNotMatch(reconcileWorklogCreate, /syncService\.run/);
assert.match(mergeSyncedWorklogIntoCache, /await localData\.loadWorklogs\(\)/);
assert.match(mergeSyncedWorklogIntoCache, /await worklogService\.saveImportedWorklogs/);
assert.match(mergeSyncedWorklogIntoCache, /candidateId && candidateId === operation\.localId/);
assert.match(markGraphWorklogSynced, /id: remoteWorklogId \|\| entryId/);
assert.match(markGraphWorklogSynced, /remoteId: remoteWorklogId/);
assert.match(markGraphWorklogSynced, /: "synced"/);
assert.match(markGraphWorklogSynced, /pendingChanges: syncResult\.pendingChanges \|\| \{\}/);

function normalizedNumber(value) {
  if (value === undefined || value === null || value === "") return 0;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function durationMinutes(value = {}) {
  const total = normalizedNumber(value.timeMinutes ?? value.durationMinutes);

  return total || normalizedNumber(value.hour) * 60 + normalizedNumber(value.min);
}

assert.equal(durationMinutes({ hour: null, min: "0" }), durationMinutes({ hour: 0, min: 0 }));
assert.equal(durationMinutes({ hour: "2", min: "0" }), 120);
assert.equal(durationMinutes({ timeMinutes: "90" }), 90);

const exactExpected = {
  docketId: "remote-job-1",
  comment: "Completed exact work",
  worklogDate: 1784226600000,
  hour: 2,
  min: 0,
};
const exactRemote = {
  id: "remote-worklog-exact",
  docketId: "remote-job-1",
  comment: "Completed exact work",
  worklogDate: 1784226600000,
  hour: 2,
  min: 0,
};
const normalizedRemote = {
  ...exactRemote,
  id: "remote-worklog-normalized",
  worklogDate: 1784179800000,
};

assert.equal(worklogMatchesForReconciliation(exactRemote, exactExpected), true);
assert.equal(worklogDatesSemanticallyMatch(1784179800000, 1784226600000), true);
assert.equal(worklogMatchesForReconciliation(normalizedRemote, exactExpected), true);
assert.equal(
  worklogMatchesForReconciliation(
    {
      ...exactRemote,
      id: "remote-worklog-different-date",
      worklogDate: 1784093400000,
    },
    exactExpected
  ),
  false
);
assert.equal(
  worklogMatchesForReconciliation(
    {
      ...normalizedRemote,
      comment: "different comment",
    },
    exactExpected
  ),
  false
);
assert.equal(
  worklogMatchesForReconciliation(
    {
      ...normalizedRemote,
      hour: 1,
      min: 0,
    },
    exactExpected
  ),
  false
);
assert.equal(
  worklogMatchesForReconciliation(
    {
      ...normalizedRemote,
      docketId: "different-docket",
    },
    exactExpected
  ),
  false
);
assert.equal(
  selectUniqueWorklogReconciliationMatch([normalizedRemote], exactExpected)?.id,
  "remote-worklog-normalized"
);
assert.equal(
  selectUniqueWorklogReconciliationMatch(
    [
      normalizedRemote,
      {
        ...normalizedRemote,
        id: "second-strong-match",
      },
    ],
    exactExpected
  ),
  null
);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-worklog-reconcile-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const localDocketId = queue.localDocketId();
const localWorklogId = queue.localWorklogId();

await queue.enqueueCreate({
  item: {
    id: localDocketId,
    type: "job",
    title: "Fresh local job",
    description: "",
  },
  payload: {
    id: localDocketId,
    type: "job",
    title: "Fresh local job",
    parentId: "remote-story-1",
  },
});
await queue.enqueueWorklogCreate({
  worklog: {
    id: localWorklogId,
    docketId: localDocketId,
    comment: "Done correction of telugu text in front side of the Teja hospital cover page",
    worklogDate: 1784140200000,
    hour: "2",
    min: "0",
  },
  dependsOn: localDocketId,
});

let loaded = await queue.load();
let cleanPending = queue.orderedPendingOperations(loaded);
assert.equal(cleanPending.length, 2);
assert.deepEqual(
  cleanPending.map((operation) => `${operation.entityType}:${operation.operation}`),
  ["docket:create", "worklog:create"]
);
assert.equal(
  loaded.operations.filter((operation) => operation.operation === "update").length,
  0
);

let graph = {
  appState: {
    workItems: [
      {
        id: localDocketId,
        type: "job",
        worklogs: [
          {
            id: localWorklogId,
            docketId: localDocketId,
            sync: {
              pendingChanges: {
                docketId: localDocketId,
              },
            },
          },
        ],
      },
    ],
  },
  jobs: [
    {
      id: localDocketId,
      type: "JOB",
      worklogs: [
        {
          id: localWorklogId,
          docketId: localDocketId,
          sync: {
            pendingChanges: {
              docketId: localDocketId,
            },
          },
        },
      ],
    },
  ],
};
graph = await queue.replaceLocalId(graph, localDocketId, "remote-job-1");
loaded = await queue.load();
const dependentWorklog = loaded.operations.find((operation) => operation.entityType === "worklog");

assert.equal(dependentWorklog.docketId, "remote-job-1");
assert.equal(dependentWorklog.payload.docketId, "remote-job-1");
assert.equal(dependentWorklog.dependsOn, "");
assert.equal(graph.appState.workItems[0].worklogs[0].docketId, "remote-job-1");
assert.equal(graph.appState.workItems[0].worklogs[0].sync.pendingChanges.docketId, "remote-job-1");
assert.equal(graph.jobs[0].worklogs[0].docketId, "remote-job-1");

let operation = dependentWorklog;
const docketCreateOperation = loaded.operations.find((entry) => entry.entityType === "docket");

await queue.markOperationSynced(docketCreateOperation.operationId, {
  localId: localDocketId,
  remoteId: "remote-job-1",
});

await queue.markOperationUnconfirmed(
  operation.operationId,
  new Error("Created worklog was accepted but the remote Elitical worklog ID could not be reconciled.")
);

let summary = await queue.summary();
assert.equal(summary.pendingCount, 1);
assert.equal(summary.retryablePendingCount, 0);
assert.equal(summary.unconfirmedCount, 1);

loaded = await queue.load();
operation = loaded.operations.find((entry) => entry.entityType === "worklog");
assert.equal(operation.acceptedMutation, true);
assert.equal(operation.retryMutation, false);
assert.equal(queue.orderedPendingOperations(loaded)[0].operationId, operation.operationId);

await queue.markOperationSynced(operation.operationId, {
  localId: localWorklogId,
  remoteId: "remote-worklog-verified",
});

loaded = await queue.load();
summary = await queue.summary();
operation = loaded.operations[0];
assert.equal(summary.pendingCount, 0);
assert.equal(summary.retryablePendingCount, 0);
assert.equal(summary.unconfirmedCount, 0);
assert.equal(
  loaded.operations.filter((entry) => entry.status !== "synced").length,
  0
);
assert.equal(loaded.localToRemote[localWorklogId], "remote-worklog-verified");
assert.equal(loaded.localToRemote[localDocketId], "remote-job-1");

const mixedDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-worklog-mixed-"));
const mixedQueue = new LocalSyncQueueService({ cacheDir: mixedDir });
const oldLocalWorklogId = mixedQueue.localWorklogId();
const freshDocketId = mixedQueue.localDocketId();
const freshWorklogId = mixedQueue.localWorklogId();

await mixedQueue.enqueueWorklogCreate({
  worklog: {
    id: oldLocalWorklogId,
    docketId: "old-remote-docket",
    comment: "old accepted worklog",
    worklogDate: 1784140200000,
    hour: 1,
    min: 0,
  },
});
loaded = await mixedQueue.load();
await mixedQueue.markOperationUnconfirmed(
  loaded.operations[0].operationId,
  new Error("Old accepted worklog still waiting for read-only reconciliation.")
);
await mixedQueue.enqueueCreate({
  item: {
    id: freshDocketId,
    type: "job",
    title: "Fresh job with old pending op present",
    description: "",
  },
  payload: {
    id: freshDocketId,
    type: "job",
    title: "Fresh job with old pending op present",
    parentId: "remote-story-1",
  },
});
await mixedQueue.enqueueWorklogCreate({
  worklog: {
    id: freshWorklogId,
    docketId: freshDocketId,
    comment: "fresh dependent worklog",
    worklogDate: 1784140200000,
    hour: 2,
    min: 0,
  },
  dependsOn: freshDocketId,
});
loaded = await mixedQueue.load();
const mixedPending = mixedQueue.orderedPendingOperations(loaded);
assert.equal(mixedPending.length, 3);
assert.equal(
  mixedPending.filter((entry) => entry.localId === freshWorklogId).length,
  1
);
assert.equal(
  mixedPending.filter((entry) => entry.localId === oldLocalWorklogId).length,
  1
);

try {
  const realQueueRaw = await fs.readFile(
    new URL("../local-backend/cache/sync-queue.json", import.meta.url),
    "utf8"
  );
  const realQueue = JSON.parse(realQueueRaw);
  const stuckWorklog = (realQueue.operations || []).find(
    (entry) =>
      entry.entityType === "worklog" &&
      entry.operation === "create" &&
      entry.status === "sync-unconfirmed" &&
      entry.acceptedMutation === true
  );

  if (stuckWorklog) {
    console.log("Observed accepted Worklog create awaiting reconciliation:", {
      operationId: stuckWorklog.operationId,
      localId: stuckWorklog.localId,
      docketId: stuckWorklog.docketId,
      retryMutation: stuckWorklog.retryMutation,
      attempts: stuckWorklog.attempts,
    });
  }
} catch {
  // The persisted development queue is optional for this regression check.
}

console.log("Worklog create reconciliation verification PASS");
