import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import {
  normalizeEliticalCreateDescriptionFields,
  normalizeEliticalDescription,
  validateEliticalDescription,
} from "../src/utils/eliticalDocketCreate.js";
import { validateDocketOperation } from "../src/utils/docketOperationValidation.js";
import {
  docketStateApiId,
  docketStateApiName,
} from "../src/utils/docketStates.js";

const serverSource = await fs.readFile(
  new URL("../local-backend/server.mjs", import.meta.url),
  "utf8"
);
const appSource = await fs.readFile(
  new URL("../src/App.jsx", import.meta.url),
  "utf8"
);
const clientSource = await fs.readFile(
  new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url),
  "utf8"
);
const queueSource = await fs.readFile(
  new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url),
  "utf8"
);

assert.equal(
  normalizeEliticalDescription("Design Sesha Sir\u2019s visiting cards."),
  "Design Sesha Sir's visiting cards."
);
assert.equal(normalizeEliticalDescription("\u201cDesign\u201d"), "\"Design\"");
assert.equal(normalizeEliticalDescription("front\u2013page"), "front-page");
assert.equal(normalizeEliticalDescription("front\u2014page"), "front-page");
assert.equal(normalizeEliticalDescription("Normal ASCII description."), "Normal ASCII description.");
assert.equal(
  normalizeEliticalDescription(
    "This is a long valid description that should not be rejected solely because it is longer than two hundred and thirteen characters. It remains ordinary text, uses supported punctuation, and should flow through the create pipeline unchanged."
  ).length > 213,
  true
);

for (const value of ["", "   ", null, undefined]) {
  assert.equal(validateEliticalDescription(value), "Description is required.");
}

assert.deepEqual(
  normalizeEliticalCreateDescriptionFields({
    description: "Design Sesha Sir\u2019s visiting cards.",
  }),
  {
    description: "Design Sesha Sir's visiting cards.",
    descr: "Design Sesha Sir's visiting cards.",
  }
);

const workItems = [
  {
    id: "epic-1",
    type: "epic",
    title: "Epic",
    parentId: "storyRoot",
  },
  {
    id: "story-1",
    type: "story",
    title: "Story",
    parentId: "epic-1",
  },
];
const validPayloads = [
  { type: "epic", parentId: "storyRoot" },
  { type: "story", parentId: "epic-1" },
  { type: "job", parentId: "story-1" },
  { type: "task", parentId: "epic-1" },
];

for (const payload of validPayloads) {
  assert.equal(
    validateDocketOperation({
      operation: "create",
      payload: {
        ...payload,
        title: `${payload.type} title`,
        description: "Valid description.",
        dktStateId: docketStateApiId("concept"),
        dktStateName: docketStateApiName("concept"),
      },
      workItems,
      sprints: [],
    }),
    "",
    `${payload.type} create accepts shared valid description/state fields`
  );
}

for (const description of ["", " ", null, undefined]) {
  assert.equal(
    validateDocketOperation({
      operation: "create",
      payload: {
        type: "job",
        parentId: "story-1",
        title: "Job with invalid description",
        description,
        dktStateId: docketStateApiId("concept"),
      },
      workItems,
      sprints: [],
    }),
    "Description is required.",
    "invalid Job description is rejected before enqueue"
  );
}

