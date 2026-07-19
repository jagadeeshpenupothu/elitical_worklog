import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const queueSource = await fs.readFile(
  new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url),
  "utf8"
);
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

const makeCreateDraft = extractFunction(appSource, "makeCreateDraft");
const acceptsTime = extractFunction(appSource, "acceptsTime");
const createLocalDocket = extractFunction(serverSource, "createLocalDocket", { async: true });
const updateLocalDocket = extractFunction(serverSource, "updateLocalDocket", { async: true });
const outboundSync = extractFunction(serverSource, "syncPendingToElitical", { async: true });

assert.match(acceptsTime, /type === "story" \|\| type === "task" \|\| type === "job"/);
assert.match(makeCreateDraft, /worklogDescription: ""/);
assert.match(makeCreateDraft, /worklogDate: ""/);
assert.match(appSource, /function isMeaningfulWorklogDraft/);
assert.match(appSource, /function validateWorklogDraft/);
assert.match(appSource, /label="Worklog Date"/);
assert.match(appSource, /label="Hours"/);
assert.match(appSource, /label="Minutes"/);
assert.match(appSource, /label="Comment"/);
assert.match(appSource, /worklog:\s*hasWorklog && isMeaningfulWorklogDraft\(draft\)/s);
assert.match(appSource, /updateEliticalDocket\(canonicalDocketId,\s*\{\s*worklog: localOnlyUpdates\.worklog,/s);

assert.match(serverSource, /function isMeaningfulWorklogPayload/);
assert.match(serverSource, /function validateWorklogPayload/);
assert.match(serverSource, /function normalizeWorklogDate/);
assert.match(serverSource, /eliticalWorklogDateMillis\(value\)/);
assert.match(createLocalDocket, /validateWorklogPayload\(requestedWorklog, \{ docketType: payload\.type \}\)/);
assert.match(createLocalDocket, /await syncQueueService\.enqueueCreate/);
assert.match(createLocalDocket, /await syncQueueService\.enqueueWorklogCreate/);
assert.match(updateLocalDocket, /queueLocalWorklogSave\(graph, docketId, item, updates\.worklog\)/);

assert.match(queueSource, /const LOCAL_WORKLOG_PREFIX = "local-worklog-"/);
assert.match(queueSource, /localWorklogId\(\)/);
assert.match(queueSource, /enqueueWorklogCreate/);
assert.match(queueSource, /enqueueWorklogUpdate/);
assert.match(queueSource, /mergePendingWorklogsIntoItem/);
assert.match(queueSource, /docketCreates/);
assert.match(queueSource, /worklogCreates/);
assert.match(queueSource, /worklogUpdates/);

assert.match(outboundSync, /operation\.entityType === "docket" && operation\.operation === "create"/);
assert.match(outboundSync, /operation\.entityType === "worklog" && operation\.operation === "create"/);
assert.match(outboundSync, /remoteDocketIdForWorklog\(graph, localToRemote, operation\)/);
assert.match(outboundSync, /provider\.createWorklog/);
assert.match(outboundSync, /provider\.updateWorklog/);
assert.match(outboundSync, /reconcileWorklogCreate\(provider, operation, remoteDocketId\)/);
assert.match(outboundSync, /await sdkLease\.release\(\);/);

assert.match(clientSource, /async createWorklog\(payload: CreateWorklogPayload\)/);
assert.match(clientSource, /async updateWorklog\(payload: CreateWorklogPayload\)/);
assert.match(clientSource, /method: "POST",\s*path: "\/api\/1\/Worklog"/s);
assert.match(clientSource, /method: "PUT",\s*path: "\/api\/1\/Worklog"/s);
assert.match(clientSource, /docketNum: null/);
assert.match(clientSource, /docketType: null/);
assert.match(clientSource, /startWorklogDate: "null"/);
assert.match(clientSource, /endWorklogDate: "null"/);
assert.match(clientSource, /imgAttachmentDtoSet: \[\]/);
assert.match(clientSource, /videoAttachmentDtoSet: \[\]/);
assert.match(clientSource, /create && hour === 0 \? null : hour/);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-worklog-queue-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const localDocketId = queue.localDocketId();
const localWorklogId = queue.localWorklogId();

await queue.enqueueCreate({
  item: {
    id: localDocketId,
    type: "job",
    title: "Local Job",
    description: "",
  },
  payload: {
    id: localDocketId,
    type: "job",
    title: "Local Job",
    parentId: "remote-story-1",
  },
});
await queue.enqueueWorklogCreate({
  worklog: {
    id: localWorklogId,
    docketId: localDocketId,
    comment: "Worked on local job",
    worklogDate: 1783987200000,
    hour: 0,
    min: 15,
  },
  dependsOn: localDocketId,
});

let loaded = await queue.load();
let ordered = queue.orderedPendingOperations(loaded);
assert.equal(ordered[0].entityType, "docket");
assert.equal(ordered[1].entityType, "worklog");
assert.equal(ordered[1].dependsOn, localDocketId);

await queue.replaceLocalId({ appState: { workItems: [] } }, localDocketId, "remote-job-1");
loaded = await queue.load();
const worklogCreate = loaded.operations.find((operation) => operation.entityType === "worklog");
assert.equal(worklogCreate.docketId, "remote-job-1");
assert.equal(worklogCreate.payload.docketId, "remote-job-1");
assert.equal(worklogCreate.dependsOn, "");

await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-1",
    docketId: "remote-job-1",
    comment: "A",
    worklogDate: 1783987200000,
    hour: 0,
    min: 15,
    sync: {
      status: "synced",
      remoteId: "remote-worklog-1",
      remoteBaseline: {
        comment: "A",
        worklogDate: 1783987200000,
        hour: 0,
        min: 15,
      },
    },
  },
  changes: {
    comment: "B",
  },
});
await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-1",
    docketId: "remote-job-1",
    comment: "B",
    worklogDate: 1783987200000,
    hour: 0,
    min: 15,
    sync: {
      status: "pending-update",
      remoteId: "remote-worklog-1",
      remoteBaseline: {
        comment: "A",
        worklogDate: 1783987200000,
        hour: 0,
        min: 15,
      },
    },
  },
  changes: {
    comment: "C",
  },
});
loaded = await queue.load();
let updates = loaded.operations.filter((operation) =>
  operation.entityType === "worklog" && operation.operation === "update"
);
assert.equal(updates.length, 1);
assert.equal(updates[0].changes.comment, "C");

await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-1",
    docketId: "remote-job-1",
    comment: "C",
    worklogDate: 1783987200000,
    hour: 0,
    min: 15,
    sync: {
      status: "pending-update",
      remoteId: "remote-worklog-1",
      remoteBaseline: {
        comment: "A",
        worklogDate: 1783987200000,
        hour: 0,
        min: 15,
      },
    },
  },
  changes: {
    comment: "A",
  },
});
loaded = await queue.load();
updates = loaded.operations.filter((operation) =>
  operation.entityType === "worklog" && operation.operation === "update"
);
assert.equal(updates.length, 0);

console.log("Local-first worklog verification PASS");
