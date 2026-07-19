import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CacheService } from "../local-backend/services/CacheService.mjs";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import {
  canonicalDocketId,
  canonicalDocketIdForItem,
} from "../src/utils/docketOperationValidation.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-local-first-update-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const remoteBaseline = {
  title: "A",
  description: "D1",
};
const remoteItem = {
  id: "remote-job-1",
  type: "job",
  title: "A",
  description: "D1",
  parentId: "remote-story-1",
  sync: {
    status: "synced",
    remoteId: "remote-job-1",
    remoteBaseline,
  },
};

await queue.enqueueUpdate({
  item: {
    ...remoteItem,
    title: "B",
  },
  changes: {
    title: "B",
  },
  baselineItem: remoteItem,
});

let loaded = await queue.load();
let updates = loaded.operations.filter((operation) => operation.operation === "update");
assert.equal(updates.length, 1);
assert.deepEqual(updates[0].changes, { title: "B" });
assert.equal(updates[0].remoteId, "remote-job-1");

await queue.enqueueUpdate({
  item: {
    ...remoteItem,
    title: "C",
    sync: {
      ...remoteItem.sync,
      status: "pending-update",
      pendingChanges: {
        title: "B",
      },
    },
  },
  changes: {
    title: "C",
  },
  baselineItem: remoteItem,
});

loaded = await queue.load();
updates = loaded.operations.filter((operation) => operation.operation === "update");
assert.equal(updates.length, 1);
assert.deepEqual(updates[0].changes, { title: "C" });

await queue.enqueueUpdate({
  item: {
    ...remoteItem,
    title: "C",
    description: "D2",
    sync: {
      ...remoteItem.sync,
      status: "pending-update",
      pendingChanges: {
        title: "C",
      },
    },
  },
  changes: {
    description: "D2",
  },
  baselineItem: remoteItem,
});

loaded = await queue.load();
updates = loaded.operations.filter((operation) => operation.operation === "update");
assert.equal(updates.length, 1);
assert.deepEqual(updates[0].changes, { title: "C", description: "D2" });

await queue.enqueueUpdate({
  item: {
    ...remoteItem,
    title: "A",
    description: "D2",
    sync: {
      ...remoteItem.sync,
      status: "pending-update",
      pendingChanges: {
        title: "C",
        description: "D2",
      },
    },
  },
  changes: {
    title: "A",
  },
  baselineItem: remoteItem,
});

loaded = await queue.load();
updates = loaded.operations.filter((operation) => operation.operation === "update");
assert.equal(updates.length, 1);
assert.deepEqual(updates[0].changes, { description: "D2" });

await queue.enqueueUpdate({
  item: {
    ...remoteItem,
    title: "A",
    description: "D1",
    sync: {
      ...remoteItem.sync,
      status: "pending-update",
      pendingChanges: {
        description: "D2",
      },
    },
  },
  changes: {
    description: "D1",
  },
  baselineItem: remoteItem,
});

loaded = await queue.load();
updates = loaded.operations.filter((operation) => operation.operation === "update");
assert.equal(updates.length, 0);

const localId = queue.localDocketId();
await queue.enqueueCreate({
  item: {
    id: localId,
    type: "job",
    title: "Create A",
    description: "Create D1",
  },
  payload: {
    id: localId,
    type: "job",
    title: "Create A",
    description: "Create D1",
  },
});
await queue.enqueueUpdate({
  item: {
    id: localId,
    type: "job",
    title: "Create B",
    description: "Create D2",
  },
  changes: {
    title: "Create B",
    description: "Create D2",
  },
});

loaded = await queue.load();
const create = loaded.operations.find((operation) => operation.operation === "create" && operation.localId === localId);
assert.equal(create.payload.title, "Create B");
assert.equal(create.payload.description, "Create D2");
assert.equal(
  loaded.operations.some((operation) => operation.operation === "update" && operation.localId === localId),
  false
);

assert.equal(canonicalDocketId("reference-1"), "");
assert.equal(canonicalDocketId("ghost-1"), "");
assert.equal(canonicalDocketId("virtual-1"), "");
assert.equal(canonicalDocketIdForItem({ id: "remote-job-1" }), "remote-job-1");

const cache = new CacheService({ cacheDir: tmpDir });
const syncIndex = {
  lastSuccessfulSync: "2026-07-18T00:00:00.000Z",
  projectId: "project-1",
  dockets: {
    "remote-job-1": {
      docketId: "remote-job-1",
      modifiedTimestamp: "100",
      createdTimestamp: "50",
    },
  },
};
const graph = {
  projects: [{ id: "project-1" }],
  epics: [],
  stories: [],
  jobs: [],
  tasks: [],
  appState: {
    sprints: [],
    workItems: [remoteItem],
  },
};

await cache.saveGraph(graph, { syncedAt: syncIndex.lastSuccessfulSync, syncIndex });
const saved = await cache.saveGraph(
  {
    ...graph,
    appState: {
      ...graph.appState,
      workItems: [
        {
          ...remoteItem,
          title: "B",
          sync: {
            ...remoteItem.sync,
            status: "pending-update",
            pendingChanges: {
              title: "B",
            },
          },
        },
      ],
    },
  },
  { syncedAt: "2026-07-18T01:00:00.000Z" }
);

assert.equal(Object.keys(saved.metadata.dockets).length, 1);
assert.equal(saved.metadata.dockets["remote-job-1"].modifiedTimestamp, "100");

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");

assert.match(appSource, /const saveModalWorkItem = useCallback/);
assert.match(appSource, /onSaveItem=\{saveModalWorkItem\}/);
assert.equal(appSource.includes("loadEliticalLookups"), false);
assert.match(serverSource, /syncQueueService\.isLocalId\(remoteId\)/);

console.log("Local-first update verification PASS");
