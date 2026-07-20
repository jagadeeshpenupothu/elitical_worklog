import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";

const clientSource = await fs.readFile(
  new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url),
  "utf8"
);
const serverSource = await fs.readFile(
  new URL("../local-backend/server.mjs", import.meta.url),
  "utf8"
);
const queueSource = await fs.readFile(
  new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url),
  "utf8"
);
const logBufferSource = await fs.readFile(
  new URL("../local-backend/services/LogBufferService.mjs", import.meta.url),
  "utf8"
);
const authSource = await fs.readFile(
  new URL("../src/services/elitical/auth/EliticalAuthService.ts", import.meta.url),
  "utf8"
);
const worklogModelSource = await fs.readFile(
  new URL("../src/utils/worklogModel.js", import.meta.url),
  "utf8"
);

function includes(source, pattern, label) {
  assert.match(source, pattern, label);
}

function excludes(source, pattern, label) {
  assert.doesNotMatch(source, pattern, label);
}

includes(clientSource, /function worklogRecordFromPayload/, "SDK extracts full Worklog DTOs from POST responses");
includes(
  clientSource,
  /const responseWorklog = worklogRecordFromPayload\(createResponse\.payload\)/,
  "Worklog create inspects the actual POST response DTO"
);
includes(
  clientSource,
  /\.\.\.responseWorklog,[\s\S]*__eliticalWorklogCreateConfirmed: true,[\s\S]*__eliticalWorklogCreateConfirmationSource: "post-response"/,
  "POST response with a Worklog ID is a confirmed success signal"
);
includes(
  clientSource,
  /__eliticalWorklogCreateConfirmationSource: "post-accepted-unmatched"/,
  "POST accepted without a usable ID is represented as accepted but unreconciled"
);
includes(
  clientSource,
  /for \(const nestedKey of \["payload", "data", "body", "response"\]\)/,
  "GET Worklog/list parser tolerates nested response envelopes"
);
includes(
  serverSource,
  /createdWorklog = await provider\.createWorklog\(worklogPayloadForRemote\(operation, remoteDocketId\)\)/,
  "Worklog create uses the shared provider create path"
);
includes(
  serverSource,
  /let remoteWorklogId = firstString\(createdWorklog\?\.id, createdWorklog\?\.worklogId\)/,
  "Backend trusts a provider-returned remote Worklog ID"
);
includes(
  serverSource,
  /markOperationSynced\(operation\.operationId,[\s\S]*remoteId: remoteWorklogId/,
  "Confirmed Worklog create marks the queue operation synced"
);
includes(
  serverSource,
  /mergeSyncedWorklogIntoCache\(/,
  "Confirmed Worklog create persists the remote Worklog identity into local cache"
);
includes(
  serverSource,
  /markGraphWorklogSynced\(graph, operation\.localId, remoteWorklogId/,
  "Confirmed Worklog create rewrites graph worklog identity"
);
includes(
  serverSource,
  /createWasAlreadyAccepted[\s\S]*reconcileWorklogCreate\(provider, operation, remoteDocketId\)/,
  "Accepted/unconfirmed Worklog creates run targeted reconciliation before mutation"
);
includes(
  serverSource,
  /blocked\.push\(\{[\s\S]*actionability: "reconciliation-actionable"[\s\S]*retryMutation: false/,
  "Accepted but unresolved Worklog creates are blocked for reconciliation, not reported as hard failures"
);
{
  const acceptedWorklogMessageIndex = serverSource.indexOf("Created worklog was accepted but the remote Elitical worklog ID could not be reconciled.");
  assert.notEqual(acceptedWorklogMessageIndex, -1, "Accepted Worklog create reconciliation message is present");
  const acceptedWorklogBlock = serverSource.slice(acceptedWorklogMessageIndex, serverSource.indexOf("continue;", acceptedWorklogMessageIndex));
  excludes(
    acceptedWorklogBlock,
    /failures\.push\(\{/,
    "Accepted but unresolved Worklog creates are not pushed into hard failure reporting"
  );
}
includes(
  queueSource,
  /operation\.status === "sync-unconfirmed"[\s\S]*operation\.acceptedMutation === true[\s\S]*operation\.ambiguousMutation === true/,
  "Queue classifies accepted/ambiguous creates as reconciliation-actionable"
);
includes(
  queueSource,
  /operation\.retryMutation = false/,
  "Accepted/ambiguous creates disable blind mutation retry"
);
includes(
  worklogModelSource,
  /function normalizeWorklogs\(input, fallbackDate, fallbackDescription, fallbackTime\) \{\s*const source = Array\.isArray\(input\) \? input : \[\]/,
  "normalizeWorklogs([]) remains empty-source based"
);
includes(
  serverSource,
  /return Number\(worklog\.hour\) > 0 \|\| Number\(worklog\.min\) > 0;/,
  "Only positive-duration worklog input creates a Worklog mutation"
);
includes(
  authSource,
  /console\.info\("\[EliticalAuthService\] authenticatedRequest\(\) called"/,
  "Normal authenticatedRequest diagnostics are info-level"
);
includes(
  authSource,
  /console\.error\("\[EliticalAuthService\] authenticatedRequest unsuccessful response"/,
  "Actual unsuccessful authenticatedRequest responses remain error-level"
);
includes(
  logBufferSource,
  /if \(level === "error"\) return "ERROR";[\s\S]*if \(\/elitical\|\\\/api\\\/1\\\//,
  "Log category inference does not turn Elitical info diagnostics into ERROR merely because stack text contains Error"
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-worklog-create-hardening-"));
const queue = new LocalSyncQueueService({ cacheDir: dir });
const localWorklog = {
  id: "local-worklog-positive",
  docketId: "remote-docket-1",
  comment: "Designed card",
  worklogDate: "2026-07-19",
  hour: 1,
  min: 30,
};

await queue.enqueueWorklogCreate({ worklog: localWorklog });
let loaded = await queue.load();
let operation = loaded.operations.find((entry) => entry.localId === localWorklog.id);

assert.equal(operation.entityType, "worklog");
assert.equal(operation.operation, "create");
assert.equal(queue.classifyOperation(operation).mutationActionable, true, "positive-duration worklog starts mutation-actionable");

await queue.markOperationUnconfirmed(operation.operationId, new Error("POST outcome unknown after request was sent"));
loaded = await queue.load();
operation = loaded.operations.find((entry) => entry.localId === localWorklog.id);

assert.equal(operation.status, "sync-unconfirmed");
assert.equal(operation.acceptedMutation, true);
assert.equal(operation.ambiguousMutation, true);
assert.equal(operation.retryMutation, false);
assert.equal(queue.classifyOperation(operation).reconciliationActionable, true);
assert.equal(queue.classifyOperation(operation).mutationActionable, false, "ambiguous accepted create will not blindly POST again");

await queue.markOperationSynced(operation.operationId, {
  localId: localWorklog.id,
  remoteId: "remote-worklog-1",
});
loaded = await queue.load();
operation = loaded.operations.find((entry) => entry.localId === localWorklog.id);

assert.equal(operation.status, "synced");
assert.equal(operation.remoteId, "remote-worklog-1");
assert.equal(queue.classifyOperation(operation).completed, true);
assert.equal(queue.classifyOperation(operation).mutationActionable, false, "synced create is not retried after restart/reload");

await queue.markOperationFailed(operation.operationId, new Error("Local cache finalization failed after remote confirmation"));
loaded = await queue.load();
operation = loaded.operations.find((entry) => entry.localId === localWorklog.id);

assert.equal(operation.status, "synced", "remote-confirmed Worklog create cannot be downgraded to sync-failed");
assert.equal(operation.remoteId, "remote-worklog-1", "remote-confirmed Worklog create retains its remote ID");
assert.equal(operation.retryMutation, false, "remote-confirmed Worklog create disables blind POST retry");
assert.equal(queue.classifyOperation(operation).completed, true);
assert.equal(queue.classifyOperation(operation).mutationActionable, false, "local finalization failure cannot make a confirmed Worklog create retryable");

const reloadedQueue = new LocalSyncQueueService({ cacheDir: dir });
const reloaded = await reloadedQueue.load();
const reloadedOperation = reloaded.operations.find((entry) => entry.localId === localWorklog.id);

assert.equal(reloadedOperation.status, "synced", "remote-confirmed Worklog create acknowledgement survives queue reload");
assert.equal(reloadedOperation.remoteId, "remote-worklog-1");
assert.equal(reloadedQueue.classifyOperation(reloadedOperation).completed, true);
assert.equal(reloadedQueue.classifyOperation(reloadedOperation).mutationActionable, false, "backend restart cannot make a confirmed Worklog create POST again");

await queue.enqueueWorklogCreate({
  worklog: {
    id: "local-worklog-view-independent",
    docketId: "remote-docket-1",
    comment: "Created from any shared UI entry point",
    worklogDate: "2026-07-19",
    hour: 0,
    min: 45,
  },
});
loaded = await queue.load();
let viewIndependentOperation = loaded.operations.find((entry) => entry.localId === "local-worklog-view-independent");
await queue.markOperationSynced(viewIndependentOperation.operationId, {
  localId: viewIndependentOperation.localId,
  remoteId: "remote-worklog-view-independent",
});
await queue.markOperationFailed(viewIndependentOperation.operationId, new Error("Projection/UI refresh failed"));
loaded = await queue.load();
viewIndependentOperation = loaded.operations.find((entry) => entry.localId === "local-worklog-view-independent");

assert.equal(viewIndependentOperation.status, "synced");
assert.equal(viewIndependentOperation.remoteId, "remote-worklog-view-independent");
assert.equal(
  queue.classifyOperation(viewIndependentOperation).mutationActionable,
  false,
  "remote-confirmed Worklog create protection is based on shared queue identity, not view metadata"
);

const legacyConfirmedOperation = {
  operationId: "queue-legacy-confirmed-worklog",
  entityType: "worklog",
  operation: "create",
  localId: "local-worklog-legacy",
  remoteId: "remote-worklog-legacy",
  docketId: "remote-docket-1",
  payload: {},
  status: "sync-failed",
  retryMutation: true,
  lastError: "old local finalization error",
};

assert.equal(queue.classifyOperation(legacyConfirmedOperation).completed, true);
assert.equal(
  queue.classifyOperation(legacyConfirmedOperation).mutationActionable,
  false,
  "legacy failed Worklog create with a known remote ID is not mutation-actionable"
);

await queue.enqueueWorklogCreate({
  worklog: {
    id: "local-worklog-same-fields-a",
    docketId: "remote-docket-1",
    comment: "Same",
    worklogDate: "2026-07-19",
    hour: 2,
    min: 0,
  },
});
await queue.enqueueWorklogCreate({
  worklog: {
    id: "local-worklog-same-fields-b",
    docketId: "remote-docket-1",
    comment: "Same",
    worklogDate: "2026-07-19",
    hour: 2,
    min: 0,
  },
});
loaded = await queue.load();

assert.equal(
  loaded.operations.filter((entry) =>
    entry.entityType === "worklog" &&
    entry.operation === "create" &&
    String(entry.localId || "").startsWith("local-worklog-same-fields-")
  ).length,
  2,
  "intentional duplicate-looking Worklogs remain separate by local operation identity"
);

console.log("Worklog create sync hardening verification PASS");
