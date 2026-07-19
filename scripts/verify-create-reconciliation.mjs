import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import {
  chooseCreatedDocketCandidate,
  createdDocketCandidates,
} from "../local-backend/services/CreateReconciliationService.mjs";

const payload = {
  parentId: "story-1",
  storyId: "story-1",
  epicId: "epic-1",
  type: "job",
  title: "Gaptor Video Edits",
  description: "Add the final slide and watermarks",
  projectId: "project-1",
  sprintId: "",
  assigneeId: "user-1",
};

const remoteJob = {
  id: "remote-job-1",
  num: "DES-682",
  projectId: "project-1",
  type: "JOB",
  title: "Gaptor Video Edits",
  descr: "Add the final slide and watermarks",
  assigneeId: "user-1",
};

let candidates = createdDocketCandidates([remoteJob], payload, { projectScoped: true });
assert.equal(candidates.length, 1);
assert.equal(chooseCreatedDocketCandidate(candidates)?.item.id, "remote-job-1");

candidates = createdDocketCandidates(
  [
    {
      ...remoteJob,
      projectId: "",
      assigneeId: "",
    },
  ],
  payload,
  { projectScoped: true }
);
assert.equal(
  chooseCreatedDocketCandidate(candidates)?.item.id,
  "remote-job-1",
  "Project-scoped IssuesBoard rows may omit projectId/assigneeId."
);

candidates = createdDocketCandidates(
  [
    {
      ...remoteJob,
      storyId: "different-story",
    },
  ],
  payload,
  { projectScoped: true }
);
assert.equal(candidates.length, 0, "Reliable contradictory Story IDs must reject a candidate.");

candidates = createdDocketCandidates([], payload, { projectScoped: true });
assert.equal(chooseCreatedDocketCandidate(candidates), null);

candidates = createdDocketCandidates(
  [
    remoteJob,
    {
      ...remoteJob,
      id: "remote-job-2",
      num: "DES-683",
    },
  ],
  payload,
  { projectScoped: true }
);
assert.equal(
  chooseCreatedDocketCandidate(candidates),
  null,
  "Ambiguous same-score candidates must not be mapped automatically."
);

candidates = createdDocketCandidates(
  [
    {
      ...remoteJob,
      sprintId: "",
    },
  ],
  {
    ...payload,
    sprintId: "virtual-orphan-sprint",
  },
  { projectScoped: true }
);
assert.equal(chooseCreatedDocketCandidate(candidates)?.item.id, "remote-job-1");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-create-reconciliation-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const localId = queue.localDocketId();

await queue.enqueueCreate({
  item: {
    id: localId,
    type: "job",
    title: payload.title,
  },
  payload: {
    ...payload,
    id: localId,
  },
});

let loaded = await queue.load();
let createOperation = loaded.operations.find((operation) => operation.localId === localId);

await queue.markOperationUnconfirmed(createOperation.operationId, new Error("accepted but unmatched"));
loaded = await queue.load();
createOperation = loaded.operations.find((operation) => operation.localId === localId);

assert.equal(createOperation.status, "sync-unconfirmed");
assert.equal(createOperation.acceptedMutation, true);
assert.equal(createOperation.retryMutation, false);
assert.equal(
  queue.orderedPendingOperations(loaded).some((operation) => operation.operationId === createOperation.operationId),
  true,
  "Unconfirmed accepted creates must be actionable for read-only recovery."
);

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /const createWasAlreadyAccepted = operationClassification\.reconciliationActionable/);
assert.match(serverSource, /let createdDocket = createWasAlreadyAccepted[\s\S]+__recoveryOnly: true/);
assert.match(serverSource, /if \(!createWasAlreadyAccepted\) \{[\s\S]+createdDocket = await createEliticalDocket\(remotePayload, provider\)/);
assert.match(serverSource, /const createReconciliation = await reconcileCreatedRemoteId\(remotePayload, createdDocket/);
assert.doesNotMatch(
  serverSource,
  /\?\s*await createEliticalDocket\(remotePayload, provider\)/,
  "Accepted create recovery must bypass the Create API and use read-only reconciliation."
);

console.log("Create reconciliation simulation PASS");
