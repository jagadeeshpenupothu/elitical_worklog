import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import { calculateStoryPoints, ROOT_ID } from "../src/utils/worklogModel.js";
import {
  normalizeEliticalDescription,
  normalizeEliticalCreateDescriptionFields,
  validateEliticalDescription,
} from "../src/utils/eliticalDocketCreate.js";

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const worklogModelSource = await fs.readFile(new URL("../src/utils/worklogModel.js", import.meta.url), "utf8");
const clientSource = await fs.readFile(new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url), "utf8");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
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

function createPayloadHelpers() {
  const context = {
    ORPHAN_SPRINT_ID: "virtual-orphan-sprint",
    normalizeEliticalDescription,
    normalizeEliticalCreateDescriptionFields,
    validateEliticalDescription,
    normalizeDocketCreatePayload(payload) {
      return normalizeEliticalCreateDescriptionFields(payload);
    },
  };

  return vm.runInNewContext(
    [
      extractFunction(serverSource, "firstString"),
      extractFunction(serverSource, "itemCollections"),
      extractFunction(serverSource, "remoteIdForLocalId"),
      extractFunction(serverSource, "localDocketRecordForOperation"),
      extractFunction(serverSource, "payloadForRemoteCreate"),
      "({ payloadForRemoteCreate, localDocketRecordForOperation });",
    ].join("\n"),
    context
  );
}

const helpers = createPayloadHelpers();
const jobDescription =
  "Design Sesha Sir's visiting cards using the existing design. Get the design reviewed and approved by Sesha Sir, print 40 copies, cut them to the required size, and deliver the finished visiting cards to Sesha Sir.";

assert.match(serverSource, /function localDocketRecordForOperation/);
assert.match(serverSource, /const description = firstString\([\s\S]*localRecord\?\.description[\s\S]*localRecord\?\.descr[\s\S]*payload\.description[\s\S]*payload\.descr/s);
assert.match(serverSource, /payload\.descr = description/);
assert.match(clientSource, /private jobDocketPayload\(payload: CreateDocketPayload, description: unknown\)/);
assert.match(clientSource, /descr: String\(description \|\| ""\)/);
assert.match(worklogModelSource, /function normalizeWorklogs\(input, fallbackDate, fallbackDescription, fallbackTime\) \{\s*const source = Array\.isArray\(input\) \? input : \[\]/);

const graph = {
  appState: {
    workItems: [
      {
        id: "remote-story-1",
        type: "story",
        title: "Synced Story",
        parentId: "epic-1",
        sync: { remoteId: "remote-story-1" },
        elitical: { remoteId: "remote-story-1" },
      },
      {
        id: "local-job-1",
        type: "job",
        title: "Sesha sir Visiting Cards",
        description: jobDescription,
        parentId: "remote-story-1",
        category: "ENHANCEMENT",
        priority: "MINOR",
        docketState: "DESIGN",
        sync: {
          status: "sync-failed",
          localId: "local-job-1",
          remoteId: "",
        },
      },
    ],
  },
  epics: [],
  stories: [],
  jobs: [
    {
      id: "local-job-1",
      type: "JOB",
      title: "Sesha sir Visiting Cards",
      description: jobDescription,
      parentId: "remote-story-1",
    },
  ],
  tasks: [],
};

const staleFailedJobOperation = {
  entityType: "docket",
  operation: "create",
  localId: "local-job-1",
  docketType: "job",
  status: "sync-failed",
  payload: {
    id: "local-job-1",
    type: "job",
    title: "Sesha sir Visiting Cards",
    description: "",
    descr: "",
    parentId: "remote-story-1",
    storyId: "remote-story-1",
    projectId: "project-1",
    projectName: "Elitical",
    category: "ENHANCEMENT",
    priority: "MINOR",
    dktStateId: "design-state-id",
  },
};
const outboundJobPayload = helpers.payloadForRemoteCreate(graph, staleFailedJobOperation, {});

assert.equal(outboundJobPayload.type, "job");
assert.equal(outboundJobPayload.parentId, "remote-story-1");
assert.equal(outboundJobPayload.storyId, "remote-story-1");
assert.equal(outboundJobPayload.description, jobDescription);
assert.equal(outboundJobPayload.descr, jobDescription);
assert.equal(outboundJobPayload.id, undefined);

const localWorklog = {
  id: "local-worklog-1",
  localId: "local-worklog-1",
  docketId: "local-job-1",
  comment: "Prepared visiting card design and print handoff.",
  description: "Prepared visiting card design and print handoff.",
  worklogDate: "2026-07-19T00:00:00.000Z",
  date: "2026-07-19T00:00:00.000Z",
  hour: 2,
  min: 30,
  timeMinutes: 150,
  durationMinutes: 150,
  sync: {
    status: "pending-create",
    localId: "local-worklog-1",
    remoteId: "",
    pendingChanges: {
      docketId: "local-job-1",
      comment: "Prepared visiting card design and print handoff.",
      worklogDate: "2026-07-19T00:00:00.000Z",
      hour: 2,
      min: 30,
    },
  },
};
const localJob = {
  id: "local-job-1",
  type: "job",
  title: "Sesha sir Visiting Cards",
  description: jobDescription,
  parentId: "local-story-1",
  worklogs: [localWorklog],
};
const totals = calculateStoryPoints([
  {
    id: "local-story-1",
    type: "story",
    title: "Local Story",
    parentId: ROOT_ID,
    storyPoints: 1,
    worklogs: [],
  },
  localJob,
]);

assert.equal(localJob.worklogs.length, 1, "Job + Worklog create materializes a local worklog");
assert.equal(localJob.worklogs[0].docketId, "local-job-1", "Local worklog is linked to the local Job ID");
assert.equal(localJob.worklogs[0].timeMinutes, 150, "Local worklog preserves 02:30 duration");
assert.equal(localJob.worklogs[0].comment, "Prepared visiting card design and print handoff.");
assert.equal(totals.ownTimeById["local-job-1"], 150, "Job card can immediately resolve own logged time");
assert.equal(totals.timeById["local-story-1"], 150, "Parent Story rollup includes local Job worklog");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-job-worklog-deps-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });

