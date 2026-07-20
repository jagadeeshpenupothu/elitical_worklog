import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STORAGE_SCHEMA_VERSION = 1;
const DEFAULT_ROOT_NAME = "Elitical Worklog Data";
const MANIFEST_FILE = "storage-manifest.json";
const LEGACY_MIGRATION_MARKER = ".elitical-worklog-data-migrated.json";

// Central writable-storage contract for the app. Persistent data must be routed
// through this resolver instead of package resources or hard-coded user paths.
function firstString(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function defaultRoot() {
  return path.join(os.homedir(), DEFAULT_ROOT_NAME);
}

export function getEliticalWorklogDataRoot() {
  return path.resolve(firstString(process.env.ELITICAL_WORKLOG_DATA_ROOT) || defaultRoot());
}

export function getStoragePaths(root = getEliticalWorklogDataRoot()) {
  const resolvedRoot = path.resolve(root);
  const dataDir = path.join(resolvedRoot, "data");
  const syncDir = path.join(resolvedRoot, "sync");
  const authDir = path.join(resolvedRoot, "auth");
  const runtimeDir = path.join(resolvedRoot, "runtime");
  const logsDir = path.join(resolvedRoot, "logs");
  const configDir = path.join(resolvedRoot, "config");

  return {
    root: resolvedRoot,
    manifestPath: path.join(resolvedRoot, MANIFEST_FILE),
    dataDir,
    syncDir,
    authDir,
    runtimeDir,
    logsDir,
    configDir,
    envPath: path.join(resolvedRoot, ".env"),
    githubPublicationEnvPath: path.join(configDir, "github-publication.env"),
    graphPath: path.join(dataDir, "graph.json"),
    worklogsPath: path.join(dataDir, "worklogs.json"),
    metadataPath: path.join(dataDir, "metadata.json"),
    layoutPath: path.join(dataDir, "layout.json"),
    settingsPath: path.join(dataDir, "settings.json"),
    worklogDraftsPath: path.join(dataDir, "worklog-drafts.json"),
    worklogHistoryPath: path.join(dataDir, "worklog-history.json"),
    pendingWorklogsPath: path.join(syncDir, "pending-worklogs.json"),
    syncQueuePath: path.join(syncDir, "sync-queue.json"),
    storageStatePath: path.join(authDir, "storage-state.json"),
    playwrightBrowsersRoot: path.join(runtimeDir, "playwright-browsers"),
    playwrightBrowsersPath: path.join(runtimeDir, "playwright-browsers", ".local-browsers"),
    startupLogPath: path.join(logsDir, "startup.log"),
  };
}

export function applyStorageEnvironment(paths = getStoragePaths()) {
  process.env.ELITICAL_WORKLOG_DATA_ROOT = paths.root;
  process.env.ELITICAL_CACHE_DIR = paths.dataDir;
  process.env.ELITICAL_DATA_DIR = paths.authDir;
  process.env.ELITICAL_SYNC_DIR = paths.syncDir;
  process.env.ELITICAL_RUNTIME_DIR = paths.runtimeDir;
  process.env.ELITICAL_LOGS_DIR = paths.logsDir;
  process.env.ELITICAL_STORAGE_STATE_PATH = paths.storageStatePath;
  process.env.GITHUB_PUBLICATION_ENV_PATH = paths.githubPublicationEnvPath;
  process.env.PLAYWRIGHT_BROWSERS_PATH = paths.playwrightBrowsersPath;

  return paths;
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function ensureDirectories(paths) {
  await Promise.all([
    fs.mkdir(paths.dataDir, { recursive: true }),
    fs.mkdir(paths.syncDir, { recursive: true }),
    fs.mkdir(paths.authDir, { recursive: true }),
    fs.mkdir(paths.runtimeDir, { recursive: true }),
    fs.mkdir(paths.logsDir, { recursive: true }),
    fs.mkdir(paths.configDir, { recursive: true }),
  ]);
}

async function copyIfPresent(source, destination) {
  if (!(await pathExists(source)) || (await pathExists(destination))) return false;

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);

  return true;
}

async function legacyFileStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function legacyPackagedRoot() {
  return (
    process.env.ELITICAL_LEGACY_PACKAGED_ROOT ||
    path.join(os.homedir(), "Library", "Application Support", "Elitical Worklog")
  );
}

function legacyDevelopmentRoot() {
  return process.env.ELITICAL_LEGACY_DEV_ROOT || path.resolve(process.cwd(), "local-backend", "cache");
}

function legacyDevelopmentAuthRoot() {
  return process.env.ELITICAL_LEGACY_DEV_AUTH_ROOT || path.resolve(process.cwd(), ".elitical");
}

async function candidateFor({ id, cacheDir, authDir }) {
  const graphPath = path.join(cacheDir, "graph.json");
  const stat = await legacyFileStat(graphPath);
  const markerPath = path.join(cacheDir, LEGACY_MIGRATION_MARKER);

  return {
    id,
    cacheDir,
    authDir,
    graphPath,
    markerPath,
    hasGraph: Boolean(stat),
    alreadyMigrated: await pathExists(markerPath),
    graphMtimeMs: stat?.mtimeMs || 0,
  };
}

async function legacyCandidates(paths) {
  const packagedRoot = legacyPackagedRoot();
  const candidates = await Promise.all([
    candidateFor({
      id: "packaged-userData",
      cacheDir: path.join(packagedRoot, "cache"),
      authDir: path.join(packagedRoot, "elitical"),
    }),
    candidateFor({
      id: "development-project",
      cacheDir: legacyDevelopmentRoot(),
      authDir: legacyDevelopmentAuthRoot(),
    }),
  ]);

  return candidates.filter((candidate) => !candidate.cacheDir.startsWith(paths.root));
}

async function hasInitializedData(paths) {
  if (await pathExists(paths.manifestPath)) return true;

  return (
    (await pathExists(paths.graphPath)) ||
    (await pathExists(paths.worklogsPath)) ||
    (await pathExists(paths.syncQueuePath)) ||
    (await pathExists(paths.storageStatePath))
  );
}

async function writeManifest(paths, manifest) {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(
    paths.manifestPath,
    `${JSON.stringify(
      {
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        root: paths.root,
        updatedAt: new Date().toISOString(),
        ...manifest,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function copyLegacyData(paths, candidate) {
  const copied = [];
  const mappings = [
    [path.join(candidate.cacheDir, "graph.json"), paths.graphPath],
    [path.join(candidate.cacheDir, "worklogs.json"), paths.worklogsPath],
    [path.join(candidate.cacheDir, "metadata.json"), paths.metadataPath],
    [path.join(candidate.cacheDir, "layout.json"), paths.layoutPath],
    [path.join(candidate.cacheDir, "settings.json"), paths.settingsPath],
    [path.join(candidate.cacheDir, "worklog-drafts.json"), paths.worklogDraftsPath],
    [path.join(candidate.cacheDir, "worklog-history.json"), paths.worklogHistoryPath],
    [path.join(candidate.cacheDir, "pending-worklogs.json"), paths.pendingWorklogsPath],
    [path.join(candidate.cacheDir, "sync-queue.json"), paths.syncQueuePath],
    [path.join(candidate.authDir, "storage-state.json"), paths.storageStatePath],
  ];

  for (const [source, destination] of mappings) {
    if (await copyIfPresent(source, destination)) {
      copied.push({
        source,
        destination,
      });
    }
  }

  return copied;
}

export async function initializeStorage() {
  const paths = applyStorageEnvironment(getStoragePaths());
  const rootExisted = await pathExists(paths.root);
  const alreadyInitialized = await hasInitializedData(paths);

  await ensureDirectories(paths);

  if (await pathExists(paths.manifestPath)) {
    return {
      status: "ready",
      paths,
      rootExisted,
      rebuildRequired: !(await pathExists(paths.graphPath)),
      resetDetected: !rootExisted && !(await pathExists(paths.graphPath)),
      migrated: false,
      manifest: await readJson(paths.manifestPath),
    };
  }

  if (alreadyInitialized) {
    await writeManifest(paths, {
      status: "ready",
      initializedAt: new Date().toISOString(),
      migration: {
        status: "skipped-existing-new-storage",
      },
    });

    return {
      status: "ready",
      paths,
      rootExisted,
      rebuildRequired: !(await pathExists(paths.graphPath)),
      resetDetected: !rootExisted && !(await pathExists(paths.graphPath)),
      migrated: false,
    };
  }

  const candidates = (await legacyCandidates(paths))
    .filter((candidate) => candidate.hasGraph)
    .filter((candidate) => !candidate.alreadyMigrated)
    .sort((first, second) => second.graphMtimeMs - first.graphMtimeMs);
  const legacy = candidates[0] || null;
  const copied = legacy ? await copyLegacyData(paths, legacy) : [];
  if (legacy && copied.length) {
    await fs.writeFile(
      legacy.markerPath,
      `${JSON.stringify(
        {
          migratedTo: paths.root,
          migratedAt: new Date().toISOString(),
          storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        },
        null,
        2
      )}\n`,
      "utf8"
    ).catch(() => {});
  }
  const graphExists = await pathExists(paths.graphPath);

  await writeManifest(paths, {
    status: graphExists ? "ready" : "rebuild-required",
    initializedAt: new Date().toISOString(),
    rebuildRequired: !graphExists,
    migration: legacy
      ? {
          status: "copied",
          source: legacy.id,
          sourceCacheDir: legacy.cacheDir,
          sourceAuthDir: legacy.authDir,
          copied,
        }
      : {
          status: "no-legacy-data",
        },
  });

  return {
    status: graphExists ? "ready" : "rebuild-required",
    paths,
    rootExisted,
    rebuildRequired: !graphExists,
    resetDetected: !rootExisted && !graphExists && !legacy,
    migrated: Boolean(legacy && copied.length),
    legacy,
    copied,
  };
}
