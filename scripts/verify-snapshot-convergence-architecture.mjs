import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSnapshotBundle,
  buildFinalizedSnapshot,
  snapshotDescriptorFor,
  snapshotIdsMatch,
} from "../local-backend/services/SynchronizedSnapshotService.mjs";

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(read(filePath));
  } catch {
    return null;
  }
}

function workItems(graph) {
  return graph?.appState?.workItems || [];
}

function worklogs(cache) {
  return Array.isArray(cache?.worklogs) ? cache.worklogs : [];
}

function docketIds(graph) {
  return new Set(workItems(graph).map((item) => item.id).filter(Boolean));
}

function worklogIds(cache) {
  return new Set(worklogs(cache).map((entry) => entry.id).filter(Boolean));
}

function missingIds(first, second) {
  return Array.from(first).filter((id) => !second.has(id)).sort();
}

const graph = {
  appState: {
    mainTitle: "Project",
    rootTitle: "Sprint",
    sprints: [{ id: "sprint-1", title: "Sprint 1" }],
    workItems: [
      {
        id: "story-1",
        title: "Story",
        type: "story",
        parentId: "epic-1",
        storyPoints: 2,
        elitical: { assigneeId: "employee-a" },
      },
      {
        id: "job-1",
        title: "Job",
        type: "job",
        parentId: "story-1",
      },
    ],
  },
};
const worklogCache = {
  version: 1,
  worklogs: [
    {
      id: "worklog-a",
      docketId: "job-1",
      employeeId: "employee-a",
      employeeName: "Employee A",
      timeMinutes: 120,
    },
    {
      id: "worklog-b",
      docketId: "job-1",
      employeeId: "employee-b",
      employeeName: "Employee B",
      timeMinutes: 30,
    },
  ],
};
const finalized = buildFinalizedSnapshot({
  graph,
  worklogs: worklogCache,
  metadata: {},
  syncedAt: "2026-07-20T00:00:00.000Z",
});
const metadata = {
  lastSuccessfulSync: "2026-07-20T00:00:00.000Z",
  syncGenerationId: finalized.snapshot.syncGenerationId,
  snapshotId: finalized.snapshot.snapshotId,
  syncGenerationSequence: finalized.snapshot.syncGenerationSequence,
  snapshot: finalized.snapshot,
  employee: finalized.snapshot.employee,
};

assert.equal(finalized.snapshot.employee.employeeId, "employee-a");
assert.equal(finalized.graph.appState.metadata.employee.employeeId, "employee-a");
assert.equal(finalized.graph.appState.employee.employeeId, "employee-a");
assert.equal(finalized.worklogs.employee.employeeId, "employee-a");
assert.equal(snapshotIdsMatch(finalized.graph, finalized.worklogs, metadata), true);
assert.equal(assertSnapshotBundle({
  graph: finalized.graph,
  worklogs: finalized.worklogs,
  metadata,
}).consistent, true);

const mismatchedMetadata = {
  ...metadata,
  syncGenerationId: "older-generation",
  snapshotId: "older-generation",
};
assert.equal(snapshotIdsMatch(finalized.graph, finalized.worklogs, mismatchedMetadata), false);
assert.throws(
  () => assertSnapshotBundle({
    graph: finalized.graph,
    worklogs: finalized.worklogs,
    metadata: mismatchedMetadata,
  }),
  /Snapshot generation mismatch/
);

const syncServiceSource = read("local-backend/services/SyncService.mjs");
assert.match(syncServiceSource, /const publication = await this\.publishSnapshot/);
assert.doesNotMatch(syncServiceSource, /publishInBackground/);
assert.match(syncServiceSource, /publishLatestLocalSnapshot/);
assert.match(syncServiceSource, /local-synced-publication-failed/);

const serverSource = read("local-backend/server.mjs");
assert.match(serverSource, /\/api\/publish\/latest-snapshot/);
assert.match(serverSource, /publishLatestLocalSnapshot/);
assert.doesNotMatch(serverSource, /DES-691|DES-692|DES-693|DES-694|DES-695|DES-696|DES-697|DES-698/);

const githubSource = read("local-backend/services/GitHubDataService.mjs");
assert.match(githubSource, /assertSnapshotBundle/);
assert.match(githubSource, /latestPublicationSequence/);
assert.match(githubSource, /snapshotIdsMatch/);

const appSource = read("src/App.jsx");
assert.match(appSource, /loadPublishedSnapshot/);
assert.match(appSource, /setImportedWorklogs\(result\.worklogs\?\.worklogs \|\| \[\]\)/);
assert.match(appSource, /local-synced-publication-failed/);

const publishedClientSource = read("src/services/publishedDataClient.js");
assert.match(publishedClientSource, /export async function loadPublishedSnapshot/);
assert.match(publishedClientSource, /snapshotConsistency/);

const modelSource = read("src/utils/worklogModel.js");
assert.match(modelSource, /metadata:/);
assert.match(modelSource, /employee:/);

const runtimeRoot = path.join(os.homedir(), "Elitical Worklog Data", "data");
const runtimeGraph = readJsonIfPresent(path.join(runtimeRoot, "graph.json"));
const runtimeWorklogs = readJsonIfPresent(path.join(runtimeRoot, "worklogs.json"));
const publishedGraph = readJsonIfPresent("data/graph.json");
const publishedWorklogs = readJsonIfPresent("data/worklogs.json");

if (runtimeGraph && runtimeWorklogs && publishedGraph && publishedWorklogs) {
  const runtimeDockets = docketIds(runtimeGraph);
  const publishedDockets = docketIds(publishedGraph);
  const runtimeWorklogIds = worklogIds(runtimeWorklogs);
  const publishedWorklogIds = worklogIds(publishedWorklogs);
  const missingPublishedDockets = missingIds(runtimeDockets, publishedDockets);
  const missingPublishedWorklogs = missingIds(runtimeWorklogIds, publishedWorklogIds);

  assert.equal(runtimeDockets.size >= publishedDockets.size, true);

  console.log("Current fixture comparison", {
    runtimeDockets: runtimeDockets.size,
    publishedDockets: publishedDockets.size,
    runtimeWorklogs: runtimeWorklogIds.size,
    publishedWorklogs: publishedWorklogIds.size,
    missingPublishedDockets: missingPublishedDockets.length,
    missingPublishedWorklogs: missingPublishedWorklogs.length,
    runtimeSnapshot: snapshotDescriptorFor(runtimeGraph).syncGenerationId || "",
    publishedSnapshot: snapshotDescriptorFor(publishedGraph).syncGenerationId || "",
  });
}

console.log("Snapshot convergence architecture verification PASS");