await queue.enqueueCreate({
  item: {
    id: "local-story-1",
    type: "story",
    title: "Local Story",
    description: "Story description",
  },
  payload: {
    id: "local-story-1",
    type: "story",
    title: "Local Story",
    description: "Story description",
    parentId: "epic-1",
  },
});
await queue.enqueueCreate({
  item: {
    id: "local-job-1",
    type: "job",
    title: "Sesha sir Visiting Cards",
    description: jobDescription,
  },
  payload: {
    id: "local-job-1",
    type: "job",
    title: "Sesha sir Visiting Cards",
    description: jobDescription,
    parentId: "local-story-1",
    storyId: "local-story-1",
  },
});
await queue.enqueueWorklogCreate({
  worklog: localWorklog,
  dependsOn: "local-job-1",
});

let loaded = await queue.load();
let ordered = queue.orderedPendingOperations(loaded);
assert.deepEqual(
  ordered.map((operation) => `${operation.entityType}:${operation.operation}:${operation.localId || operation.docketId}`),
  [
    "docket:create:local-story-1",
    "docket:create:local-job-1",
    "worklog:create:local-worklog-1",
  ],
  "Dependency order is Story -> Job -> Worklog"
);
assert.equal(ordered[2].dependsOn, "local-job-1", "Worklog remains blocked on local Job before reconciliation");
assert.equal(ordered[2].docketId, "local-job-1", "Worklog keeps local Job docketId before Job reconciliation");

await queue.replaceLocalId({ appState: { workItems: [localJob] } }, "local-story-1", "remote-story-1");
loaded = await queue.load();
let jobCreate = loaded.operations.find((operation) => operation.localId === "local-job-1");
let worklogCreate = loaded.operations.find((operation) => operation.localId === "local-worklog-1");
assert.equal(jobCreate.payload.parentId, "remote-story-1", "Job create parent is rewritten after Story reconciliation");
assert.equal(jobCreate.payload.storyId, "remote-story-1", "Job create storyId is rewritten after Story reconciliation");
assert.equal(worklogCreate.dependsOn, "local-job-1", "Worklog still waits for Job after Story reconciliation");

await queue.replaceLocalId({ appState: { workItems: [localJob] } }, "local-job-1", "remote-job-1");
loaded = await queue.load();
worklogCreate = loaded.operations.find((operation) => operation.localId === "local-worklog-1");
assert.equal(worklogCreate.docketId, "remote-job-1", "Worklog docketId is rewritten after Job reconciliation");
assert.equal(worklogCreate.payload.docketId, "remote-job-1", "Worklog payload docketId is rewritten after Job reconciliation");
assert.equal(worklogCreate.dependsOn, "", "Worklog dependency is cleared after Job reconciliation");
const summary = await queue.summary();
assert.equal(
  summary.operations.find((operation) => operation.localId === "local-worklog-1").classification.mutationActionable,
  true
);

console.log("Job create + worklog sync verification PASS");
