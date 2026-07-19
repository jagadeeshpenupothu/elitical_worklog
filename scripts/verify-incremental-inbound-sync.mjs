import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CacheService } from "../local-backend/services/CacheService.mjs";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-incremental-inbound-"));
const cache = new CacheService({ cacheDir: tmpDir });
const graph = {
  projects: [{ id: "project-1", name: "UX Designer" }],
  epics: [],
  stories: [],
  jobs: [],
  tasks: [],
  appState: {
    sprints: [],
    workItems: [
      {
        id: "remote-1",
        type: "job",
        title: "Remote Job",
        parentId: "story-1",
        elitical: {
          projectId: "project-1",
          remoteId: "remote-1",
        },
      },
    ],
  },
};
const syncIndex = {
  lastSuccessfulSync: "2026-07-18T00:00:00.000Z",
  projectId: "project-1",
  dockets: {
    "remote-1": {
      docketId: "remote-1",
      modifiedTimestamp: "100",
      createdTimestamp: "50",
      fingerprint: "{\"id\":\"remote-1\"}",
    },
  },
};

let result = await cache.saveGraph(graph, {
  syncedAt: syncIndex.lastSuccessfulSync,
  syncIndex,
});

assert.equal(Object.keys(result.metadata.dockets).length, 1);

result = await cache.saveGraph(
  {
    ...graph,
    appState: {
      ...graph.appState,
      workItems: [
        {
          ...graph.appState.workItems[0],
          title: "Local Pending Title",
          sync: {
            status: "pending-update",
            remoteId: "remote-1",
            pendingChanges: {
              title: "Local Pending Title",
            },
          },
        },
      ],
    },
  },
  {
    syncedAt: "2026-07-18T01:00:00.000Z",
  }
);

assert.equal(
  Object.keys(result.metadata.dockets).length,
  1,
  "Local-only cache writes must preserve the previous remote docket baseline."
);
assert.equal(result.metadata.projectId, "project-1");
assert.equal(result.metadata.dockets["remote-1"].modifiedTimestamp, "100");

const syncLiveSource = await fs.readFile(
  new URL("../src/services/elitical/syncLive.ts", import.meta.url),
  "utf8"
);

assert.match(syncLiveSource, /function baselineStatus/);
assert.match(syncLiveSource, /reason: "valid-baseline"/);
assert.match(syncLiveSource, /reason: "baseline-empty-docket-index"/);
assert.match(syncLiveSource, /function issueFingerprint/);
assert.match(syncLiveSource, /previous\.fingerprint && previous\.fingerprint !== issueFingerprint/);
assert.match(syncLiveSource, /const worklogRefreshTargets = canReuseCachedWorklogs[\s\S]+?\?\s*\[\.\.\.newIssues, \.\.\.modifiedIssues\]/);
assert.match(syncLiveSource, /\[inbound-sync\] mode=\$\{incremental\.mode\} reason=\$\{incremental\.reason\}/);

console.log("Incremental inbound sync verification PASS");