assert.match(appSource, /validateEliticalDescription\(/);
assert.match(appSource, /normalizeEliticalDescription\(payload\.description\)/);
assert.match(serverSource, /function normalizeDocketCreatePayload/);
assert.match(serverSource, /const createPayload = normalizeDocketCreatePayload\(payload\)/);
assert.match(serverSource, /validateDocketOperation\(\{[\s\S]*\.\.\.createPayload/);
assert.match(serverSource, /enqueueCreate\(\{[\s\S]*\.\.\.createPayload/);
assert.match(serverSource, /function resolveDocketCreateStateFields/);
assert.match(serverSource, /docketStateApiId\(docketState\)/);
assert.match(clientSource, /normalizeEliticalDescription\(/);
assert.match(queueSource, /function isConfirmedWorklogCreate/);
assert.match(queueSource, /if \(isConfirmedWorklogCreate\(operation\)\)/);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-docket-create-safety-"));
const queue = new LocalSyncQueueService({ cacheDir: tempDir });
const invalidDescriptionError = validateDocketOperation({
  operation: "create",
  payload: {
    type: "job",
    parentId: "story-1",
    title: "Job + Worklog invalid description",
    description: " ",
    worklog: {
      comment: "Would be unsafe if queued without parent",
      worklogDate: "2026-07-19",
      hour: 1,
      min: 0,
    },
    dktStateId: docketStateApiId("concept"),
  },
  workItems,
  sprints: [],
});

assert.equal(invalidDescriptionError, "Description is required.");
assert.equal((await queue.load()).operations.length, 0, "invalid create validation leaves no Docket or Worklog mutation");

await queue.enqueueCreate({
  item: {
    id: "local-docket-smart",
    type: "job",
    title: "Smart punctuation Job",
    description: normalizeEliticalDescription("Design Sesha Sir\u2019s visiting cards."),
  },
  payload: {
    id: "local-docket-smart",
    type: "job",
    parentId: "story-1",
    description: normalizeEliticalDescription("Design Sesha Sir\u2019s visiting cards."),
    descr: normalizeEliticalDescription("Design Sesha Sir\u2019s visiting cards."),
    dktStateId: docketStateApiId("design"),
    dktStateName: docketStateApiName("design"),
  },
});
await queue.enqueueWorklogCreate({
  worklog: {
    id: "local-worklog-smart",
    docketId: "local-docket-smart",
    comment: "Completed visiting cards.",
    worklogDate: "2026-07-19",
    hour: 1,
    min: 30,
  },
  dependsOn: "local-docket-smart",
});

let loaded = await queue.load();
const smartJob = loaded.operations.find((operation) => operation.localId === "local-docket-smart");
const smartWorklog = loaded.operations.find((operation) => operation.localId === "local-worklog-smart");

assert.equal(smartJob.payload.description, "Design Sesha Sir's visiting cards.");
assert.equal(smartJob.payload.descr, "Design Sesha Sir's visiting cards.");
assert.equal(smartJob.payload.dktStateId, docketStateApiId("design"));
assert.equal(smartJob.payload.dktStateName, docketStateApiName("design"));
assert.equal(smartWorklog.dependsOn, "local-docket-smart");
assert.equal(smartWorklog.status, "pending-create");

await queue.markOperationSynced(smartWorklog.operationId, {
  localId: smartWorklog.localId,
  remoteId: "remote-worklog-smart",
});
await queue.markOperationFailed(smartWorklog.operationId, new Error("Local projection failed after remote confirmation"));
loaded = await queue.load();
const confirmedWorklog = loaded.operations.find((operation) => operation.localId === "local-worklog-smart");

assert.equal(confirmedWorklog.status, "synced");
assert.equal(confirmedWorklog.remoteId, "remote-worklog-smart");
assert.equal(queue.classifyOperation(confirmedWorklog).mutationActionable, false);

const realQueuePath = path.join(os.homedir(), "Elitical Worklog Data", "sync", "sync-queue.json");
try {
  const realQueue = JSON.parse(await fs.readFile(realQueuePath, "utf8"));
  const stale = (realQueue.operations || []).find(
    (operation) => operation.operationId === "queue-ed6357a0-e0f9-4ed7-9199-b6f0b11bb1b1"
  );

  if (stale) {
    assert.equal(["sync-failed", "superseded"].includes(stale.status), true);
    assert.equal(stale.payload?.description?.includes("Sir\u2019s"), true);
    assert.equal(stale.payload?.descr?.includes("Sir\u2019s"), true);
  }
} catch {
  // Runtime queue is optional in clean test environments.
}

console.log("Docket create safety verification PASS");
