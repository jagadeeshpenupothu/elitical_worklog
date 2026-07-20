import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getEliticalWorklogDataRoot,
  getStoragePaths,
  initializeStorage,
} from "../local-backend/services/StoragePathService.mjs";
import { CacheService } from "../local-backend/services/CacheService.mjs";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import { WorklogService } from "../local-backend/services/WorklogService.mjs";

const originalEnv = { ...process.env };

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function restoreEnv() {
  process.env = { ...originalEnv };
}

function setStorageFixtureEnv({ root, legacyDev, legacyPackaged }) {
  restoreEnv();
  process.env.ELITICAL_WORKLOG_DATA_ROOT = root;
  process.env.ELITICAL_LEGACY_DEV_ROOT = legacyDev;
  process.env.ELITICAL_LEGACY_DEV_AUTH_ROOT = path.join(path.dirname(legacyDev), ".elitical");
  process.env.ELITICAL_LEGACY_PACKAGED_ROOT = legacyPackaged;
  delete process.env.ELITICAL_CACHE_DIR;
  delete process.env.ELITICAL_SYNC_DIR;
  delete process.env.ELITICAL_DATA_DIR;
  delete process.env.ELITICAL_STORAGE_STATE_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
}

try {
  delete process.env.ELITICAL_WORKLOG_DATA_ROOT;
  assert.equal(
    getEliticalWorklogDataRoot(),
    path.join(os.homedir(), "Elitical Worklog Data"),
    "default root uses the current user's home directory"
  );
  assert.doesNotMatch(
    await fs.readFile(new URL("../local-backend/services/StoragePathService.mjs", import.meta.url), "utf8"),
    /jagadeeshpenupothu487|\/Users\//,
    "resolver source does not hard-code a username or /Users path"
  );

  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-storage-root-"));
  const root = path.join(fixtureRoot, "new-root");
  const legacyDev = path.join(fixtureRoot, "legacy-dev-cache");
  const legacyPackaged = path.join(fixtureRoot, "legacy-packaged");
  setStorageFixtureEnv({ root, legacyDev, legacyPackaged });

  const paths = getStoragePaths();

  assert.equal(paths.root, root);
  assert.equal(paths.graphPath, path.join(root, "data", "graph.json"));
  assert.equal(paths.worklogsPath, path.join(root, "data", "worklogs.json"));
  assert.equal(paths.syncQueuePath, path.join(root, "sync", "sync-queue.json"));
  assert.equal(paths.storageStatePath, path.join(root, "auth", "storage-state.json"));
  assert.equal(paths.playwrightBrowsersPath, path.join(root, "runtime", "playwright-browsers", ".local-browsers"));

  await writeJson(path.join(legacyDev, "graph.json"), {
    appState: { workItems: [{ id: "legacy-job", type: "job" }] },
  });
  await writeJson(path.join(legacyDev, "worklogs.json"), {
    version: 1,
    worklogs: [{ id: "legacy-worklog", docketId: "legacy-job" }],
  });
  await writeJson(path.join(legacyDev, "metadata.json"), { lastSuccessfulSync: "legacy" });
  await writeJson(path.join(legacyDev, "sync-queue.json"), {
    version: 1,
    operations: [
      {
        operationId: "queue-pending-create",
        entityType: "docket",
        operation: "create",
        localId: "local-docket-1",
        status: "pending-create",
      },
      {
        operationId: "queue-confirmed-worklog",
        entityType: "worklog",
        operation: "create",
        localId: "local-worklog-1",
        remoteId: "remote-worklog-1",
        status: "sync-failed",
        retryMutation: true,
      },
    ],
    localToRemote: {},
  });
  await writeJson(path.join(path.dirname(legacyDev), ".elitical", "storage-state.json"), {
    cookies: [{ name: "JSESSIONID", value: "fixture" }],
    origins: [],
  });

  const migrated = await initializeStorage();

  assert.equal(migrated.status, "ready");
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.paths.root, root);
  assert.equal((await readJson(paths.graphPath)).appState.workItems[0].id, "legacy-job");
  assert.equal((await readJson(paths.worklogsPath)).worklogs[0].id, "legacy-worklog");
  assert.equal((await readJson(paths.syncQueuePath)).operations.length, 2);
  assert.equal((await readJson(paths.storageStatePath)).cookies[0].name, "JSESSIONID");
  assert.equal(await pathExists(path.join(legacyDev, ".elitical-worklog-data-migrated.json")), true);

  const migratedQueue = new LocalSyncQueueService({ cacheDir: paths.syncDir });
  const queue = await migratedQueue.load();
  const confirmedWorklog = queue.operations.find((operation) => operation.operationId === "queue-confirmed-worklog");

  assert.equal(migratedQueue.classifyOperation(confirmedWorklog).completed, true);
  assert.equal(
    migratedQueue.classifyOperation(confirmedWorklog).mutationActionable,
    false,
    "confirmed Worklog create protection survives storage migration"
  );

  await writeJson(path.join(legacyDev, "graph.json"), { appState: { workItems: [{ id: "stale" }] } });
  const secondInit = await initializeStorage();

  assert.equal(secondInit.migrated, false);
  assert.equal((await readJson(paths.graphPath)).appState.workItems[0].id, "legacy-job");

  const healthyRoot = path.join(fixtureRoot, "healthy-root");
  setStorageFixtureEnv({
    root: healthyRoot,
    legacyDev: path.join(fixtureRoot, "missing-legacy-dev"),
    legacyPackaged: path.join(fixtureRoot, "missing-legacy-packaged"),
  });
  await writeJson(path.join(healthyRoot, "data", "graph.json"), { appState: { workItems: [] } });
  const healthy = await initializeStorage();

  assert.equal(healthy.status, "ready");
  assert.equal(healthy.rebuildRequired, false);
  assert.equal(healthy.resetDetected, false);

  const resetRoot = path.join(fixtureRoot, "reset-root");
  setStorageFixtureEnv({
    root: resetRoot,
    legacyDev: path.join(fixtureRoot, "no-legacy-dev"),
    legacyPackaged: path.join(fixtureRoot, "no-legacy-packaged"),
  });
  const reset = await initializeStorage();

  assert.equal(reset.status, "rebuild-required");
  assert.equal(reset.rebuildRequired, true);
  assert.equal(reset.resetDetected, true);
  for (const dir of ["data", "sync", "auth", "runtime", "logs"]) {
    assert.equal(await pathExists(path.join(resetRoot, dir)), true, `${dir} directory is recreated`);
  }

  const cache = new CacheService({ cacheDir: path.join(fixtureRoot, "cache-service-tmp") });
  const worklogs = new WorklogService({ cacheDir: path.join(fixtureRoot, "worklog-service-tmp") });
  const queueService = new LocalSyncQueueService({ cacheDir: path.join(fixtureRoot, "queue-service-tmp") });

  assert.match(cache.graphPath, /cache-service-tmp/);
  assert.match(worklogs.pendingPath, /worklog-service-tmp/);
  assert.match(queueService.queuePath, /queue-service-tmp/);

  const cacheSource = await fs.readFile(new URL("../local-backend/services/CacheService.mjs", import.meta.url), "utf8");
  const queueSource = await fs.readFile(new URL("../local-backend/services/LocalSyncQueueService.mjs", import.meta.url), "utf8");
  const worklogSource = await fs.readFile(new URL("../local-backend/services/WorklogService.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(cacheSource, /path\.resolve\("local-backend\/cache"\)/);
  assert.doesNotMatch(queueSource, /path\.resolve\("local-backend\/cache"\)/);
  assert.doesNotMatch(worklogSource, /path\.resolve\("local-backend\/cache"\)/);

  await fs.rm(fixtureRoot, { recursive: true, force: true });
} finally {
  restoreEnv();
}

console.log("Storage architecture verification PASS");
